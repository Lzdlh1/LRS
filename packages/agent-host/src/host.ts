import { eventsFor, type GameState, type PendingRequest } from '@lrs/core-engine';
import type { LlmRouter } from '@lrs/llm-router';
import type { Action, GameEvent, Logger, Role, SeatId, SpeechContext } from '@lrs/shared';
import { Agent } from './agent.ts';
import { PHASE_LABELS } from './labels.ts';
import { applyEvents, createFacts, recordClaim, type PublicFacts } from './memory/facts.ts';
import { pickProfiles, type AgentProfile } from './profiles.ts';

export interface AiSeat {
  seat: SeatId;
  name: string;
  profile: AgentProfile;
}

/** 一次 AI 决策的可复盘信息 */
export interface DecisionLogEntry {
  seat: SeatId;
  kind: string;
  reasoning: string;
  stance: string;
  push: SeatId | null;
  mood: string;
  claim: { role: Role; note: string } | null;
}

export interface AgentHostOptions {
  router: LlmRouter;
  logger: Logger;
  seats: readonly AiSeat[];
  seatCount: number;
  /** 投票结算后是否触发反思（每个 AI 一次便宜调用） */
  enableReflection?: boolean;
  /** 发言增量回调：边生成边推给前端做打字机效果 */
  onSpeechDelta?: (seat: SeatId, delta: string) => void;
  /** 发言生成完毕的回调 */
  onSpeech?: (seat: SeatId, text: string) => void;
  /** 每次决策完成后的回调，供复盘与离线分析使用 */
  onDecision?: (entry: DecisionLogEntry) => void;
}

export interface CreateHostOptions {
  router: LlmRouter;
  logger: Logger;
  /** 真人座位，不归 AI 管 */
  humanSeats: readonly SeatId[];
  seatCount: number;
  /** 座位显示名，按座位号顺序 */
  names: readonly string[];
  rng?: () => number;
  enableReflection?: boolean;
  onSpeechDelta?: (seat: SeatId, delta: string) => void;
  onSpeech?: (seat: SeatId, text: string) => void;
  onDecision?: (entry: DecisionLogEntry) => void;
}

function speechContextFor(phase: GameState['phase']): SpeechContext | null {
  switch (phase) {
    case 'CHIEF_SPEECH':
      return 'chief_campaign';
    case 'CHIEF_PK_SPEECH':
      return 'chief_pk';
    case 'DAY_PK_SPEECH':
      return 'day_pk';
    case 'LAST_WORDS':
      return 'last_words';
    case 'DAY_SPEECH':
      return 'day';
    default:
      return null;
  }
}

/**
 * 8 个 AI 玩家的编排者。
 *
 * 它持有唯一一份公共事实层（所有 AI 共享同一个「客观世界」），
 * 同时把事件按各自视角分发给每个 Agent 的私有记忆 —— 狼看得到狼队友，好人看不到。
 */
export class AgentHost {
  private readonly facts: PublicFacts;
  private readonly agents: Map<SeatId, Agent>;
  private readonly logger: Logger;
  private readonly reflection: boolean;
  private readonly onSpeech: ((seat: SeatId, text: string) => void) | null;
  private readonly onSpeechDelta: ((seat: SeatId, delta: string) => void) | null;
  private readonly onDecision: ((entry: DecisionLogEntry) => void) | null;
  private reflecting = false;

  constructor(options: AgentHostOptions) {
    this.logger = options.logger;
    this.reflection = options.enableReflection ?? true;
    this.onSpeech = options.onSpeech ?? null;
    this.onSpeechDelta = options.onSpeechDelta ?? null;
    this.onDecision = options.onDecision ?? null;
    this.facts = createFacts(options.seatCount);
    this.agents = new Map(
      options.seats.map((seat) => [
        seat.seat,
        new Agent({
          seat: seat.seat,
          profile: seat.profile,
          router: options.router,
          logger: options.logger,
          seatCount: options.seatCount,
        }),
      ]),
    );
  }

  get seatCount(): number {
    return this.agents.size;
  }

  /** 这个座位是不是归 AI 管 */
  handles(seat: SeatId): boolean {
    return this.agents.has(seat);
  }

  /** 只读快照，调试与复盘用 */
  get snapshot(): PublicFacts {
    return this.facts;
  }

  /**
   * 喂入新事件。
   * 公共事实层吸收 public 事件；每个 Agent 只拿到自己看得到的那些。
   */
  observe(events: readonly GameEvent[]): void {
    if (events.length === 0) return;

    applyEvents(this.facts, events);
    for (const agent of this.agents.values()) {
      agent.observe(eventsFor(events, agent.seat));
    }

    const tally = events.find((event) => event.payload.t === 'vote_tally');
    if (this.reflection && tally?.payload.t === 'vote_tally' && !this.reflecting) {
      void this.reflectAll(this.summarizeVote(tally.payload.counts, tally.payload.eliminated));
    }
  }

  /** 让某个 AI 产出行动。失败请由调用方兜底，不要在这里吞异常。 */
  async act(state: GameState, pending: PendingRequest): Promise<Action> {
    const agent = this.agents.get(pending.seat);
    if (!agent) throw new Error(`${pending.seat} 号不归 AI 管`);

    const kind = pending.options[0]?.kind ?? 'speak';
    const delta = this.onSpeechDelta;
    const result = await agent.decide(
      {
        facts: this.facts,
        phaseLabel: PHASE_LABELS[state.phase],
        speechContext: speechContextFor(state.phase),
        pending,
        packNotes: this.packNotesFor(pending.seat),
      },
      delta ? (chunk: string) => delta(pending.seat, chunk) : undefined,
    );

    if (result.claim) {
      recordClaim(this.facts, {
        seat: pending.seat,
        role: result.claim.role,
        day: this.facts.day,
        note: result.claim.note,
      });
    }

    this.onDecision?.({
      seat: pending.seat,
      kind,
      reasoning: result.decision.reasoning,
      stance: result.decision.stance,
      push: result.decision.push,
      mood: result.decision.mood,
      claim: result.claim,
    });

    if (result.action.kind === 'speak') {
      this.logger.debug('AI 发言', { seat: pending.seat, kind, length: result.action.text.length });
      this.onSpeech?.(pending.seat, result.action.text);
    } else {
      this.logger.debug('AI 行动', { seat: pending.seat, kind, action: result.action.kind });
    }

    return result.action;
  }

  /** 狼队友当前的想法，供代表狼在刀人时对齐（MVP 的「狼队协商」） */
  private packNotesFor(seat: SeatId): string[] {
    const self = this.agents.get(seat);
    if (!self || self.currentRole !== 'werewolf') return [];

    return [...this.agents.values()]
      .filter((other) => other.seat !== seat && other.currentRole === 'werewolf')
      .map(
        (other) =>
          `${other.seat} 号队友目前想推 ${other.currentPush ?? '还没定'}（情绪：${other.currentMood}）`,
      );
  }

  private summarizeVote(
    counts: readonly { seat: SeatId; votes: number }[],
    eliminated: SeatId | null,
  ): string {
    const tally = counts.map((item) => `${item.seat} 号 ${item.votes} 票`).join('，');
    const result = eliminated === null ? '没有人被放逐' : `${eliminated} 号被放逐`;
    return `${tally || '全员弃票'}；${result}`;
  }

  private async reflectAll(summary: string): Promise<void> {
    this.reflecting = true;
    try {
      const day = this.facts.day;
      await Promise.all(
        [...this.agents.values()].map((agent) =>
          agent.reflect({ facts: this.facts, phaseLabel: '投票结算后', outcome: { day, summary } }),
        ),
      );
    } catch (error) {
      this.logger.warn('批量反思出错', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.reflecting = false;
    }
  }
}

export function createAgentHost(options: CreateHostOptions): AgentHost {
  const aiSeats: SeatId[] = [];
  for (let seat = 1; seat <= options.seatCount; seat += 1) {
    if (!options.humanSeats.includes(seat)) aiSeats.push(seat);
  }

  const profiles = pickProfiles(aiSeats.length, options.rng ?? Math.random);
  const seats: AiSeat[] = aiSeats.map((seat, index) => ({
    seat,
    name: options.names[seat - 1] ?? `${seat} 号`,
    profile: profiles[index % profiles.length]!,
  }));

  return new AgentHost({
    router: options.router,
    logger: options.logger,
    seats,
    seatCount: options.seatCount,
    enableReflection: options.enableReflection,
    onSpeech: options.onSpeech,
    onSpeechDelta: options.onSpeechDelta,
    onDecision: options.onDecision,
  });
}
