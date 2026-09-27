import type { DatabaseSync } from 'node:sqlite';
import type { Camp, GameEvent, GameId, Role, SeatId } from '@lrs/shared';
import { inTransaction } from './db.ts';

export interface GameRecord {
  id: GameId;
  board: string;
  configJson: string;
  startedAt: string;
  endedAt: string | null;
  winner: Camp | null;
}

export interface SeatRecord {
  seat: SeatId;
  role: Role;
  isHuman: boolean;
  profileId: string | null;
}

export interface UsageRecord {
  gameId: GameId | null;
  task: string;
  tier: string;
  provider: string;
  model: string;
  inTokens: number;
  outTokens: number;
  cost: number;
  ts: string;
}

export class GameStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createGame(record: GameRecord): void {
    this.db
      .prepare(
        'INSERT INTO games (id, board, config_json, started_at, ended_at, winner) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.board, record.configJson, record.startedAt, record.endedAt, record.winner);
  }

  saveSeats(gameId: GameId, seats: readonly SeatRecord[]): void {
    const statement = this.db.prepare(
      'INSERT OR REPLACE INTO game_seats (game_id, seat, role, is_human, profile_id) VALUES (?, ?, ?, ?, ?)',
    );
    inTransaction(this.db, () => {
      for (const seat of seats) {
        statement.run(gameId, seat.seat, seat.role, seat.isHuman ? 1 : 0, seat.profileId);
      }
    });
  }

  appendEvents(gameId: GameId, events: readonly GameEvent[]): void {
    if (events.length === 0) return;
    const statement = this.db.prepare(
      'INSERT OR REPLACE INTO game_events (game_id, seq, day, phase, visibility, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    inTransaction(this.db, () => {
      for (const event of events) {
        statement.run(
          gameId,
          event.seq,
          event.day,
          event.phase,
          JSON.stringify(event.visibility),
          JSON.stringify(event.payload),
        );
      }
    });
  }

  listEvents(gameId: GameId, sinceSeq = 0): GameEvent[] {
    const rows = this.db
      .prepare(
        'SELECT seq, day, phase, visibility, payload_json FROM game_events WHERE game_id = ? AND seq > ? ORDER BY seq',
      )
      .all(gameId, sinceSeq) as {
      seq: number;
      day: number;
      phase: string;
      visibility: string;
      payload_json: string;
    }[];

    return rows.map((row) => ({
      seq: row.seq,
      day: row.day,
      phase: row.phase,
      visibility: JSON.parse(row.visibility),
      payload: JSON.parse(row.payload_json),
    })) as GameEvent[];
  }

  countEvents(gameId: GameId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM game_events WHERE game_id = ?')
      .get(gameId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  finishGame(gameId: GameId, winner: Camp, endedAt: string): void {
    this.db.prepare('UPDATE games SET winner = ?, ended_at = ? WHERE id = ?').run(winner, endedAt, gameId);
  }

  /** 记一次模型调用的用量，供成本看板使用 */
  recordUsage(record: UsageRecord): void {
    this.db
      .prepare(
        'INSERT INTO llm_usage (game_id, task, tier, provider, model, in_tokens, out_tokens, cost, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.gameId,
        record.task,
        record.tier,
        record.provider,
        record.model,
        record.inTokens,
        record.outTokens,
        record.cost,
        record.ts,
      );
  }

  /** 某一局的成本汇总 */
  usageSummary(gameId: GameId): { calls: number; inTokens: number; outTokens: number; cost: number } {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS calls, COALESCE(SUM(in_tokens),0) AS in_tokens, COALESCE(SUM(out_tokens),0) AS out_tokens, COALESCE(SUM(cost),0) AS cost FROM llm_usage WHERE game_id = ?',
      )
      .get(gameId) as { calls: number; in_tokens: number; out_tokens: number; cost: number } | undefined;

    return {
      calls: row?.calls ?? 0,
      inTokens: row?.in_tokens ?? 0,
      outTokens: row?.out_tokens ?? 0,
      cost: row?.cost ?? 0,
    };
  }

  /** 把内置人设写进库，让 /ai_profiles 这类后续功能有统一的来源 */
  seedBuiltinProfiles(
    profiles: readonly { id: string; name: string; persona: string; aggression: number }[],
  ): number {
    const statement = this.db.prepare(
      'INSERT OR REPLACE INTO ai_profiles (id, name, persona_text, traits_json, is_builtin, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    );
    const now = new Date().toISOString();
    let count = 0;
    inTransaction(this.db, () => {
      for (const profile of profiles) {
        statement.run(
          profile.id,
          profile.name,
          profile.persona,
          JSON.stringify({ aggression: profile.aggression }),
          now,
        );
        count += 1;
      }
    });
    return count;
  }

  getGame(gameId: GameId): GameRecord | null {
    const row = this.db
      .prepare('SELECT id, board, config_json, started_at, ended_at, winner FROM games WHERE id = ?')
      .get(gameId) as
      | { id: string; board: string; config_json: string; started_at: string; ended_at: string | null; winner: string | null }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      board: row.board,
      configJson: row.config_json,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      winner: row.winner as Camp | null,
    };
  }

  listGames(limit = 20): GameRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, board, config_json, started_at, ended_at, winner FROM games ORDER BY started_at DESC LIMIT ?',
      )
      .all(limit) as {
      id: string;
      board: string;
      config_json: string;
      started_at: string;
      ended_at: string | null;
      winner: string | null;
    }[];

    return rows.map((row) => ({
      id: row.id,
      board: row.board,
      configJson: row.config_json,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      winner: row.winner as Camp | null,
    }));
  }
}
