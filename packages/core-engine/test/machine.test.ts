import type { Action, GameEvent, Phase, Role } from '@lrs/shared';
import { describe, expect, it } from 'vitest';
import { choicesFor } from '../src/choices.ts';
import { beatNightStep, createGame, isOver, pendingRequest, step } from '../src/machine.ts';
import { guardOptions, onBoardSeats, playerAt, witchOptions } from '../src/options.ts';
import type { EngineConfig, GameState, StepResult } from '../src/types.ts';

/**
 * 固定发牌，让每个座位的身份可预测：
 *   1 民(真人) · 2 狼 · 3 预言家 · 4 女巫 · 5 猎人 · 6 守卫 · 7 狼 · 8 民 · 9 狼
 */
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

const SEER = 3;
const WITCH = 4;
const GUARD = 6;
const WOLF_REP = 2;

function newGame(overrides: Partial<EngineConfig> = {}): StepResult {
  return createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1], ...overrides });
}

function run(start: StepResult, actions: Action[]): { state: GameState; events: GameEvent[] } {
  let current = start;
  const events = [...start.events];
  for (const action of actions) {
    current = step(current.state, action);
    events.push(...current.events);
  }
  return { state: current.state, events };
}

function payloads<T extends GameEvent['payload']['t']>(events: GameEvent[], t: T) {
  return events.filter((e) => e.payload.t === t).map((e) => e.payload as Extract<GameEvent['payload'], { t: T }>);
}

/** 走完首夜：守卫守 guardTarget，狼刀 wolfTarget，女巫用 witchUse，预言家验 seerTarget */
function firstNight(options: {
  guardTarget: number;
  wolfTarget: number;
  witchAction: Action;
  seerTarget: number;
}) {
  return [
    { kind: 'guard_protect', actor: GUARD, target: options.guardTarget },
    { kind: 'wolf_kill', actor: WOLF_REP, target: options.wolfTarget },
    options.witchAction,
    { kind: 'seer_check', actor: SEER, target: options.seerTarget },
  ] satisfies Action[];
}

describe('开局', () => {
  it('产出 game_started / role_assigned / wolf_teammates', () => {
    const { events } = newGame();
    expect(payloads(events, 'game_started')).toHaveLength(1);
    expect(payloads(events, 'role_assigned')).toHaveLength(9);
    expect(payloads(events, 'wolf_teammates')).toHaveLength(3);
  });

  it('身份与狼队友是私密事件，其余人看不到', () => {
    const { events } = newGame();
    for (const event of events.filter((e) => e.payload.t === 'role_assigned')) {
      expect(event.visibility.scope).toBe('seats');
    }
    const mates = payloads(events, 'wolf_teammates');
    const seat3 = mates.find((m) => m.seat === 3);
    expect(seat3).toBeUndefined();
    expect(mates.find((m) => m.seat === WOLF_REP)?.mates.sort()).toEqual([7, 9]);
  });

  it('seq 从 1 开始单调递增', () => {
    const { events } = newGame();
    expect(events[0]?.seq).toBe(1);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('第一个待办是守卫行动', () => {
    const result = newGame();
    expect(result.state.phase).toBe('NIGHT_GUARD');
    expect(pendingRequest(result.state)?.seat).toBe(GUARD);
    expect(pendingRequest(result.state)?.options[0]?.kind).toBe('guard_protect');
  });

  it('开局事件发生在 SETUP 阶段，随后才切到夜晚', () => {
    const { events } = newGame();
    expect(events[0]?.phase).toBe('SETUP');
    expect(payloads(events, 'phase_changed')[0]).toMatchObject({ from: 'SETUP', to: 'NIGHT_GUARD' });
  });

  it('板子非法时直接抛错', () => {
    expect(() => newGame({ fixedRoles: ['villager'] })).toThrow(/身份牌数量/);
  });
});

describe('夜晚阶段顺序与选项合法性', () => {
  it('顺序固定为 守卫 → 狼人 → 女巫 → 预言家', () => {
    let result = newGame();
    const asked: number[] = [pendingRequest(result.state)!.seat];

    result = step(result.state, { kind: 'guard_protect', actor: GUARD, target: SEER });
    asked.push(pendingRequest(result.state)!.seat);

    result = step(result.state, { kind: 'wolf_kill', actor: WOLF_REP, target: SEER });
    asked.push(pendingRequest(result.state)!.seat);

    result = step(result.state, { kind: 'witch_act', actor: WITCH, use: 'pass' });
    asked.push(pendingRequest(result.state)!.seat);

    expect(asked).toEqual([GUARD, WOLF_REP, WITCH, SEER]);
  });

  it('守卫的候选目标是所有存活玩家（默认允许自守）', () => {
    const result = newGame();
    expect(guardOptions(result.state, GUARD)[0]?.targets).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('规则禁止自守时，守卫的候选目标不含自己', () => {
    const result = newGame({ rules: { guardCanSelfProtect: false } });
    expect(guardOptions(result.state, GUARD)[0]?.targets).not.toContain(GUARD);
  });

  it('守卫连守被排除', () => {
    const result = newGame();
    const stateWithHistory: GameState = { ...result.state, lastNightGuardTarget: 5 };
    expect(guardOptions(stateWithHistory, GUARD)[0]?.targets).not.toContain(5);
  });

  it('预言家的候选目标不含自己', () => {
    let result = newGame();
    result = step(result.state, { kind: 'guard_protect', actor: GUARD, target: 1 });
    result = step(result.state, { kind: 'wolf_kill', actor: WOLF_REP, target: 1 });
    result = step(result.state, { kind: 'witch_act', actor: WITCH, use: 'pass' });

    const options = pendingRequest(result.state)!.options;
    expect(options[0]?.targets).not.toContain(SEER);
    expect(options[0]?.targets).toContain(WOLF_REP);
  });

  it('女巫默认不能自救：被刀时选项里没有解药', () => {
    let result = newGame();
    result = step(result.state, { kind: 'guard_protect', actor: GUARD, target: 1 });
    result = step(result.state, { kind: 'wolf_kill', actor: WOLF_REP, target: WITCH });

    const options = witchOptions(result.state, WITCH);
    expect(options.map((o) => o.params?.['use'])).toEqual([['poison'], ['pass']]);
  });

  it('允许自救时，被刀的女巫可以救自己', () => {
    let result = newGame({ rules: { witchCanSelfSave: true } });
    result = step(result.state, { kind: 'guard_protect', actor: GUARD, target: 1 });
    result = step(result.state, { kind: 'wolf_kill', actor: WOLF_REP, target: WITCH });

    expect(witchOptions(result.state, WITCH).map((o) => o.params?.['use'])).toEqual([
      ['save'],
      ['poison'],
      ['pass'],
    ]);
  });

  it('女巫收到本夜被刀对象（私密）', () => {
    const { events } = run(
      newGame(),
      firstNight({ guardTarget: 5, wolfTarget: SEER, witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' }, seerTarget: 7 }),
    );
    const info = payloads(events, 'witch_night_info');
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ seat: WITCH, killed: SEER });
    expect(events.find((e) => e.payload.t === 'witch_night_info')?.visibility).toEqual({
      scope: 'seats',
      seats: [WITCH],
    });
  });

  it('预言家的验人结果只发给预言家', () => {
    const { events } = run(
      newGame(),
      firstNight({ guardTarget: 5, wolfTarget: 5, witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' }, seerTarget: 7 }),
    );
    const result = payloads(events, 'seer_result');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seat: SEER, target: 7, camp: 'wolf' });
    expect(events.find((e) => e.payload.t === 'seer_result')?.visibility).toEqual({
      scope: 'seats',
      seats: [SEER],
    });
  });
});

describe('非法 Action 被拒绝但不影响状态', () => {
  it('行动者与当前待办不符时被拒', () => {
    const result = newGame();
    const after = step(result.state, { kind: 'guard_protect', actor: 1, target: 2 });

    expect(payloads(after.events, 'action_rejected')).toHaveLength(1);
    expect(pendingRequest(after.state)?.seat).toBe(GUARD);
    expect(after.state.phase).toBe('NIGHT_GUARD');
  });

  it('目标不在合法选项内时被拒', () => {
    const result = newGame();
    const after = step(result.state, { kind: 'guard_protect', actor: GUARD, target: 99 });
    expect(payloads(after.events, 'action_rejected')[0]?.reason).toContain('99 号不是合法目标');
  });

  it('阶段不接受该 kind 时被拒', () => {
    const result = newGame();
    const after = step(result.state, { kind: 'vote', actor: GUARD, target: 2 });
    expect(payloads(after.events, 'action_rejected')[0]?.reason).toContain('当前阶段不接受');
  });

  it('被拒后可以继续提交合法 Action', () => {
    const result = newGame();
    step(result.state, { kind: 'guard_protect', actor: GUARD, target: 99 });
    const ok = step(result.state, { kind: 'guard_protect', actor: GUARD, target: 3 });
    expect(pendingRequest(ok.state)?.seat).toBe(WOLF_REP);
  });
});

describe('夜间固定节拍', () => {
  const BEAT = { rules: { nightStepMs: 1000 } };

  /** 有行动就行动、该敲节拍就敲，一路推到离开夜晚 */
  function driveNight(start: StepResult, limit = 60) {
    let current = start;
    const events = [...start.events];
    for (let i = 0; i < limit && current.state.phase.startsWith('NIGHT_'); i += 1) {
      const pending = pendingRequest(current.state);
      if (pending) {
        current = step(current.state, choicesFor(pending)[0]!.action);
      } else if (current.state.nightBeat === 'open') {
        current = beatNightStep(current.state);
      } else {
        break;
      }
      events.push(...current.events);
    }
    const phases = events
      .filter((e) => e.payload.t === 'phase_changed')
      .map((e) => (e.payload as { to: Phase }).to)
      .filter((phase) => phase.startsWith('NIGHT_'));
    return { state: current.state, events, phases };
  }

  it('行动不换步：提交之后原地等「到点了」', () => {
    const game = newGame(BEAT);
    expect(game.state.phase).toBe('NIGHT_GUARD');
    expect(pendingRequest(game.state)?.seat).toBe(GUARD);

    const acted = step(game.state, { kind: 'guard_protect', actor: GUARD, target: 1 });
    expect(acted.state.phase, '提交了也还停在这一步').toBe('NIGHT_GUARD');
    expect(acted.state.nightBeat).toBe('open');

    const beaten = beatNightStep(acted.state);
    expect(beaten.state.phase).toBe('NIGHT_WOLF');
  });

  it('这一步没人动（超时）也照样到点换步', () => {
    const game = newGame(BEAT);
    expect(pendingRequest(game.state)?.seat).toBe(GUARD);

    const beaten = beatNightStep(game.state);
    expect(beaten.state.phase).toBe('NIGHT_WOLF');
  });

  it('四步永远都走：一夜固定是守卫 → 狼人 → 女巫 → 预言家', () => {
    const { state, phases } = driveNight(newGame(BEAT));

    expect(phases).toEqual(['NIGHT_GUARD', 'NIGHT_WOLF', 'NIGHT_WITCH', 'NIGHT_SEER']);
    expect(state.phase.startsWith('NIGHT_')).toBe(false);
  });

  it('角色出局也照走那一步，只是没人行动', () => {
    // 板子里没有守卫、也没有女巫
    const noGuardWitch: Role[] = [
      'villager',
      'werewolf',
      'seer',
      'villager',
      'hunter',
      'villager',
      'werewolf',
      'villager',
      'werewolf',
    ];
    const game = createGame({
      fixedRoles: noGuardWitch,
      humanSeats: [1],
      rules: { nightStepMs: 1000 },
    });

    expect(game.state.phase).toBe('NIGHT_GUARD');
    expect(pendingRequest(game.state), '这一步没人在，谁都不问').toBeNull();
    expect(game.state.nightBeat).toBe('open');

    const { phases } = driveNight(game);
    expect(phases, '没人也照样占满这两步').toEqual([
      'NIGHT_GUARD',
      'NIGHT_WOLF',
      'NIGHT_WITCH',
      'NIGHT_SEER',
    ]);
  });

  it('关掉节拍时还是老行为：一提交就换步', () => {
    const game = newGame();
    expect(game.state.nightBeat).toBe('idle');

    const acted = step(game.state, { kind: 'guard_protect', actor: GUARD, target: 1 });
    expect(acted.state.phase).toBe('NIGHT_WOLF');
  });
});

describe('夜晚结算', () => {
  it('守卫守中狼刀目标 → 平安夜', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: SEER,
        wolfTarget: SEER,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' },
        seerTarget: 7,
      }),
    );
    expect(playerAt(state, SEER).death).toBeNull();
    expect(state.night.deaths).toEqual([]);
  });

  it('女巫救中狼刀目标 → 免死，且解药减一', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: 1,
        wolfTarget: SEER,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'save', target: SEER },
        seerTarget: 7,
      }),
    );
    expect(playerAt(state, SEER).death).toBeNull();
    expect(state.witchPotions).toEqual({ antidote: 0, poison: 1 });
  });

  it('同守同救 → 该玩家死亡（奶穿）', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: SEER,
        wolfTarget: SEER,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'save', target: SEER },
        seerTarget: 7,
      }),
    );
    expect(playerAt(state, SEER).death).toMatchObject({ cause: 'wolf', day: 1 });
    expect(state.night.deaths).toEqual([SEER]);
  });

  it('无人保护 → 被刀者死亡', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: 1,
        wolfTarget: 8,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' },
        seerTarget: 7,
      }),
    );
    expect(playerAt(state, 8).death).toMatchObject({ cause: 'wolf' });
  });

  it('毒药带走目标，且记为 poison（决定猎人能否开枪）', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: 1,
        wolfTarget: 8,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'poison', target: 5 },
        seerTarget: 7,
      }),
    );
    expect(playerAt(state, 5).death).toMatchObject({ cause: 'poison' });
    expect(state.witchPotions).toEqual({ antidote: 1, poison: 0 });
    expect(new Set(state.night.deaths)).toEqual(new Set([8, 5]));
  });

  it('夜晚结束后死讯尚未公布（留给天亮环节）', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: 1,
        wolfTarget: 8,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' },
        seerTarget: 7,
      }),
    );
    expect(playerAt(state, 8).deathAnnounced).toBe(false);
  });
});

describe('第 1 天：警长竞选（变体 A）', () => {
  it('首夜结束后先进入上警报，而不是直接公布死讯', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: 1,
        wolfTarget: 8,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' },
        seerTarget: 7,
      }),
    );
    expect(state.phase).toBe('CHIEF_SIGNUP');
    expect(pendingRequest(state)?.seat).toBe(1);
    expect(pendingRequest(state)?.options[0]?.kind).toBe('chief_signup');
  });

  it('首夜死者照常参与上警（死讯未公布）', () => {
    const { state } = run(
      newGame(),
      firstNight({
        guardTarget: 1,
        wolfTarget: SEER,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' },
        seerTarget: 7,
      }),
    );
    expect(playerAt(state, SEER).death).not.toBeNull();
    expect(onBoardSeats(state)).toContain(SEER);
  });

  it('上警按座位号依次询问，并记录上警名单', () => {
    let result = run(
      newGame(),
      firstNight({
        guardTarget: 1,
        wolfTarget: 8,
        witchAction: { kind: 'witch_act', actor: WITCH, use: 'pass' },
        seerTarget: 7,
      }),
    );

    result = { state: step(result.state, { kind: 'chief_signup', actor: 1, join: true }).state, events: [] };
    expect(pendingRequest(result.state)?.seat).toBe(2);
    expect(result.state.chief.candidates).toEqual([1]);

    const after = step(result.state, { kind: 'chief_signup', actor: 2, join: false });
    expect(pendingRequest(after.state)?.seat).toBe(3);
    expect(after.state.chief.candidates).toEqual([1]);
  });

  it('游戏尚未结束', () => {
    const { state } = newGame();
    expect(isOver(state)).toBe(false);
  });
});
