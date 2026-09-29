import { z } from 'zod';
import { actionOptionSchema } from './actions.ts';
import { seatIdSchema } from './ids.ts';
import { phaseSchema, speechContextSchema } from './phases.ts';
import { campSchema, roleSchema } from './roles.ts';

/**
 * 事件可见范围。
 *
 * 引擎只负责「标记」，真正按 visibility 过滤是 session-service 的事 ——
 * 这样玩家视角 / 上帝视角的切换不依赖前端，前端也刷不出底牌。
 */
export const visibilitySchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('public') }),
  z.object({ scope: z.literal('seats'), seats: z.array(seatIdSchema).min(1) }),
]);
export type Visibility = z.infer<typeof visibilitySchema>;

export const publicSeatSchema = z.object({
  seat: seatIdSchema,
  name: z.string(),
  isHuman: z.boolean(),
});
export type PublicSeat = z.infer<typeof publicSeatSchema>;

/** 死亡原因 */
export const DEATH_CAUSES = ['wolf', 'poison', 'vote', 'gun'] as const;
export type DeathCause = (typeof DEATH_CAUSES)[number];
export const deathCauseSchema = z.enum(DEATH_CAUSES);

const tallySchema = z.array(
  z.object({ seat: seatIdSchema, votes: z.number().min(0) }),
);

export const eventPayloadSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('game_started'),
    board: z.string(),
    seats: z.array(publicSeatSchema),
  }),

  // ── 私密事件 ──
  z.object({
    t: z.literal('role_assigned'),
    seat: seatIdSchema,
    role: roleSchema,
  }),
  z.object({
    t: z.literal('wolf_teammates'),
    seat: seatIdSchema,
    mates: z.array(seatIdSchema),
  }),

  // ── 阶段推进 ──
  z.object({
    t: z.literal('phase_changed'),
    from: phaseSchema,
    to: phaseSchema,
  }),
  z.object({
    t: z.literal('action_requested'),
    seat: seatIdSchema,
    options: z.array(actionOptionSchema).min(1),
    /**
     * 相对当前时刻的应答时限（毫秒）。
     * 引擎不持有定时器、也不知道真实时间 —— 计时与超时代打由 session-service 负责。
     */
    deadlineMs: z.number().int().positive(),
  }),
  z.object({
    t: z.literal('action_rejected'),
    seat: seatIdSchema,
    reason: z.string(),
  }),

  // ── 发言 ──
  z.object({
    t: z.literal('spoke'),
    seat: seatIdSchema,
    text: z.string(),
    context: speechContextSchema,
    /**
     * 这次发言从「开始发言」到「说完」的墙钟毫秒数。
     *
     * 可选：只有能可靠测出起点与终点的路径才带（AI 从发起生成请求到产出文本、
     * 真人从下发待办到提交）。复盘、补发、快照重放这类拿不到起点的路径就不填，
     * 老数据（没有这个字段）也照样通过校验。
     */
    ms: z.number().int().min(0).optional(),
  }),

  // ── 夜晚私有信息 ──
  z.object({
    t: z.literal('seer_result'),
    seat: seatIdSchema,
    target: seatIdSchema,
    camp: campSchema,
  }),
  z.object({
    t: z.literal('witch_night_info'),
    seat: seatIdSchema,
    /** 今夜被狼刀的人；无人被刀则为 null */
    killed: z.union([seatIdSchema, z.null()]),
  }),

  // ── 警长竞选 ──
  z.object({
    t: z.literal('chief_signup_result'),
    /** 上警的座位（按座位号升序） */
    candidates: z.array(seatIdSchema),
  }),
  z.object({
    t: z.literal('chief_withdrawn'),
    seat: seatIdSchema,
  }),
  z.object({
    t: z.literal('chief_vote_tally'),
    counts: tallySchema,
    /** null 表示再次平票、警徽流失 */
    elected: z.union([seatIdSchema, z.null()]),
    tie: z.boolean(),
  }),
  z.object({
    t: z.literal('chief_transferred'),
    from: seatIdSchema,
    /** null 表示撕毁警徽 */
    to: z.union([seatIdSchema, z.null()]),
  }),

  // ── 白天投票 ──
  z.object({
    t: z.literal('voted'),
    seat: seatIdSchema,
    target: z.union([seatIdSchema, z.literal('abstain')]),
  }),
  z.object({
    t: z.literal('vote_tally'),
    counts: tallySchema,
    /** null 表示平票无人出局 */
    eliminated: z.union([seatIdSchema, z.null()]),
    tie: z.boolean(),
  }),

  // ── 死亡与技能结算 ──
  z.object({
    t: z.literal('died'),
    seat: seatIdSchema,
    cause: deathCauseSchema,
  }),
  z.object({
    t: z.literal('hunter_shot'),
    seat: seatIdSchema,
    /** null 表示放弃开枪 */
    target: z.union([seatIdSchema, z.null()]),
  }),

  // ── 结束 ──
  z.object({
    t: z.literal('game_over'),
    winner: campSchema,
    reveal: z.array(z.object({ seat: seatIdSchema, role: roleSchema })),
  }),
]);
export type EventPayload = z.infer<typeof eventPayloadSchema>;

/** payload 的 t 取值 */
export type EventType = EventPayload['t'];

/**
 * GameEvent —— 引擎吐出来的东西。
 *
 * seq 单调递增，是事件溯源的主键：复盘 = 按 seq 回放，AI 记忆 = 从事件流投影。
 */
export const gameEventSchema = z.object({
  seq: z.number().int().min(1),
  /** 天数。开局与阶段准备为 0，第 1 夜起为 1 */
  day: z.number().int().min(0),
  phase: phaseSchema,
  visibility: visibilitySchema,
  payload: eventPayloadSchema,
});
export type GameEvent = z.infer<typeof gameEventSchema>;
