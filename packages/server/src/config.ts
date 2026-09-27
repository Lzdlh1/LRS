import { resolve } from 'node:path';
import { isLogLevel, type LogLevel } from '@lrs/shared';

export interface LlmTierConfig {
  provider: string;
  model: string;
}

export interface LlmConfig {
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  cheap: LlmTierConfig;
  strong: LlmTierConfig;
  maxConcurrency: number;
  /** 投票结算后是否让 AI 反思（每个 AI 一次便宜调用） */
  reflection: boolean;
}

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  /** 是否把 prompt 全文落盘。默认 false —— 只有排查问题时才临时打开。 */
  logPrompts: boolean;
  logDir: string;
  logRetentionDays: number;
  dbPath: string;
  llm: LlmConfig;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): ServerConfig {
  const rawLevel = env['LOG_LEVEL'];
  return {
    host: env['SERVER_HOST'] ?? '127.0.0.1',
    port: positiveNumber(env['SERVER_PORT'], 8787),
    logLevel: isLogLevel(rawLevel) ? rawLevel : 'info',
    logPrompts: bool(env['LOG_PROMPTS'], false),
    logDir: resolve(rootDir, env['LOG_DIR'] ?? 'logs'),
    logRetentionDays: positiveNumber(env['LOG_RETENTION_DAYS'], 7),
    dbPath: resolve(rootDir, env['DB_PATH'] ?? 'data/lrs.db'),
    llm: {
      deepseekApiKey: env['DEEPSEEK_API_KEY'] ?? '',
      deepseekBaseUrl: env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1',
      openaiApiKey: env['OPENAI_API_KEY'] ?? '',
      openaiBaseUrl: env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
      cheap: {
        provider: env['LLM_CHEAP_PROVIDER'] ?? 'deepseek',
        model: env['LLM_CHEAP_MODEL'] ?? 'deepseek-chat',
      },
      strong: {
        provider: env['LLM_STRONG_PROVIDER'] ?? 'deepseek',
        model: env['LLM_STRONG_MODEL'] ?? 'deepseek-reasoner',
      },
      maxConcurrency: positiveNumber(env['LLM_MAX_CONCURRENCY'], 4),
      reflection: bool(env['LLM_REFLECTION'], true),
    },
  };
}

/** 给日志用的安全摘要：**绝不包含 Key 本身**，只说有没有配 */
export function describeLlm(config: LlmConfig): Record<string, unknown> {
  return {
    cheap: `${config.cheap.provider}/${config.cheap.model}`,
    strong: `${config.strong.provider}/${config.strong.model}`,
    deepseekKey: config.deepseekApiKey.length > 0 ? '已配置' : '未配置',
    openaiKey: config.openaiApiKey.length > 0 ? '已配置' : '未配置',
    maxConcurrency: config.maxConcurrency,
    reflection: config.reflection,
  };
}
