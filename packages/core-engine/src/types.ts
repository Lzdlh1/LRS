import type {
  ActionOption,
  Camp,
  DeathCause,
  GameEvent,
  Phase,
  Role,
  SeatId,
  SpeechContext,
  VoteTarget,
} from '@lrs/shared';
import type { Board } from './board.ts';
import type { Rules, RulesInput } from './rules.ts';

export interface PlayerDeath {
  cause: DeathCause;
  /** 死亡发生的天数 */
  day: number;
}

export interface PlayerState {
  seat: SeatId;
  name: string;
  isHuman: boolean;
  role: Role;
  /** 真实死亡状态；null 表示存活 */
  death: PlayerDeath | null;
  /**
   * 死讯是否已公布。
   * 变体 A 下，首夜死者在这一刻仍是 false —— 他照常参与警长竞选与投票，
   * 直到 DAWN_ANNOUNCE 才被宣布死亡。
   */
  deathAnnounced: boolean;
  /** 遗言是否已用掉 */
  lastWordsDone: boolean;
  /** 是否现任警长 */
  isChief: boolean;
}

/** 一夜的行动记录与结算结果 */
export interface NightRecord {
  /** 本夜已行动的座位。用于判断某个阶段的角色是否已经行动过 */
  actedSeats: SeatId[];
  guardTarget: SeatId | null;
  wolfTarget: SeatId | null;
  witchSaved: SeatId | null;
  witchPoisoned: SeatId | null;
  seerTarget: SeatId | null;
  seerCamp: Camp | null;
  /** 结算后当夜死亡名单 */
  deaths: SeatId[];
}

export interface ChiefState {
  /** 已产生的警长 */
  elected: SeatId | null;
  /** 警徽是否还在（被撕毁后为 false） */
  badgeAlive: boolean;
  /** 上警名单 */
  candidates: SeatId[];
  /** 已提交上警意向的座位 */
  signupAnswered: SeatId[];
  /** 退水名单 */
  withdrawn: SeatId[];
  /** 退水阶段尚待询问的座位 */
  withdrawQueue: SeatId[];
  /** 1 = 首轮；2 = PK 轮 */
  round: 1 | 2;
  /** 进入 PK 的平票者 */
  tied: SeatId[];
  /** 已提交的竞选票 */
  votes: { seat: SeatId; target: SeatId }[];
  /** PK 轮的投票人（平票者不能投票），仅在 round = 2 时使用 */
  votersCache: SeatId[];
}

export interface VoteState {
  round: 1 | 2;
  /** 本轮有投票权的座位 */
  voters: SeatId[];
  /** 已提交的票 */
  votes: { seat: SeatId; target: VoteTarget }[];
  /** 进入 PK 的平票者 */
  tied: SeatId[];
}

export interface SpeechState {
  context: SpeechContext;
  /** 尚未发言的顺序 */
  queue: SeatId[];
  /** 已发言 */
  spoken: SeatId[];
}

/** 引擎当前在等谁做什么 */
export interface PendingRequest {
  seat: SeatId;
  options: ActionOption[];
  /** 相对时限（毫秒）。引擎不持有定时器，计时与超时代打由会话服务负责。 */
  deadlineMs: number;
}

export interface GameState {
  /** 已产生的事件数，同时是最后一个事件的 seq */
  seq: number;
  board: Board;
  rules: Rules;
  /** 天数。第 1 夜与第 1 天同为 1 */
  day: number;
  phase: Phase;
  players: PlayerState[];
  witchPotions: { antidote: number; poison: number };
  night: NightRecord;
  /** 上一夜守卫守护的座位，用于禁止连守 */
  lastNightGuardTarget: SeatId | null;
  chief: ChiefState;
  vote: VoteState;
  speech: SpeechState;
  lastWordsQueue: SeatId[];
  hunterQueue: SeatId[];
  /**
   * 死亡结算完毕后还要回到哪个场景：
   * dawn = 天亮结算（接下来是白天发言）；day = 白天投票结算（接下来进入下一夜）
   */
  resolutionStage: 'dawn' | 'day';
  /** 死亡的警长若尚未决定警徽去向，这里记着他是谁 */
  pendingChiefTransfer: SeatId | null;
  pending: PendingRequest | null;
  /**
   * 夜间那一步的节拍状态（见 Rules.nightStepMs）。
   *
   * - `idle`：不在等节拍（白天，或夜里刚进这一步还没走完）
   * - `open`：这一步该做的都做完了，但**按住不换步**，等会话服务的「到点了」
   * - `beaten`：这一步的节拍已经到过，可以换下一步了
   *
   * 三态是必须的：只有两态的话，敲完节拍再进一次同一个阶段函数，
   * 它会以为自己该继续等，于是整局卡在夜里那一步。
   */
  nightBeat: 'idle' | 'open' | 'beaten';
  winner: Camp | null;
}

export interface EngineConfig {
  board?: Board;
  rules?: RulesInput;
  /** 座位显示名，长度需等于座位数 */
  names?: string[];
  /** 真人所在座位，默认 [1] */
  humanSeats?: SeatId[];
  /** 固定发牌顺序（测试用），长度需等于座位数 */
  fixedRoles?: Role[];
  /** 随机源，默认 Math.random */
  rng?: () => number;
}

export interface StepResult {
  state: GameState;
  events: GameEvent[];
}
