import type { GameEvent } from '@lrs/shared';
import { describe, expect, it } from 'vitest';
import { deriveMarks } from '../src/marks.ts';

/** 只关心 payload，其余字段对归集逻辑没有影响 */
const ev = (payload: unknown): GameEvent =>
  ({ seq: 1, day: 1, phase: 'DAY_SPEECH', visibility: { scope: 'public' }, payload }) as GameEvent;

describe('头像上的身份标记', () => {
  it('预言家查验：目标是好人标好、是狼标狼，并记下来源', () => {
    const marks = deriveMarks([
      ev({ t: 'seer_result', target: 3, camp: 'wolf' }),
      ev({ t: 'seer_result', target: 5, camp: 'good' }),
    ]);

    expect(marks[3]).toEqual({ camp: 'wolf', from: '预言家查验', note: null });
    expect(marks[5]).toEqual({ camp: 'good', from: '预言家查验', note: null });
  });

  it('狼队友名单：队友全标狼', () => {
    const marks = deriveMarks([ev({ t: 'wolf_teammates', mates: [2, 4] })]);

    expect(marks[2]?.camp).toBe('wolf');
    expect(marks[4]?.from).toBe('狼队友');
    expect(marks[7]).toBeUndefined();
  });

  it('女巫夜里的信息：只加一个「昨夜被刀」小角标，不冒充阵营判断', () => {
    const marks = deriveMarks([ev({ t: 'witch_night_info', killed: 6 })]);

    expect(marks[6]).toEqual({ camp: null, from: '', note: '昨夜被刀' });
  });

  it('夜里没人被刀时不留标记，没收到过的事件也不会凭空出现', () => {
    expect(deriveMarks([ev({ t: 'witch_night_info', killed: null })])).toEqual({});
    expect(deriveMarks([])).toEqual({});
  });
});
