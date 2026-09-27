import type { LlmProvider, ProviderRequest, ProviderResponse } from '../types.ts';

export interface MockProviderOptions {
  /** 自定义应答；不传就用 defaultReply */
  respond?: (request: ProviderRequest) => string | Promise<string>;
  defaultReply?: string;
  /** 前 N 次调用先抛错，用于测重试与降级 */
  failTimes?: number;
  failWith?: Error;
  /** 每次调用的模拟延迟 */
  delayMs?: number;
}

/** 估算 token：按 4 字符 ≈ 1 token，只用于测试与离线跑通链路 */
const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly configured = true;

  /** 记录每次收到的请求，方便断言提示词内容 */
  readonly received: ProviderRequest[] = [];

  private readonly respond: (request: ProviderRequest) => string | Promise<string>;
  private readonly delayMs: number;
  private remainingFailures: number;
  private readonly failWith: Error;

  constructor(options: MockProviderOptions = {}) {
    const fallback = options.defaultReply ?? '{}';
    this.respond = options.respond ?? (() => fallback);
    this.delayMs = options.delayMs ?? 0;
    this.remainingFailures = options.failTimes ?? 0;
    this.failWith = options.failWith ?? new Error('mock 故障');
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.received.push(request);
    await this.maybeDelay();
    this.maybeFail();
    const text = await this.respond(request);
    return {
      text,
      inTokens: estimateTokens(JSON.stringify(request.messages)),
      outTokens: estimateTokens(text),
    };
  }

  async *stream(request: ProviderRequest): AsyncIterable<string> {
    this.received.push(request);
    await this.maybeDelay();
    this.maybeFail();
    const text = await this.respond(request);
    for (const chunk of text.match(/[\s\S]{1,8}/g) ?? []) yield chunk;
  }

  private async maybeDelay(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  private maybeFail(): void {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw this.failWith;
    }
  }
}
