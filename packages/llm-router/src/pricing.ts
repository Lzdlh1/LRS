export interface ModelPrice {
  /** 每百万输入 token 的价格（元） */
  input: number;
  /** 每百万输出 token 的价格（元） */
  output: number;
}

/**
 * 价格表。**这是估算值，官方随时会调**，只用于成本看板给个量级。
 * 想精确对账请以供应商账单为准。
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-chat': { input: 2, output: 8 },
  'deepseek-reasoner': { input: 4, output: 16 },
  'gpt-4o-mini': { input: 1.1, output: 4.4 },
  'gpt-4o': { input: 18, output: 72 },
};

export function estimateCost(model: string, inTokens: number, outTokens: number): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  return (inTokens / 1_000_000) * price.input + (outTokens / 1_000_000) * price.output;
}
