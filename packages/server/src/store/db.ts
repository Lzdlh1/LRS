import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 用 Node 24 内置的 node:sqlite —— 免去 better-sqlite3 的原生编译，
 * 在 Windows 上尤其省事。接口保持最小，将来要换实现只改这一层。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS games (
     id           TEXT PRIMARY KEY,
     board        TEXT NOT NULL,
     config_json  TEXT NOT NULL,
     started_at   TEXT NOT NULL,
     ended_at     TEXT,
     winner       TEXT
   )`,

  // 事件溯源主表：复盘 = 按 seq 回放这张表
  `CREATE TABLE IF NOT EXISTS game_events (
     game_id       TEXT NOT NULL,
     seq           INTEGER NOT NULL,
     day           INTEGER NOT NULL,
     phase         TEXT NOT NULL,
     visibility    TEXT NOT NULL,
     payload_json  TEXT NOT NULL,
     PRIMARY KEY (game_id, seq)
   )`,

  `CREATE TABLE IF NOT EXISTS game_seats (
     game_id     TEXT NOT NULL,
     seat        INTEGER NOT NULL,
     role        TEXT NOT NULL,
     is_human    INTEGER NOT NULL,
     profile_id  TEXT,
     PRIMARY KEY (game_id, seat)
   )`,

  `CREATE TABLE IF NOT EXISTS ai_profiles (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     persona_text  TEXT NOT NULL,
     traits_json   TEXT NOT NULL DEFAULT '{}',
     is_builtin    INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS llm_usage (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     game_id     TEXT,
     task        TEXT NOT NULL,
     tier        TEXT NOT NULL,
     provider    TEXT NOT NULL,
     model       TEXT NOT NULL,
     in_tokens   INTEGER NOT NULL DEFAULT 0,
     out_tokens  INTEGER NOT NULL DEFAULT 0,
     cost        REAL NOT NULL DEFAULT 0,
     ts          TEXT NOT NULL
   )`,

  // 注意：这里不放 API Key。密钥只走环境变量 / 本地 .env
  `CREATE TABLE IF NOT EXISTS settings (
     key    TEXT PRIMARY KEY,
     value  TEXT NOT NULL
   )`,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const statement of SCHEMA) db.exec(statement);
  return db;
}

/** 包一层事务，避免写事件写到一半留下半局数据 */
export function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
