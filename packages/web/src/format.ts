import { ROLE_LABELS, type GameEvent } from '@lrs/shared';
import { DEATH_CAUSE_LABELS, PHASE_LABELS, SPEECH_CONTEXT_LABELS, seatLabel } from './labels';

export type Tone = 'muted' | 'normal' | 'highlight' | 'danger' | 'success' | 'private';

export interface EventLine {
  key: string;
  day: number;
  tone: Tone;
  text: string;
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

    case 'phase_changed':
      return {
        ...base,
        tone: event.payload.to === 'GAME_OVER' ? 'success' : 'muted',
        text: `—— 第 ${event.day} 天 · ${PHASE_LABELS[event.payload.to]} ——`,
      };

    case 'action_requested':
      return { ...base, tone: 'highlight', text: `轮到 ${seatLabel(event.payload.seat)}行动` };

    case 'action_rejected':
      return { ...base, tone: 'danger', text: `行动被拒：${event.payload.reason}` };

    case 'spoke':
      return {
        ...base,
        tone: 'normal',
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
        text: `${seatLabel(event.payload.seat)}出局（${DEATH_CAUSE_LABELS[event.payload.cause]}）`,
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
