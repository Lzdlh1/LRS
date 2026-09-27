import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../src/errors.ts';
import { estimateCost } from '../src/pricing.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { LlmRouter, type RouterOptions } from '../src/router.ts';
import { Semaphore } from '../src/semaphore.ts';
import type { LlmProvider, LlmUsage, ProviderResponse } from '../src/types.ts';

class UnconfiguredProvider implements LlmProvider {
  readonly name = 'unconfigured';
  readonly configured = false;

  async complete(): Promise<ProviderResponse> {
    throw new Error('未配置的 provider 不该被调用');
  }

  async *stream(): AsyncIterable<string> {
    throw new Error('未配置的 provider 不该被调用');
  }
}

interface Harness {
  router: LlmRouter;
  strong: MockProvider;
  cheap: MockProvider;
  usages: LlmUsage[];
}

function makeRouter(
  strong: MockProvider = new MockProvider({ defaultReply: 'strong-reply' }),
  cheap: MockProvider = new MockProvider({ defaultReply: 'cheap-reply' }),
  extra: Partial<RouterOptions> = {},
): Harness {
  const usages: LlmUsage[] = [];
  const router = new LlmRouter({
    providers: { strong, cheap, unconfigured: new UnconfiguredProvider() },
    tiers: {
      cheap: { provider: 'cheap', model: 'deepseek-chat' },
      strong: { provider: 'strong', model: 'deepseek-reasoner' },
    },
    onUsage: (usage) => usages.push(usage),
    ...extra,
  });
  return { router, strong, cheap, usages };
}

const ask = (tier: 'cheap' | 'strong', task = 'test') => ({
  tier,
  task,
  messages: [{ role: 'user' as const, content: '你好' }],
});

describe('档位路由', () => {
  it('cheap 与 strong 分别打到绑定的模型', async () => {
    const { router, strong, cheap } = makeRouter();

    const low = await router.complete(ask('cheap'));
    const high = await router.complete(ask('strong'));

    expect(low.value).toBe('cheap-reply');
    expect(low.usage.model).toBe('deepseek-chat');
    expect(high.value).toBe('strong-reply');
    expect(high.usage.model).toBe('deepseek-reasoner');
    expect(strong.received).toHaveLength(1);
    expect(cheap.received).toHaveLength(1);
  });

  it('记录用量并估算成本', async () => {
    const { router, usages } = makeRouter();
    const result = await router.complete(ask('cheap'));

    expect(result.usage.ok).toBe(true);
    expect(result.usage.inTokens).toBeGreaterThan(0);
    expect(usages).toHaveLength(1);
    expect(usages[0]?.cost).toBeCloseTo(
      estimateCost('deepseek-chat', result.usage.inTokens, result.usage.outTokens),
      10,
    );
  });

  it('provider 未配置 Key 时直接报 not_configured，不重试', async () => {
    const { router } = makeRouter(new MockProvider(), new MockProvider(), {
      tiers: {
        cheap: { provider: 'unconfigured', model: 'x' },
        strong: { provider: 'unconfigured', model: 'x' },
      },
      degradeStrongToCheap: false,
    });

    await expect(router.complete(ask('cheap'))).rejects.toMatchObject({ kind: 'not_configured' });
    expect(router.available).toBe(false);
  });
});

describe('重试与降级', () => {
  it('可重试的错误会重试，第二次成功', async () => {
    const strong = new MockProvider({
      defaultReply: 'ok',
      failTimes: 1,
      failWith: new LlmError('rate_limit', '429'),
    });
    const { router, usages } = makeRouter(strong, new MockProvider(), { maxRetries: 2 });

    const result = await router.complete(ask('strong'));
    expect(result.value).toBe('ok');
    expect(result.usage.attempts).toBe(2);
    expect(usages.filter((u) => u.ok)).toHaveLength(1);
  });

  it('鉴权失败不重试', async () => {
    const strong = new MockProvider({
      failTimes: 5,
      failWith: new LlmError('auth', '401'),
    });
    const { router } = makeRouter(strong, new MockProvider(), {
      maxRetries: 3,
      degradeStrongToCheap: false,
    });

    await expect(router.complete(ask('strong'))).rejects.toMatchObject({ kind: 'auth' });
    expect(strong.received).toHaveLength(1);
  });

  it('strong 全挂时降级到 cheap，并标记 degraded', async () => {
    const strong = new MockProvider({
      failTimes: 10,
      failWith: new LlmError('server', '500'),
    });
    const { router, usages } = makeRouter(strong, new MockProvider({ defaultReply: 'cheap 兜底' }), {
      maxRetries: 1,
    });

    const result = await router.complete(ask('strong'));
    expect(result.value).toBe('cheap 兜底');
    expect(result.usage.tier).toBe('cheap');
    expect(result.usage.degraded).toBe(true);
    expect(usages[usages.length - 1]?.ok).toBe(true);
  });

  it('全部失败时上报一条 ok=false 的用量', async () => {
    const strong = new MockProvider({ failTimes: 10, failWith: new LlmError('server', '500') });
    const cheap = new MockProvider({ failTimes: 10, failWith: new LlmError('server', '500') });
    const { router, usages } = makeRouter(strong, cheap, { maxRetries: 0 });

    await expect(router.complete(ask('strong'))).rejects.toMatchObject({ kind: 'server' });
    const failure = usages.find((usage) => !usage.ok);
    expect(failure).toBeDefined();
    expect(failure?.error).toContain('500');
  });
});

describe('结构化输出', () => {
  const schema = z.object({ target: z.number().int(), reason: z.string().min(1) });

  it('合法 JSON 直接通过', async () => {
    const provider = new MockProvider({ defaultReply: '{"target":3,"reason":"像狼"}' });
    const { router } = makeRouter(provider);

    const result = await router.completeJson({ ...ask('strong'), schema });
    expect(result.value).toEqual({ target: 3, reason: '像狼' });
  });

  it('兼容被 markdown 代码块包住的 JSON', async () => {
    const provider = new MockProvider({ defaultReply: '```json\n{"target":5,"reason":"跟票"}\n```' });
    const { router } = makeRouter(provider);

    const result = await router.completeJson({ ...ask('strong'), schema });
    expect(result.value.target).toBe(5);
  });

  it('首次不合规会把错误回灌给模型重写一次', async () => {
    let call = 0;
    const provider = new MockProvider({
      respond: () => {
        call += 1;
        return call === 1 ? '{"target":"三号"}' : '{"target":9,"reason":"改好了"}';
      },
    });
    const { router } = makeRouter(provider);

    const result = await router.completeJson({ ...ask('strong'), schema });
    expect(result.value).toEqual({ target: 9, reason: '改好了' });

    // 第二次请求里带上了「上次输出不合规」的提示
    const second = provider.received[1];
    expect(JSON.stringify(second?.messages)).toContain('不符合要求');
    expect(second?.json).toBe(true);
  });

  it('连续不合规会抛 invalid_output', async () => {
    const provider = new MockProvider({ defaultReply: '完全不是 JSON' });
    const { router } = makeRouter(provider);

    await expect(router.completeJson({ ...ask('strong'), schema })).rejects.toMatchObject({
      kind: 'invalid_output',
    });
    expect(provider.received).toHaveLength(2);
  });

  it('关闭重写后只尝试一次', async () => {
    const provider = new MockProvider({ defaultReply: '不是 JSON' });
    const { router } = makeRouter(provider, new MockProvider(), { repairInvalidJson: false });

    await expect(router.completeJson({ ...ask('strong'), schema })).rejects.toMatchObject({
      kind: 'invalid_output',
    });
    expect(provider.received).toHaveLength(1);
  });
});

describe('流式输出', () => {
  it('逐块吐出内容', async () => {
    const provider = new MockProvider({ defaultReply: '一二三四五六七八九十' });
    const { router, usages } = makeRouter(new MockProvider(), provider);

    const chunks: string[] = [];
    for await (const chunk of router.stream(ask('cheap', 'speech'))) chunks.push(chunk);

    expect(chunks.join('')).toBe('一二三四五六七八九十');
    expect(chunks.length).toBeGreaterThan(1);
    expect(usages[0]?.task).toBe('speech');
    expect(usages[0]?.ok).toBe(true);
  });

  it('未配置时直接抛错', async () => {
    const { router } = makeRouter(new MockProvider(), new MockProvider(), {
      tiers: {
        cheap: { provider: 'unconfigured', model: 'x' },
        strong: { provider: 'strong', model: 'x' },
      },
    });

    const iterate = async (): Promise<void> => {
      for await (const _ of router.stream(ask('cheap'))) void _;
    };
    await expect(iterate()).rejects.toMatchObject({ kind: 'not_configured' });
  });
});

describe('并发闸门', () => {
  it('limit=1 时任务严格串行', async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];

    const task = async (id: number): Promise<void> => {
      const release = await semaphore.acquire();
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();
    };

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('release 后可以继续领取', async () => {
    const semaphore = new Semaphore(2);
    const a = await semaphore.acquire();
    const b = await semaphore.acquire();
    expect(semaphore.queueLength).toBe(0);
    a();
    b();
    const c = await semaphore.acquire();
    c();
    expect(semaphore.queueLength).toBe(0);
  });
});

describe('错误归一化', () => {
  it('未知异常会被归成 network 并标记可重试', async () => {
    const provider = new MockProvider({ failTimes: 1, failWith: new Error('socket hang up') });
    const { router } = makeRouter(provider, new MockProvider(), { maxRetries: 1 });

    const result = await router.complete(ask('strong'));
    expect(result.usage.attempts).toBe(2);
  });

  it('fetch 的 AbortError 被识别为超时', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const provider = new MockProvider({ failTimes: 1, failWith: abort });
    const { router } = makeRouter(provider, new MockProvider(), { maxRetries: 0, degradeStrongToCheap: false });

    await expect(router.complete(ask('strong'))).rejects.toMatchObject({ kind: 'timeout' });
  });
});
