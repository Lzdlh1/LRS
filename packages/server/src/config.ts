import { resolve } from 'node:path';
import { isLogLevel, type LogLevel } from '@lrs/shared';

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  /** 是否把 prompt 全文落盘。默认 false —— 只有排查问题时才临时打开。 */
  logPrompts: boolean;
  logDir: string;
  logRetentionDays: number;
  dbPath: string;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): ServerConfig {
  const rawLevel = env['LOG_LEVEL'];
  return {
    host: env['SERVER_HOST'] ?? '127.0.0.1',
    port: positiveNumber(env['SERVER_PORT'], 8787),
    logLevel: isLogLevel(rawLevel) ? rawLevel : 'info',
    logPrompts: env['LOG_PROMPTS'] === 'true',
    logDir: resolve(rootDir, env['LOG_DIR'] ?? 'logs'),
    logRetentionDays: positiveNumber(env['LOG_RETENTION_DAYS'], 7),
    dbPath: resolve(rootDir, env['DB_PATH'] ?? 'data/lrs.db'),
  };
}
