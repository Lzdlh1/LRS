import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameEvent } from '@lrs/shared';
import { createLogger, nullSink } from '@lrs/shared';
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
  predicate: (message: ServerMessage) => boolean;
  run: (message: ServerMessage) => void;
}

const waiters = new WeakMap<WebSocketLike, Set<Waiter>>();

function waitFor(socket: WebSocketLike, predicate: (m: ServerMessage) => boolean, label: string): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
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
  latest: ServerMessage | null;
  send: (message: unknown) => void;
  waitFor: (predicate: (message: ServerMessage) => boolean, label: string) => Promise<ServerMessage>;
}

async function connect(port: number): Promise<Client> {
  const socket = new NodeWebSocket(`ws://127.0.0.1:${port}/ws`);
  const client: Client = {
    events: [],
    latest: null,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: (predicate, label) => waitFor(socket, predicate, label),
  };

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  socket.addEventListener('message', (event: { data: unknown }) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    client.latest = message;
    if (message.type !== 'error') client.events.push(...message.events);
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
    const finished = await client.waitFor(
      (m) => m.type !== 'error' && m.state.winner !== null,
      '对局结束',
    );

    if (finished.type === 'error') throw new Error(finished.message);
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
      (m) => m.type !== 'error' && m.events.some((event) => event.payload.t === 'action_rejected'),
      '拒绝事件',
    );

    client.send({ type: 'newGame' });
    const after = await client.waitFor((m) => m.type === 'snapshot' && m.state.lastSeq > 0, '重开快照');
    expect(after.type).toBe('snapshot');
  });
});
