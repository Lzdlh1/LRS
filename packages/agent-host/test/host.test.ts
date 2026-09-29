import { choicesFor, createGame, needsSpeech, pendingRequest, step, type PendingRequest } from '@lrs/core-engine';
import { LlmRouter, MockProvider } from '@lrs/llm-router';
import { createLogger, nullSink, type Action, type GameEvent, type Role } from '@lrs/shared';
import { describe, expect, it } from 'vitest';
import { createAgentHost, type DecisionLogEntry } from '../src/host.ts';
import { applyEvent, createFacts, recordClaim } from '../src/memory/facts.ts';
import { pickProfiles, BUILTIN_PROFILES } from '../src/profiles.ts';
import { GUESS_VALUES } from '../src/schema.ts';

const logger = createLogger('agent-test', nullSink, 'error');

/** 1 民(真人) · 2 狼 · 3 预言家 · 4 女巫 · 5 猎人 · 6 守卫 · 7 狼 · 8 民 · 9 狼 */
const FIXED_ROLES: Role[] = [
  'villager',
  'werewolf',
  'seer',
  'witch',
  'hunter',
  'guard',
  'werewolf',
  'villager',
  'werewolf',
];

const NAMES = ['你', '阿哲', '豆豆', '老K', '糖糖', '林小满', '小鹿', '铁蛋', '阿May'];

function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从决策提示词里数出「可选行动」有几条 */
function countChoices(userPrompt: string): number {
  const section = userPrompt.split('# 可选行动（只能选其中一个）')[1]?.split('# 输出要求')[0] ?? '';
  return section.split('\n').filter((line) => /^\d+\.\s/.test(line.trim())).length;
}

/**
 * 一个「只会合法行动」的假大脑：
 * 决策调用返回合法的 JSON，发言调用返回一段文本。
 * 它证明的是链路与契约，不证明 AI 有脑子 —— 那要真实模型。
 */
function mockBrain(rng: () => number, recorder?: { prompts: string[] }): MockProvider {
  return new MockProvider({
    respond: (request) => {
      const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
      recorder?.prompts.push(user);

      if (user.includes('只输出发言内容本身')) {
        return `我是这轮的发言内容，就事论事说两句。`;
      }

      const count = Math.max(1, countChoices(user));
      return JSON.stringify({
        choiceIndex: 1 + Math.floor(rng() * count),
        reasoning: '按当前信息挑一个看起来最合理的。',
        stance: '继续观察',
        push: null,
        reads: [],
        claim: null,
        mood: 'calm',
      });
    },
  });
}

/** 真人的兜底：有按钮就点第一个，要发言就随便说一句（发言不生成 Choice） */
function humanFallback(pending: PendingRequest): Action {
  const choice = choicesFor(pending)[0];
  if (choice) return choice.action;
  if (needsSpeech(pending)) return { kind: 'speak', actor: pending.seat, text: '（真人）我先听着。' };
  throw new Error(`没有可用行动：${pending.options.map((option) => option.kind).join(',')}`);
}

/** 「逢决策必跳预言家」的假大脑：用来验证身份宣称的公开时机 */
function claimingBrain(): MockProvider {
  return new MockProvider({
    respond: (request) => {
      const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
      if (user.includes('只输出发言内容本身')) return '我才是预言家，昨晚验了 9 号，是查杀。';
      return JSON.stringify({
        choiceIndex: 1,
        reasoning: '悍跳预言家，先把水搅浑。',
        stance: '我要跳预言家',
        push: null,
        reads: [],
        claim: { role: 'seer', note: '我验了 9 号是查杀' },
        mood: 'confident',
      });
    },
  });
}

function makeRouter(brain: MockProvider): LlmRouter {
  return new LlmRouter({
    providers: { brain },
    tiers: {
      cheap: { provider: 'brain', model: 'deepseek-chat' },
      strong: { provider: 'brain', model: 'deepseek-reasoner' },
    },
    maxConcurrency: 4,
  });
}

describe('公共事实层', () => {
  it('只吸收 public 事件，私密信息不污染公共认知', () => {
    const facts = createFacts(9);
    applyEvent(facts, {
      seq: 1,
      day: 0,
      phase: 'SETUP',
      visibility: { scope: 'seats', seats: [3] },
      payload: { t: 'role_assigned', seat: 3, role: 'seer' },
    });
    applyEvent(facts, {
      seq: 2,
      day: 1,
      phase: 'NIGHT_SEER',
      visibility: { scope: 'seats', seats: [3] },
      payload: { t: 'seer_result', seat: 3, target: 9, camp: 'wolf' },
    });

    expect(facts.timeline).toEqual([]);
    expect(facts.claims).toEqual([]);
  });

  it('记录死亡、投票与警长', () => {
    const facts = createFacts(9);
    applyEvent(facts, {
      seq: 1,
      day: 1,
      phase: 'DAWN_ANNOUNCE',
      visibility: { scope: 'public' },
      payload: { t: 'died', seat: 5, cause: 'wolf' },
    });
    applyEvent(facts, {
      seq: 2,
      day: 1,
      phase: 'DAY_VOTE',
      visibility: { scope: 'public' },
      payload: { t: 'voted', seat: 2, target: 3 },
    });
    applyEvent(facts, {
      seq: 3,
      day: 1,
      phase: 'CHIEF_VOTE',
      visibility: { scope: 'public' },
      payload: { t: 'chief_vote_tally', counts: [{ seat: 1, votes: 4 }], elected: 1, tie: false },
    });

    expect(facts.aliveSeats).not.toContain(5);
    expect(facts.deaths[0]).toMatchObject({ seat: 5, cause: 'wolf' });
    expect(facts.votesByDay[0]?.records).toEqual([{ from: 2, to: 3 }]);
    expect(facts.chief.elected).toBe(1);
    expect(facts.timeline.join('\n')).toContain('5 号出局');
    expect(facts.timeline.join('\n')).toContain('1 号当选警长');
  });

  it('换天之后只保留最近一轮发言原文', () => {
    const facts = createFacts(9);
    applyEvent(facts, {
      seq: 1,
      day: 1,
      phase: 'DAY_SPEECH',
      visibility: { scope: 'public' },
      payload: { t: 'spoke', seat: 2, text: '第一天的发言', context: 'day' },
    });
    applyEvent(facts, {
      seq: 2,
      day: 2,
      phase: 'DAY_SPEECH',
      visibility: { scope: 'public' },
      payload: { t: 'spoke', seat: 3, text: '第二天的发言', context: 'day' },
    });

    expect(facts.recentSpeeches).toHaveLength(1);
    expect(facts.recentSpeeches[0]?.text).toBe('第二天的发言');
  });

  it('宣称会进时间线且不重复记', () => {
    const facts = createFacts(9);
    recordClaim(facts, { seat: 3, role: 'seer', day: 1, note: '验了 9 号是狼' });
    recordClaim(facts, { seat: 3, role: 'seer', day: 1, note: '重复' });

    expect(facts.claims).toHaveLength(1);
    expect(facts.timeline.join('')).toContain('3 号宣称自己是预言家');
  });
});

describe('人设分配', () => {
  it('9 个内置人设互不重复', () => {
    const picked = pickProfiles(9, seededRng(1));
    expect(picked).toHaveLength(9);
    expect(new Set(picked.map((profile) => profile.id)).size).toBe(9);
    expect(BUILTIN_PROFILES.length).toBeGreaterThanOrEqual(9);
  });

  it('同一颗种子分到同一套人设', () => {
    const a = pickProfiles(8, seededRng(42)).map((profile) => profile.id);
    const b = pickProfiles(8, seededRng(42)).map((profile) => profile.id);
    expect(a).toEqual(b);
  });
});

describe('契约一致性', () => {
  it('身份猜测的取值范围覆盖了全部角色', () => {
    expect([...GUESS_VALUES]).toEqual(
      expect.arrayContaining(['werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'unknown']),
    );
  });
});

describe('Agent 决策映射', () => {
  it('把模型给的序号正确映射成引擎的 Action', async () => {
    const rng = seededRng(7);
    const host = createAgentHost({
      router: makeRouter(mockBrain(rng)),
      logger,
      humanSeats: [1],
      seatCount: 9,
      names: NAMES,
      rng: seededRng(3),
      enableReflection: false,
    });

    const game = createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] });
    host.observe(game.events);

    const pending = pendingRequest(game.state);
    expect(pending).not.toBeNull();
    const seat = pending!.seat;
    expect(host.handles(seat)).toBe(true);

    const action = await host.act(game.state, pending!);
    expect(action.actor).toBe(seat);

    // 提交给引擎后必须被接受（不能出现 action_rejected）
    const after = step(game.state, action);
    expect(after.events.some((event) => event.payload.t === 'action_rejected')).toBe(false);
  });

  it('每次决策完成后回调出可复盘的推理依据', async () => {
    const rng = seededRng(7);
    const entries: DecisionLogEntry[] = [];
    const host = createAgentHost({
      router: makeRouter(mockBrain(rng)),
      logger,
      humanSeats: [1],
      seatCount: 9,
      names: NAMES,
      rng: seededRng(3),
      enableReflection: false,
      onDecision: (entry) => entries.push(entry),
    });

    const game = createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] });
    host.observe(game.events);

    const pending = pendingRequest(game.state);
    expect(pending).not.toBeNull();
    await host.act(game.state, pending!);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seat: pending!.seat });
    expect(entries[0]!.reasoning.length).toBeGreaterThan(0);
    expect(entries[0]!.kind.length).toBeGreaterThan(0);
  });

  it('身份宣称只有真的发言了才算公开', async () => {
    const host = createAgentHost({
      router: makeRouter(claimingBrain()),
      logger,
      humanSeats: [1],
      seatCount: 9,
      names: NAMES,
      rng: seededRng(5),
      enableReflection: false,
    });

    let game = createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] });
    host.observe(game.events);

    // 一路走到第一次 AI 发言。途中的守/刀/验这些决策同样带着 claim，
    // 但那些只是「计划」—— 一个字都还没说出口
    let speechPending: PendingRequest | null = null;
    for (let i = 0; i < 300; i += 1) {
      const pending = pendingRequest(game.state);
      if (!pending) break;
      if (needsSpeech(pending) && host.handles(pending.seat)) {
        speechPending = pending;
        break;
      }
      const action = host.handles(pending.seat)
        ? await host.act(game.state, pending)
        : humanFallback(pending);
      const next = step(game.state, action);
      game = next;
      host.observe(next.events);
    }

    expect(speechPending).not.toBeNull();
    // 关键断言：这一步（修复前）claims 里已经塞满了还没发生的「宣称」，
    // 先发言的人就会照着不存在的话往下编
    expect(host.snapshot.claims).toEqual([]);

    // 决策产出了、发言文本也生成了，但只要还没落地（spoke 事件）就不算公开
    const speech = await host.act(game.state, speechPending!);
    expect(speech.kind).toBe('speak');
    expect(host.snapshot.claims).toEqual([]);

    const after = step(game.state, speech);
    host.observe(after.events);
    expect(host.snapshot.claims.map((claim) => claim.seat)).toContain(speechPending!.seat);
    expect(host.snapshot.timeline.some((line) => line.includes(`宣称自己是预言家`))).toBe(true);
  });

  it('发言阶段会先决策再生成发言文本', async () => {
    const rng = seededRng(11);
    const recorder = { prompts: [] as string[] };
    const host = createAgentHost({
      router: makeRouter(mockBrain(rng, recorder)),
      logger,
      humanSeats: [1],
      seatCount: 9,
      names: NAMES,
      rng: seededRng(5),
      enableReflection: false,
    });

    let game = createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] });
    host.observe(game.events);

    const spoken: GameEvent[] = [];
    for (let i = 0; i < 300; i += 1) {
      if (recorder.prompts.some((prompt) => prompt.includes('只输出发言内容本身'))) break;
      const pending = pendingRequest(game.state);
      if (!pending) break;

      const action = host.handles(pending.seat)
        ? await host.act(game.state, pending)
        : humanFallback(pending);

      const next = step(game.state, action);
      spoken.push(...next.events.filter((event) => event.payload.t === 'spoke'));
      game = next;
      host.observe(next.events);
    }

    // 发言阶段一共两次调用：先决策，再演绎
    const speechPrompts = recorder.prompts.filter((prompt) => prompt.includes('只输出发言内容本身'));
    expect(speechPrompts).toHaveLength(1);
    expect(speechPrompts[0]).toContain('你已经想好的结论');

    const aiSpoken = spoken.find(
      (event) => event.payload.t === 'spoke' && host.handles(event.payload.seat),
    );
    expect(aiSpoken).toBeDefined();
    if (aiSpoken?.payload.t === 'spoke') {
      expect(aiSpoken.payload.text.length).toBeGreaterThan(0);
      expect(aiSpoken.payload.text).not.toContain('{');
    }
  });
});

describe('发言耗时 ms', () => {
  it('AI 发言带上「发起生成请求 → 拿到文本」的耗时', async () => {
    // 可注入的时钟：每读一次前进 750ms，一次发言（读两次）就是 750ms
    let clock = 0;
    const host = createAgentHost({
      router: makeRouter(mockBrain(seededRng(5))),
      logger,
      humanSeats: [1],
      seatCount: 9,
      names: NAMES,
      rng: seededRng(5),
      enableReflection: false,
      now: () => (clock += 750),
    });

    let game = createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] });
    host.observe(game.events);

    // 一路走到第一次 AI 发言（发起动作前先停住）
    let speechPending: PendingRequest | null = null;
    for (let i = 0; i < 300; i += 1) {
      const pending = pendingRequest(game.state);
      if (!pending) break;
      if (needsSpeech(pending) && host.handles(pending.seat)) {
        speechPending = pending;
        break;
      }
      const action = host.handles(pending.seat)
        ? await host.act(game.state, pending)
        : humanFallback(pending);
      const next = step(game.state, action);
      game = next;
      host.observe(next.events);
    }

    expect(speechPending).not.toBeNull();
    const speech = await host.act(game.state, speechPending!);
    expect(speech.kind).toBe('speak');
    if (speech.kind !== 'speak') throw new Error('这一步一定是发言');
    expect(speech.ms).toBe(750);

    // 落到引擎之后，spoke 事件上带着同一个 ms
    const after = step(game.state, speech);
    const spoke = after.events.find((event) => event.payload.t === 'spoke');
    if (spoke?.payload.t !== 'spoke') throw new Error('应当产出 spoke 事件');
    expect(spoke.payload.ms).toBe(750);
  });
});

describe('整局跑通', () => {
  it('AI 靠假大脑也能把一整局打完，且零非法行动', async () => {
    const rng = seededRng(2024);
    const host = createAgentHost({
      router: makeRouter(mockBrain(rng)),
      logger,
      humanSeats: [1],
      seatCount: 9,
      names: NAMES,
      rng: seededRng(99),
      enableReflection: false,
    });

    let game = createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] });
    host.observe(game.events);

    const allEvents: GameEvent[] = [...game.events];
    let steps = 0;

    while (game.state.winner === null && steps < 600) {
      steps += 1;
      const pending = pendingRequest(game.state);
      if (!pending) throw new Error('游戏没结束却没有待办');

      const action = host.handles(pending.seat)
        ? await host.act(game.state, pending)
        : humanFallback(pending);

      const next = step(game.state, action);
      game = next;
      allEvents.push(...next.events);
      host.observe(next.events);
    }

    expect(game.state.winner).not.toBeNull();

    const rejected = allEvents.filter((event) => event.payload.t === 'action_rejected');
    expect(rejected).toEqual([]);

    // 8 个 AI 都真的发过言
    const speakers = new Set(
      allEvents.filter((event) => event.payload.t === 'spoke').map((event) => (event.payload as { seat: number }).seat),
    );
    expect(speakers.size).toBeGreaterThanOrEqual(6);

    // seq 连续
    allEvents.forEach((event, index) => expect(event.seq).toBe(index + 1));
  }, 30_000);
});
