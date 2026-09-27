import { ROLE_LABELS, type DeathCause, type GameEvent, type Role, type SeatId, type SpeechContext } from '@lrs/shared';
import { DEATH_CAUSE_LABELS } from '../labels.ts';

export interface ClaimRecord {
  seat: SeatId;
  role: Role;
  day: number;
  note: string;
}

export interface VoteRecord {
  day: number;
  from: SeatId;
  to: SeatId | 'abstain';
}

export interface SpeechRecord {
  seat: SeatId;
  day: number;
  context: SpeechContext;
  text: string;
}

/**
 * M1 事实层：**只由引擎事件投影而来，不经过任何 LLM**。
 *
 * 这是 AI 不会「记错谁投了谁」的根本原因 —— 它读的不是模型记忆，是引擎日志。
 * 私密事件（验人结果、狼队友、女巫死讯）一律不进这一层，走各自的私有记忆。
 */
export interface PublicFacts {
  day: number;
  seatCount: number;
  aliveSeats: SeatId[];
  deaths: { seat: SeatId; cause: DeathCause; day: number }[];
  chief: {
    elected: SeatId | null;
    badgeAlive: boolean;
    candidates: SeatId[];
    withdrawn: SeatId[];
  };
  votes: VoteRecord[];
  votesByDay: { day: number; records: { from: SeatId; to: SeatId | 'abstain' }[] }[];
  claims: ClaimRecord[];
  /** 只保留最近一轮的发言原文，更早的靠 narrative 与 claims 兜住 */
  recentSpeeches: SpeechRecord[];
  /** 紧凑的时间线，直接拼进提示词 */
  timeline: string[];
}

const seatText = (seat: SeatId): string => `${seat} 号`;

export function createFacts(seatCount: number): PublicFacts {
  return {
    day: 0,
    seatCount,
    aliveSeats: Array.from({ length: seatCount }, (_, i) => i + 1),
    deaths: [],
    chief: { elected: null, badgeAlive: true, candidates: [], withdrawn: [] },
    votes: [],
    votesByDay: [],
    claims: [],
    recentSpeeches: [],
    timeline: [],
  };
}

function seatList(seats: readonly SeatId[]): string {
  return seats.length > 0 ? seats.map(seatText).join('、') : '无';
}

/** 出现过的身份宣称，供提示词渲染 */
export function claimsBySeat(facts: PublicFacts): Map<SeatId, ClaimRecord[]> {
  const map = new Map<SeatId, ClaimRecord[]>();
  for (const claim of facts.claims) {
    const list = map.get(claim.seat) ?? [];
    list.push(claim);
    map.set(claim.seat, list);
  }
  return map;
}

export function recordClaim(facts: PublicFacts, claim: ClaimRecord): void {
  // 同一天同一个人不重复记同一身份
  const exists = facts.claims.some(
    (item) => item.seat === claim.seat && item.day === claim.day && item.role === claim.role,
  );
  if (exists) return;
  facts.claims.push(claim);
  facts.timeline.push(`第 ${claim.day} 天：${seatText(claim.seat)}宣称自己是${ROLE_LABELS[claim.role]}`);
}

/**
 * 把一个事件折进事实层。
 * **非 public 事件直接忽略** —— 私密信息不允许污染公共认知。
 */
export function applyEvent(facts: PublicFacts, event: GameEvent): void {
  if (event.visibility.scope !== 'public') return;

  const payload = event.payload;
  facts.day = Math.max(facts.day, event.day);

  switch (payload.t) {
    case 'game_started':
      facts.seatCount = payload.seats.length;
      facts.aliveSeats = payload.seats.map((seat) => seat.seat);
      break;

    case 'spoke': {
      const last = facts.recentSpeeches[facts.recentSpeeches.length - 1];
      // 换天或换环节就开新的一轮，上一轮不再保留原文（由 narrative 与 claims 兜住）
      if (last && (last.day !== event.day || last.context !== payload.context)) {
        facts.recentSpeeches = [];
      }
      facts.recentSpeeches.push({
        seat: payload.seat,
        day: event.day,
        context: payload.context,
        text: payload.text,
      });
      break;
    }

    case 'died': {
      facts.deaths.push({ seat: payload.seat, cause: payload.cause, day: event.day });
      facts.aliveSeats = facts.aliveSeats.filter((seat) => seat !== payload.seat);
      facts.timeline.push(
        `第 ${event.day} 天：${seatText(payload.seat)}出局（${DEATH_CAUSE_LABELS[payload.cause]}）`,
      );
      break;
    }

    case 'voted': {
      facts.votes.push({ day: event.day, from: payload.seat, to: payload.target });
      const bucket = facts.votesByDay.find((item) => item.day === event.day) ?? {
        day: event.day,
        records: [],
      };
      bucket.records.push({ from: payload.seat, to: payload.target });
      if (!facts.votesByDay.includes(bucket)) facts.votesByDay.push(bucket);
      break;
    }

    case 'vote_tally': {
      const tally = payload.counts.map((item) => `${seatText(item.seat)} ${item.votes} 票`).join('，');
      const result =
        payload.eliminated !== null
          ? `${seatText(payload.eliminated)}被放逐`
          : payload.tie
            ? '平票进入 PK'
            : '无人出局';
      facts.timeline.push(`第 ${event.day} 天投票：${tally || '全员弃票'}；${result}`);
      break;
    }

    case 'chief_signup_result':
      facts.chief.candidates = [...payload.candidates];
      facts.timeline.push(`警长竞选上警：${seatList(payload.candidates)}`);
      break;

    case 'chief_withdrawn':
      facts.chief.withdrawn.push(payload.seat);
      facts.timeline.push(`${seatText(payload.seat)}退水`);
      break;

    case 'chief_vote_tally':
      facts.chief.elected = payload.elected;
      if (payload.elected === null) facts.chief.badgeAlive = false;
      facts.timeline.push(
        payload.elected === null
          ? '警长竞选未能选出警长，警徽流失'
          : `${seatText(payload.elected)}当选警长`,
      );
      break;

    case 'chief_transferred':
      if (payload.to === null) {
        facts.chief.badgeAlive = false;
        facts.chief.elected = null;
        facts.timeline.push(`${seatText(payload.from)}撕毁了警徽`);
      } else {
        facts.chief.elected = payload.to;
        facts.timeline.push(`${seatText(payload.from)}把警徽交给${seatText(payload.to)}`);
      }
      break;

    case 'hunter_shot':
      facts.timeline.push(
        payload.target === null
          ? `${seatText(payload.seat)}放弃开枪`
          : `${seatText(payload.seat)}开枪带走${seatText(payload.target)}`,
      );
      break;

    case 'game_over':
      facts.timeline.push(`对局结束：${payload.winner === 'wolf' ? '狼人阵营获胜' : '好人阵营获胜'}`);
      break;

    // 以下不进公共事实层：
    //   role_assigned / wolf_teammates / seer_result / witch_night_info → 私密
    //   phase_changed / action_requested / action_rejected → 流程事件，没有信息量
    default:
      break;
  }
}

export function applyEvents(facts: PublicFacts, events: readonly GameEvent[]): void {
  for (const event of events) applyEvent(facts, event);
}
