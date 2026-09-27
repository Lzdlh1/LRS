import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameEvent } from '@lrs/shared';
import { createLogger, nullSink, type Role } from '@lrs/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import type { ServerMessage } from '../src/session/protocol.ts';
import { startServer, type RunningServer } from '../src/server.ts';

const logger = createLogger('e2e', nullSink, 'error');
const tempDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lrs-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 用 Node 内置的 WHATWG WebSocket（与浏览器同一个 API）而不是 ws 包，
 * 这样测到的就是前端真正会走的那条路径。
 */
interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', handler: () => void): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', handler: (event: unknown) => void): void;
}

const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket;

interface Waiter {
  predicate: (message: StateMessage) => boolean;
  run: (message: StateMessage) => void;
}

/** 流式片段不带状态，测试里只关心带状态的消息 */
type StateMessage = Extract<ServerMessage, { type: 'snapshot' | 'update' }>;

const isStateMessage = (message: ServerMessage): message is StateMessage =>
  message.type === 'snapshot' || message.type === 'update';

const waiters = new WeakMap<WebSocketLike, Set<Waiter>>();

function waitFor(
  socket: WebSocketLike,
  predicate: (m: StateMessage) => boolean,
  label: string,
): Promise<StateMessage> {
  return new Promise<StateMessage>((resolve, reject) => {
    const bucket = waiters.get(socket) ?? new Set<Waiter>();
    waiters.set(socket, bucket);

    const finish = (action: () => void): void => {
      clearTimeout(timer);
      bucket.delete(waiter);
      action();
    };

    const timer = setTimeout(() => finish(() => reject(new Error(`等待「${label}」超时`))), 10_000);

    const waiter: Waiter = {
      predicate,
      run: (message) => {
        if (predicate(message)) finish(() => resolve(message));
      },
    };
    bucket.add(waiter);
  });
}

interface Harness {
  running: RunningServer;
  port: number;
  baseUrl: string;
}

async function start(): Promise<Harness> {
  const base = loadConfig({}, tempDir());
  const config: ServerConfig = {
    ...base,
    port: 0,
    logLevel: 'error',
    logDir: tempDir(),
    dbPath: join(tempDir(), 'e2e.db'),
  };

  const running = startServer({ config, logger, wsLogger: logger, store: null });
  await once(running.server, 'listening');
  cleanups.push(() => running.close());

  const port = (running.server.address() as AddressInfo).port;
  return { running, port, baseUrl: `http://127.0.0.1:${port}` };
}

interface Client {
  events: GameEvent[];
  latest: StateMessage | null;
  /** 收到的每一帧（含 stream / replay 这些不带状态的），审计用 */
  frames: ServerMessage[];
  /** 每一帧的原始文本，用来做「报文里到底有没有出现某个字符串」的兜底扫描 */
  raw: string[];
  send: (message: unknown) => void;
  waitFor: (predicate: (message: StateMessage) => boolean, label: string) => Promise<StateMessage>;
}

async function connect(port: number): Promise<Client> {
  const socket = new NodeWebSocket(`ws://127.0.0.1:${port}/ws`);
  const client: Client = {
    events: [],
    latest: null,
    frames: [],
    raw: [],
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: (predicate, label) => waitFor(socket, predicate, label),
  };

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  socket.addEventListener('message', (event: { data: unknown }) => {
    const text = String(event.data);
    const message = JSON.parse(text) as ServerMessage;
    client.frames.push(message);
    client.raw.push(text);
    if (!isStateMessage(message)) return;
    client.latest = message;
    client.events.push(...message.events);
    for (const waiter of [...(waiters.get(socket) ?? [])]) waiter.run(message);
  });

  cleanups.push(() => socket.close());
  return client;
}

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;

async function firstSnapshot(client: Client): Promise<Snapshot> {
  return (await client.waitFor((m) => m.type === 'snapshot', '首份快照')) as Snapshot;
}

describe('HTTP 接口', () => {
  it('/health 返回房间信息', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; roomId: string; subscribers: number };
    expect(body.ok).toBe(true);
    expect(body.roomId).toBeTruthy();
    expect(body.subscribers).toBe(0);
  });

  it('未知路径返回 404', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/nothing-here`);
    expect(response.status).toBe(404);
  });
});

describe('WebSocket 端到端', () => {
  it('连上就能拿到完整快照', async () => {
    const { port } = await start();
    const client = await connect(port);
    const snapshot = await firstSnapshot(client);

    expect(snapshot.state.seats).toHaveLength(9);
    expect(snapshot.state.board).toBe('9 人预女猎守');
    expect(snapshot.state.lastSeq).toBeGreaterThan(0);
    expect(snapshot.events.length).toBeGreaterThan(0);
  });

  it('通过 WebSocket 能把一整局代打到底', async () => {
    const { port } = await start();
    const client = await connect(port);
    await firstSnapshot(client);

    client.send({ type: 'autoPlay', count: 600 });
    const finished = await client.waitFor((m) => m.state.winner !== null, '对局结束');

    expect(['wolf', 'good']).toContain(finished.state.winner);
    expect(finished.state.pending).toBeNull();

    const over = client.events.filter((event) => event.payload.t === 'game_over');
    expect(over).toHaveLength(1);

    // seq 连续说明没有丢事件
    client.events.forEach((event, index) => expect(event.seq).toBe(index + 1));
  });

  it('玩家视角的连接拿不到别人的身份', async () => {
    const { port } = await start();
    const god = await connect(port);
    const godSnapshot = await firstSnapshot(god);
    const witchSeat = godSnapshot.state.seats.find((seat) => seat.role === 'witch')!.seat;
    const me = witchSeat === 1 ? 2 : 1;

    const player = await connect(port);
    player.send({ type: 'setViewer', viewer: me });
    const snapshot = (await player.waitFor(
      (m) => m.type === 'snapshot' && m.state.viewer === me,
      '玩家快照',
    )) as Snapshot;

    for (const seat of snapshot.state.seats.filter((s) => s.seat !== me)) {
      expect(seat.role).toBeNull();
    }
    expect(snapshot.events.filter((event) => event.payload.t === 'role_assigned')).toHaveLength(1);
    expect(snapshot.events.some((event) => event.payload.t === 'wolf_teammates')).toBe(
      snapshot.state.seats.find((s) => s.seat === me)?.role === 'werewolf',
    );
  });

  it('非法 Action 会被拒绝，但连接不会断', async () => {
    const { port } = await start();
    const client = await connect(port);
    await firstSnapshot(client);

    client.send({ type: 'action', action: { kind: 'vote', actor: 99, target: 1 } });
    await client.waitFor(
      (m) => m.events.some((event) => event.payload.t === 'action_rejected'),
      '拒绝事件',
    );

    client.send({ type: 'newGame' });
    const after = await client.waitFor((m) => m.type === 'snapshot' && m.state.lastSeq > 0, '重开快照');
    expect(after.type).toBe('snapshot');
  });
});

/**
 * 信息边界审计。
 *
 * M4-3/M4-4 是靠读代码 + 手工点几下发现的泄漏，只覆盖了「我当时想得到」的那几处。
 * 这一组测试换个思路：把 9 个座位逐个当成真人连上去打完整局，
 * 把收到的**每一帧原始报文**都留下来，用一组不变量去扫。
 * 自己没想到的泄漏，只能靠这种穷举撞出来。
 */
describe('信息边界穷举审计（抓包）', () => {
  const ALL_ROLES: Role[] = ['werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager'];

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** 轮询式等待：waitFor 只认带状态的消息，这里要等 replay 这类帧 */
  async function waitForFrame(
    client: Client,
    from: number,
    predicate: (message: ServerMessage) => boolean,
    label: string,
  ): Promise<ServerMessage> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const found = client.frames.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
      await sleep(20);
    }
  }

  /** 以某人视角开一局新的并代打到底，返回这段时间收到的全部报文 */
  async function playAs(
    port: number,
    seat: number,
  ): Promise<{ frames: ServerMessage[]; raw: string[] }> {
    const client = await connect(port);
    client.send({ type: 'setViewer', viewer: seat });
    await client.waitFor(
      (m) => m.type === 'snapshot' && m.state.viewer === seat,
      `${seat} 号视角的快照`,
    );

    const from = client.frames.length;
    client.send({ type: 'newGame' });
    await client.waitFor((m) => m.type === 'snapshot' && m.state.lastSeq > 0, '新局快照');
    client.send({ type: 'autoPlay', count: 600 });
    await client.waitFor((m) => m.state.winner !== null, `${seat} 号视角的对局结束`);

    return { frames: client.frames.slice(from), raw: client.raw.slice(from) };
  }

  /** 一帧一帧地过不变量；msg 参数只用来让失败信息指得准 */
  function audit(
    received: { frames: ServerMessage[]; raw: string[] },
    viewer: number,
    seatRoles: Map<number, Role>,
  ): void {
    const myRole = seatRoles.get(viewer)!;
    const witchSeat = [...seatRoles].find(([, role]) => role === 'witch')![0];
    const otherRoles = ALL_ROLES.filter((role) => role !== myRole);
    /** 这一路视角已经收到过死讯的座位 */
    const announced = new Set<number>();
    let audited = 0;

    for (const [index, frame] of received.frames.entries()) {
      if (frame.type !== 'snapshot' && frame.type !== 'update') continue;
      audited += 1;
      const { state, events } = frame;
      /** 终局那一帧是刻意亮底牌的（game_over 里带 reveal），不参与原文扫描 */
      const over = events.some((event) => event.payload.t === 'game_over');

      // 死讯先入账，再看状态 —— 它们本来就在同一帧里
      for (const event of events) {
        if (event.payload.t === 'died') announced.add(event.payload.seat);
      }

      for (const seat of state.seats) {
        if (seat.seat === viewer) {
          expect(seat.role, `${viewer} 号反而看不到自己的身份`).toBe(myRole);
        } else {
          expect(seat.role, `泄漏：${viewer} 号视角看到了 ${seat.seat} 号的身份`).toBeNull();
          if (!announced.has(seat.seat)) {
            expect(
              seat.deathCause,
              `泄漏：${seat.seat} 号的死讯还没公布，${viewer} 号就看到了死因`,
            ).toBeNull();
          }
        }
        if (!seat.alive) {
          expect(
            announced.has(seat.seat),
            `泄漏：${seat.seat} 号的死讯还没公布，${viewer} 号就看到他已出局`,
          ).toBe(true);
        }
      }

      expect(
        state.witchPotions !== null,
        `泄漏：只有女巫（${witchSeat} 号）该看到药水`,
      ).toBe(viewer === witchSeat);

      if (state.pending && state.pending.seat !== viewer) {
        expect(
          state.pending.options,
          `泄漏：${viewer} 号看到了 ${state.pending.seat} 号能做什么`,
        ).toEqual([]);
      }
      // 夜间顺序固定且公开，「现在轮到 8 号」就等于点名 8 号是守卫。
      // 这里不依赖服务端自己的 masked 标志 —— 万一那个标志本身算错了，它也会一起错。
      if (state.phase.startsWith('NIGHT_') && state.pending?.seat !== viewer) {
        expect(
          state.pending,
          `泄漏：夜间旁观者（${viewer} 号）看到了「轮到谁」`,
        ).toBeNull();
      }
      if (state.masked) {
        expect(state.pending, '泄漏：夜间旁观者不该看到「轮到谁」').toBeNull();
      }

      for (const event of events) {
        switch (event.payload.t) {
          case 'role_assigned':
            expect(event.payload.seat, '泄漏：别人的身份事件').toBe(viewer);
            break;
          case 'seer_result':
            expect(event.payload.seat, '泄漏：别人的验人结果').toBe(viewer);
            break;
          case 'action_requested':
            expect(event.payload.seat, '泄漏：别人的待办').toBe(viewer);
            break;
          case 'wolf_teammates':
            expect(myRole, '泄漏：非狼也收到了狼队友名单').toBe('werewolf');
            break;
          default:
            break;
        }
      }

      // 兜底：不按结构、直接扫原始文本。JSON 里的字符串值会被转义，所以
      // 一个未被转义的 `"role":"x"` 只可能来自真的把身份当字段发出去了。
      if (over) continue;
      const raw = received.raw[index]!;
      for (const role of otherRoles) {
        expect(raw.includes(`"role":"${role}"`), `泄漏：报文原文里出现了 ${role}`).toBe(false);
      }
      expect(/sk-[A-Za-z0-9]{16,}/.test(raw), '泄漏：报文里出现了 API Key').toBe(false);
    }

    expect(audited, `${viewer} 号视角一帧都没审到，这轮审计是空的`).toBeGreaterThan(20);
  }

  /**
   * 对照数据：上帝视角必须看得到 9 张底牌，否则上面那套不变量等于没测。
   * 每一条断言都建立在「对照是真的」之上。
   */
  function groundTruth(god: Client): Map<number, Role> {
    const roles = new Map(god.latest!.state.seats.map((seat) => [seat.seat, seat.role]));
    expect([...roles.values()].every((role) => role !== null), '上帝视角看不到底牌').toBe(true);
    expect([...roles.values()].filter((role) => role === 'werewolf')).toHaveLength(3);
    return roles as Map<number, Role>;
  }

  it('9 个座位逐个当玩家抓完整局，都拿不到未公开信息', async () => {
    const { port } = await start();
    const god = await connect(port);
    await firstSnapshot(god);

    for (let seat = 1; seat <= 9; seat += 1) {
      const received = await playAs(port, seat);
      expect(god.latest?.state.winner, `${seat} 号那局没打完`).not.toBeNull();
      audit(received, seat, groundTruth(god));
    }
  }, 60_000);

  it('局中拉复盘：玩家只能拿到封存版，且报文里没有别人的底牌', async () => {
    const { port } = await start();
    const god = await connect(port);
    await firstSnapshot(god);

    // 走几步就停，保证还在局中
    god.send({ type: 'autoPlay', count: 6 });
    await god.waitFor((m) => m.state.lastSeq > 20, '走了几步');

    const player = await connect(port);
    player.send({ type: 'setViewer', viewer: 1 });
    await player.waitFor((m) => m.type === 'snapshot' && m.state.viewer === 1, '1 号快照');
    expect(player.latest!.state.winner, '这一步之后应该还在局中').toBeNull();

    const godFrom = god.frames.length;
    god.send({ type: 'replay' });
    const godReplay = await waitForFrame(god, godFrom, (m) => m.type === 'replay', '上帝复盘');
    if (godReplay.type !== 'replay') throw new Error('类型收窄失败');
    expect(godReplay.payload.sealed).toBe(false);
    expect(godReplay.payload.roles).toHaveLength(9);

    const playerFrom = player.frames.length;
    player.send({ type: 'replay' });
    const playerReplay = await waitForFrame(player, playerFrom, (m) => m.type === 'replay', '玩家复盘');
    if (playerReplay.type !== 'replay') throw new Error('类型收窄失败');
    expect(playerReplay.payload.sealed).toBe(true);
    expect(playerReplay.payload.roles).toBeNull();
    expect(playerReplay.payload.decisions).toEqual([]);

    // 玩家这份复盘的原文里，也不该出现别人底牌的痕迹
    const myRole = groundTruth(god).get(1)!;
    for (const role of ALL_ROLES.filter((item) => item !== myRole)) {
      expect(
        player.raw.slice(playerFrom).some((raw) => raw.includes(`"role":"${role}"`)),
        `泄漏：玩家复盘的报文原文里出现了 ${role}`,
      ).toBe(false);
    }
  });
});
