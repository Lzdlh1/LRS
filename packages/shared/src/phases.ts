import { z } from 'zod';

/**
 * 阶段枚举。
 *
 * 注意这里是「阶段名」的集合，不代表执行顺序 —— 执行顺序由状态机决定。
 * 实际顺序（变体 A）：
 *   第 1 夜  → NIGHT_GUARD → NIGHT_WOLF → NIGHT_WITCH → NIGHT_SEER
 *   第 1 天  → CHIEF_* → DAWN_ANNOUNCE → LAST_WORDS → HUNTER_SHOOT
 *              → DAY_SPEECH → DAY_VOTE → [DAY_PK_*] → LAST_WORDS → HUNTER_SHOOT
 *   第 N 夜/天 → 同上，但没有 CHIEF_*
 */
export const PHASES = [
  'SETUP',

  // 夜晚（顺序固定：守卫 → 狼人 → 女巫 → 预言家）
  'NIGHT_GUARD',
  'NIGHT_WOLF',
  'NIGHT_WITCH',
  'NIGHT_SEER',

  // 警长竞选（仅第 1 天，排在公布死讯之前）
  'CHIEF_SIGNUP',
  'CHIEF_SPEECH',
  'CHIEF_WITHDRAW',
  'CHIEF_VOTE',
  'CHIEF_PK_SPEECH',
  'CHIEF_PK_VOTE',

  // 天亮结算
  'DAWN_ANNOUNCE',
  'CHIEF_TRANSFER',
  'LAST_WORDS',
  'HUNTER_SHOOT',

  // 白天
  'DAY_SPEECH',
  'DAY_VOTE',
  'DAY_PK_SPEECH',
  'DAY_PK_VOTE',

  // 结束
  'GAME_OVER',
] as const;

export type Phase = (typeof PHASES)[number];
export const phaseSchema = z.enum(PHASES);

export const NIGHT_PHASES = [
  'NIGHT_GUARD',
  'NIGHT_WOLF',
  'NIGHT_WITCH',
  'NIGHT_SEER',
] as const satisfies readonly Phase[];

export function isNightPhase(phase: Phase): boolean {
  return (NIGHT_PHASES as readonly Phase[]).includes(phase);
}

export const CHIEF_PHASES = [
  'CHIEF_SIGNUP',
  'CHIEF_SPEECH',
  'CHIEF_WITHDRAW',
  'CHIEF_VOTE',
  'CHIEF_PK_SPEECH',
  'CHIEF_PK_VOTE',
] as const satisfies readonly Phase[];

export function isChiefPhase(phase: Phase): boolean {
  return (CHIEF_PHASES as readonly Phase[]).includes(phase);
}

/** 发言场景，用于区分同样是「说话」但语境不同的发言 */
export const SPEECH_CONTEXTS = [
  'chief_campaign',
  'chief_pk',
  'day',
  'day_pk',
  'last_words',
] as const;
export type SpeechContext = (typeof SPEECH_CONTEXTS)[number];
export const speechContextSchema = z.enum(SPEECH_CONTEXTS);
