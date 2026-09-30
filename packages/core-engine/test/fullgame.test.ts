import { gameEventSchema, type Action, type GameEvent, type Role, type WitchUse } from '@lrs/shared';
import { describe, expect, it } from 'vitest';
import { createGame, isOver, pendingRequest, step } from '../src/machine.ts';
import type { GameState, StepResult } from '../src/types.ts';

// ────────────────────────────── 工具 ──────────────────────────────

/** 确定性随机源：同一个种子必然得到同一局 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], rng: () => number): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('从空集合里取值');
  return item;
}

/**
 * 只会从引擎给出的 options 里挑的机器人。
 * 它产生的 Action 一定合法 —— 所以整局跑完不该出现任何 action_rejected。
 */
function botAction(state: GameState, rng: () => number): Action {
  const pending = pendingRequest(state);
  if (!pending) throw new Error(`没有待办却发现游戏未结束（阶段 ${state.phase}）`);

  const actor = pending.seat;
  const option = pick(pending.options, rng);

  switch (option.kind) {
    case 'speak':
      return { kind: 'speak', actor, text: `${actor} 号发言` };
    case 'chief_signup':
      return { kind: 'chief_signup', actor, join: rng() < 0.5 };
    case 'chief_withdraw':
      return { kind: 'chief_withdraw', actor, withdraw: rng() < 0.3 };
    case 'chief_transfer':
      return rng() < 0.8 && option.targets.length > 0
        ? { kind: 'chief_transfer', actor, target: pick(option.targets, rng) }
        : { kind: 'chief_transfer', actor, target: null };
    case 'hunter_shoot':
      return rng() < 0.7 && option.targets.length > 0
        ? { kind: 'hunter_shoot', actor, target: pick(option.targets, rng) }
        : { kind: 'hunter_shoot', actor, target: null };
    case 'witch_act': {
      const uses = (option.params?.['use'] ?? []) as WitchUse[];
      const usable = uses.filter((use) => use === 'pass' || option.targets.length > 0);
      const use = pick(usable.length > 0 ? usable : uses, rng);
      return use === 'pass'
        ? { kind: 'witch_act', actor, use }
        : { kind: 'witch_act', actor, use, target: pick(option.targets, rng) };
    }
    case 'vote':
      return option.params?.['allowAbstain']?.includes(true) && rng() < 0.15
        ? { kind: 'vote', actor, target: 'abstain' }
        : { kind: 'vote', actor, target: pick(option.targets, rng) };
    case 'guard_protect':
      return { kind: 'guard_protect', actor, target: pick(option.targets, rng) };
    case 'wolf_kill':
      return { kind: 'wolf_kill', actor, target: pick(option.targets, rng) };
    case 'seer_check':
      return { kind: 'seer_check', actor, target: pick(option.targets, rng) };
  }
}

const MAX_ACTIONS_PER_GAME = 3000;

interface Recording {
  state: GameState;
  events: GameEvent[];
  actions: Action[];
}

/** 用机器人把一整局打完 */
function playFullGame(seed: number): Recording {
  const rng = mulberry32(seed);
  let result: StepResult = createGame({ humanSeats: [1], rng });
  const events = [...result.events];
  const actions: Action[] = [];

  while (!isOver(result.state)) {
    if (actions.length > MAX_ACTIONS_PER_GAME) {
      throw new Error(`种子 ${seed} 跑了 ${MAX_ACTIONS_PER_GAME} 步还没结束，疑似死循环`);
    }
    const action = botAction(result.state, rng);
    actions.push(action);
    result = step(result.state, action);
    events.push(...result.events);
  }

  return { state: result.state, events, actions };
}

const SEEDS = [1, 7, 42, 99, 123, 777, 2024, 31337, 88888, 987654];

// ────────────────────────────── 整局跑通 ──────────────────────────────

describe('整局对局', () => {
  it.each(SEEDS)('种子 %i 能正常打完一局', (seed) => {
    const { state, events } = playFullGame(seed);

    expect(isOver(state)).toBe(true);
    expect(['wolf', 'good']).toContain(state.winner);

    const over = events.filter((e) => e.payload.t === 'game_over');
    expect(over).toHaveLength(1);
    expect(over[0]?.payload).toMatchObject({ winner: state.winner });
  });

  it.each(SEEDS)('种子 %i 全程没有非法的 Action', (seed) => {
    const { events } = playFullGame(seed);
    const rejected = events.filter((e) => e.payload.t === 'action_rejected');
    expect(rejected.map((e) => (e.payload.t === 'action_rejected' ? e.payload.reason : ''))).toEqual([]);
  });

  it.each(SEEDS)('种子 %i 的所有事件都符合契约 schema', (seed) => {
    const { events } = playFullGame(seed);
    for (const event of events) {
      const parsed = gameEventSchema.safeParse(event);
      if (!parsed.success) {
        throw new Error(`事件 seq=${event.seq} 不符合 schema：${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });

  it.each(SEEDS)('种子 %i 的 seq 严格递增且无跳号', (seed) => {
    const { events } = playFullGame(seed);
    events.forEach((event, index) => expect(event.seq).toBe(index + 1));
  });

  it.each(SEEDS)('种子 %i 亮底牌覆盖全部座位', (seed) => {
    const { state, events } = playFullGame(seed);
    const over = events.find((e) => e.payload.t === 'game_over');
    if (over?.payload.t !== 'game_over') throw new Error('缺少 game_over');

    expect(over.payload.reveal).toHaveLength(9);
    expect(over.payload.reveal.map((r) => r.seat).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 亮出的身份与引擎内部状态一致
    for (const { seat, role } of over.payload.reveal) {
      expect(state.players.find((p) => p.seat === seat)?.role).toBe(role);
    }
  });

  it('胜负判定与实际存活情况一致', () => {
    for (const seed of SEEDS) {
      const { state } = playFullGame(seed);
      const alive = state.players.filter((p) => p.death === null);
      const wolves = alive.filter((p) => p.role === 'werewolf').length;

      if (state.winner === 'good') expect(wolves).toBe(0);
      if (state.winner === 'wolf') expect(wolves).toBeGreaterThan(0);
    }
  });

  it('同一颗种子重放结果完全一致（确定性）', () => {
    const first = playFullGame(31337);
    const second = playFullGame(31337);

    expect(second.actions).toEqual(first.actions);
    expect(second.events).toEqual(first.events);
    expect(second.state.winner).toBe(first.state.winner);
  });

  it('不同种子会走出不同的对局', () => {
    const a = playFullGame(1);
    const b = playFullGame(42);
    expect(a.actions).not.toEqual(b.actions);
  });

  it('随机打满 40 局全部正常结束', () => {
    const winners = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const { state } = playFullGame(seed);
      expect(isOver(state)).toBe(true);
      winners.add(state.winner!);
    }
    expect(winners.size).toBeGreaterThan(0);
  });
});

// ────────────────────────────── 手写黄金用例 ──────────────────────────────

/** 1 民 · 2 狼 · 3 预言家 · 4 女巫 · 5 猎人 · 6 守卫 · 7 狼 · 8 民 · 9 狼 */
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

function play(seedResult: StepResult, actions: Action[]): Recording {
  let state = seedResult.state;
  const events = [...seedResult.events];
  for (const action of actions) {
    const next = step(state, action);
    state = next.state;
    events.push(...next.events);
  }
  return { state, events, actions };
}

describe('黄金用例：首夜 → 竞选平票 PK → 当选 → 公布死讯 → 遗言', () => {
  function scriptedDayOne() {
    const actions: Action[] = [
      // 首夜：守卫守 5，狼刀 3（预言家），女巫不用药，预言家验 9（狼）
      { kind: 'guard_protect', actor: 6, target: 5 },
      { kind: 'wolf_kill', actor: 2, target: 3 },
      { kind: 'witch_act', actor: 4, use: 'pass' },
      { kind: 'seer_check', actor: 3, target: 9 },
      // 上警：1、2、3 上警；3 号是首夜死者，死讯未公布所以照常上警
      ...[1, 2, 3].map((actor) => ({ kind: 'chief_signup', actor, join: true }) as Action),
      ...[4, 5, 6, 7, 8, 9].map((actor) => ({ kind: 'chief_signup', actor, join: false }) as Action),
      // 竞选发言
      ...[1, 2, 3].map((actor) => ({ kind: 'speak', actor, text: `${actor} 号竞选发言` }) as Action),
      // 都不退水
      ...[1, 2, 3].map((actor) => ({ kind: 'chief_withdraw', actor, withdraw: false }) as Action),
      // 警下投票 3:3 平票
      { kind: 'vote', actor: 4, target: 1 },
      { kind: 'vote', actor: 5, target: 1 },
      { kind: 'vote', actor: 6, target: 1 },
      { kind: 'vote', actor: 7, target: 2 },
      { kind: 'vote', actor: 8, target: 2 },
      { kind: 'vote', actor: 9, target: 2 },
      // PK 发言
      { kind: 'speak', actor: 1, text: '1 号 PK 发言' },
      { kind: 'speak', actor: 2, text: '2 号 PK 发言' },
      // PK 再投：1 号压倒性当选
      { kind: 'vote', actor: 4, target: 1 },
      { kind: 'vote', actor: 5, target: 1 },
      { kind: 'vote', actor: 6, target: 1 },
      { kind: 'vote', actor: 7, target: 1 },
      { kind: 'vote', actor: 8, target: 1 },
      { kind: 'vote', actor: 9, target: 1 },
      // 公布死讯后，3 号留遗言
      { kind: 'speak', actor: 3, text: '3 号遗言' },
    ];
    return play(createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] }), actions);
  }

  it('走完竞选与遗言后进入白天发言，且轮到 2 号', () => {
    const { state } = scriptedDayOne();
    expect(state.phase).toBe('DAY_SPEECH');
    expect(pendingRequest(state)?.seat).toBe(2);
  });

  it('1 号当选警长', () => {
    const { state, events } = scriptedDayOne();
    expect(state.chief.elected).toBe(1);
    expect(state.players.find((p) => p.seat === 1)?.isChief).toBe(true);

    const tallies = events.filter((e) => e.payload.t === 'chief_vote_tally');
    expect(tallies[0]?.payload).toMatchObject({ elected: null, tie: true });
    expect(tallies[1]?.payload).toMatchObject({ elected: 1, tie: false });
  });

  it('首夜死者 3 号：先参与竞选，后被公布死讯，再留遗言', () => {
    const { state, events } = scriptedDayOne();

    const signupEvents = events.filter((e) => e.payload.t === 'phase_changed' && e.payload.to === 'CHIEF_SIGNUP');
    const diedEvent = events.find((e) => e.payload.t === 'died');
    const spokeEvents = events.filter((e) => e.payload.t === 'spoke');

    expect(signupEvents).toHaveLength(1);
    // 死因对外是 null：夜里被刀的，天亮只公布「谁出局了」。
    // 真实原因在 state 里（player.death.cause），上帝视角与复盘才看得到。
    expect(diedEvent?.payload).toMatchObject({ seat: 3, cause: null });
    expect(state.players.find((p) => p.seat === 3)?.death?.cause).toBe('wolf');
    // 3 号的竞选发言排在死讯之前
    expect(events.indexOf(signupEvents[0]!)).toBeLessThan(events.indexOf(diedEvent!));

    const lastWords = spokeEvents.filter((e) => e.payload.t === 'spoke' && e.payload.context === 'last_words');
    expect(lastWords).toHaveLength(1);
    expect(lastWords[0]?.payload).toMatchObject({ seat: 3 });

    expect(state.players.find((p) => p.seat === 3)?.deathAnnounced).toBe(true);
  });

  it('预言家验到 9 号是狼', () => {
    const { events } = scriptedDayOne();
    const seerResult = events.find((e) => e.payload.t === 'seer_result');
    expect(seerResult?.payload).toMatchObject({ seat: 3, target: 9, camp: 'wolf' });
  });

  it('第一天的竞选阶段排在夜晚之后、公布死讯之前', () => {
    const { events } = scriptedDayOne();
    const seqOf = (predicate: (e: GameEvent) => boolean) => events.find(predicate)?.seq ?? -1;

    const firstNight = seqOf((e) => e.payload.t === 'phase_changed' && e.payload.to === 'NIGHT_GUARD');
    const signup = seqOf((e) => e.payload.t === 'phase_changed' && e.payload.to === 'CHIEF_SIGNUP');
    const dawn = seqOf((e) => e.payload.t === 'phase_changed' && e.payload.to === 'DAWN_ANNOUNCE');
    const daySpeech = seqOf((e) => e.payload.t === 'phase_changed' && e.payload.to === 'DAY_SPEECH');

    expect(firstNight).toBeGreaterThan(0);
    expect(firstNight).toBeLessThan(signup);
    expect(signup).toBeLessThan(dawn);
    expect(dawn).toBeLessThan(daySpeech);
  });
});
