import type { EventPayload, GameEvent, SeatId, Visibility } from '@lrs/shared';
import type { GameState } from './types.ts';

export const PUBLIC: Visibility = { scope: 'public' };

/** 只有这些座位能看到 */
export function seatsVisible(...seats: SeatId[]): Visibility {
  return { scope: 'seats', seats };
}

/**
 * 产出一条事件。
 *
 * seq 单调递增，是事件溯源游标；visibility 只「标记」可见范围，
 * 真正的过滤由会话服务执行 —— 这是玩家/上帝视角切换与防作弊的基础。
 */
export function emit(
  state: GameState,
  events: GameEvent[],
  payload: EventPayload,
  visibility: Visibility = PUBLIC,
): GameEvent {
  state.seq += 1;
  const event: GameEvent = {
    seq: state.seq,
    day: state.day,
    phase: state.phase,
    visibility,
    payload,
  };
  events.push(event);
  return event;
}
