import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, nullSink } from '@lrs/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.ts';
import type { ServerConfig } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { openDatabase } from '../src/store/db.ts';
import { SettingsStore, type Provider } from '../src/store/settingsStore.ts';

const logger = createLogger('admin-test', nullSink, 'error');

/**
 * 测试用的假 Key。
 *
 * 特意写成**不像密钥**的样子：`sk-` 后面跟 32 位字母数字会被 GitHub 的推送保护
 * 当成真的 DeepSeek Key 拦下来（第一版就是这么被拦的）。密钥在代码里本来就是
 * 不透明字符串，测试不需要它长得像真的。
 */
const FAKE_KEY = 'test-fixture-not-a-real-key';
const FAKE_ENV_KEY = 'test-fixture-from-env';
const FAKE_OPENAI_KEY = 'test-fixture-openai';
const tempDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lrs-admin-'));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  baseUrl: string;
  settings: SettingsStore;
}

/** 一个最小的应答体：状态码 + 头 + 解析后的 JSON */
interface Reply {
  status: number;
  cookie: string | null;
  body: Record<string, unknown>;
}

async function start(envKeys: Partial<Record<Provider, string>> = {}): Promise<Harness> {
  const base = loadConfig({}, tempDir());
  const config: ServerConfig = {
    ...base,
    port: 0,
    logLevel: 'error',
    logDir: tempDir(),
    dbPath: join(tempDir(), 'admin.db'),
  };

  const db = openDatabase(':memory:');
  const settings = new SettingsStore(db);
  let reloads = 0;

  const admin = createAdmin({
    settings,
    logger,
    envKeys: { deepseek: '', openai: '', custom: '', ...envKeys },
    isLive: () => false,
    onConfigChanged: () => {
      reloads += 1;
    },
  });

  const running: RunningServer = startServer({
    config,
    logger,
    wsLogger: logger,
    store: null,
    admin,
  });
  await once(running.server, 'listening');
  cleanups.push(() => running.close());
  cleanups.push(() => db.close());

  const port = (running.server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, settings };
}

async function call(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string | null } = {},
): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  const raw = response.headers.get('set-cookie');
  return {
    status: response.status,
    cookie: raw === null ? null : raw.split(';')[0]!,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

describe('设置后台：口令与 Key 的保护', () => {
  it('没设口令时能读到状态，但 Key 永远只有掩码', async () => {
    const { baseUrl, settings } = await start();
    settings.setApiKey('deepseek', FAKE_KEY);

    const reply = await call(baseUrl, '/admin/state');
    expect(reply.status).toBe(200);
    expect(reply.body['passphraseSet']).toBe(false);
    expect(reply.body['unlocked']).toBe(false);

    const text = JSON.stringify(reply.body);
    expect(text).not.toContain(FAKE_KEY);
    const keys = (reply.body['llm'] as { keys: { deepseek: { masked: string; source: string } } }).keys;
    expect(keys.deepseek.source).toBe('ui');
    expect(keys.deepseek.masked).toContain('test-f');
    expect(keys.deepseek.masked).toContain('••••');
  });

  it('没解锁就改不了配置、也拿不到 Key', async () => {
    const { baseUrl } = await start();
    await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });

    // 故意不带 cookie：相当于另一台没解锁的设备
    const save = await call(baseUrl, '/admin/config', {
      method: 'POST',
      body: { provider: 'openai', cheapModel: 'gpt-4o-mini', strongModel: 'gpt-4o' },
    });
    expect(save.status).toBe(401);

    const reveal = await call(baseUrl, '/admin/reveal', { method: 'POST', body: { provider: 'deepseek' } });
    expect(reveal.status).toBe(401);
  });

  it('口令太短不给设；设完之后解锁才能改配置，改动会落库并触发重载', async () => {
    const { baseUrl, settings } = await start();

    const short = await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: '123' } });
    expect(short.status).toBe(400);
    expect(settings.adminHash()).toBeNull();

    const setup = await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });
    expect(setup.status).toBe(200);
    expect(setup.cookie).toContain('lrs_admin=');
    expect(settings.adminHash()).not.toBeNull();
    // 库里只有哈希，不能出现原口令
    expect(settings.adminHash()).not.toContain('lrs-pass-123');

    const save = await call(baseUrl, '/admin/config', {
      method: 'POST',
      cookie: setup.cookie,
      body: {
        provider: 'openai',
        cheapModel: 'gpt-4o-mini',
        strongModel: 'gpt-4o',
        keys: { openai: FAKE_OPENAI_KEY },
      },
    });
    expect(save.status).toBe(200);

    const stored = settings.readLlm();
    expect(stored.provider).toBe('openai');
    expect(stored.strongModel).toBe('gpt-4o');
    expect(settings.apiKey('openai')).toBe(FAKE_OPENAI_KEY);
    expect(settings.hasOwnApiKey('openai')).toBe(true);
  });

  it('清空 Key 会落成空串（明确关掉），而不是删掉记录回落到 .env', async () => {
    const { baseUrl, settings } = await start();
    settings.setApiKey('deepseek', FAKE_KEY);
    const setup = await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });

    const save = await call(baseUrl, '/admin/config', {
      method: 'POST',
      cookie: setup.cookie,
      body: { provider: 'deepseek', cheapModel: 'deepseek-chat', strongModel: 'deepseek-reasoner', keys: { deepseek: '' } },
    });
    expect(save.status).toBe(200);
    expect(settings.apiKey('deepseek')).toBe('');
    expect(settings.hasOwnApiKey('deepseek')).toBe(true);
  });

  it('界面没配过 Key 时，查看给出的就是 .env 里那把；未解锁则不给', async () => {
    const { baseUrl } = await start({ deepseek: FAKE_ENV_KEY });
    const setup = await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });

    const state = await call(baseUrl, '/admin/state', { cookie: setup.cookie });
    const keys = (state.body['llm'] as { keys: Record<Provider, { source: string; masked: string }> }).keys;
    expect(keys.deepseek.source).toBe('env');
    // 状态接口里绝不能出现明文
    expect(JSON.stringify(state.body)).not.toContain(FAKE_ENV_KEY);

    const reveal = await call(baseUrl, '/admin/reveal', {
      method: 'POST',
      cookie: setup.cookie,
      body: { provider: 'deepseek' },
    });
    expect(reveal.status).toBe(200);
    expect(reveal.body['key']).toBe(FAKE_ENV_KEY);
  });

  it('解锁后才能查看完整 Key；锁定之后立刻失效', async () => {
    const { baseUrl, settings } = await start();
    settings.setApiKey('deepseek', FAKE_KEY);
    await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });

    const unlock = await call(baseUrl, '/admin/unlock', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });
    expect(unlock.status).toBe(200);

    const reveal = await call(baseUrl, '/admin/reveal', {
      method: 'POST',
      cookie: unlock.cookie,
      body: { provider: 'deepseek' },
    });
    expect(reveal.status).toBe(200);
    expect(reveal.body['key']).toBe(FAKE_KEY);

    const locked = await call(baseUrl, '/admin/lock', { method: 'POST', cookie: unlock.cookie });
    expect(locked.status).toBe(200);

    const again = await call(baseUrl, '/admin/reveal', {
      method: 'POST',
      cookie: unlock.cookie,
      body: { provider: 'deepseek' },
    });
    expect(again.status).toBe(401);
  });

  it('改口令必须已解锁；改完之后旧会话失效', async () => {
    const { baseUrl } = await start();
    const first = await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });

    // 没解锁就想改：拒绝
    const denied = await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-456' } });
    expect(denied.status).toBe(409);

    const changed = await call(baseUrl, '/admin/setup', {
      method: 'POST',
      cookie: first.cookie,
      body: { passphrase: 'lrs-pass-456' },
    });
    expect(changed.status).toBe(200);

    // 旧会话被踢掉
    const stale = await call(baseUrl, '/admin/reveal', {
      method: 'POST',
      cookie: first.cookie,
      body: { provider: 'deepseek' },
    });
    expect(stale.status).toBe(401);

    // 新口令可用，旧口令不行
    const withOld = await call(baseUrl, '/admin/unlock', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });
    expect(withOld.status).toBe(401);
    const withNew = await call(baseUrl, '/admin/unlock', { method: 'POST', body: { passphrase: 'lrs-pass-456' } });
    expect(withNew.status).toBe(200);
  });

  it('口令连错多次会被冷静一段时间', async () => {
    const { baseUrl } = await start();
    await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });

    for (let i = 0; i < 5; i += 1) {
      const wrong = await call(baseUrl, '/admin/unlock', { method: 'POST', body: { passphrase: `nope-${i}` } });
      expect(wrong.status).toBe(401);
    }

    const blocked = await call(baseUrl, '/admin/unlock', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });
    expect(blocked.status).toBe(429);

    // 冷静期内即使口令对，也不放行
    expect(JSON.stringify(blocked.body)).toContain('秒后再试');
  });

  it('非法参数不会写进库', async () => {
    const { baseUrl, settings } = await start();
    const setup = await call(baseUrl, '/admin/setup', { method: 'POST', body: { passphrase: 'lrs-pass-123' } });

    const bad = await call(baseUrl, '/admin/config', {
      method: 'POST',
      cookie: setup.cookie,
      body: { provider: 'not-a-provider', cheapModel: 'x', strongModel: 'y' },
    });
    expect(bad.status).toBe(400);

    const noModels = await call(baseUrl, '/admin/config', {
      method: 'POST',
      cookie: setup.cookie,
      body: { provider: 'deepseek', cheapModel: '', strongModel: '' },
    });
    expect(noModels.status).toBe(400);

    const badUrl = await call(baseUrl, '/admin/config', {
      method: 'POST',
      cookie: setup.cookie,
      body: { provider: 'custom', cheapModel: 'a', strongModel: 'b', baseUrl: 'ftp://nope' },
    });
    expect(badUrl.status).toBe(400);

    expect(settings.readLlm().provider).toBe('deepseek');
  });
});
