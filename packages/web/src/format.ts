import { ROLE_LABELS, type DeathCause, type GameEvent } from '@lrs/shared';
import {
  DEATH_CAUSE_LABELS,
  isNightPhase,
  nightStepLabel,
  PHASE_LABELS,
  SPEECH_CONTEXT_LABELS,
  seatLabel,
} from './labels';

/**
 * 死讯文案。
 *
 * 没有死因时只写「N 号出局」—— 夜里被刀、被毒本来就只公布「谁出局了」；
 * 只有投票放逐、猎人带走这种当场就公开的原因才会带上括号。
 */
function diedText(seat: number, cause: DeathCause | null): string {
  return cause === null ? `${seatLabel(seat)}出局` : `${seatLabel(seat)}出局（${DEATH_CAUSE_LABELS[cause]}）`;
}

export type Tone = 'muted' | 'normal' | 'highlight' | 'danger' | 'success' | 'private';

export interface EventLine {
  key: string;
  day: number;
  tone: Tone;
  text: string;
  /** 发言行要单独排版（说话人是日志里最要紧的信息） */
  speech?: boolean;
}

/**
 * 一张「重大信息」卡片：查验、死讯、技能这类一出来局面就跳过去的信息。
 *
 * 目前卡片上是一枚阵营徽记（`kind` 决定画什么），不是立绘 ——
 * 本机的图片生成接口只返回占位图（302 到一张固定的 default.jpeg），
 * 真图到位之后把徽记换成 `<img>` 即可，数据这一层不用动。
 */
export interface AckCard {
  kind: 'seer' | 'witch' | 'death' | 'shot' | 'other';
  title: string;
  tone: 'wolf' | 'good' | 'neutral';
  lines: string[];
}

/** 把一批需要确认的事件摊成一张卡片：标题取第一件，正文列全 */
export function buildAckCard(events: readonly GameEvent[]): AckCard {
  const lines: string[] = [];
  let primary: Omit<AckCard, 'lines'> | null = null;

  for (const event of events) {
    const payload = event.payload;
    let spec: Omit<AckCard, 'lines'> | null = null;
    let line = '';

    switch (payload.t) {
      case 'seer_result': {
        const isWolf = payload.camp === 'wolf';
        spec = {
          kind: 'seer',
          title: '查验结果',
          tone: isWolf ? 'wolf' : 'good',
        };
        line = `${seatLabel(payload.target)}是${isWolf ? '狼人' : '好人'}`;
        break;
      }

      case 'witch_night_info': {
        spec = {
          kind: 'witch',
          title: payload.killed === null ? '今夜平安' : '今夜的消息',
          tone: 'neutral',
        };
        line = payload.killed === null ? '今晚没有人被刀' : `${seatLabel(payload.killed)}被刀了`;
        break;
      }

      case 'died': {
        spec = { kind: 'death', title: '天亮了 · 死讯', tone: 'neutral' };
        line = diedText(payload.seat, payload.cause);
        break;
      }

      case 'hunter_shot': {
        spec = {
          kind: 'shot',
          title: '猎人开枪',
          tone: payload.target === null ? 'neutral' : 'wolf',
        };
        line =
          payload.target === null
            ? `${seatLabel(payload.seat)}放弃开枪`
            : `${seatLabel(payload.seat)}开枪带走 ${seatLabel(payload.target)}`;
        break;
      }
    }

    if (spec !== null) {
      if (primary === null) primary = spec;
      lines.push(line);
    }
  }

  const head: Omit<AckCard, 'lines'> = primary ?? { kind: 'other', title: '有新消息', tone: 'neutral' };
  return { ...head, lines };
}

/** 把引擎事件翻译成一句人话。这是纯展示层，不做任何推断。 */
export function formatEvent(event: GameEvent): EventLine {
  const key = `${event.seq}`;
  const base = { key, day: event.day };

  switch (event.payload.t) {
    case 'game_started':
      return { ...base, tone: 'highlight', text: `对局开始 · ${event.payload.board}` };

    case 'role_assigned':
      return {
        ...base,
        tone: 'private',
        text: `你的身份：${ROLE_LABELS[event.payload.role]}`,
      };

    case 'wolf_teammates': {
      const mates = event.payload.mates;
      return {
        ...base,
        tone: 'private',
        text: mates.length > 0 ? `你的狼队友：${mates.map(seatLabel).join('、')}` : '你是唯一的狼',
      };
    }

    case 'phase_changed': {
      // 夜间四步永远都走且步长固定，所以这里可以写清「第几步、谁在行动」——
      // 顺序本来就是公开的，看得出步骤也推不出谁还活着
      const to = event.payload.to;
      const label = isNightPhase(to)
        ? `夜晚 · ${nightStepLabel(to)}`
        : PHASE_LABELS[to];
      return {
        ...base,
        tone: to === 'GAME_OVER' ? 'success' : 'muted',
        text: `—— 第 ${event.day} 天 · ${label} ——`,
      };
    }

    case 'action_requested':
      return { ...base, tone: 'highlight', text: `轮到 ${seatLabel(event.payload.seat)}行动` };

    case 'action_rejected':
      return { ...base, tone: 'danger', text: `行动被拒：${event.payload.reason}` };

    case 'spoke':
      return {
        ...base,
        tone: 'normal',
        speech: true,
        text: `${seatLabel(event.payload.seat)}（${SPEECH_CONTEXT_LABELS[event.payload.context]}）：${event.payload.text}`,
      };

    case 'seer_result':
      return {
        ...base,
        tone: 'private',
        text: `查验结果：${seatLabel(event.payload.target)}是${event.payload.camp === 'wolf' ? '狼人' : '好人'}`,
      };

    case 'witch_night_info':
      return {
        ...base,
        tone: 'private',
        text: event.payload.killed === null ? '今夜你没有得知谁被刀' : `今夜 ${seatLabel(event.payload.killed)}被刀`,
      };

    case 'chief_signup_result':
      return {
        ...base,
        tone: 'normal',
        text: event.payload.candidates.length > 0
          ? `上警：${event.payload.candidates.map(seatLabel).join('、')}`
          : '无人上警',
      };

    case 'chief_withdrawn':
      return { ...base, tone: 'normal', text: `${seatLabel(event.payload.seat)}退水` };

    case 'chief_vote_tally': {
      const tally = event.payload.counts.map((c) => `${seatLabel(c.seat)} ${c.votes} 票`).join('，');
      const result =
        event.payload.elected !== null
          ? `${seatLabel(event.payload.elected)}当选警长`
          : event.payload.tie
            ? '再次平票，警徽流失'
            : '无人当选，警徽流失';
      return { ...base, tone: 'highlight', text: `竞选票型：${tally}；${result}` };
    }

    case 'chief_transferred':
      return {
        ...base,
        tone: 'highlight',
        text:
          event.payload.to === null
            ? `${seatLabel(event.payload.from)}撕毁了警徽`
            : `${seatLabel(event.payload.from)}把警徽交给 ${seatLabel(event.payload.to)}`,
      };

    case 'voted':
      return {
        ...base,
        tone: 'normal',
        text: `${seatLabel(event.payload.seat)} → ${event.payload.target === 'abstain' ? '弃票' : seatLabel(event.payload.target)}`,
      };

    case 'vote_tally': {
      const tally = event.payload.counts.map((c) => `${seatLabel(c.seat)} ${c.votes} 票`).join('，');
      const result =
        event.payload.eliminated !== null
          ? `${seatLabel(event.payload.eliminated)}被放逐`
          : event.payload.tie
            ? '平票，进入 PK'
            : '无人出局';
      return { ...base, tone: 'highlight', text: `票型：${tally}；${result}` };
    }

    case 'died':
      return {
        ...base,
        tone: 'danger',
        text: diedText(event.payload.seat, event.payload.cause),
      };

    case 'hunter_shot':
      return {
        ...base,
        tone: 'danger',
        text:
          event.payload.target === null
            ? `${seatLabel(event.payload.seat)}放弃开枪`
            : `${seatLabel(event.payload.seat)}开枪带走 ${seatLabel(event.payload.target)}`,
      };

    case 'game_over': {
      const reveal = event.payload.reveal.map((r) => `${r.seat}=${ROLE_LABELS[r.role]}`).join('，');
      return {
        ...base,
        tone: 'success',
        text: `${event.payload.winner === 'wolf' ? '狼人阵营获胜' : '好人阵营获胜'} · 底牌：${reveal}`,
      };
    }
  }
}
