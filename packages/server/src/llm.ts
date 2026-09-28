import { LlmRouter, OpenAiCompatibleProvider, type LlmProvider, type LlmUsage } from '@lrs/llm-router';
import type { Logger } from '@lrs/shared';
import type { LlmConfig } from './config.ts';
import type { Provider, SettingsStore } from './store/settingsStore.ts';

export interface LlmBundle {
  router: LlmRouter;
  /** 目标档位的 provider 是否都配好了 Key */
  live: boolean;
  /** 给日志与启动提示用的一句话 */
  summary: string;
}

/**
 * 把「.env 的默认值」和「界面里改过的设置」合成一份真正生效的配置。
 *
 * 优先级：**界面 > .env**。界面里配过（含清空）就以界面为准 ——
 * 否则清掉 Key 之后 `.env` 里的那个又会悄悄顶上来。
 */
export function resolveLlmConfig(env: LlmConfig, settings: SettingsStore): LlmConfig {
  const stored = settings.readLlm();
  const keyFor = (provider: Provider, fallback: string): string =>
    settings.hasOwnApiKey(provider) ? settings.apiKey(provider) : fallback;

  return {
    ...env,
    deepseekApiKey: keyFor('deepseek', env.deepseekApiKey),
    openaiApiKey: keyFor('openai', env.openaiApiKey),
    customApiKey: keyFor('custom', env.customApiKey),
    customBaseUrl: stored.baseUrl !== '' ? stored.baseUrl : env.customBaseUrl,
    cheap: { provider: stored.provider, model: stored.cheapModel },
    strong: { provider: stored.provider, model: stored.strongModel },
  };
}

/**
 * 组装模型路由。
 *
 * 这里只放「有哪些 provider」，不放任何 Key —— Key 从环境变量或设置表来，
 * 并且永远不写进日志（日志里只有「已配置 / 未配置」）。
 */
export function createLlmRouter(
  config: LlmConfig,
  logger: Logger,
  onUsage: (usage: LlmUsage) => void,
): LlmBundle {
  const providers: Record<string, LlmProvider> = {
    deepseek: new OpenAiCompatibleProvider({
      name: 'deepseek',
      apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl,
    }),
    openai: new OpenAiCompatibleProvider({
      name: 'openai',
      apiKey: config.openaiApiKey,
      baseUrl: config.openaiBaseUrl,
    }),
  };

  // 自定义端点：填了地址才注册。没填却选了它，会得到「未注册」而不是发出一个坏请求
  if (config.customBaseUrl !== '') {
    providers['custom'] = new OpenAiCompatibleProvider({
      name: 'custom',
      apiKey: config.customApiKey,
      baseUrl: config.customBaseUrl,
    });
  }

  const router = new LlmRouter({
    providers,
    tiers: { cheap: config.cheap, strong: config.strong },
    maxConcurrency: config.maxConcurrency,
    logger,
    onUsage,
  });

  const live = router.available;
  const summary = live
    ? `AI 已就绪（${config.cheap.provider}/${config.cheap.model} + ${config.strong.provider}/${config.strong.model}）`
    : '未配置任何可用的 LLM Key，AI 玩家将只能提交兜底动作（游戏仍可跑完）';

  return { router, live, summary };
}
