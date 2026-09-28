/**
 * 设置界面的接口客户端。
 *
 * 全走同源 HTTP，cookie 由浏览器自动带上（管理口令换来的会话是 HttpOnly 的，
 * 前端脚本读不到、也不需要读）。
 */
export type Provider = 'deepseek' | 'openai' | 'custom';

export interface KeyView {
  /** ui = 界面里配的；env = 只有 .env 兜底；none = 都没有 */
  source: 'ui' | 'env' | 'none';
  masked: string;
}

export interface AdminState {
  passphraseSet: boolean;
  unlocked: boolean;
  llm: {
    provider: Provider;
    cheapModel: string;
    strongModel: string;
    baseUrl: string;
    keys: Record<Provider, KeyView>;
    live: boolean;
  };
}

export interface ConfigPayload {
  provider: Provider;
  cheapModel: string;
  strongModel: string;
  baseUrl: string;
  /** 只有真正要改的项才放进来；空串表示「明确清空」 */
  keys?: Partial<Record<Provider, string>>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });

  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return body as T;
}

export const fetchAdminState = (): Promise<AdminState> => request<AdminState>('/admin/state');

export const setupPassphrase = (passphrase: string): Promise<unknown> =>
  request('/admin/setup', { method: 'POST', body: JSON.stringify({ passphrase }) });

export const unlock = (passphrase: string): Promise<unknown> =>
  request('/admin/unlock', { method: 'POST', body: JSON.stringify({ passphrase }) });

export const lock = (): Promise<unknown> => request('/admin/lock', { method: 'POST', body: '{}' });

export const saveConfig = (payload: ConfigPayload): Promise<{ state: AdminState }> =>
  request('/admin/config', { method: 'POST', body: JSON.stringify(payload) });

export const revealKey = async (provider: Provider): Promise<string> => {
  const body = await request<{ key: string }>('/admin/reveal', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
  return body.key;
};
