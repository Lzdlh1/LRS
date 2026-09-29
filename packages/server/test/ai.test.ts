import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHost } from '@lrs/agent-host';
import { choicesFor, needsSpeech } from '@lrs/core-engine';
import { LlmRouter, MockProvider } from '@lrs/llm-router';
import { createLogger, nullSink, type Action, type GameEvent } from '@lrs/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { ClientState, ServerMessage } from '../src/session/protocol.ts';
import { startServer } from '../src/server.ts';

const logger = createLogger('ai-e2e', nullSink, 'error');

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', handler: () => void): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', handler: (event: unknown) => void): void;
}

const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket;

const tempDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lrs-ai-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 一个永远挑第一个合法选项的假大脑，用来验证「AI 接管」这条链路本身 */
function mockRouter(): LlmRouter {
  const brain = new MockProvider({
    respond: (request) => {
      const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
      if (user.includes('只输出发言内容本身')) return '我是 AI，这轮先说这些。';
      return JSON.stringify({
        choiceIndex: 1,
        reasoning: '先按最保守的选择走。',
        stance: '继续观察',
        push: null,
        reads: [],
        claim: null,
        mood: 'calm',
      });
    },
  });

  return new LlmRouter({
    providers: { brain },
    tiers: {
      cheap: { provider: 'brain', model: 'mock-cheap' },
      strong: { provider: 'brain', model: 'mock-strong' },
    },
  });
}

async function startWithAi(): Promise<number> {
  const base = loadConfig({}, tempDir());
  const config = {
    ...base,
    port: 0,
    logLevel: 'error' as const,
    logDir: tempDir(),
    dbPath: join(tempDir(), 'ai.db'),
  };

  const router = mockRouter();
  const running = startServer({
    config,
    logger,
    wsLogger: logger,
    store: null,
    hostFactory: ({ seatCount, names, humanSeat, onSpeechDelta }) =>
      createAgentHost({
        router,
        logger,
        humanSeats: [humanSeat],
        seatCount,
        names,
        rng: () => 0.42,
        enableReflection: false,
        onSpeechDelta,
      }),
  });

  await once(running.server, 'listening');
  cleanups.push(() => running.close());
  return (running.server.address() as AddressInfo).port;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 真人只负责「轮到自己时点一下第一个按钮」，其余全交给 AI。
 *
 * 位次每局随机，所以真人坐哪不写死 —— 从服务端下发的 humanSeat 里读。
 */
async function playWithAi(
  port: number,
  timeoutMs = 60_000,
): Promise<{
  state: ClientState | null;
  events: GameEvent[];
  streams: { seat: number; text: string }[];
  streamDone: number[];
}> {
  const socket = new NodeWebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: GameEvent[] = [];
  const streams: { seat: number; text: string }[] = [];
  const streamDone: number[] = [];
  let lastStream: { seat: number; text: string } | null = null;
  let latest: ClientState | null = null;

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  socket.addEventListener('message', (event: { data: unknown }) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;

    // 流式片段与「结束」信号都不带状态，单独收集
    if (message.type === 'stream') {
      if (!lastStream || lastStream.seat !== message.seat) {
        lastStream = { seat: message.seat, text: '' };
        streams.push(lastStream);
      }
      lastStream.text += message.delta;
      return;
    }
    if (message.type === 'stream-done') {
      streamDone.push(message.seat);
      return;
    }
    if (message.type !== 'snapshot' && message.type !== 'update') return;

    latest = message.state;
    events.push(...message.events);

    if (latest.winner !== null || latest.pending?.seat !== latest.humanSeat) return;

    const pending = latest.pending;
    const choice = choicesFor(pending)[0];
    const action: Action | null =
      choice?.action ??
      (needsSpeech(pending) ? { kind: 'speak', actor: pending.seat, text: '（真人）我先听着。' } : null);
    if (action) socket.send(JSON.stringify({ type: 'action', action }));
  });

  const deadline = Date.now() + timeoutMs;
  // 用 getter 读，避免 TS 把闭包里赋值的变量一直在外部收窄成初始值
  const readLatest = (): ClientState | null => latest;
  while (Date.now() < deadline && readLatest()?.winner == null) await sleep(50);

  socket.close();
  return { state: readLatest(), events, streams, streamDone };
}

describe('AI 接管对局', () => {
  it('8 个 AI 自动行动，真人只点几下就能打完一整局', async () => {
    const port = await startWithAi();
    const { state, events } = await playWithAi(port);

    expect(state).not.toBeNull();
    expect(['wolf', 'good']).toContain(state?.winner);
    expect(state?.pending).toBeNull();

    // AI 真的发了言
    const aiSpeech = events.filter(
      (event) => event.payload.t === 'spoke' && event.payload.seat !== state?.humanSeat,
    );
    expect(aiSpeech.length).toBeGreaterThan(3);

    // 全程没有出现非法行动
    expect(events.filter((event) => event.payload.t === 'action_rejected')).toEqual([]);

    // 事件序号连续
    events.forEach((event, index) => expect(event.seq).toBe(index + 1));
  }, 90_000);

  it('引擎给出的待办会轮流落到 AI 座位上，而不是只由真人推进', async () => {
    const port = await startWithAi();
    const { state, events } = await playWithAi(port, 30_000);

    const requested = new Set(
      events
        .filter((event) => event.payload.t === 'action_requested')
        .map((event) => (event.payload as { seat: number }).seat),
    );

    expect(
      requested.size,
      `收到 ${events.length} 个事件；胜方=${state?.winner ?? '未结束'}；阶段=${state?.phase ?? '未知'}`,
    ).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it('AI 发言以增量片段流式推给前端，且与最终落地文本一致', async () => {
    const port = await startWithAi();
    const { events, streams, streamDone } = await playWithAi(port, 60_000);

    expect(streams.length).toBeGreaterThan(0);
    expect(streamDone.length).toBeGreaterThan(0);

    const spoken = events.filter((event) => event.payload.t === 'spoke');
    for (const stream of streams) {
      const matched = spoken.some(
        (event) => event.payload.t === 'spoke' && event.payload.seat === stream.seat && event.payload.text === stream.text,
      );
      expect(matched, `${stream.seat} 号的流式文本应该能对上一条正式发言：${stream.text}`).toBe(true);
    }
  }, 90_000);
});
