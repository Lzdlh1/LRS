import type {
  Action,
  ActionOption,
  Camp,
  DeathCause,
  GameEvent,
  Phase,
  Role,
  SeatId,
} from '@lrs/shared';
import type { GameState, Viewer } from '@lrs/core-engine';

/** 座位在前端的可见信息。别人的身份永远是 null。 */
export interface ClientSeat {
  seat: SeatId;
  name: string;
  isHuman: boolean;
  alive: boolean;
  deathAnnounced: boolean;
  deathCause: DeathCause | null;
  isChief: boolean;
  /** 只有上帝视角或本人看得到 */
  role: Role | null;
}

export interface ClientState {
  roomId: string;
  gameId: string;
  board: string;
  day: number;
  phase: Phase;
  viewer: Viewer;
  seats: ClientSeat[];
  chief: {
    elected: SeatId | null;
    badgeAlive: boolean;
    candidates: SeatId[];
    withdrawn: SeatId[];
  };
  /** 只有女巫本人与上帝视角看得到 */
  witchPotions: { antidote: number; poison: number } | null;
  /** 轮到谁：所有人都能看到座位号；选项只给行动者本人与上帝视角 */
  pending: {
    seat: SeatId;
    options: ActionOption[];
    deadlineMs: number;
    /** 行动者本人才有意义的绝对到期时间戳 */
    deadlineAt: number;
  } | null;
  /**
   * 这段过程不该被旁观者看到。
   *
   * 夜里谁在行动是致命信息 —— 夜间顺序是固定且公开的，
   * 「现在轮到 8 号」等于直接告诉所有人 8 号是守卫。
   * 为 true 时 pending 与阶段细节都不会下发。
   */
  masked: boolean;
  winner: Camp | null;
  lastSeq: number;
}

/** 一次 AI 决策，复盘里用来展示「它当时在想什么」 */
export interface ReplayDecision {
  /** 与事件流同一套序号，用于把决策插回时间线 */
  seq: number;
  day: number;
  phase: Phase;
  seat: SeatId;
  kind: string;
  reasoning: string;
  stance: string;
  push: SeatId | null;
  mood: string;
  claim: { role: Role; note: string } | null;
}

export interface ReplayPayload {
  gameId: string;
  /** 这一局出现过哪些天 */
  days: number[];
  /** 当前回放的是哪一天 */
  day: number;
  /** 已按视角裁剪过的事件 */
  events: GameEvent[];
  /**
   * AI 的推理依据**默认封存**。
   *
   * 推理里带着身份信息（「我是狼，队友是 2、5」），局中看到等于作弊；
   * 只有本局结束（或上帝视角）才解封。
   */
  sealed: boolean;
  decisions: ReplayDecision[];
  /** 亮底牌；同样受 sealed 限制 */
  roles: { seat: SeatId; role: Role }[] | null;
}

export type ClientMessage =
  | { type: 'action'; action: Action }
  | { type: 'setViewer'; viewer: Viewer }
  | { type: 'resync'; sinceSeq: number }
  | { type: 'newGame'; seed?: number }
  | { type: 'autoPlay'; count?: number }
  | { type: 'replay'; day?: number };

export type ServerMessage =
  | { type: 'snapshot'; state: ClientState; events: GameEvent[] }
  | { type: 'update'; state: ClientState; events: GameEvent[] }
  /** AI 发言的增量片段，用于打字机效果；不含事件，落地仍以 spoke 事件为准 */
  | { type: 'stream'; seat: SeatId; delta: string }
  | { type: 'stream-done'; seat: SeatId }
  | { type: 'replay'; payload: ReplayPayload }
  | { type: 'error'; message: string };

export interface ProjectArgs {
  roomId: string;
  gameId: string;
  state: GameState;
  viewer: Viewer;
  /** 当前待办的绝对到期时间戳；无待办则为 0 */
  deadlineAt: number;
}

/**
 * 按观察者投影出一份「可以安全发给前端」的状态。
 *
 * 这是信息裁剪的第二道地方（第一道是事件流的 visibility 过滤）：
 * 状态里同样藏着身份、药水、夜间信息，必须在这里按视角抹掉。
 */
export function projectState({ roomId, gameId, state, viewer, deadlineAt }: ProjectArgs): ClientState {
  const isGod = viewer === 'god';
  const viewerSeat = typeof viewer === 'number' ? viewer : null;

  const seats: ClientSeat[] = state.players.map((player) => {
    // 死讯公布之前，对外仍是「在场」—— 与引擎的 onBoardSeats 同一口径。
    // 否则夜里刚被刀的人会立刻在别人屏幕上变成灰色，狼刀结果提前泄露。
    const revealed = isGod || player.death === null || player.deathAnnounced;
    return {
      seat: player.seat,
      name: player.name,
      isHuman: player.isHuman,
      alive: revealed ? player.death === null : true,
      deathAnnounced: player.deathAnnounced,
      deathCause: revealed ? (player.death?.cause ?? null) : null,
      isChief: player.isChief,
      role: isGod || player.seat === viewerSeat ? player.role : null,
    };
  });

  const witchSeat = state.players.find((p) => p.role === 'witch')?.seat ?? null;
  const seesPotions = isGod || (viewerSeat !== null && viewerSeat === witchSeat);
  const isActor = state.pending !== null && state.pending.seat === viewerSeat;
  const seesOptions = isGod || isActor;
  const masked = !isGod && !isActor && state.winner === null && state.phase.startsWith('NIGHT_');

  return {
    roomId,
    gameId,
    board: state.board.name,
    day: state.day,
    phase: state.phase,
    viewer,
    seats,
    chief: {
      elected: state.chief.elected,
      badgeAlive: state.chief.badgeAlive,
      candidates: [...state.chief.candidates],
      withdrawn: [...state.chief.withdrawn],
    },
    witchPotions: seesPotions ? { ...state.witchPotions } : null,
    // masked 时连「轮到谁」都不下发，否则夜间顺序 + 座位号 = 身份
    pending:
      state.pending && !masked
        ? {
            seat: state.pending.seat,
            options: seesOptions ? state.pending.options.map((o) => ({ ...o, targets: [...o.targets] })) : [],
            deadlineMs: state.pending.deadlineMs,
            deadlineAt: seesOptions ? deadlineAt : 0,
          }
        : null,
    masked,
    winner: state.winner,
    lastSeq: state.seq,
  };
}
