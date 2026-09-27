import type { Viewer } from '@lrs/core-engine';
import { createLogger, nullSink } from '@lrs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientState, ServerMessage } from '../src/session/protocol.ts';
import { GameRoom } from '../src/session/room.ts';
import { openDatabase } from '../src/store/db.ts';
import { GameStore } from '../src/store/gameStore.ts';

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

  it('行动选项只发给行动者本人与上帝', () => {
    const { room } = makeRoom();
    const god = collector();
    god.subscribe(room, 'god', 'god');
    const actor = god.state().pending!.seat;
    const bystander = actor === 1 ? 2 : 1;

    const player = collector();
    player.subscribe(room, 'player', bystander);

    const state = player.state();
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
