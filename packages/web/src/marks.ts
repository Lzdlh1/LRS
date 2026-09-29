import type { GameEvent, SeatId } from '@lrs/shared';

/**
 * 一个座位上「玩家已经知道的情报」。
 *
 * 文字局全靠眼睛记，把身份标在头像上比回头翻日志省事得多。
 * 这里只做归集，不做任何推断 —— 没收到过的事件就不会有标记。
 */
export interface SeatMark {
  /** 阵营判断：预言家查验、狼队友名单给的 */
  camp: 'good' | 'wolf' | null;
  /** 来源，鼠标悬停时看得到，方便玩家记住这条情报是怎么来的 */
  from: string;
  /** 非阵营的情报（女巫夜里看到的「被刀」），单独用一个小角标表示 */
  note: string | null;
}

/**
 * 从「已按视角裁剪过的事件流」里攒出座位标记。
 *
 * 关键点：入参必须是服务端裁剪后的可见事件 —— 拿不到的信息在这里也不可能凭空出现。
 * 谁该知道什么由引擎的 visibility 决定（狼王知狼、狼不知狼王这类差异也走同一套），
 * 这里只负责「什么时候可以摆到脸上」。
 */
export function deriveMarks(
  events: readonly GameEvent[],
  options: { teammatesKnown: boolean },
): Record<SeatId, SeatMark> {
  const marks: Record<SeatId, SeatMark> = {};

  const setCamp = (seat: SeatId, camp: 'good' | 'wolf', from: string): void => {
    const current = marks[seat];
    marks[seat] = { camp, from, note: current?.note ?? null };
  };

  for (const event of events) {
    const payload = event.payload;
    switch (payload.t) {
      case 'seer_result':
        // 查验是「出结果」之后才有标记，这一点天然由事件本身保证
        setCamp(payload.target, payload.camp, '预言家查验');
        break;

      case 'wolf_teammates':
        // 首夜狼人睁眼之前，狼也还没跟队友碰上面，先不摆出来
        if (!options.teammatesKnown) break;
        // 只有狼本人收得到这条，标上去不会泄漏给别人（事件本来就被裁过）
        for (const mate of payload.mates) setCamp(mate, 'wolf', '狼队友');
        break;

      case 'witch_night_info': {
        if (payload.killed === null) break;
        const current = marks[payload.killed] ?? { camp: null, from: '', note: null };
        marks[payload.killed] = { ...current, note: '昨夜被刀' };
        break;
      }
    }
  }

  return marks;
}
