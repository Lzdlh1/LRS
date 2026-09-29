import { describe, expect, it } from 'vitest';
import { actionOptionSchema, actionSchema } from '../src/actions.ts';
import { gameEventSchema } from '../src/events.ts';
import { isChiefPhase, isNightPhase, PHASES } from '../src/phases.ts';
import { isGodRole, roleCamp, roleSchema } from '../src/roles.ts';

/** 每种 Action kind 各准备一个合法样本，保证枚举与 schema 不脱节 */
const VALID_ACTIONS = [
  { kind: 'guard_protect', actor: 1, target: 2 },
  { kind: 'wolf_kill', actor: 3, target: 4 },
  { kind: 'witch_act', actor: 5, use: 'save', target: 4 },
  { kind: 'witch_act', actor: 5, use: 'poison', target: 6 },
  { kind: 'witch_act', actor: 5, use: 'pass' },
  { kind: 'seer_check', actor: 7, target: 1 },
  { kind: 'chief_signup', actor: 2, join: true },
  { kind: 'chief_withdraw', actor: 2, withdraw: true },
  { kind: 'chief_withdraw', actor: 2, withdraw: false },
  { kind: 'chief_transfer', actor: 1, target: 4 },
  { kind: 'chief_transfer', actor: 1, target: null },
  { kind: 'speak', actor: 3, text: '我觉得 5 号有问题。' },
  { kind: 'vote', actor: 3, target: 5 },
  { kind: 'vote', actor: 3, target: 'abstain' },
  { kind: 'hunter_shoot', actor: 6, target: 2 },
  { kind: 'hunter_shoot', actor: 6, target: null },
];

describe('Action schema', () => {
  it.each(VALID_ACTIONS)('接受合法 Action：$kind', (action) => {
    expect(actionSchema.safeParse(action).success).toBe(true);
  });

  it('覆盖了所有声明的 Action kind', () => {
    const covered = new Set(VALID_ACTIONS.map((a) => a.kind));
    expect([...covered].sort()).toEqual([
      'chief_signup',
      'chief_transfer',
      'chief_withdraw',
      'guard_protect',
      'hunter_shoot',
      'seer_check',
      'speak',
      'vote',
      'witch_act',
      'wolf_kill',
    ]);
  });

  it('拒绝未知 kind', () => {
    expect(actionSchema.safeParse({ kind: 'fly', actor: 1 }).success).toBe(false);
  });

  it('拒绝缺失判别字段', () => {
    expect(actionSchema.safeParse({ kind: 'vote', actor: 3 }).success).toBe(false);
  });

  it('拒绝非整数座位号', () => {
    expect(actionSchema.safeParse({ kind: 'vote', actor: 1.5, target: 2 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: 'vote', actor: 0, target: 2 }).success).toBe(false);
  });

  it('拒绝空发言', () => {
    expect(actionSchema.safeParse({ kind: 'speak', actor: 1, text: '' }).success).toBe(false);
  });

  it('拒绝非法的女巫用药', () => {
    expect(actionSchema.safeParse({ kind: 'witch_act', actor: 5, use: 'kill' }).success).toBe(false);
  });
});

describe('ActionOption schema', () => {
  it('接受无 params 的最小选项', () => {
    const r = actionOptionSchema.safeParse({ kind: 'vote', targets: [1, 2, 3], label: '投票' });
    expect(r.success).toBe(true);
  });

  it('接受带 params 的选项', () => {
    const r = actionOptionSchema.safeParse({
      kind: 'witch_act',
      targets: [2, 4],
      params: { use: ['save', 'pass'] },
      label: '是否使用解药',
    });
    expect(r.success).toBe(true);
  });

  it('拒绝 params 里出现对象取值', () => {
    const r = actionOptionSchema.safeParse({
      kind: 'witch_act',
      targets: [],
      params: { use: [{ nested: true }] },
      label: 'x',
    });
    expect(r.success).toBe(false);
  });
});

describe('GameEvent schema', () => {
  it('接受公开事件', () => {
    const r = gameEventSchema.safeParse({
      seq: 1,
      day: 0,
      phase: 'SETUP',
      visibility: { scope: 'public' },
      payload: {
        t: 'game_started',
        board: '9人预女猎守',
        seats: [
          { seat: 1, name: '你', isHuman: true },
          { seat: 2, name: '阿哲', isHuman: false },
        ],
      },
    });
    expect(r.success).toBe(true);
  });

  it('接受私密事件', () => {
    const r = gameEventSchema.safeParse({
      seq: 2,
      day: 1,
      phase: 'NIGHT_SEER',
      visibility: { scope: 'seats', seats: [7] },
      payload: { t: 'seer_result', seat: 7, target: 3, camp: 'wolf' },
    });
    expect(r.success).toBe(true);
  });

  it('拒绝空 seats 私密可见范围', () => {
    const r = gameEventSchema.safeParse({
      seq: 2,
      day: 1,
      phase: 'NIGHT_SEER',
      visibility: { scope: 'seats', seats: [] },
      payload: { t: 'seer_result', seat: 7, target: 3, camp: 'wolf' },
    });
    expect(r.success).toBe(false);
  });

  it('拒绝 seq 从 0 开始', () => {
    const r = gameEventSchema.safeParse({
      seq: 0,
      day: 0,
      phase: 'SETUP',
      visibility: { scope: 'public' },
      payload: { t: 'game_started', board: 'b', seats: [] },
    });
    expect(r.success).toBe(false);
  });

  it('拒绝未知阶段', () => {
    const r = gameEventSchema.safeParse({
      seq: 1,
      day: 0,
      phase: 'NIGHT_TEA',
      visibility: { scope: 'public' },
      payload: { t: 'game_started', board: 'b', seats: [] },
    });
    expect(r.success).toBe(false);
  });

  it('action_requested 必须带至少一个选项，且 deadlineMs 为正', () => {
    const base = {
      seq: 5,
      day: 1,
      phase: 'DAY_VOTE',
      visibility: { scope: 'seats', seats: [1] },
    };
    const ok = gameEventSchema.safeParse({
      ...base,
      payload: {
        t: 'action_requested',
        seat: 1,
        options: [{ kind: 'vote', targets: [2], label: '投票' }],
        deadlineMs: 30_000,
      },
    });
    expect(ok.success).toBe(true);

    const noOptions = gameEventSchema.safeParse({
      ...base,
      payload: { t: 'action_requested', seat: 1, options: [], deadlineMs: 30_000 },
    });
    expect(noOptions.success).toBe(false);

    const zeroDeadline = gameEventSchema.safeParse({
      ...base,
      payload: {
        t: 'action_requested',
        seat: 1,
        options: [{ kind: 'vote', targets: [2], label: '投票' }],
        deadlineMs: 0,
      },
    });
    expect(zeroDeadline.success).toBe(false);
  });

  it('spoke 的 ms 可选：老数据（没有 ms）与新数据都接受，负数拒绝', () => {
    const base = { seq: 3, day: 1, phase: 'DAY_SPEECH' as const, visibility: { scope: 'public' as const } };
    const withoutMs = gameEventSchema.safeParse({
      ...base,
      payload: { t: 'spoke', seat: 2, text: '说两句', context: 'day' },
    });
    expect(withoutMs.success).toBe(true);

    const withMs = gameEventSchema.safeParse({
      ...base,
      payload: { t: 'spoke', seat: 2, text: '说两句', context: 'day', ms: 1500 },
    });
    expect(withMs.success).toBe(true);

    const negative = gameEventSchema.safeParse({
      ...base,
      payload: { t: 'spoke', seat: 2, text: '说两句', context: 'day', ms: -1 },
    });
    expect(negative.success).toBe(false);
  });
});

describe('角色与阶段工具函数', () => {
  it('识别神职与阵营', () => {
    expect(isGodRole('seer')).toBe(true);
    expect(isGodRole('villager')).toBe(false);
    expect(roleCamp('werewolf')).toBe('wolf');
    expect(roleCamp('guard')).toBe('good');
  });

  it('拒绝未知角色', () => {
    expect(roleSchema.safeParse('白痴').success).toBe(false);
  });

  it('识别夜晚阶段与竞选阶段', () => {
    expect(isNightPhase('NIGHT_WOLF')).toBe(true);
    expect(isNightPhase('DAY_SPEECH')).toBe(false);
    expect(isChiefPhase('CHIEF_PK_VOTE')).toBe(true);
    expect(isChiefPhase('DAY_VOTE')).toBe(false);
  });

  it('PHASES 里没有重复项', () => {
    expect(new Set(PHASES).size).toBe(PHASES.length);
  });
});
