import type { GameEvent, SeatId } from '@lrs/shared';

/** 观察者：某个座位号，或上帝视角 */
export type Viewer = SeatId | 'god';

export function isVisibleTo(event: GameEvent, viewer: Viewer): boolean {
  if (viewer === 'god') return true;
  return event.visibility.scope === 'public' || event.visibility.seats.includes(viewer);
}

/**
 * 按观察者裁剪事件流。
 *
 * 这是「玩家视角 ⇄ 上帝视角」与防作弊的唯一实现点：
 * 引擎只负责标记 visibility，真正的过滤发生在这里 ——
 * 前端因此不可能拿到任何未公开信息，改前端代码也刷不出底牌。
 */
export function eventsFor(events: readonly GameEvent[], viewer: Viewer): GameEvent[] {
  return events.filter((event) => isVisibleTo(event, viewer));
}
