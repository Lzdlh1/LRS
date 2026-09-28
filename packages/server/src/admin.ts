import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@lrs/shared';
import {
  ACCESS_TOKEN_PATTERN,
  isProvider,
  PROVIDERS,
  type Provider,
  type SettingsStore,
} from './store/settingsStore.ts';

/**
 * 设置界面的后台。
 *
 * 两道锁，各管一件事：
 * 1. `ACCESS_TOKEN`（在 transport 层）挡住整个站点；
 * 2. **管理口令**挡住「设置」这一块 —— 新设备第一次进来要输一次，
 *    输过之后这台设备上换成 HttpOnly cookie，不用每次都输。
 *
 * 口令只存 scrypt 哈希，服务端自己也不知道原文；Key 只在「查看」那一下被读出来，
 * 其余任何响应里都只有掩码。
 */
const SESSION_COOKIE = 'lrs_admin';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 64 * 1024;
/** 连续错这么多次就冷静一会儿，避免被人对着口令穷举 */
const MAX_FAILURES = 5;
const BLOCK_MS = 60_000;

export interface KeyView {
  /** ui = 界面里配的；env = 只有 .env 兜底；none = 都没有 */
  source: 'ui' | 'env' | 'none';
  /** 给界面看的掩码，永远不会是完整 Key */
  masked: string;
}

export interface AdminState {
  passphraseSet: boolean;
  unlocked: boolean;
  /**
   * 进站点的那道门。
   *
   * 只给掩码：改完口令之后当前设备会带着新口令重新访问一次，
   * 所以不需要在界面上把完整口令摆出来。
   */
  access: {
    set: boolean;
    source: 'ui' | 'env' | 'none';
    masked: string;
  };
  llm: {
    provider: Provider;
    cheapModel: string;
    strongModel: string;
    baseUrl: string;
    keys: Record<Provider, KeyView>;
    live: boolean;
  };
}

export interface AdminOptions {
  settings: SettingsStore;
  logger: Logger;
  /** 设置写完之后重新装配模型路由（对新开一局生效） */
  onConfigChanged: () => void;
  /**
   * `.env` 里的兜底 Key。
   *
   * 这里拿的是真值（不是布尔），因为「查看」要能给出**当前真正在用的那把** ——
   * 否则界面里配过之前，点查看会什么都不显示。它只会回给已解锁的会话。
   */
  envKeys: Record<Provider, string>;
  /** `.env` 里的访问口令（`ACCESS_TOKEN`），界面改过之后就不再回落到它 */
  envAccessToken: string;
  /** 当前生效的档位是否可用 */
  isLive: () => boolean;
}

export interface AdminHandler {
  /** 命中 /admin 就接管请求并返回 true */
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
}

function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassphrase(passphrase: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(passphrase, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

/** 只露头 6 尾 4，中间一律星号 */
function maskKey(key: string): string {
  if (key.length === 0) return '';
  if (key.length <= 12) return '•'.repeat(key.length);
  return `${key.slice(0, 6)}${'•'.repeat(6)}${key.slice(-4)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(buf);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是对象');
  return parsed as Record<string, unknown>;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

export function createAdmin(options: AdminOptions): AdminHandler {
  const { settings, logger } = options;

  /** 已解锁的设备：token -> 到期时间 */
  const sessions = new Map<string, number>();
  let failures = 0;
  let blockedUntil = 0;

  const unlocked = (req: IncomingMessage): boolean => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return false;
    const expires = sessions.get(token);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  const keyView = (provider: Provider): KeyView => {
    if (settings.hasOwnApiKey(provider)) {
      const key = settings.apiKey(provider);
      return key === ''
        ? { source: 'ui', masked: '（已清空）' }
        : { source: 'ui', masked: maskKey(key) };
    }
    return options.envKeys[provider] === ''
      ? { source: 'none', masked: '' }
      : { source: 'env', masked: '（来自 .env）' };
  };

  /** 当前真正在用的那把 Key：界面配过就用界面的（含清空），否则用 .env 的 */
  const effectiveKey = (provider: Provider): string =>
    settings.hasOwnApiKey(provider) ? settings.apiKey(provider) : options.envKeys[provider];

  /** 当前真正在用的访问口令，以及它是哪来的 */
  const accessView = (): AdminState['access'] => {
    if (settings.hasOwnAccessToken()) {
      const token = settings.accessToken();
      return token === ''
        ? { set: false, source: 'ui', masked: '' }
        : { set: true, source: 'ui', masked: maskKey(token) };
    }
    return options.envAccessToken === ''
      ? { set: false, source: 'none', masked: '' }
      : { set: true, source: 'env', masked: maskKey(options.envAccessToken) };
  };

  const readState = (req: IncomingMessage): AdminState => {
    const stored = settings.readLlm();
    return {
      passphraseSet: settings.adminHash() !== null,
      unlocked: unlocked(req),
      access: accessView(),
      llm: {
        provider: stored.provider,
        cheapModel: stored.cheapModel,
        strongModel: stored.strongModel,
        baseUrl: stored.baseUrl,
        keys: {
          deepseek: keyView('deepseek'),
          openai: keyView('openai'),
          custom: keyView('custom'),
        },
        live: options.isLive(),
      },
    };
  };

  /** 写配置：只认识白名单字段，长度都卡死 */
  const saveConfig = (body: Record<string, unknown>): string | null => {
    const provider = body['provider'];
    if (!isProvider(provider)) return '供应商不合法';

    const cheapModel = str(body['cheapModel'], 120);
    const strongModel = str(body['strongModel'], 120);
    if (cheapModel === '' || strongModel === '') return '模型名不能为空';

    const baseUrl = str(body['baseUrl'], 300);
    if (provider === 'custom') {
      if (!/^https?:\/\//.test(baseUrl)) return '自定义供应商必须填 http(s) 开头的地址';
    } else if (baseUrl !== '' && !/^https?:\/\//.test(baseUrl)) {
      return '地址必须以 http(s) 开头';
    }

    const keys = body['keys'];
    if (keys !== undefined) {
      if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) return 'keys 必须是对象';
      for (const item of PROVIDERS) {
        const value = (keys as Record<string, unknown>)[item];
        // undefined = 这一项没动；空串 = 明确清空（之后不再回落到 .env）
        if (value !== undefined && typeof value !== 'string') return `key.${item} 必须是字符串`;
      }
    }

    settings.writeLlm({ provider, cheapModel, strongModel, baseUrl });
    if (keys !== undefined) {
      const map = keys as Record<string, unknown>;
      for (const item of PROVIDERS) {
        const value = map[item];
        if (typeof value === 'string') settings.setApiKey(item, value.trim().slice(0, 400));
      }
    }
    return null;
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (path === '/admin/state' && method === 'GET') {
        sendJson(res, 200, readState(req));
        return;
      }

      if (method !== 'POST') {
        sendJson(res, 405, { error: '只支持 GET /admin/state 与 POST' });
        return;
      }

      // ── 设置/修改口令：没设过时谁都能设（第一次），设过之后必须是已解锁的设备才能改 ──
      if (path === '/admin/setup') {
        if (settings.adminHash() !== null && !unlocked(req)) {
          sendJson(res, 409, { error: '口令已设置过，请先解锁再修改' });
          return;
        }
        const body = await readJson(req);
        const passphrase = str(body['passphrase'], 200);
        if (passphrase.length < 6) {
          sendJson(res, 400, { error: '口令至少 6 位' });
          return;
        }
        settings.setAdminHash(hashPassphrase(passphrase));
        logger.info('设置管理口令已创建/更新');

        // 改口令的用意通常是「别人可能知道旧的」，所以顺带把其它设备的会话全踢掉
        sessions.clear();
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── 解锁 ──
      if (path === '/admin/unlock') {
        if (Date.now() < blockedUntil) {
          sendJson(res, 429, { error: `错误次数过多，请 ${Math.ceil((blockedUntil - Date.now()) / 1000)} 秒后再试` });
          return;
        }
        const stored = settings.adminHash();
        if (stored === null) {
          sendJson(res, 409, { error: '还没设置口令' });
          return;
        }
        const body = await readJson(req);
        const passphrase = str(body['passphrase'], 200);
        if (!verifyPassphrase(passphrase, stored)) {
          failures += 1;
          logger.warn('设置口令校验失败', { failures });
          if (failures >= MAX_FAILURES) {
            blockedUntil = Date.now() + BLOCK_MS;
            failures = 0;
          }
          sendJson(res, 401, { error: '口令不对' });
          return;
        }

        failures = 0;
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (path === '/admin/lock') {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (token) sessions.delete(token);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── 以下都要先解锁 ──
      if (!unlocked(req)) {
        sendJson(res, 401, { error: '需要先解锁：请输入管理口令' });
        return;
      }

      if (path === '/admin/token') {
        const body = await readJson(req);
        const token = str(body['token'], 64);
        if (!ACCESS_TOKEN_PATTERN.test(token)) {
          sendJson(res, 400, {
            error: '口令要 8~64 位，只能用字母、数字和 . _ ~ - （它会放进网址里，特殊符号会被转义）',
          });
          return;
        }
        settings.setAccessToken(token);
        logger.info('访问口令已更新（不记口令本身）');

        // 这台设备上的旧 cookie 立刻就作废了。前端拿到 ok 之后会带着新口令
        // 重新访问一次，顺理成章地换到新 cookie —— 所以这里不用发 cookie。
        sendJson(res, 200, { ok: true, state: readState(req) });
        return;
      }

      if (path === '/admin/config') {
        const error = saveConfig(await readJson(req));
        if (error !== null) {
          sendJson(res, 400, { error });
          return;
        }
        // 重新装配模型路由：对新开一局生效，当前这局不受影响
        options.onConfigChanged();
        logger.info('模型设置已更新', { provider: settings.readLlm().provider });
        sendJson(res, 200, { ok: true, state: readState(req) });
        return;
      }

      if (path === '/admin/reveal') {
        const body = await readJson(req);
        const provider = body['provider'];
        if (!isProvider(provider)) {
          sendJson(res, 400, { error: '供应商不合法' });
          return;
        }
        // 只回给已解锁的会话；这是一次明确的「我要看」动作
        sendJson(res, 200, { key: effectiveKey(provider) });
        return;
      }

      sendJson(res, 404, { error: '没有这个接口' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('设置接口出错', { path, error: message });
      if (!res.headersSent) sendJson(res, 400, { error: message });
    }
  };

  return {
    handle: (req, res, url) => {
      if (!url.pathname.startsWith('/admin/')) return false;
      void route(req, res, url);
      return true;
    },
  };
}
