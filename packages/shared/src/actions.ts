import { z } from 'zod';
import { seatIdSchema } from './ids.ts';

export const ACTION_KINDS = [
  'guard_protect',
  'wolf_kill',
  'witch_act',
  'seer_check',
  'chief_signup',
  'chief_withdraw',
  'chief_transfer',
  'speak',
  'vote',
  'hunter_shoot',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const actionKindSchema = z.enum(ACTION_KINDS);

/** 女巫三种选择：用解药 / 用毒药 / 不用药 */
export const WITCH_USES = ['save', 'poison', 'pass'] as const;
export type WitchUse = (typeof WITCH_USES)[number];
export const witchUseSchema = z.enum(WITCH_USES);

/** 投票目标：某人，或弃票 */
export const voteTargetSchema = z.union([seatIdSchema, z.literal('abstain')]);
export type VoteTarget = z.infer<typeof voteTargetSchema>;

/**
 * Action —— 玩家（真人或 AI）交给引擎的东西。
 *
 * 引擎会校验合法性；不合法的 Action 会被拒绝并记为错误事件，不会改变游戏状态。
 */
export const actionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('guard_protect'),
    actor: seatIdSchema,
    target: seatIdSchema,
  }),
  z.object({
    kind: z.literal('wolf_kill'),
    /** 狼队共识只有一个结果；actor 记录「代表狼队提交这一刀的狼」 */
    actor: seatIdSchema,
    target: seatIdSchema,
  }),
  z.object({
    kind: z.literal('witch_act'),
    actor: seatIdSchema,
    use: witchUseSchema,
    /** use = 'pass' 时无目标；其余必须有目标 */
    target: seatIdSchema.optional(),
  }),
  z.object({
    kind: z.literal('seer_check'),
    actor: seatIdSchema,
    target: seatIdSchema,
  }),
  z.object({
    kind: z.literal('chief_signup'),
    actor: seatIdSchema,
    join: z.boolean(),
  }),
  z.object({
    kind: z.literal('chief_withdraw'),
    actor: seatIdSchema,
    /** true = 退水（放弃竞选，之后也无投票权）；false = 继续参选 */
    withdraw: z.boolean(),
  }),
  z.object({
    kind: z.literal('chief_transfer'),
    actor: seatIdSchema,
    /** null 表示撕毁警徽，本局不再有警长 */
    target: z.union([seatIdSchema, z.null()]),
  }),
  z.object({
    kind: z.literal('speak'),
    actor: seatIdSchema,
    text: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal('vote'),
    actor: seatIdSchema,
    target: voteTargetSchema,
  }),
  z.object({
    kind: z.literal('hunter_shoot'),
    actor: seatIdSchema,
    /** null 表示放弃开枪 */
    target: z.union([seatIdSchema, z.null()]),
  }),
]);
export type Action = z.infer<typeof actionSchema>;

/** ActionOption 的附加参数取值 */
const paramValuesSchema = z.array(z.union([z.string(), z.number(), z.boolean()]));

/**
 * ActionOption —— 引擎告诉行动者「你现在合法能做什么」。
 *
 * 这是杜绝 AI 产生非法行动的关键：AI 只需在这个集合里挑，
 * 不需要自己判断「守卫能不能连守」「女巫还有没有药」。
 */
export const actionOptionSchema = z.object({
  kind: actionKindSchema,
  /** 可选目标座位。空数组表示该选项不需要选目标（如退水、弃票） */
  targets: z.array(seatIdSchema),
  /** 附加参数：参数名 → 合法取值（如女巫的 use: ['save','pass']） */
  params: z.record(z.string(), paramValuesSchema).optional(),
  /** 给前端和 AI 看的一句人话 */
  label: z.string(),
});
export type ActionOption = z.infer<typeof actionOptionSchema>;
