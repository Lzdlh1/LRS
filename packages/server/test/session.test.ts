import type { AgentHost } from '@lrs/agent-host';
import { choicesFor, type PendingRequest, type Viewer } from '@lrs/core-engine';
import { createLogger, nullSink, type Action, type GameEvent, type SeatId } from '@lrs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientState, ReplayPayload, ServerMessage, UsageReport } from '../src/session/protocol.ts';
import { GameRoom, type AgentHostFactory } from '../src/session/room.ts';
import { openDatabase } from '../src/store/db.ts';
import { GameStore, type UsageRecord } from '../src/store/gameStore.ts';

const logger = createLogger('test', nullSink, 'error');

/** 带状态的两种消息（流式片段不带状态） */
type StateMessage = Extract<ServerMessage, { type: 'snapshot' | 'update' }>;

const isStateMessage = (message: ServerMessage): message is StateMessage =>
  message.type === 'snapshot' || message.type === 'update';

interface Collector {
  messages: ServerMessage[];
  streams: string[];
  subscribe: (room: GameRoom, id: string, viewer: Viewer) => void;
  last: () => StateMessage;
  state: () => ClientState;
}

function collector(): Collector {
  const messages: ServerMessage[] = [];
  const streams: string[] = [];
  return {
    messages,
    streams,
    subscribe: (room, id, viewer) => {
      room.subscribe({
        id,
        viewer,
        send: (message) => {
          messages.push(message);
          if (message.type === 'stream') streams.push(message.delta);
        },
      });
    },
    last: () => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (isStateMessage(message)) return message;
      }
      throw new Error('还没有收到状态');
    },
    state: () => collectorState(messages),
  };
}

function collectorState(messages: ServerMessage[]): ClientState {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isStateMessage(message)) return message.state;
  }
  throw new Error('还没有收到状态');
}

const rooms: GameRoom[] = [];

function makeRoom(seed = 2024): { room: GameRoom; store: GameStore } {
  const db = openDatabase(':memory:');
  const store = new GameStore(db);
  const room = new GameRoom({ logger, store, id: 'room-1' });
  room.newGame(seed);
  rooms.push(room);
  return { room, store };
}

afterEach(() => {
  for (const room of rooms.splice(0)) room.dispose();
  vi.useRealTimers();
});

describe('随机位次', () => {
  it('每局重抽座位，下发的状态里带着这一局的座位', () => {
    const room = new GameRoom({ logger, store: null });
    rooms.push(room);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    const seen = new Set<SeatId>();
    for (let i = 0; i < 40; i += 1) {
      seen.add(room.humanSeatId);
      room.newGame();
    }

    expect(seen.size, `40 局只抽到过 ${[...seen].join('/')} 号，位次没有在随机`).toBeGreaterThan(1);
    for (const seat of seen) {
      expect(seat).toBeGreaterThanOrEqual(1);
      expect(seat).toBeLessThanOrEqual(9);
    }

    const state = god.state();
    expect(state.humanSeat).toBe(room.humanSeatId);
    expect(state.seats.find((seat) => seat.seat === room.humanSeatId)?.isHuman).toBe(true);
  });

  it('固定种子依然能复现：同一种子抽到同一座位', () => {
    const a = new GameRoom({ logger, store: null, id: 'a' });
    const b = new GameRoom({ logger, store: null, id: 'b' });
    rooms.push(a, b);
    a.newGame(2468);
    b.newGame(2468);
    expect(a.humanSeatId).toBe(b.humanSeatId);
  });
});

describe('信息裁剪', () => {
  it('上帝视角能看到全部身份与药水', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');

    const state = god.state();
    expect(state.seats).toHaveLength(9);
    expect(state.seats.every((seat) => seat.role !== null)).toBe(true);
    expect(state.witchPotions).not.toBeNull();
    expect(state.pending?.options.length).toBeGreaterThan(0);
  });

  it('玩家视角看不到别人的身份，只看得到自己的', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');

    const witchSeat = god.state().seats.find((seat) => seat.role === 'witch')!.seat;
    const me = witchSeat === 1 ? 2 : 1;

    const player = collector();
    player.subscribe(room, 'player', me);

    const state = player.state();
    expect(state.seats.find((seat) => seat.seat === me)?.role).not.toBeNull();
    for (const seat of state.seats.filter((s) => s.seat !== me)) {
      expect(seat.role).toBeNull();
    }
  });

  it('药水只有女巫本人与上帝看得到', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const witchSeat = god.state().seats.find((seat) => seat.role === 'witch')!.seat;

    const witch = collector();
    witch.subscribe(room, 'witch', witchSeat);
    expect(witch.state().witchPotions).not.toBeNull();

    const other = collector();
    other.subscribe(room, 'other', witchSeat === 5 ? 4 : 5);
    expect(other.state().witchPotions).toBeNull();
  });

  it('白天看得到轮到谁，但看不到别人能做什么', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');

    // 推到白天投票：夜间「轮到谁」是保密的，由另一个测试覆盖
    for (let i = 0; i < 200; i += 1) {
      // 重大信息要真人确认，这一步不能省（否则房间会停在那里）
      if (god.state().ackSeq.length > 0) {
        room.handleMessage('god', { type: 'resume' });
        continue;
      }
      const current = god.state().pending;
      if (!current || god.state().winner !== null) break;
      if (current.options[0]?.kind === 'vote') break;
      const action = driveAction(current);
      if (!action) break;
      room.submit(action, 'client');
    }

    const pending = god.state().pending;
    expect(pending?.options[0]?.kind).toBe('vote');

    const actor = pending!.seat;
    const bystander = actor === 1 ? 2 : 1;

    const player = collector();
    player.subscribe(room, 'player', bystander);

    const state = player.state();
    expect(state.masked).toBe(false);
    // 看得到轮到谁，但看不到他能做什么
    expect(state.pending?.seat).toBe(actor);
    expect(state.pending?.options).toEqual([]);

    const actorView = collector();
    actorView.subscribe(room, 'actor', actor);
    expect(actorView.state().pending?.options.length).toBeGreaterThan(0);
  });

  it('玩家视角的事件流里没有别人的身份事件', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const witchSeat = god.state().seats.find((seat) => seat.role === 'witch')!.seat;
    const me = witchSeat === 1 ? 2 : 1;

    const player = collector();
    player.subscribe(room, 'player', me);

    const snapshot = player.last() as Extract<StateMessage, { type: 'snapshot' }>;
    const roleEvents = snapshot.events.filter((event) => event.payload.t === 'role_assigned');
    expect(roleEvents).toHaveLength(1);
    expect(roleEvents[0]?.payload).toMatchObject({ seat: me });

    expect(snapshot.events.some((event) => event.payload.t === 'wolf_teammates')).toBe(
      god.state().seats.find((seat) => seat.seat === me)!.role === 'werewolf',
    );
  });

  it('切换视角会补发一份新的快照', () => {
    const { room } = makeRoom();
    const player = collector();
    player.subscribe(room, 'player', 1);
    expect(player.state().viewer).toBe(1);

    room.setViewer('player', 'god');
    expect(player.state().viewer).toBe('god');
    expect(player.state().seats.every((seat) => seat.role !== null)).toBe(true);
  });
});

describe('行动提交', () => {
  it('非法 Action 被广播为 action_rejected，且状态不前进', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const before = god.state();
    const actor = before.pending!.seat;

    room.submit({ kind: 'vote', actor, target: 2 });

    const after = god.state();
    expect(after.pending?.seat).toBe(actor);
    expect(after.phase).toBe(before.phase);

    const update = god.last() as Extract<StateMessage, { type: 'update' }>;
    expect(update.events.some((event) => event.payload.t === 'action_rejected')).toBe(true);
  });

  it('合法 Action 会推进阶段', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const before = god.state();
    const actor = before.pending!.seat;
    const option = before.pending!.options[0]!;

    if (option.kind !== 'guard_protect') throw new Error('首夜第一手应当是守卫');
    room.submit({ kind: 'guard_protect', actor, target: option.targets[0]! });

    const after = god.state();
    expect(after.pending?.seat).not.toBe(actor);
    expect(after.lastSeq).toBeGreaterThan(before.lastSeq);
  });

  it('超时后自动提交兜底动作并继续推进', () => {
    vi.useFakeTimers();
    const { room } = makeRoom(777);
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const actor = god.state().pending!.seat;
    const seqBefore = god.state().lastSeq;

    vi.advanceTimersByTime(10 * 60 * 1000);

    const after = god.state();
    expect(after.lastSeq).toBeGreaterThan(seqBefore);
    expect(after.pending?.seat).not.toBe(actor);
  });

  it('没人看着的时候不推进 —— 闲置的服务不该自己把整局打完', () => {
    vi.useFakeTimers();
    const { room } = makeRoom(777);

    const god = collector();
    god.subscribe(room, 'god', 'god');
    const seqBefore = god.state().lastSeq;
    room.unsubscribe('god');

    // 十分钟过去了，局面上应该一动不动
    vi.advanceTimersByTime(10 * 60 * 1000);

    const back = collector();
    back.subscribe(room, 'back', 'god');
    expect(back.state().lastSeq).toBe(seqBefore);
  });

  it('调试面板可以连续代打把整局跑完', () => {
    const { room } = makeRoom(31337);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    for (let i = 0; i < 400 && god.state().winner === null; i += 1) room.autoPlay(1);

    const state = god.state();
    expect(state.winner).not.toBeNull();
    expect(state.pending).toBeNull();
  });
});

describe('持久化与重开', () => {
  it('事件会被落库，且可以按 seq 读回', () => {
    const { room, store } = makeRoom(99);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    const total = store.countEvents(room.gameId);
    expect(total).toBeGreaterThan(0);

    const events = store.listEvents(room.gameId);
    expect(events).toHaveLength(total);
    expect(events[0]?.seq).toBe(1);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.seq).toBe(events[i - 1]!.seq + 1);
    }
  });

  it('重开一局会换新的 gameId 并重新广播快照', () => {
    const { room } = makeRoom(1);
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const firstGameId = room.gameId;
    const messagesBefore = god.messages.length;

    room.newGame(2);

    expect(room.gameId).not.toBe(firstGameId);
    expect(god.messages.length).toBeGreaterThan(messagesBefore);
    expect(god.state().lastSeq).toBeGreaterThan(0);
    expect(god.state().winner).toBeNull();
  });
});

describe('玩家视角的信息边界', () => {
  /** 一路推到上警阶段（此时首夜死讯按变体 A 还没公布） */
  function advanceToChiefSignup(room: GameRoom, god: Collector): void {
    god.subscribe(room, 'god', 'god');
    for (let i = 0; i < 60; i += 1) {
      const pending = god.state().pending;
      if (!pending || pending.options[0]?.kind === 'chief_signup') break;
      const action = driveAction(pending);
      if (!action) break;
      room.submit(action, 'client');
    }
  }

  it('夜间旁观者看不到「轮到谁」—— 否则夜间顺序 + 座位号就是身份', () => {
    const { room } = makeRoom(2024);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    const pending = god.state().pending;
    expect(pending).not.toBeNull();
    expect(god.state().phase.startsWith('NIGHT_')).toBe(true);

    const actor = pending!.seat;
    const bystander = pending!.options[0]!.targets.find((seat) => seat !== actor)!;

    const spy = collector();
    spy.subscribe(room, 'spy', bystander);
    expect(spy.state().masked).toBe(true);
    expect(spy.state().pending).toBeNull();

    // 行动者本人与上帝视角照常看得到
    const self = collector();
    self.subscribe(room, 'self', actor);
    expect(self.state().masked).toBe(false);
    expect(self.state().pending?.seat).toBe(actor);

    expect(god.state().masked).toBe(false);
    expect(god.state().pending?.seat).toBe(actor);
  });

  it('首夜死讯公布之前，玩家视角仍然把死者当作在场', () => {
    const { room } = makeRoom(2024);
    const god = collector();
    advanceToChiefSignup(room, god);

    const godView = god.state();
    expect(godView.phase).toBe('CHIEF_SIGNUP');
    const deadSeats = godView.seats.filter((seat) => !seat.alive).map((seat) => seat.seat);
    expect(deadSeats.length, '首夜应该有人出局').toBeGreaterThan(0);

    // 上帝视角看得到死亡与死因
    const victim = godView.seats.find((seat) => seat.seat === deadSeats[0]!);
    expect(victim?.deathCause).not.toBeNull();

    // 玩家视角看不到 —— 变体 A 下首夜死者此时还要照常上警
    const bystander = godView.seats.find((seat) => seat.alive && seat.seat !== 1)!.seat;
    const player = collector();
    player.subscribe(room, 'player', bystander);

    const seen = player.state().seats.find((seat) => seat.seat === deadSeats[0]!);
    expect(seen?.alive, '死讯未公布前，别人看到的他应该是活着的').toBe(true);
    expect(seen?.deathCause).toBeNull();
  });
});

describe('复盘', () => {
  /** 假 AI：只负责产出动作并回报一条决策，用来验证复盘链路 */
  function replayFactory(): AgentHostFactory {
    return ({ onDecision, humanSeat }) =>
      ({
        observe: (): void => {},
        handles: (seat: SeatId): boolean => seat !== humanSeat,
        act: async (_state: unknown, pending: PendingRequest): Promise<Action> => {
          onDecision({
            seat: pending.seat,
            kind: pending.options[0]?.kind ?? '?',
            reasoning: `${pending.seat} 号的假推理`,
            stance: '假立场',
            push: null,
            mood: 'calm',
            claim: null,
          });
          const choice = choicesFor(pending)[0];
          return choice?.action ?? { kind: 'speak', actor: pending.seat, text: '（假 AI）发言' };
        },
      }) as unknown as AgentHost;
  }

  function lastReplay(target: Collector): ReplayPayload {
    for (let i = target.messages.length - 1; i >= 0; i -= 1) {
      const message = target.messages[i]!;
      if (message.type === 'replay') return message.payload;
    }
    throw new Error('没有收到复盘数据');
  }

  it('局中封存推理依据与底牌，事件仍按视角裁剪', async () => {
    const room = new GameRoom({ logger, store: null, hostFactory: replayFactory() });
    rooms.push(room);

    const god = collector();
    god.subscribe(room, 'god', 'god');

    // 只走两步：让 AI 真的产生决策，同时保证这局还没打完 —— 局中才谈得上「封存」
    let humanTurns = 0;
    for (let i = 0; i < 60 && humanTurns < 2; i += 1) {
      const pending = god.state().pending;
      if (!pending) break;
      if (pending.seat === room.humanSeatId) {
        const action = driveAction(pending);
        if (!action) break;
        room.submit(action, 'client');
        humanTurns += 1;
      }
      await sleep(15);
    }
    expect(god.state().winner, '这一步之后对局应该还在进行中').toBeNull();

    // 上帝视角：解封，且能拿到 9 张底牌
    room.handleMessage('god', { type: 'replay', day: 1 });
    const godPayload = lastReplay(god);
    expect(godPayload.sealed).toBe(false);
    expect(godPayload.roles).toHaveLength(9);
    expect(godPayload.decisions.length).toBeGreaterThan(0);

    // 玩家视角：事件只剩自己该看的，推理与底牌一律封存
    const player = collector();
    player.subscribe(room, 'player', 1);
    room.handleMessage('player', { type: 'replay', day: 1 });

    const payload = lastReplay(player);
    expect(payload.sealed).toBe(true);
    expect(payload.roles).toBeNull();
    expect(payload.decisions).toEqual([]);
    expect(payload.days).toContain(1);

    const roleEvents = payload.events.filter((event) => event.payload.t === 'role_assigned');
    expect(roleEvents, '玩家视角只该看到自己的身份事件').toHaveLength(1);
  });

  it('本局结束后解封，但玩家视角依旧只看得到自己的私密事件', () => {
    const { room } = makeRoom(31337);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    for (let i = 0; i < 400 && god.state().winner === null; i += 1) room.autoPlay(1);
    expect(god.state().winner).not.toBeNull();

    const player = collector();
    player.subscribe(room, 'player', 1);
    room.handleMessage('player', { type: 'replay', day: 1 });

    const payload = lastReplay(player);
    expect(payload.sealed).toBe(false);
    expect(payload.roles).toHaveLength(9);
    expect(payload.events.filter((event) => event.payload.t === 'role_assigned')).toHaveLength(1);
  });
});

describe('用量看板', () => {
  function lastUsage(target: Collector): UsageReport {
    for (let i = target.messages.length - 1; i >= 0; i -= 1) {
      const message = target.messages[i]!;
      if (message.type === 'usage') return message.payload;
    }
    throw new Error('没有收到用量数据');
  }

  const usage = (gameId: string, task: string, model: string, cost: number): UsageRecord => ({
    gameId,
    task,
    tier: 'cheap',
    provider: 'deepseek',
    model,
    inTokens: 1000,
    outTokens: 200,
    cost,
    ts: new Date().toISOString(),
  });

  it('本局与全部历史两个范围给得出，数字与 llm_usage 对得上', () => {
    const { room, store } = makeRoom(2024);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    // 一笔属于本局，一笔属于上一局
    store.recordUsage(usage(room.gameId, 'decision', 'deepseek-reasoner', 0.0072));
    store.recordUsage(usage('old-game', 'speech', 'deepseek-chat', 0.0018));

    room.handleMessage('god', { type: 'usage', scope: 'game' });
    const mine = lastUsage(god);
    expect(mine.scope).toBe('game');
    expect(mine.gameId).toBe(room.gameId);
    expect(mine.totals).toEqual({ calls: 1, inTokens: 1000, outTokens: 200, cost: 0.0072 });
    expect(mine.byTask.map((row) => row.task)).toEqual(['decision']);
    expect(mine.byModel.map((row) => row.model)).toEqual(['deepseek-reasoner']);
    expect(mine.byGame, '只看本局时按局拆分没有意义').toEqual([]);

    room.handleMessage('god', { type: 'usage', scope: 'all' });
    const all = lastUsage(god);
    expect(all.scope).toBe('all');
    expect(all.gameId).toBeNull();
    expect(all.totals.calls).toBe(2);
    expect(all.byTask.map((row) => row.task).sort()).toEqual(['decision', 'speech']);
    expect(all.byGame.map((row) => row.gameId).sort()).toEqual([room.gameId, 'old-game'].sort());
    expect(all.byGame.find((row) => row.gameId === room.gameId)?.board).toBe('9 人预女猎守');
  });

  it('没有落库（store 为 null）时给一份空报告，而不是报错', () => {
    const room = new GameRoom({ logger, store: null });
    rooms.push(room);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    room.handleMessage('god', { type: 'usage', scope: 'game' });
    const payload = lastUsage(god);
    expect(payload.totals).toEqual({ calls: 0, inTokens: 0, outTokens: 0, cost: 0 });
    expect(payload.byTask).toEqual([]);
    expect(payload.byGame).toEqual([]);
  });
});

describe('暂停与中止', () => {
  it('暂停之后：不超时兜底、手动推进也被拒绝', () => {
    vi.useFakeTimers();
    const { room } = makeRoom(777);
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const seqBefore = god.state().lastSeq;

    room.handleMessage('god', { type: 'pause' });
    expect(god.state().paused).toBe(true);

    // 十分钟过去，局面该一动不动
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(god.state().lastSeq).toBe(seqBefore);

    // 就算有人硬塞一手，也不接受
    const pending = god.state().pending;
    if (pending) room.submit(driveAction(pending)!, 'client');
    expect(god.state().lastSeq).toBe(seqBefore);
  });

  it('继续之后接着走', () => {
    const { room } = makeRoom(777);
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const seqBefore = god.state().lastSeq;

    room.handleMessage('god', { type: 'pause' });
    room.handleMessage('god', { type: 'resume' });
    expect(god.state().paused).toBe(false);

    const pending = god.state().pending!;
    room.submit(driveAction(pending)!, 'client');
    expect(god.state().lastSeq).toBeGreaterThan(seqBefore);
  });

  it('中止是终态：继续不回来，超时也不推进，只能新开一局', () => {
    vi.useFakeTimers();
    const { room } = makeRoom(777);
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const seqBefore = god.state().lastSeq;

    room.handleMessage('god', { type: 'stop' });
    const after = god.state();
    expect(after.stopped).toBe(true);
    expect(after.pending, '中止之后不该再摆出一手待办').toBeNull();

    room.handleMessage('god', { type: 'resume' });
    expect(god.state().stopped).toBe(true);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(god.state().lastSeq).toBe(seqBefore);

    room.newGame(999);
    expect(god.state().stopped).toBe(false);
    expect(god.state().paused).toBe(false);
  });
});

describe('重大信息等真人确认', () => {
  /** 把所有收到的状态消息里的事件摊平 */
  function eventsOf(target: Collector): GameEvent[] {
    return target.messages.flatMap((message) =>
      message.type === 'snapshot' || message.type === 'update' ? message.events : [],
    );
  }

  /**
   * 一路代打到「被拦住」为止。
   * 位次随机，所以第一件大事可能是查验、女巫夜况，也可能是天亮死讯 —— 不写死。
   */
  function driveUntilAck(room: GameRoom, god: Collector): void {
    for (let i = 0; i < 800; i += 1) {
      const state = god.state();
      if (state.ackSeq.length > 0 || state.winner !== null) return;
      room.autoPlay(1);
    }
  }

  it('查验/死讯这类信息一出来就停手，点「继续」才接着走', () => {
    vi.useFakeTimers();
    const { room } = makeRoom(2024);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    driveUntilAck(room, god);
    const held = god.state().ackSeq;
    expect(held.length, '一路代打下来应该碰到过重大信息').toBeGreaterThan(0);
    const seqAtHold = god.state().lastSeq;

    // 拦住期间：十分钟过去局面一动不动（不排兜底）
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(god.state().lastSeq).toBe(seqAtHold);

    // 硬塞一手也不接受
    const pending = god.state().pending;
    if (pending) room.submit(driveAction(pending)!, 'client');
    expect(god.state().lastSeq).toBe(seqAtHold);

    // 点「继续」之后才放行
    room.handleMessage('god', { type: 'resume' });
    expect(god.state().ackSeq).toEqual([]);
    room.autoPlay(1);
    expect(god.state().lastSeq).toBeGreaterThan(seqAtHold);
  });

  it('被拦住的只会是「真人本人收得到」的事件', () => {
    const { room } = makeRoom(31337);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    driveUntilAck(room, god);
    const heldSeqs = new Set(god.state().ackSeq);
    const held = eventsOf(god).filter((event) => heldSeqs.has(event.seq));

    expect(held.length).toBeGreaterThan(0);
    for (const event of held) {
      expect(['seer_result', 'witch_night_info', 'died', 'hunter_shot']).toContain(event.payload.t);
      // 查验与女巫夜况是私密事件：只有本人（真人）收到时才会拦
      if (event.payload.t === 'seer_result' || event.payload.t === 'witch_night_info') {
        expect((event.payload as { seat: SeatId }).seat).toBe(room.humanSeatId);
      }
    }
  });

  it('对局结束后不再拦人', () => {
    const { room } = makeRoom(777);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    for (let i = 0; i < 3000 && god.state().winner === null; i += 1) {
      if (god.state().ackSeq.length > 0) {
        room.handleMessage('god', { type: 'resume' });
        continue;
      }
      room.autoPlay(1);
    }

    expect(god.state().winner).not.toBeNull();
    expect(god.state().ackSeq, '结束那屏本来就摆着底牌，不用再等确认').toEqual([]);
  });
});

describe('夜间固定节拍', () => {
  /** 打开节拍的房间：只有节拍能推动夜晚，正好用来验「换步与有没有人行动无关」 */
  function beatRoom(stepMs: number): { room: GameRoom; god: Collector } {
    const room = new GameRoom({ logger, store: null, id: 'beat-room', rules: { nightStepMs: stepMs } });
    rooms.push(room);
    const god = collector();
    god.subscribe(room, 'god', 'god');
    return { room, god };
  }

  it('四步固定走满：没人行动也一步不少、一步不早', () => {
    vi.useFakeTimers();
    const { god } = beatRoom(1000);

    expect(god.state().phase).toBe('NIGHT_GUARD');
    expect(god.state().nightStepLeftMs, '倒计时下发给了所有人').toBe(1000);

    // 差 1 毫秒都还没到点
    vi.advanceTimersByTime(999);
    expect(god.state().phase).toBe('NIGHT_GUARD');
    vi.advanceTimersByTime(1);
    expect(god.state().phase).toBe('NIGHT_WOLF');

    const phases: string[] = [god.state().phase];
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(1000);
      phases.push(god.state().phase);
    }

    // 全程没人行动，四步依然一步不落地走完，然后进白天
    expect(phases).toEqual(['NIGHT_WOLF', 'NIGHT_WITCH', 'NIGHT_SEER', 'CHIEF_SIGNUP']);
    expect(god.state().nightStepLeftMs, '出了夜晚就没有这一步的倒计时了').toBe(0);
  });

  it('节拍关着时不排节拍，也不下发倒计时', () => {
    const room = new GameRoom({ logger, store: null, id: 'no-beat' });
    rooms.push(room);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    expect(god.state().nightStepLeftMs).toBe(0);
  });
});

/** 只记录调用时序的假 AI；真实 AI 的接线由 ai.test.ts 覆盖 */
function timingHost(options: { delayMs: number }) {
  const calls: { seat: SeatId; kind: string; at: number }[] = [];
  const factory: AgentHostFactory = ({ humanSeat }) =>
    ({
      observe: (): void => {},
      handles: (seat: SeatId): boolean => seat !== humanSeat,
      act: async (_state: unknown, pending: PendingRequest): Promise<Action> => {
        calls.push({ seat: pending.seat, kind: pending.options[0]?.kind ?? '?', at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        const choice = choicesFor(pending)[0];
        // 发言不生成按钮，假 AI 自己编一句
        if (!choice) return { kind: 'speak', actor: pending.seat, text: `（假 AI）${pending.seat} 号发言` };
        return choice.action;
      },
    }) as unknown as AgentHost;
  // AgentHost 带私有字段，结构类型无法直接赋值，测试里显式转换
  return { factory, calls };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 真人座位能提交的动作：有按钮点第一个，要发言就编一句 */
function humanAction(pending: PendingRequest): Action | null {
  const choice = choicesFor(pending)[0];
  if (choice) return choice.action;
  if (pending.options[0]?.kind === 'speak') {
    return { kind: 'speak', actor: pending.seat, text: '（真人）我先听听。' };
  }
  return null;
}

/**
 * 自动推进用的动作。
 * 夜里让女巫不用药、守卫守最高位，这样首夜一定有人出局 ——
 * 否则「死讯公布前」这类测试就没有场景可测。
 */
function driveAction(pending: PendingRequest): Action | null {
  const choices = choicesFor(pending);
  if (choices.length === 0) return humanAction(pending);
  const kind = pending.options[0]?.kind ?? '';
  if (kind === 'witch_act' || kind === 'guard_protect') return choices[choices.length - 1]!.action;
  return choices[0]!.action;
}

describe('并行预思考', () => {
  it('轮到真人时 8 个 AI 已并行想完，真人一点后面立刻过完', async () => {
    const { factory, calls } = timingHost({ delayMs: 80 });
    const room = new GameRoom({ logger, store: null, hostFactory: factory });
    rooms.push(room);

    const god = collector();
    god.subscribe(room, 'god', 'god');

    // 先把首夜走完，一直走到「轮到真人上警」为止（位次随机，所以要看座位号）
    for (let i = 0; i < 80; i += 1) {
      // 夜里验到自己头上的重大信息要真人确认，这一步不能省
      if (god.state().ackSeq.length > 0) {
        room.handleMessage('god', { type: 'resume' });
        continue;
      }
      const pending = god.state().pending;
      if (!pending) break;
      if (pending.options[0]?.kind === 'chief_signup' && pending.seat === room.humanSeatId) break;
      const action = humanAction(pending);
      if (!action) break;
      room.submit(action, 'client');
    }

    const pending = god.state().pending;
    expect(pending?.options[0]?.kind).toBe('chief_signup');
    expect(pending?.seat).toBe(room.humanSeatId);

    // 关键断言：真人还一个字没回，其余 8 个座位的决策已经全部发出去了
    const signupCalls = calls.filter((call) => call.kind === 'chief_signup');
    expect(signupCalls.map((call) => call.seat).sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((seat) => seat !== room.humanSeatId),
    );

    const spread = Math.max(...signupCalls.map((call) => call.at)) - Math.min(...signupCalls.map((call) => call.at));
    expect(spread, `8 次决策发起时间跨度为 ${spread}ms，若串行发起会超过 600ms`).toBeLessThan(200);

    // 真人点下去之后，2~9 号复用预思考结果，不再产生新的决策调用
    room.submit(humanAction(pending!)!, 'client');
    await sleep(200);
    expect(calls.filter((call) => call.kind === 'chief_signup')).toHaveLength(signupCalls.length);
  });

  it('发言阶段不做预思考：同时只会有一个人在发言决策上', async () => {
    const { factory, calls } = timingHost({ delayMs: 40 });
    const room = new GameRoom({ logger, store: null, hostFactory: factory });
    rooms.push(room);

    const god = collector();
    god.subscribe(room, 'god', 'god');

    // 走到第一次「AI 发言」
    for (let i = 0; i < 200; i += 1) {
      if (god.state().ackSeq.length > 0) {
        room.handleMessage('god', { type: 'resume' });
        continue;
      }
      const pending = god.state().pending;
      if (!pending || god.state().winner !== null) break;
      if (pending.options[0]?.kind === 'speak' && pending.seat !== room.humanSeatId) break;
      const action = humanAction(pending);
      if (!action) break;
      room.submit(action, 'client');
    }

    const speakCalls = calls.filter((call) => call.kind === 'speak');
    // 若发言被误当成可并行阶段，这里会一次冒出 8 个
    expect(speakCalls.length, `发言阶段同时发起了 ${speakCalls.length} 个决策`).toBeLessThanOrEqual(2);
  });
});

describe('真人发言耗时 spoke.ms', () => {
  it('真人发言带上「下发待办 → 提交」的耗时', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const { room } = makeRoom(2024);
    const god = collector();
    god.subscribe(room, 'god', 'god');

    // 推到「轮到真人发言」
    for (let i = 0; i < 400; i += 1) {
      if (god.state().ackSeq.length > 0) {
        room.handleMessage('god', { type: 'resume' });
        continue;
      }
      const current = god.state().pending;
      if (!current || god.state().winner !== null) break;
      if (current.options[0]?.kind === 'speak' && current.seat === room.humanSeatId) break;
      const action = driveAction(current);
      if (!action) break;
      room.submit(action, 'client');
    }

    const pending = god.state().pending;
    expect(pending?.options[0]?.kind).toBe('speak');
    expect(pending?.seat).toBe(room.humanSeatId);

    // 真人「想了」3.5 秒才提交
    vi.setSystemTime(1_003_500);
    room.submit({ kind: 'speak', actor: room.humanSeatId, text: '（真人）我先听听。' }, 'client');

    const spoke = god
      .last()
      .events.find((event) => event.payload.t === 'spoke' && event.payload.seat === room.humanSeatId);
    if (spoke?.payload.t !== 'spoke') throw new Error('应当产出真人的 spoke 事件');
    expect(spoke.payload.ms).toBe(3500);
  });
});
