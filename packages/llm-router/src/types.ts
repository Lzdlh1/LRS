/** 任务档位。上层只说「这是便宜任务」或「这是强任务」，具体用哪个模型由路由层决定。 */
export type LlmTier = 'cheap' | 'strong';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 一次调用的用量与结果，供成本看板与排障使用 */
export interface LlmUsage {
  task: string;
  tier: LlmTier;
  provider: string;
  model: string;
  inTokens: number;
  outTokens: number;
  /** 估算花费（元） */
  cost: number;
  latencyMs: number;
  attempts: number;
  /** 是否发生过重试或降级 */
  degraded: boolean;
  ok: boolean;
  error?: string;
}

export interface LlmResult<T> {
  value: T;
  usage: LlmUsage;
}

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 要求模型输出 JSON（会带上 response_format） */
  json?: boolean;
  timeoutMs: number;
}

export interface ProviderResponse {
  text: string;
  inTokens: number;
  outTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  /** 是否已配置可用（例如有没有 API Key）。未配置的 provider 会在调用前就被拦下。 */
  readonly configured: boolean;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  stream(request: ProviderRequest): AsyncIterable<string>;
}
