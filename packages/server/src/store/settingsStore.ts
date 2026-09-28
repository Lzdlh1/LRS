import type { DatabaseSync } from 'node:sqlite';

/**
 * 设置仓库。
 *
 * 存的是「界面改过之后要生效的东西」：用哪家模型、Key、以及管理口令的哈希。
 * 优先级上 **数据库 > .env**：`.env` 只当首次部署的兜底，界面一旦写过就以界面为准。
 *
 * 两条硬规矩：
 * 1. Key 只在需要发请求时被读出来，绝不进日志；
 * 2. 管理口令只存 `scrypt` 哈希，服务端自己也不知道原口令是什么。
 */
export const PROVIDERS = ['deepseek', 'openai', 'custom'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface LlmSettings {
  provider: Provider;
  cheapModel: string;
  strongModel: string;
  /** 只有 custom 用得上；空串表示走内置默认地址 */
  baseUrl: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: 'deepseek',
  cheapModel: 'deepseek-chat',
  strongModel: 'deepseek-reasoner',
  baseUrl: '',
};

const LLM_KEYS = {
  provider: 'llm.provider',
  cheapModel: 'llm.cheapModel',
  strongModel: 'llm.strongModel',
  baseUrl: 'llm.baseUrl',
} as const;

const ADMIN_PASS_KEY = 'admin.pass';
const keyName = (provider: Provider): string => `key.${provider}`;

export class SettingsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ── 模型设置 ──

  readLlm(): LlmSettings {
    const provider = this.get(LLM_KEYS.provider);
    return {
      provider: isProvider(provider) ? provider : DEFAULT_LLM_SETTINGS.provider,
      cheapModel: this.get(LLM_KEYS.cheapModel) ?? DEFAULT_LLM_SETTINGS.cheapModel,
      strongModel: this.get(LLM_KEYS.strongModel) ?? DEFAULT_LLM_SETTINGS.strongModel,
      baseUrl: this.get(LLM_KEYS.baseUrl) ?? DEFAULT_LLM_SETTINGS.baseUrl,
    };
  }

  writeLlm(next: LlmSettings): void {
    this.set(LLM_KEYS.provider, next.provider);
    this.set(LLM_KEYS.cheapModel, next.cheapModel);
    this.set(LLM_KEYS.strongModel, next.strongModel);
    this.set(LLM_KEYS.baseUrl, next.baseUrl);
  }

  // ── Key ──

  /** 某个供应商的 Key；没配过就是空串 */
  apiKey(provider: Provider): string {
    return this.get(keyName(provider)) ?? '';
  }

  /**
   * 界面里配过没有。
   *
   * 这一步是必要的：配过就以界面为准，**包括界面里被清空的情况** ——
   * 否则用户清掉 Key 之后，`.env` 里的那个又会悄悄顶上来。
   */
  hasOwnApiKey(provider: Provider): boolean {
    return this.get(keyName(provider)) !== null;
  }

  setApiKey(provider: Provider, key: string): void {
    this.set(keyName(provider), key);
  }

  // ── 管理口令（只存哈希） ──

  adminHash(): string | null {
    return this.get(ADMIN_PASS_KEY);
  }

  setAdminHash(value: string): void {
    this.set(ADMIN_PASS_KEY, value);
  }
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}
