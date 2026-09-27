import {
  isNightPhase,
  roleCamp,
  type Action,
  type GameEvent,
  type Phase,
  type SeatId,
  type SpeechContext,
} from '@lrs/shared';
import { buildRoleDeck, DEFAULT_BOARD, validateBoard, type Board } from './board.ts';
import { emit, seatsVisible } from './events.ts';
import {
  chiefSignupOptions,
  guardOptions,
  onBoardSeats,
  playerAt,
  seerOptions,
  seatsWithRole,
  wolfOptions,
  witchOptions,
} from './options.ts';
import { resolveRules, validateRules, type Rules } from './rules.ts';
import type {
  ChiefState,
  EngineConfig,
  GameState,
  NightRecord,
  PendingRequest,
  PlayerState,
  StepResult,
  VoteState,
} from './types.ts';

/** 状态机单次推进的步数上限，防止规则写错导致死循环 */
const MAX_DRIVE_STEPS = 500;

// ────────────────────────────── 初始状态 ──────────────────────────────

function emptyNight(): NightRecord {
  return {
    actedSeats: [],
    guardTarget: null,
    wolfTarget: null,
    witchSaved: null,
    witchPoisoned: null,
    seerTarget: null,
    seerCamp: null,
    deaths: [],
  };
}

function emptyChief(): ChiefState {
  return {
    elected: null,
    badgeAlive: true,
    candidates: [],
    signupAnswered: [],
    withdrawn: [],
    round: 1,
    tied: [],
    votes: [],
  };
}

function emptyVote(): VoteState {
  return { round: 1, voters: [], votes: [], tied: [] };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = result[i]!;
    const b = result[j]!;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

// ────────────────────────────── 开局 ──────────────────────────────

export function createGame(config: EngineConfig = {}): StepResult {
  const board: Board = config.board ?? DEFAULT_BOARD;

  const boardErrors = validateBoard(board);
  if (boardErrors.length > 0) throw new Error(`板子非法：${boardErrors.join('；')}`);

  const rules: Rules = resolveRules(config.rules);
  const ruleErrors = validateRules(rules);
  if (ruleErrors.length > 0) throw new Error(`规则参数非法：${ruleErrors.join('；')}`);

  const deck = config.fixedRoles
    ? [...config.fixedRoles]
    : shuffle(buildRoleDeck(board), config.rng ?? Math.random);
  if (deck.length !== board.seatCount) {
    throw new Error(`身份牌数量 ${deck.length} 与座位数 ${board.seatCount} 不一致`);
  }

  const humanSeats = new Set(config.humanSeats ?? [1]);
  const players: PlayerState[] = Array.from({ length: board.seatCount }, (_, i) => {
    const seat = i + 1;
    return {
      seat,
      name: config.names?.[i] ?? `玩家${seat}`,
      isHuman: humanSeats.has(seat),
      role: deck[i]!,
      death: null,
      deathAnnounced: false,
      lastWordsDone: false,
      isChief: false,
    };
  });

  const state: GameState = {
    seq: 0,
    board,
    rules,
    day: 1,
    phase: 'SETUP',
    players,
    witchPotions: { antidote: rules.witchAntidoteCount, poison: rules.witchPoisonCount },
    night: emptyNight(),
    lastNightGuardTarget: null,
    chief: emptyChief(),
    vote: emptyVote(),
    speech: { context: 'day', queue: [], spoken: [] },
    lastWordsQueue: [],
    hunterQueue: [],
    pending: null,
    winner: null,
  };

  const events: GameEvent[] = [];
  emit(state, events, {
    t: 'game_started',
    board: board.name,
    seats: players.map((p) => ({ seat: p.seat, name: p.name, isHuman: p.isHuman })),
  });

  for (const player of players) {
    emit(state, events, { t: 'role_assigned', seat: player.seat, role: player.role }, seatsVisible(player.seat));
  }

  const wolves = seatsWithRole(state, 'werewolf', false);
  for (const seat of wolves) {
    emit(
      state,
      events,
      { t: 'wolf_teammates', seat, mates: wolves.filter((s) => s !== seat) },
      seatsVisible(seat),
    );
  }

  goTo(state, events, 'NIGHT_GUARD');
  drive(state, events);
  return { state, events };
}

// ────────────────────────────── 对外推进接口 ──────────────────────────────

/**
 * 提交一个 Action。
 *
 * 非法 Action 不会抛异常，而是产出一条 action_rejected 事件并保持状态不变 ——
 * 这样 AI 说错话 / 提交垃圾数据时，整局游戏不会崩。
 */
export function step(prev: GameState, action: Action): StepResult {
  const state = structuredClone(prev) as GameState;
  const events: GameEvent[] = [];

  const applied = tryApplyAction(state, events, action);
  if (applied) drive(state, events);

  return { state, events };
}

/** 当前在等谁做什么 */
export function pendingRequest(state: GameState): PendingRequest | null {
  return state.pending;
}

export function isOver(state: GameState): boolean {
  return state.winner !== null;
}

// ────────────────────────────── 驱动 ──────────────────────────────

function drive(state: GameState, events: GameEvent[]): void {
  let steps = 0;
  while (state.winner === null && state.pending === null) {
    steps += 1;
    if (steps > MAX_DRIVE_STEPS) {
      throw new Error(`状态机推进超过 ${MAX_DRIVE_STEPS} 步，疑似死循环（当前阶段 ${state.phase}）`);
    }
    advanceOnce(state, events);
  }
}

function goTo(state: GameState, events: GameEvent[], phase: Phase, lastWordsQueue: SeatId[] = []): void {
  const from = state.phase;
  state.phase = phase;
  state.lastWordsQueue = lastWordsQueue;
  emit(state, events, { t: 'phase_changed', from, to: phase });
}

function advanceOnce(state: GameState, events: GameEvent[]): void {
  switch (state.phase) {
    case 'NIGHT_GUARD':
      return phaseNightGuard(state, events);
    case 'NIGHT_WOLF':
      return phaseNightWolf(state, events);
    case 'NIGHT_WITCH':
      return phaseNightWitch(state, events);
    case 'NIGHT_SEER':
      return phaseNightSeer(state, events);
    case 'DAWN_ANNOUNCE':
      return phaseDawnAnnounce(state, events);
    case 'CHIEF_SIGNUP':
      return phaseChiefSignup(state, events);
    default:
      throw new Error(`阶段 ${state.phase} 尚未实现`);
  }
}

// ────────────────────────────── 夜晚 ──────────────────────────────

function ask(state: GameState, seat: SeatId, options: PendingRequest['options'], deadlineMs: number): void {
  state.pending = { seat, options, deadlineMs };
}

function phaseNightGuard(state: GameState, events: GameEvent[]): void {
  const [guard] = seatsWithRole(state, 'guard');
  if (guard === undefined) return goTo(state, events, 'NIGHT_WOLF');
  ask(state, guard, guardOptions(state, guard), state.rules.timeoutMs.night);
}

function phaseNightWolf(state: GameState, events: GameEvent[]): void {
  const wolves = seatsWithRole(state, 'werewolf');
  if (wolves.length === 0) return goTo(state, events, 'NIGHT_WITCH');
  // 狼队共识由一个代表提交；内部协商由 agent-host 在 M3 阶段实现
  ask(state, wolves[0]!, wolfOptions(state), state.rules.timeoutMs.night);
}

function phaseNightWitch(state: GameState, events: GameEvent[]): void {
  const [witch] = seatsWithRole(state, 'witch');
  if (witch === undefined) return goTo(state, events, 'NIGHT_SEER');

  // 解药用光后，女巫不再被告知今夜谁被刀
  const informedKilled = state.witchPotions.antidote > 0 ? state.night.wolfTarget : null;
  emit(
    state,
    events,
    { t: 'witch_night_info', seat: witch, killed: informedKilled },
    seatsVisible(witch),
  );
  ask(state, witch, witchOptions(state, witch), state.rules.timeoutMs.night);
}

function phaseNightSeer(state: GameState, events: GameEvent[]): void {
  const [seer] = seatsWithRole(state, 'seer');
  if (seer !== undefined && !state.night.actedSeats.includes(seer)) {
    ask(state, seer, seerOptions(state, seer), state.rules.timeoutMs.night);
    return;
  }
  resolveNight(state);

  if (state.day === 1 && state.board.hasChiefElection && state.rules.chiefElectionBeforeDawnAnnounce) {
    return goTo(state, events, 'CHIEF_SIGNUP');
  }
  goTo(state, events, 'DAWN_ANNOUNCE');
}

/**
 * 夜晚结算。只计算死亡、写入 player.death，不公布死讯 ——
 * 公布发生在 DAWN_ANNOUNCE，因为变体 A 下警长竞选要排在公布之前。
 */
function resolveNight(state: GameState): void {
  const { wolfTarget, guardTarget, witchSaved, witchPoisoned } = state.night;
  const deaths = new Map<SeatId, 'wolf' | 'poison'>();

  if (wolfTarget !== null) {
    const guarded = guardTarget === wolfTarget;
    const saved = witchSaved === wolfTarget;
    const dies = guarded && saved ? state.rules.guardedAndSavedDies : !(guarded || saved);
    if (dies) deaths.set(wolfTarget, 'wolf');
  }

  if (witchPoisoned !== null) {
    // 被毒优先记为 poison —— 这决定猎人能否开枪（被毒死不能开枪）
    deaths.set(witchPoisoned, 'poison');
  }

  for (const [seat, cause] of deaths) {
    playerAt(state, seat).death = { cause, day: state.day };
  }

  state.night.deaths = [...deaths.keys()];
  state.lastNightGuardTarget = state.night.guardTarget;
}

// ────────────────────────────── 天亮 ──────────────────────────────

function phaseDawnAnnounce(state: GameState, events: GameEvent[]): void {
  const unannounced = state.players.filter((p) => p.death !== null && !p.deathAnnounced);

  for (const player of unannounced) {
    player.deathAnnounced = true;
    emit(state, events, { t: 'died', seat: player.seat, cause: player.death!.cause });
  }

  const lastWords = unannounced.filter((p) => shouldHaveLastWords(state, p)).map((p) => p.seat);
  state.hunterQueue = unannounced.filter((p) => canHunterShoot(state, p)).map((p) => p.seat);

  goTo(state, events, lastWords.length > 0 ? 'LAST_WORDS' : 'DAY_SPEECH', lastWords);
}

function shouldHaveLastWords(state: GameState, player: PlayerState): boolean {
  const death = player.death;
  if (!death) return false;
  switch (death.cause) {
    case 'vote':
      return state.rules.votedOutHasLastWords;
    case 'gun':
      // 被猎人带走视为与猎人同时死亡，不留遗言
      return false;
    case 'wolf':
    case 'poison':
      return death.day <= 1
        ? state.rules.firstNightDeathsHaveLastWords
        : state.rules.nightDeathsHaveLastWordsFromNight2;
  }
}

function canHunterShoot(state: GameState, player: PlayerState): boolean {
  if (player.role !== 'hunter') return false;
  if (player.death?.cause === 'poison') return state.rules.hunterCanShootWhenPoisoned;
  return true;
}

// ────────────────────────────── 警长竞选 ──────────────────────────────

function phaseChiefSignup(state: GameState, events: GameEvent[]): void {
  const next = onBoardSeats(state).find((seat) => !state.chief.signupAnswered.includes(seat));
  if (next === undefined) {
    goTo(state, events, 'CHIEF_SPEECH');
    return;
  }
  ask(state, next, chiefSignupOptions(), state.rules.timeoutMs.chiefSignup);
}

// ────────────────────────────── Action 校验与应用 ──────────────────────────────

/**
 * 校验并应用一个 Action。
 *
 * 返回 false 表示 Action 未被接受（已产出 action_rejected 事件，状态未改变）。
 */
function tryApplyAction(state: GameState, events: GameEvent[], action: Action): boolean {
  const pending = state.pending;
  if (!pending) {
    emit(state, events, { t: 'action_rejected', seat: action.actor, reason: '当前没有等待任何人的行动' });
    return false;
  }
  if (pending.seat !== action.actor) {
    emit(state, events, {
      t: 'action_rejected',
      seat: action.actor,
      reason: `当前等待 ${pending.seat} 号行动，收到的是 ${action.actor} 号`,
    });
    return false;
  }

  const reason = validateAgainstOptions(pending, action);
  if (reason !== null) {
    emit(state, events, { t: 'action_rejected', seat: action.actor, reason });
    return false;
  }

  state.pending = null;
  applyAction(state, events, action);
  afterAction(state, events);
  return true;
}

function validateAgainstOptions(pending: PendingRequest, action: Action): string | null {
  const candidates = pending.options.filter((o) => o.kind === action.kind);
  if (candidates.length === 0) return `当前阶段不接受 ${action.kind}`;

  if (action.kind === 'chief_signup' || action.kind === 'speak') return null;

  // 女巫同一个 kind 下有多个选项（解药 / 毒药 / 不用药），先按 use 挑出适用的那一个
  let option = candidates[0]!;
  if (action.kind === 'witch_act') {
    const matched = candidates.find((o) => o.params?.['use']?.includes(action.use));
    if (!matched) return `当前不能使用「${action.use}」（可能是药水已用完或规则不允许）`;
    option = matched;
    if (action.use === 'pass') {
      return action.target === undefined ? null : '选择不用药时不应指定目标';
    }
    if (action.target === undefined) return `使用「${action.use}」必须指定目标`;
  }

  if (action.kind === 'hunter_shoot') {
    if (action.target === null) return null;
    return option.targets.includes(action.target) ? null : `${action.target} 号不是可开枪的目标`;
  }

  const target = 'target' in action ? action.target : undefined;
  if (target === undefined) return `${action.kind} 必须指定目标`;
  if (target === 'abstain') return '当前不允许弃票';

  const allTargets = candidates.flatMap((o) => o.targets);
  return allTargets.includes(target) ? null : `${target} 号不是合法目标`;
}

function applyAction(state: GameState, events: GameEvent[], action: Action): void {
  switch (action.kind) {
    case 'guard_protect':
      state.night.guardTarget = action.target;
      break;
    case 'wolf_kill':
      state.night.wolfTarget = action.target;
      break;
    case 'witch_act':
      if (action.use === 'save') {
        state.night.witchSaved = action.target ?? null;
        state.witchPotions.antidote -= 1;
      } else if (action.use === 'poison') {
        state.night.witchPoisoned = action.target ?? null;
        state.witchPotions.poison -= 1;
      }
      break;
    case 'seer_check': {
      const camp = roleCamp(playerAt(state, action.target).role);
      state.night.seerTarget = action.target;
      state.night.seerCamp = camp;
      emit(state, events, { t: 'seer_result', seat: action.actor, target: action.target, camp }, seatsVisible(action.actor));
      break;
    }
    case 'chief_signup':
      state.chief.signupAnswered.push(action.actor);
      if (action.join) state.chief.candidates.push(action.actor);
      break;
    case 'chief_withdraw':
      if (!state.chief.withdrawn.includes(action.actor)) state.chief.withdrawn.push(action.actor);
      break;
    case 'speak':
      emit(state, events, {
        t: 'spoke',
        seat: action.actor,
        text: action.text,
        context: speechContextFor(state.phase),
      });
      state.speech.spoken.push(action.actor);
      break;
    case 'vote':
      state.vote.votes.push({ seat: action.actor, target: action.target });
      break;
    case 'hunter_shoot':
      emit(state, events, { t: 'hunter_shot', seat: action.actor, target: action.target });
      break;
  }

  if (isNightPhase(state.phase)) {
    state.night.actedSeats.push(action.actor);
  }
}

/** 行动之后该往哪走。留在原阶段的（如 NIGHT_SEER）由阶段函数自己处理后续推进。 */
function afterAction(state: GameState, events: GameEvent[]): void {
  switch (state.phase) {
    case 'NIGHT_GUARD':
      return goTo(state, events, 'NIGHT_WOLF');
    case 'NIGHT_WOLF':
      return goTo(state, events, 'NIGHT_WITCH');
    case 'NIGHT_WITCH':
      return goTo(state, events, 'NIGHT_SEER');
    default:
      return;
  }
}

function speechContextFor(phase: Phase): SpeechContext {
  switch (phase) {
    case 'CHIEF_SPEECH':
      return 'chief_campaign';
    case 'CHIEF_PK_SPEECH':
      return 'chief_pk';
    case 'DAY_PK_SPEECH':
      return 'day_pk';
    case 'LAST_WORDS':
      return 'last_words';
    default:
      return 'day';
  }
}
