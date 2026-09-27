import type { Role, SeatId } from '@lrs/shared';

export const MOODS = ['confident', 'anxious', 'confused', 'excited', 'calm'] as const;
export type Mood = (typeof MOODS)[number];

export const MOOD_LABELS: Record<Mood, string> = {
  confident: '自信',
  anxious: '焦虑',
  confused: '迷茫',
  excited: '亢奋',
  calm: '平静',
};

/** 对某个座位的推断 */
export interface SeatRead {
  seat: SeatId;
  guess: Role | 'unknown';
  /** 0-1 */
  confidence: number;
  reason: string;
}

/**
 * M2 信念层：AI 的主观推断，结构化存储。
 *
 * 与事实层严格分开 —— 事实层是引擎喂的（不会错），信念层是模型推的（会错），
 * 混在一起就再也分不清「它记错了」还是「它推错了」。
 */
export interface Belief {
  reads: SeatRead[];
  /** 今天想推谁 */
  push: SeatId | null;
  /** 一句话立场 */
  stance: string;
  mood: Mood;
}

export function createBelief(seats: readonly SeatId[], self: SeatId): Belief {
  return {
    reads: seats
      .filter((seat) => seat !== self)
      .map((seat) => ({ seat, guess: 'unknown', confidence: 0.5, reason: '还没有信息' })),
    push: null,
    stance: '先听听大家怎么说',
    mood: 'calm',
  };
}

/** 用模型给出的新判断覆盖旧的；只覆盖它提到的座位，其余保持不变 */
export function mergeReads(belief: Belief, updates: readonly SeatRead[]): void {
  for (const update of updates) {
    const index = belief.reads.findIndex((read) => read.seat === update.seat);
    if (index >= 0) belief.reads[index] = { ...update };
    else belief.reads.push({ ...update });
  }
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return '很确定';
  if (confidence >= 0.6) return '比较确定';
  if (confidence >= 0.4) return '偏向';
  return '拿不准';
}
