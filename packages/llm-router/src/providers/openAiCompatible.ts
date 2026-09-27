import { LlmError, toLlmError } from '../errors.ts';
import type { LlmProvider, ProviderRequest, ProviderResponse } from '../types.ts';

export interface OpenAiCompatibleOptions {
  name: string;
  apiKey: string;
  baseUrl: string;
}

interface ChatCompletionBody {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function classify(status: number, detail: string): LlmError {
  if (status === 401 || status === 403) return new LlmError('auth', `${status} 鉴权失败：${detail}`, status);
  if (status === 429) return new LlmError('rate_limit', `429 触发限流：${detail}`, status);
  if (status >= 500) return new LlmError('server', `${status} 服务端错误：${detail}`, status);
  return new LlmError('network', `${status} 请求失败：${detail}`, status);
}

function extractDelta(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
    return parsed.choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}

/**
 * OpenAI 兼容协议的 provider。
 * DeepSeek / OpenAI / 大多数第三方中转都走这个形状，所以只写一份。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.configured = this.apiKey.length > 0;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const { response, done } = await this.send(request, false);
    try {
      const body = (await response.json()) as ChatCompletionBody;
      const text = body.choices?.[0]?.message?.content ?? '';
      if (text.length === 0) throw new LlmError('invalid_output', '模型返回了空内容');
      return {
        text,
        inTokens: body.usage?.prompt_tokens ?? 0,
        outTokens: body.usage?.completion_tokens ?? 0,
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError('invalid_output', `解析响应失败：${String(error)}`);
    } finally {
      done();
    }
  }

  async *stream(request: ProviderRequest): AsyncIterable<string> {
    const { response, done } = await this.send(request, true);
    try {
      if (!response.body) throw new LlmError('invalid_output', '响应没有 body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });

        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload !== '[DONE]') {
              const delta = extractDelta(payload);
              if (delta.length > 0) yield delta;
            }
          }
          index = buffer.indexOf('\n');
        }
      }
    } finally {
      done();
    }
  }

  /** 发请求。返回的 done() 必须被调用，否则超时定时器会一直挂着。 */
  private async send(
    request: ProviderRequest,
    stream: boolean,
  ): Promise<{ response: Response; done: () => void }> {
    if (!this.configured) {
      throw new LlmError('not_configured', `${this.name} 未配置 API Key`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    const done = (): void => clearTimeout(timer);

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.json) body['response_format'] = { type: 'json_object' };

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // 注意：detail 来自供应商，落盘前仍会过一遍脱敏器
        throw classify(response.status, detail.slice(0, 300));
      }

      return { response, done };
    } catch (error) {
      done();
      throw toLlmError(error);
    }
  }
}
