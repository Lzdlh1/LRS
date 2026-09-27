import { z } from 'zod';

/**
 * 座位号：从 1 开始，顺时针排列。
 * 座位顺序同时就是默认的发言顺序，因此座位号本身带语义，不要随意打乱。
 */
export type SeatId = number;

export const seatIdSchema = z.number().int().min(1);

/** 对局 id */
export type GameId = string;

/** 9 人板子的座位数 */
export const SEAT_COUNT_9 = 9;

/** 生成 1..count 的座位号列表 */
export function seatRange(count: number): SeatId[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}
