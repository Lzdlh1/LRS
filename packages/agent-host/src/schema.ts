import { ROLES } from '@lrs/shared';
import { z } from 'zod';
import { MOODS } from './memory/belief.ts';

/**
 * 身份猜测的取值范围。
 * 注意与 shared 的 ROLES 保持一致（有测试守着），多出来的 'unknown' 表示还没判断。
 */
export const GUESS_VALUES = [
  'werewolf',
  'seer',
  'witch',
  'hunter',
  'guard',
  'villager',
  'unknown',
] as const;

export const readSchema = z.object({
  seat: z.number().int().min(1),
  guess: z.enum(GUESS_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(160),
});

export const claimSchema = z.object({
  role: z.enum(ROLES),
  note: z.string().max(160),
});

/**
 * 决策调用的输出。**先想后说**里的「想」全部落在这个结构里：
 * 选什么行动、为什么、以及顺带更新自己的判断表。
 */
export const decisionSchema = z.object({
  /** 从提示词给出的可选行动里挑一个（1 开始） */
  choiceIndex: z.number().int().min(1),
  reasoning: z.string().min(2).max(800),
  stance: z.string().max(200),
  push: z.number().int().min(1).nullable(),
  reads: z.array(readSchema).max(20),
  /** 本轮是否跳身份；不跳就填 null */
  claim: claimSchema.nullable(),
  mood: z.enum(MOODS),
});

export type Decision = z.infer<typeof decisionSchema>;

/**
 * 按本轮实际有多少个可选行动收紧 choiceIndex 的取值范围。
 * 这样「模型报了个不存在的序号」会被 schema 拦下，走路由层的重写流程，
 * 而不是让一个越界值悄悄溜进引擎。
 */
export function decisionSchemaWithChoices(count: number) {
  return decisionSchema.extend({ choiceIndex: z.number().int().min(1).max(count) });
}

/** 反思调用的输出：只更新判断、情绪与一句教训 */
export const reflectionSchema = z.object({
  reads: z.array(readSchema).max(20),
  mood: z.enum(MOODS),
  lesson: z.string().max(200),
  stance: z.string().max(200),
});

export type Reflection = z.infer<typeof reflectionSchema>;

/** 决策时提示词里给出的可选行动 */
export interface PromptChoice {
  index: number;
  label: string;
}
