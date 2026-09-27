import type { Logger } from '@lrs/shared';
import type { ZodType } from 'zod';
import { LlmError, toLlmError } from './errors.ts';
import { estimateCost } from './pricing.ts';
import { Semaphore } from './semaphore.ts';
import type { ChatMessage, LlmProvider, LlmResult, LlmTier, LlmUsage, ProviderRequest } from './types.ts';

export interface TierBinding {
  provider: string;
  model: string;
}

export interface RouterOptions {
  providers: Record<string, LlmProvider>;
  tiers: Record<LlmTier, TierBinding>;
  timeoutMs?: Partial<Record<LlmTier, number>>;
  /** 单个档位内部的重试次数（不含首次） */
  maxRetries?: number;
  /** 全局并发上限，避免 8 个 AI 一起把供应商打到限流 */
  maxConcurrency?: number;
  /** strong 全部失败时，降级到 cheap 再试一遍 */
  degradeStrongToCheap?: boolean;
  /** JSON 输出不合规时，把错误回灌让模型重写一次 */
  repairInvalidJson?: boolean;
  logger?: Logger;
  onUsage?: (usage: LlmUsage) => void;
}

export interface RouterRequest {
  tier: LlmTier;
  /** 任务名，用于日志与成本归类，例如 'vote' / 'speech' */
  task: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
}

const TIERS: LlmTier[] = ['cheap', 'strong'];
const DEFAULT_TIMEOUT_MS: Record<LlmTier, number> = { cheap: 30_000, strong: 90_000 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 模型有时会把 JSON 包在 markdown 代码块里，这里统一剥掉 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

const roughTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; issue: string };

/**
 * 模型路由层。上层只说「这是 cheap 任务」或「这是 strong 任务」，
 * 由这里负责选 provider、限流、重试、降级、校验与记用量。
 * 全项目只有这一处知道 API Key 与模型名。
 */
export class LlmRouter {
  private readonly providers: Record<string, LlmProvider>;
  private readonly tiers: Record<LlmTier, TierBinding>;
  private readonly timeoutMs: Record<LlmTier, number>;
  private readonly maxRetries: number;
  private readonly degrade: boolean;
  private readonly repair: boolean;
  private readonly logger: Logger | null;
  private readonly onUsage: ((usage: LlmUsage) => void) | null;
  private readonly semaphore: Semaphore;

  constructor(options: RouterOptions) {
    this.providers = options.providers;
    this.tiers = options.tiers;
    this.timeoutMs = { ...DEFAULT_TIMEOUT_MS, ...options.timeoutMs };
    this.maxRetries = options.maxRetries ?? 1;
    this.degrade = options.degradeStrongToCheap ?? true;
    this.repair = options.repairInvalidJson ?? true;
    this.logger = options.logger ?? null;
    this.onUsage = options.onUsage ?? null;
    this.semaphore = new Semaphore(options.maxConcurrency ?? 4);
  }

  /** 两个档位的 provider 是否都配好了 Key */
  get available(): boolean {
    return TIERS.every((tier) => this.providers[this.tiers[tier].provider]?.configured ?? false);
  }

  get bindings(): Record<LlmTier, TierBinding> {
    return { cheap: { ...this.tiers.cheap }, strong: { ...this.tiers.strong } };
  }

  async complete(request: RouterRequest): Promise<LlmResult<string>> {
    return this.run(request);
  }

  /** 要求模型输出符合 schema 的 JSON；不合规会自动要求重写一次 */
  async completeJson<T>(request: RouterRequest & { schema: ZodType<T> }): Promise<LlmResult<T>> {
    const messages: ChatMessage[] = [...request.messages];
    const rounds = this.repair ? 2 : 1;
    const startedAt = Date.now();
    let totalAttempts = 0;
    let lastIssue = '';

    for (let round = 0; round < rounds; round += 1) {
      const result = await this.run({ ...request, messages, json: true });
      totalAttempts += result.usage.attempts;

      const outcome = this.parseJson(result.value, request.schema);
      if (outcome.ok) {
        return {
          value: outcome.value,
          usage: { ...result.usage, attempts: totalAttempts, latencyMs: Date.now() - startedAt },
        };
      }

      lastIssue = outcome.issue;
      this.logger?.warn('模型输出不合规，要求重写', {
        task: request.task,
        round,
        issue: outcome.issue,
      });
      messages.push({ role: 'assistant', content: result.value });
      messages.push({
        role: 'user',
        content: `你上一次的输出不符合要求：${outcome.issue}\n请只输出一个合法的 JSON 对象，不要解释、不要 markdown 代码块。`,
      });
    }

    throw new LlmError('invalid_output', `模型连续输出不合规：${lastIssue}`);
  }

  async *stream(request: RouterRequest): AsyncIterable<string> {
    const binding = this.tiers[request.tier];
    const provider = this.providers[binding.provider];
    if (!provider?.configured) {
      throw new LlmError('not_configured', `provider「${binding.provider}」未配置 API Key`);
    }

    const startedAt = Date.now();
    const release = await this.semaphore.acquire();
    let text = '';

    try {
      for await (const chunk of provider.stream(
        this.toProviderRequest(request, binding.model, this.timeoutMs[request.tier]),
      )) {
        text += chunk;
        yield chunk;
      }

      // 流式响应拿不到供应商的 usage，这里按字符数估算 —— 标成估算值，别当真账
      const inTokens = roughTokens(JSON.stringify(request.messages));
      const outTokens = roughTokens(text);
      this.report({
        task: request.task,
        tier: request.tier,
        provider: binding.provider,
        model: binding.model,
        inTokens,
        outTokens,
        cost: estimateCost(binding.model, inTokens, outTokens),
        latencyMs: Date.now() - startedAt,
        attempts: 1,
        degraded: false,
        ok: true,
      });
    } catch (error) {
      const llmError = toLlmError(error);
      this.logger?.warn('流式调用失败', {
        task: request.task,
        provider: binding.provider,
        kind: llmError.kind,
        message: llmError.message,
      });
      this.report({
        task: request.task,
        tier: request.tier,
        provider: binding.provider,
        model: binding.model,
        inTokens: 0,
        outTokens: 0,
        cost: 0,
        latencyMs: Date.now() - startedAt,
        attempts: 1,
        degraded: false,
        ok: false,
        error: llmError.message,
      });
      throw llmError;
    } finally {
      release();
    }
  }

  // ── 内部 ──

  private async run(request: RouterRequest): Promise<LlmResult<string>> {
    const order: LlmTier[] =
      request.tier === 'strong' && this.degrade ? ['strong', 'cheap'] : [request.tier];

    const startedAt = Date.now();
    let attempts = 0;
    let degraded = false;
    let lastError: LlmError | null = null;

    for (let index = 0; index < order.length; index += 1) {
      const tier = order[index]!;
      if (index > 0) degraded = true;

      const binding = this.tiers[tier];
      const provider = this.providers[binding.provider];

      if (!provider) {
        lastError = new LlmError('not_configured', `provider「${binding.provider}」未注册`);
        continue;
      }
      if (!provider.configured) {
        lastError = new LlmError('not_configured', `provider「${binding.provider}」未配置 API Key`);
        continue;
      }

      for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
        attempts += 1;
        const release = await this.semaphore.acquire();
        try {
          const response = await provider.complete(
            this.toProviderRequest(request, binding.model, this.timeoutMs[tier]),
          );
          const usage: LlmUsage = {
            task: request.task,
            tier,
            provider: binding.provider,
            model: binding.model,
            inTokens: response.inTokens,
            outTokens: response.outTokens,
            cost: estimateCost(binding.model, response.inTokens, response.outTokens),
            latencyMs: Date.now() - startedAt,
            attempts,
            degraded,
            ok: true,
          };
          this.report(usage);
          return { value: response.text, usage };
        } catch (error) {
          lastError = toLlmError(error);
          this.logger?.warn('模型调用失败', {
            task: request.task,
            tier,
            provider: binding.provider,
            model: binding.model,
            attempt,
            kind: lastError.kind,
            message: lastError.message,
          });
          if (!lastError.retryable) break;
          if (attempt <= this.maxRetries) await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
        } finally {
          release();
        }
      }
    }

    this.report({
      task: request.task,
      tier: request.tier,
      provider: '',
      model: '',
      inTokens: 0,
      outTokens: 0,
      cost: 0,
      latencyMs: Date.now() - startedAt,
      attempts,
      degraded,
      ok: false,
      error: lastError?.message ?? '未知错误',
    });
    throw lastError ?? new LlmError('not_configured', '没有可用的模型');
  }

  private parseJson<T>(text: string, schema: ZodType<T>): ParseOutcome<T> {
    let raw: unknown;
    try {
      raw = JSON.parse(stripCodeFence(text));
    } catch (error) {
      return { ok: false, issue: `不是合法 JSON（${String(error)}）` };
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues
        .map((item) => `${item.path.join('.') || '(根)'}: ${item.message}`)
        .join('；');
      return { ok: false, issue };
    }
    return { ok: true, value: parsed.data };
  }

  private toProviderRequest(request: RouterRequest, model: string, timeoutMs: number): ProviderRequest {
    const output: ProviderRequest = { model, messages: request.messages, timeoutMs };
    if (request.maxTokens !== undefined) output.maxTokens = request.maxTokens;
    if (request.temperature !== undefined) output.temperature = request.temperature;
    if (request.json !== undefined) output.json = request.json;
    return output;
  }

  private report(usage: LlmUsage): void {
    this.onUsage?.(usage);
    const fields = {
      task: usage.task,
      tier: usage.tier,
      provider: usage.provider,
      model: usage.model,
      inTokens: usage.inTokens,
      outTokens: usage.outTokens,
      // 保留 6 位小数，单次调用的成本本来就很小
      cost: Number(usage.cost.toFixed(6)),
      latencyMs: usage.latencyMs,
      attempts: usage.attempts,
      degraded: usage.degraded,
      ok: usage.ok,
    };
    if (usage.ok) this.logger?.debug('模型调用完成', fields);
    else this.logger?.warn('模型调用最终失败', { ...fields, error: usage.error });
  }
}
