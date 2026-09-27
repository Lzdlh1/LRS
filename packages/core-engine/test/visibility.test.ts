import type { Role } from '@lrs/shared';
import { describe, expect, it } from 'vitest';
import { createGame, step } from '../src/machine.ts';
import { eventsFor, isVisibleTo, type Viewer } from '../src/visibility.ts';

/** 1 民 · 2 狼 · 3 预言家 · 4 女巫 · 5 猎人 · 6 守卫 · 7 狼 · 8 民 · 9 狼 */
const FIXED_ROLES: Role[] = [
  'villager',
  'werewolf',
  'seer',
  'witch',
  'hunter',
  'guard',
  'werewolf',
  'villager',
  'werewolf',
];

const SEER = 3;
const GUARD = 6;
const WITCH = 4;
const WOLF_REP = 2;
const VILLAGER = 8;

function firstNightEvents() {
  let result = createGame({ fixedRoles: FIXED_ROLES, humanSeats: [1] });
  const events = [...result.events];

  for (const action of [
    { kind: 'guard_protect', actor: GUARD, target: VILLAGER },
    { kind: 'wolf_kill', actor: WOLF_REP, target: SEER },
    { kind: 'witch_act', actor: WITCH, use: 'pass' },
    { kind: 'seer_check', actor: SEER, target: SEER - 1 },
  ] as const) {
    result = step(result.state, action);
    events.push(...result.events);
  }
  return events;
}

describe('事件可见性', () => {
  it('普通民看不到别人的身份，只看得到自己的', () => {
    const events = firstNightEvents();
    const visible = eventsFor(events, VILLAGER);

    const roles = visible.filter((e) => e.payload.t === 'role_assigned');
    expect(roles).toHaveLength(1);
    expect(roles[0]?.payload).toMatchObject({ seat: VILLAGER, role: 'villager' });
  });

  it('普通民看不到预言家的验人结果', () => {
    const events = firstNightEvents();
    expect(eventsFor(events, VILLAGER).some((e) => e.payload.t === 'seer_result')).toBe(false);
    expect(eventsFor(events, SEER).some((e) => e.payload.t === 'seer_result')).toBe(true);
  });

  it('普通民看不到女巫的夜间信息', () => {
    const events = firstNightEvents();
    expect(eventsFor(events, VILLAGER).some((e) => e.payload.t === 'witch_night_info')).toBe(false);
    expect(eventsFor(events, WITCH).some((e) => e.payload.t === 'witch_night_info')).toBe(true);
  });

  it('狼能看到狼队友，好人看不到', () => {
    const events = firstNightEvents();
    expect(eventsFor(events, WOLF_REP).some((e) => e.payload.t === 'wolf_teammates')).toBe(true);
    expect(eventsFor(events, VILLAGER).some((e) => e.payload.t === 'wolf_teammates')).toBe(false);
  });

  it('公开信息所有人都看得到', () => {
    const events = firstNightEvents();
    for (const viewer of [1, 5, 9] as Viewer[]) {
      const visible = eventsFor(events, viewer);
      expect(visible.some((e) => e.payload.t === 'game_started')).toBe(true);
      expect(visible.some((e) => e.payload.t === 'phase_changed')).toBe(true);
    }
  });

  it('上帝视角看到全量事件', () => {
    const events = firstNightEvents();
    expect(eventsFor(events, 'god')).toHaveLength(events.length);
    expect(eventsFor(events, 'god').filter((e) => e.payload.t === 'role_assigned')).toHaveLength(9);
  });

  it('过滤后的 seq 序列与原始顺序一致（不重排、不插值）', () => {
    const events = firstNightEvents();
    const visible = eventsFor(events, VILLAGER);
    const seqs = visible.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('isVisibleTo 与 eventsFor 一致', () => {
    const events = firstNightEvents();
    const visible = eventsFor(events, WITCH);
    for (const event of events) {
      expect(visible.includes(event)).toBe(isVisibleTo(event, WITCH));
    }
  });

  it('私密事件不会泄露给任意其他座位', () => {
    const events = firstNightEvents();
    const roleEvent = events.find((e) => e.payload.t === 'role_assigned' && e.payload.seat === SEER)!;
    for (const seat of [1, 2, 4, 5, 6, 7, 8, 9]) {
      expect(eventsFor([roleEvent], seat)).toHaveLength(0);
    }
  });
});
