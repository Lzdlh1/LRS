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
  winner: Camp | null;
  lastSeq: number;
}

export type ClientMessage =
  | { type: 'action'; action: Action }
  | { type: 'setViewer'; viewer: Viewer }
  | { type: 'resync'; sinceSeq: number }
  | { type: 'newGame'; seed?: number }
  | { type: 'autoPlay'; count?: number };

export type ServerMessage =
  | { type: 'snapshot'; state: ClientState; events: GameEvent[] }
  | { type: 'update'; state: ClientState; events: GameEvent[] }
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

  const seats: ClientSeat[] = state.players.map((player) => ({
    seat: player.seat,
    name: player.name,
    isHuman: player.isHuman,
    alive: player.death === null,
    deathAnnounced: player.deathAnnounced,
    deathCause: player.death?.cause ?? null,
    isChief: player.isChief,
    role: isGod || player.seat === viewerSeat ? player.role : null,
  }));

  const witchSeat = state.players.find((p) => p.role === 'witch')?.seat ?? null;
  const seesPotions = isGod || (viewerSeat !== null && viewerSeat === witchSeat);
  const isActor = state.pending !== null && state.pending.seat === viewerSeat;
  const seesOptions = isGod || isActor;

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
    pending: state.pending
      ? {
          seat: state.pending.seat,
          options: seesOptions ? state.pending.options.map((o) => ({ ...o, targets: [...o.targets] })) : [],
          deadlineMs: state.pending.deadlineMs,
          deadlineAt: seesOptions ? deadlineAt : 0,
        }
      : null,
    winner: state.winner,
    lastSeq: state.seq,
  };
}
