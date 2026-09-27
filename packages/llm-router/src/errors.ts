export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'invalid_output'
  | 'not_configured';

/**
 * 所有 provider 错误都归一成这几种，路由层据此决定「要不要重试」「能不能降级」。
 * 未归一化的错误丢给上层是排障噩梦。
 */
export class LlmError extends Error {
  kind: LlmErrorKind;
  status: number | null;
  retryable: boolean;

  constructor(kind: LlmErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
    // 鉴权失败与输出不合法重试也没用；限流/超时/网络/5xx 值得再试一次
    this.retryable = kind === 'rate_limit' || kind === 'timeout' || kind === 'network' || kind === 'server';
  }
}

export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return new LlmError('timeout', '请求超时');
    return new LlmError('network', error.message);
  }
  return new LlmError('network', String(error));
}
