import { choicesFor, needsSpeech, type PendingRequest } from '@lrs/core-engine';
import type { LlmRouter, LlmTier } from '@lrs/llm-router';
import type { Action, ActionKind, GameEvent, Logger, Role, SeatId, SpeechContext } from '@lrs/shared';
import { MOOD_LABELS, createBelief, mergeReads, type Belief } from './memory/belief.ts';
import type { PublicFacts } from './memory/facts.ts';
import {
  buildDecisionUserPrompt,
  buildReflectionPrompt,
  buildSpeechUserPrompt,
  buildSystemPrompt,
  type PromptInput,
} from './prompt.ts';
import type { AgentProfile } from './profiles.ts';
import { decisionSchemaWithChoices, reflectionSchema, type Decision } from './schema.ts';

/** 每次调用最多保留多少条私有信息与要点，防止提示词无限膨胀 */
const MAX_PRIVATE_NOTES = 24;
const MAX_NARRATIVE = 8;
const MAX_SPEECH_CHARS = 220;

export interface AgentOptions {
  seat: SeatId;
  profile: AgentProfile;
  router: LlmRouter;
  logger: Logger;
  /** 座位总数，用于初始化判断表 */
  seatCount: number;
}

export interface ActContext {
  facts: PublicFacts;
  /** 本轮阶段的中文说明 */
  phaseLabel: string;
  /** 发言阶段才有值 */
  speechContext: SpeechContext | null;
  pending: PendingRequest;
  /** 狼队友当前的想法（只有狼有） */
  packNotes: string[];
}

export interface DecideOutput {
  action: Action;
  decision: Decision;
  /** 本轮跳了什么身份（没跳为 null），由 host 记进公共事实层 */
  claim: { role: Role; note: string } | null;
}

/** 任务名 → 档位。与设计文档 5.7 的模型路由表一一对应。 */
function tierFor(kind: ActionKind): LlmTier {
  switch (kind) {
    case 'vote':
    case 'wolf_kill':
    case 'seer_check':
    case 'witch_act':
    case 'chief_signup':
    case 'chief_withdraw':
    case 'chief_transfer':
    case 'hunter_shoot':
      return 'strong';
    case 'guard_protect':
    case 'speak':
      return 'cheap';
  }
}

function taskInstruction(kind: ActionKind): string {
  switch (kind) {
    case 'guard_protect':
      return '现在是夜晚的守卫环节。选择今晚要守护的人。';
    case 'wolf_kill':
      return '现在是夜晚的狼人环节。选择今晚要刀的人（可以刀自己人做戏，也可以刀威胁最大的好人）。';
    case 'witch_act':
      return '现在是夜晚的女巫环节。决定是否使用药水。';
    case 'seer_check':
      return '现在是夜晚的预言家环节。选择今晚要查验的人。';
    case 'chief_signup':
      return '现在是警长竞选的上警环节。决定你是否要上警竞选警长。';
    case 'chief_withdraw':
      return '现在是退水环节。决定你是否退出竞选（退水后既不能被选也不能投票）。';
    case 'vote':
      return '现在是投票环节。选择你要投给谁，也可以弃票。';
    case 'hunter_shoot':
      return '你出局了，可以开枪带走一个人，也可以放弃。';
    case 'chief_transfer':
      return '你出局了，决定警徽交给谁，或者撕毁警徽。';
    case 'speak':
      return '现在轮到你发言。';
  }
}

/** 模型偶尔会带引号、代码块或换行，这里统一收拾干净 */
function sanitizeSpeech(raw: string): string {
  let text = raw.trim();
  const fenced = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  text = text.replace(/^["「『]/, '').replace(/["」』]$/, '').trim();
  text = text.replace(/\s*\n+\s*/g, ' ').trim();
  if (text.length > MAX_SPEECH_CHARS) text = `${text.slice(0, MAX_SPEECH_CHARS)}…`;
  return text;
}

/**
 * 一个 AI 玩家。
 *
 * 记忆分三层：事实层由 host 统一维护（引擎事件投影，零幻觉），
 * 信念层与要点层属于自己（模型推断，会错但结构化）。
 * 「先想后说」在这里落地：decide 产出结构化结论，speak 只负责演绎成人话。
 */
export class Agent {
  readonly seat: SeatId;
  readonly profile: AgentProfile;

  private readonly router: LlmRouter;
  private readonly logger: Logger;

  private role: Role | null = null;
  private teammates: SeatId[] = [];
  private readonly belief: Belief;
  private readonly privateNotes: string[] = [];
  private readonly narrative: string[] = [];

  constructor(options: AgentOptions) {
    this.seat = options.seat;
    this.profile = options.profile;
    this.router = options.router;
    this.logger = options.logger.child(`seat${options.seat}`);
    this.belief = createBelief(
      Array.from({ length: options.seatCount }, (_, index) => index + 1),
      options.seat,
    );
  }

  get currentRole(): Role | null {
    return this.role;
  }

  get currentPush(): SeatId | null {
    return this.belief.push;
  }

  get currentMood(): string {
    return MOOD_LABELS[this.belief.mood];
  }

  /** 只喂「这个座位能看到的事件」；过滤由 host 负责 */
  observe(events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event.payload.t) {
        case 'role_assigned':
          this.role = event.payload.role;
          break;
        case 'wolf_teammates':
          this.teammates = [...event.payload.mates];
          break;
        case 'seer_result':
          this.pushPrivateNote(
            `第 ${event.day} 天你验了 ${event.payload.target} 号，结果是${event.payload.camp === 'wolf' ? '狼人' : '好人'}`,
          );
          break;
        case 'witch_night_info':
          this.pushPrivateNote(
            event.payload.killed === null
              ? `第 ${event.day} 夜你没有得到被刀信息`
              : `第 ${event.day} 夜被刀的是 ${event.payload.killed} 号`,
          );
          break;
        default:
          break;
      }
    }
  }

  /** 「想」：产出一个结构化决策；发言阶段会紧接着调用 speak 把它说出来 */
  async decide(context: ActContext): Promise<DecideOutput> {
    if (this.role === null) throw new Error(`${this.seat} 号还没有拿到自己的身份`);

    const isSpeech = needsSpeech(context.pending);
    const choices = isSpeech ? [] : choicesFor(context.pending);
    const promptChoices = isSpeech
      ? [{ index: 1, label: '发言' }]
      : choices.map((choice, index) => ({ index: index + 1, label: choice.label }));

    const kind = context.pending.options[0]?.kind ?? 'speak';
    const promptInput = this.buildPromptInput(context);

    const { value: decision } = await this.router.completeJson({
      tier: tierFor(kind),
      task: kind,
      messages: [
        { role: 'system', content: buildSystemPrompt(promptInput) },
        {
          role: 'user',
          content: buildDecisionUserPrompt(promptInput, {
            instruction: taskInstruction(kind),
            choices: promptChoices,
          }),
        },
      ],
      maxTokens: 1200,
      temperature: 0.9,
      schema: decisionSchemaWithChoices(promptChoices.length),
    });

    this.applyDecision(decision);
    this.logger.debug('决策完成', {
      kind,
      choice: decision.choiceIndex,
      push: decision.push,
      mood: decision.mood,
      reasoning: decision.reasoning,
    });

    if (isSpeech) {
      const speech = await this.composeSpeech(promptInput, decision, context.speechContext ?? 'day');
      return {
        action: { kind: 'speak', actor: this.seat, text: speech },
        decision,
        claim: decision.claim,
      };
    }

    const picked = choices[decision.choiceIndex - 1];
    if (!picked) throw new Error(`${this.seat} 号选中的行动序号越界：${decision.choiceIndex}`);
    return { action: picked.action, decision, claim: decision.claim };
  }

  /** 「说」：把已经定好的结论演绎成人话，用便宜模型流式产出 */
  private async composeSpeech(
    promptInput: PromptInput,
    decision: Decision,
    context: SpeechContext,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.router.stream({
      tier: 'cheap',
      task: 'speech',
      messages: [
        { role: 'system', content: buildSystemPrompt(promptInput) },
        { role: 'user', content: buildSpeechUserPrompt(promptInput, decision, context) },
      ],
      maxTokens: 500,
      temperature: 1.1,
    })) {
      chunks.push(chunk);
    }

    const text = sanitizeSpeech(chunks.join(''));
    return text.length > 0 ? text : `${this.seat} 号发言：先听听大家怎么说。`;
  }

  /** 反思：对比预测与实际，更新判断与情绪，并留下一句教训 */
  async reflect(input: { facts: PublicFacts; phaseLabel: string; outcome: { day: number; summary: string } }): Promise<void> {
    if (this.role === null) return;

    const promptInput = this.buildPromptInput({
      facts: input.facts,
      phaseLabel: input.phaseLabel,
      packNotes: [],
    });

    try {
      const { value } = await this.router.completeJson({
        tier: 'cheap',
        task: 'reflection',
        messages: [
          { role: 'system', content: buildSystemPrompt(promptInput) },
          { role: 'user', content: buildReflectionPrompt(promptInput, input.outcome) },
        ],
        maxTokens: 800,
        temperature: 0.8,
        schema: reflectionSchema,
      });

      mergeReads(this.belief, value.reads);
      this.belief.mood = value.mood;
      this.belief.stance = value.stance;
      this.narrative.push(`第 ${input.outcome.day} 天教训：${value.lesson}`);
      if (this.narrative.length > MAX_NARRATIVE) {
        this.narrative.splice(0, this.narrative.length - MAX_NARRATIVE);
      }
      this.logger.debug('反思完成', { mood: value.mood, lesson: value.lesson });
    } catch (error) {
      // 反思失败不该影响对局，记一笔就够了
      this.logger.warn('反思调用失败，已跳过', {
        seat: this.seat,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyDecision(decision: Decision): void {
    mergeReads(
      this.belief,
      decision.reads.map((read) => ({
        seat: read.seat,
        guess: read.guess,
        confidence: read.confidence,
        reason: read.reason,
      })),
    );
    this.belief.push = decision.push;
    this.belief.stance = decision.stance;
    this.belief.mood = decision.mood;
    if (decision.claim) {
      this.pushPrivateNote(`你跳了${decision.claim.role}：${decision.claim.note}`);
    }
  }

  private pushPrivateNote(note: string): void {
    this.privateNotes.push(note);
    if (this.privateNotes.length > MAX_PRIVATE_NOTES) {
      this.privateNotes.splice(0, this.privateNotes.length - MAX_PRIVATE_NOTES);
    }
  }

  private buildPromptInput(context: {
    facts: PublicFacts;
    phaseLabel: string;
    packNotes: string[];
  }): PromptInput {
    return {
      profile: this.profile,
      seat: this.seat,
      role: this.role ?? 'villager',
      phaseLabel: context.phaseLabel,
      teammates: this.teammates,
      facts: context.facts,
      belief: this.belief,
      privateNotes: [...this.privateNotes],
      narrative: [...this.narrative],
      packNotes: context.packNotes,
    };
  }
}
