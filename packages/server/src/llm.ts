import { LlmRouter, OpenAiCompatibleProvider, type LlmProvider, type LlmUsage } from '@lrs/llm-router';
import type { Logger } from '@lrs/shared';
import type { LlmConfig } from './config.ts';

export interface LlmBundle {
  router: LlmRouter;
  /** 目标档位的 provider 是否都配好了 Key */
  live: boolean;
  /** 给日志与启动提示用的一句话 */
  summary: string;
}

/**
 * 组装模型路由。
 *
 * 这里只放「有哪些 provider」，不放任何 Key —— Key 从环境变量来，
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
