import { DatabaseSync } from 'node:sqlite';
import { choicesFor, needsSpeech } from '@lrs/core-engine';
import type { Action, GameEvent } from '@lrs/shared';
import type { ClientState, ClientMessage, ServerMessage } from '../src/session/protocol.ts';

/**
 * 无头跑一局真实对局：只由真人的座位自动代打，其余全部交给 AI。
 *
 * 这是调 AI 的主力工具 —— 改完提示词跑一局，直接看发言质量与成本。
 *
 *   npm run ai:game           跑一局
 *   npm run ai:usage          只看累计用量
 *   WS_URL=... DB_PATH=...    可覆盖默认地址
 */

const WS_URL = process.env['WS_URL'] ?? 'ws://127.0.0.1:8787/ws';
const DB_PATH = process.env['DB_PATH'] ?? 'data/lrs.db';
const HUMAN_SEAT = Number(process.env['HUMAN_SEAT'] ?? 1);
const TIMEOUT_MS = Number(process.env['GAME_TIMEOUT_MS'] ?? 7 * 60 * 1000);
const USAGE_ONLY = process.argv.includes('--usage');

interface Speech {
  seat: number;
  context: string;
  text: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function printUsage(gameId: string | null): void {
  const db = new DatabaseSync(DB_PATH);

  if (gameId) {
    const rows = db
      .prepare(
        'SELECT task, tier, model, COUNT(*) AS n, SUM(in_tokens) AS i, SUM(out_tokens) AS o, SUM(cost) AS c FROM llm_usage WHERE game_id = ? GROUP BY task, tier, model ORDER BY c DESC',
      )
      .all(gameId) as { task: string; tier: string; model: string; n: number; i: number; o: number; c: number }[];

    console.log('\n[本局成本明细]');
    for (const row of rows) {
      console.log(
        `  ${row.task.padEnd(16)} ${row.tier.padEnd(7)} ${row.model.padEnd(18)} ${String(row.n).padStart(3)} 次  ${row.i}→${row.o} tokens  ¥${row.c.toFixed(4)}`,
      );
    }
  }

  const scope = gameId ? 'WHERE game_id = ?' : '';
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(in_tokens),0) AS i, COALESCE(SUM(out_tokens),0) AS o, COALESCE(SUM(cost),0) AS c FROM llm_usage ${scope}`,
    )
    .get(...(gameId ? [gameId] : [])) as { n: number; i: number; o: number; c: number };

  console.log(
    `\n[${gameId ? '本局' : '累计'}合计] ${summary.n} 次调用 · ${summary.i}→${summary.o} tokens · ¥${summary.c.toFixed(4)}`,
  );
  db.close();
}

async function playGame(): Promise<void> {
  const speeches: Speech[] = [];
  const deaths: string[] = [];
  let lastState: ClientState | null = null;
  let eventCount = 0;

  const socket = new WebSocket(WS_URL);
  const reader = (): ClientState | null => lastState;

  socket.addEventListener('message', (event: { data: unknown }) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    if (message.type === 'error') {
      console.log('[服务端错误]', message.message);
      return;
    }

    lastState = message.state;
    for (const raw of message.events as GameEvent[]) {
      eventCount += 1;
      if (raw.payload.t === 'spoke') {
        speeches.push({ seat: raw.payload.seat, context: raw.payload.context, text: raw.payload.text });
      }
      if (raw.payload.t === 'died') {
        deaths.push(`${raw.payload.seat} 号（${raw.payload.cause}）`);
      }
    }

    const state = reader();
    if (!state || state.winner !== null || state.pending?.seat !== HUMAN_SEAT) return;

    const pending = state.pending;
    const choice = choicesFor(pending)[0];
    const action: Action | null =
      choice?.action ??
      (needsSpeech(pending)
        ? { kind: 'speak', actor: pending.seat, text: '（真人）我按直觉先说着。' }
        : null);
    if (action) socket.send(JSON.stringify({ type: 'action', action } satisfies ClientMessage));
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`连不上 ${WS_URL}，服务端起了吗？`)));
  });

  console.log(`[开始] 新开一局；真人固定坐 ${HUMAN_SEAT} 号，其余交给 AI`);
  socket.send(JSON.stringify({ type: 'newGame' } satisfies ClientMessage));

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && reader()?.winner == null) await sleep(1000);

  const state = reader();
  const winner = state?.winner ?? null;
  console.log(`\n[结果] 胜方 = ${winner ?? '未结束（超时）'}；事件数 = ${eventCount}；发言 ${speeches.length} 条`);
  console.log(`[出局] ${deaths.join('、') || '无'}`);

  console.log('\n[发言全文]');
  for (const speech of speeches) {
    console.log(`  ${speech.seat} 号（${speech.context}）：${speech.text}`);
  }

  socket.close();
  printUsage(state?.gameId ?? null);
}

if (USAGE_ONLY) {
  printUsage(null);
} else {
  await playGame();
}
