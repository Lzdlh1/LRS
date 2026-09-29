import {
  isGodRole,
  isNightPhase,
  roleCamp,
  type Action,
  type Camp,
  type GameEvent,
  type Phase,
  type SeatId,
  type SpeechContext,
  type VoteTarget,
} from '@lrs/shared';
import { buildRoleDeck, DEFAULT_BOARD, validateBoard, type Board } from './board.ts';
import { emit, seatsVisible } from './events.ts';
import {
  aliveSeats,
  chiefSignupOptions,
  chiefTransferOptions,
  chiefVoteOptions,
  chiefWithdrawOptions,
  dayVoteOptions,
  guardOptions,
  hunterShootOptions,
  onBoardSeats,
  playerAt,
  seerOptions,
  seatsWithRole,
  speakOptions,
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
const MAX_DRIVE_STEPS = 2000;

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
    withdrawQueue: [],
    round: 1,
    tied: [],
    votes: [],
    votersCache: [],
  };
}

function emptyVote(): VoteState {
  return { round: 1, voters: [], votes: [], tied: [] };
}

function emptySpeech(): GameState['speech'] {
  return { context: 'day', queue: [], spoken: [] };
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
    speech: emptySpeech(),
    lastWordsQueue: [],
    hunterQueue: [],
    resolutionStage: 'dawn',
    pendingChiefTransfer: null,
    pending: null,
    nightBeat: 'idle',
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

// ────────────────────────────── 对外接口 ──────────────────────────────

/**
 * 提交一个 Action。
 *
 * 非法 Action 不抛异常，而是产出 action_rejected 事件并保持状态不变 ——
 * AI 提交垃圾数据时整局游戏不会崩。
 */
export function step(prev: GameState, action: Action): StepResult {
  const state = structuredClone(prev) as GameState;
  const events: GameEvent[] = [];

  if (tryApplyAction(state, events, action)) drive(state, events);

  return { state, events };
}

/**
 * 夜里那一步「到点了」。
 *
 * 打开 `rules.nightStepMs` 之后，夜间的换步不再由行动触发，而由会话服务按固定节拍
 * 调这个函数 —— 行动者提前提交也照样等满这一步，节奏因此与「有没有人行动」无关。
 * 它不是玩家能提交的 Action（不进 actionSchema），免得客户端直接跳过整夜。
 */
export function beatNightStep(prev: GameState): StepResult {
  const state = structuredClone(prev) as GameState;
  const events: GameEvent[] = [];

  if (state.rules.nightStepMs <= 0 || !isNightPhase(state.phase)) return { state, events };

  // 到点了：这一步还没做的就此作罢（没人行动，或行动者一直没动）
  state.pending = null;
  state.nightBeat = 'beaten';
  drive(state, events);

  return { state, events };
}

export function pendingRequest(state: GameState): PendingRequest | null {
  return state.pending;
}

export function isOver(state: GameState): boolean {
  return state.winner !== null;
}

// ────────────────────────────── 驱动 ──────────────────────────────

function drive(state: GameState, events: GameEvent[]): void {
  let steps = 0;
  let announced = state.pending;

  // 用「阶段是否已到 GAME_OVER」作为终止条件，而不是 winner ——
  // 因为 winner 可能在结算途中就被置上，此时还需要走完公布与结算流程。
  // nightBeat 为 open 表示这一步在等固定节拍，也停下来。
  while (state.phase !== 'GAME_OVER' && state.pending === null && state.nightBeat !== 'open') {
    steps += 1;
    if (steps > MAX_DRIVE_STEPS) {
      throw new Error(`状态机推进超过 ${MAX_DRIVE_STEPS} 步，疑似死循环（当前阶段 ${state.phase}）`);
    }
    advanceOnce(state, events);

    // 新的待办一旦产生就记进事件流，让整局日志自包含（复盘与 AI 记忆都靠它）
    // 这里通过函数读取，避免 TS 沿用循环条件里的收窄结果
    const next = readPending(state);
    if (next !== null && next !== announced) {
      announced = next;
      emit(
        state,
        events,
        {
          t: 'action_requested',
          seat: next.seat,
          options: next.options,
          deadlineMs: next.deadlineMs,
        },
        seatsVisible(next.seat),
      );
    }
  }
}

function readPending(state: GameState): PendingRequest | null {
  return state.pending;
}

function goTo(state: GameState, events: GameEvent[], phase: Phase): void {
  const from = state.phase;
  state.phase = phase;
  // 新的一步：节拍状态归零（夜里那一步要不要按住，由阶段函数自己决定）
  state.nightBeat = 'idle';
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
    case 'CHIEF_SIGNUP':
      return phaseChiefSignup(state, events);
    case 'CHIEF_SPEECH':
      return phaseChiefSpeech(state, events);
    case 'CHIEF_WITHDRAW':
      return phaseChiefWithdraw(state, events);
    case 'CHIEF_VOTE':
    case 'CHIEF_PK_VOTE':
      return phaseChiefVote(state, events);
    case 'CHIEF_PK_SPEECH':
      return phaseChiefPkSpeech(state, events);
    case 'DAWN_ANNOUNCE':
      return phaseDawnAnnounce(state, events);
    case 'CHIEF_TRANSFER':
      return phaseChiefTransfer(state, events);
    case 'LAST_WORDS':
      return phaseLastWords(state, events);
    case 'HUNTER_SHOOT':
      return phaseHunterShoot(state, events);
    case 'DAY_SPEECH':
      return phaseDaySpeech(state, events);
    case 'DAY_VOTE':
    case 'DAY_PK_VOTE':
      return phaseDayVote(state, events);
    case 'DAY_PK_SPEECH':
      return phaseDayPkSpeech(state, events);
    default:
      throw new Error(`阶段 ${state.phase} 没有对应的处理函数`);
  }
}

function ask(state: GameState, seat: SeatId, options: PendingRequest['options'], deadlineMs: number): void {
  state.pending = { seat, options, deadlineMs };
}

// ────────────────────────────── 夜晚 ──────────────────────────────

/**
 * 一步夜里的事做完了：固定节拍开着就按住等「到点了」，否则直接换下一步。
 *
 * `nightBeat === 'beaten'` 表示节拍刚敲过，这时必须真的换步 —— 再按住就会卡在这一步。
 */
function finishNightStep(state: GameState, events: GameEvent[], next: Phase): void {
  if (state.rules.nightStepMs > 0 && state.nightBeat !== 'beaten') {
    state.nightBeat = 'open';
    return;
  }
  goTo(state, events, next);
}

function phaseNightGuard(state: GameState, events: GameEvent[]): void {
  // 这一步的节拍已经到过：不管之前有没有人动过手，都换下一步
  if (state.nightBeat === 'beaten') return finishNightStep(state, events, 'NIGHT_WOLF');

  const [guard] = seatsWithRole(state, 'guard');
  if (guard !== undefined && !state.night.actedSeats.includes(guard)) {
    ask(state, guard, guardOptions(state, guard), nightStepMs(state));
    return;
  }
  // 这一步没人（角色出局）或已经动过手：换步 —— 但固定节拍下照样要走满这一步
  finishNightStep(state, events, 'NIGHT_WOLF');
}

function phaseNightWolf(state: GameState, events: GameEvent[]): void {
  if (state.nightBeat === 'beaten') return finishNightStep(state, events, 'NIGHT_WITCH');

  const wolves = seatsWithRole(state, 'werewolf');
  // 狼队共识由一个代表提交；内部协商由 agent-host 在 M3 阶段实现
  const speaker = wolves[0];
  if (speaker !== undefined && !state.night.actedSeats.includes(speaker)) {
    ask(state, speaker, wolfOptions(state), nightStepMs(state));
    return;
  }
  finishNightStep(state, events, 'NIGHT_WITCH');
}

function phaseNightWitch(state: GameState, events: GameEvent[]): void {
  if (state.nightBeat === 'beaten') return finishNightStep(state, events, 'NIGHT_SEER');

  const [witch] = seatsWithRole(state, 'witch');
  if (witch === undefined || state.night.actedSeats.includes(witch)) {
    return finishNightStep(state, events, 'NIGHT_SEER');
  }

  // 解药用光后，女巫不再被告知今夜谁被刀
  const informedKilled = state.witchPotions.antidote > 0 ? state.night.wolfTarget : null;
  emit(state, events, { t: 'witch_night_info', seat: witch, killed: informedKilled }, seatsVisible(witch));
  ask(state, witch, witchOptions(state, witch), nightStepMs(state));
}

/** 夜间每一步给多久：固定节拍开着就用节拍，否则用通用的夜间时限 */
function nightStepMs(state: GameState): number {
  return state.rules.nightStepMs > 0 ? state.rules.nightStepMs : state.rules.timeoutMs.night;
}

function phaseNightSeer(state: GameState, events: GameEvent[]): void {
  if (state.nightBeat !== 'beaten') {
    const [seer] = seatsWithRole(state, 'seer');
    if (seer !== undefined && !state.night.actedSeats.includes(seer)) {
      ask(state, seer, seerOptions(state, seer), nightStepMs(state));
      return;
    }

    // 固定节拍下，验人这一步也要等满才结算 —— 否则「天亮得特别快」本身就说明有人查了人
    if (state.rules.nightStepMs > 0) {
      state.nightBeat = 'open';
      return;
    }
  }

  resolveNight(state);

  // 狼刀在先：胜负已定，就不必再走警长竞选，直接公布死讯并结算
  if (state.winner !== null) return goTo(state, events, 'DAWN_ANNOUNCE');

  if (state.day === 1 && state.board.hasChiefElection && state.rules.chiefElectionBeforeDawnAnnounce) {
    return goTo(state, events, 'CHIEF_SIGNUP');
  }
  goTo(state, events, 'DAWN_ANNOUNCE');
}

/**
 * 夜晚结算。只计算死亡并写入 player.death，**不公布死讯** ——
 * 公布发生在 DAWN_ANNOUNCE，因为变体 A 下警长竞选排在公布之前。
 */
function resolveNight(state: GameState): void {
  const { wolfTarget, guardTarget, witchSaved, witchPoisoned } = state.night;

  if (wolfTarget !== null) {
    const guarded = guardTarget === wolfTarget;
    const saved = witchSaved === wolfTarget;
    const dies = guarded && saved ? state.rules.guardedAndSavedDies : !(guarded || saved);
    if (dies) playerAt(state, wolfTarget).death = { cause: 'wolf', day: state.day };
  }

  // 狼刀在先：狼当夜达成胜利条件时直接判狼胜，后手的毒杀不改变结果
  const wolfVictory = state.rules.wolfKillTakesPriority ? checkWinner(state) : null;

  if (witchPoisoned !== null) {
    // 记为 poison —— 这决定猎人能否开枪（被毒死不能开枪）
    playerAt(state, witchPoisoned).death = { cause: 'poison', day: state.day };
  }

  state.winner = wolfVictory ?? checkWinner(state);
  state.night.deaths = state.players.filter((p) => p.death?.day === state.day).map((p) => p.seat);
  state.lastNightGuardTarget = state.night.guardTarget;
}

// ────────────────────────────── 警长竞选 ──────────────────────────────

/** 仍在竞选的候选者 */
function activeCandidates(state: GameState): SeatId[] {
  return state.chief.candidates.filter((seat) => !state.chief.withdrawn.includes(seat));
}

/** 警下玩家：没上警的人才有投票权。变体 A 下首夜死者在死讯公布前也在此列。 */
function chiefVoters(state: GameState): SeatId[] {
  return onBoardSeats(state).filter((seat) => !state.chief.candidates.includes(seat));
}

function phaseChiefSignup(state: GameState, events: GameEvent[]): void {
  const next = onBoardSeats(state).find((seat) => !state.chief.signupAnswered.includes(seat));
  if (next !== undefined) {
    ask(state, next, chiefSignupOptions(), state.rules.timeoutMs.chiefSignup);
    return;
  }

  const active = activeCandidates(state);
  if (active.length > 1) {
    state.speech.queue = [...active];
    return goTo(state, events, 'CHIEF_SPEECH');
  }
  if (active.length === 1) return electChief(state, events, active[0]!);
  noChief(state, events);
}

function phaseChiefSpeech(state: GameState, events: GameEvent[]): void {
  const speaker = state.speech.queue[0];
  if (speaker !== undefined) {
    ask(state, speaker, speakOptions('竞选发言'), state.rules.timeoutMs.chiefSpeech);
    return;
  }
  state.chief.withdrawQueue = [...activeCandidates(state)];
  goTo(state, events, 'CHIEF_WITHDRAW');
}

function phaseChiefWithdraw(state: GameState, events: GameEvent[]): void {
  const next = state.chief.withdrawQueue[0];
  if (next !== undefined) {
    ask(state, next, chiefWithdrawOptions(), state.rules.timeoutMs.chiefSignup);
    return;
  }

  const active = activeCandidates(state);
  if (active.length > 1) {
    state.chief.votes = [];
    return goTo(state, events, 'CHIEF_VOTE');
  }
  if (active.length === 1) return electChief(state, events, active[0]!);
  noChief(state, events);
}

function phaseChiefVote(state: GameState, events: GameEvent[]): void {
  const active = activeCandidates(state);
  const voters = state.chief.round === 1 ? chiefVoters(state) : state.chief.votersCache;

  const remaining = voters.filter((seat) => !state.chief.votes.some((v) => v.seat === seat));
  if (remaining.length > 0) {
    ask(state, remaining[0]!, chiefVoteOptions(active), state.rules.timeoutMs.chiefVote);
    return;
  }

  const { counts, top } = tally(state.chief.votes, () => 1);

  if (top.length === 1) {
    emit(state, events, { t: 'chief_vote_tally', counts, elected: top[0]!, tie: false });
    return electChief(state, events, top[0]!);
  }

  if (top.length > 1 && state.chief.round === 1) {
    state.chief.round = 2;
    state.chief.tied = top;
    state.chief.votes = [];
    state.speech.queue = [...top];
    emit(state, events, { t: 'chief_vote_tally', counts, elected: null, tie: true });
    return goTo(state, events, 'CHIEF_PK_SPEECH');
  }

  // 再次平票 → 警徽流失
  emit(state, events, { t: 'chief_vote_tally', counts, elected: null, tie: top.length > 1 });
  noChief(state, events);
}

function phaseChiefPkSpeech(state: GameState, events: GameEvent[]): void {
  const speaker = state.speech.queue[0];
  if (speaker !== undefined) {
    ask(state, speaker, speakOptions('PK 发言'), state.rules.timeoutMs.chiefSpeech);
    return;
  }
  // 平票者不能投票
  state.chief.votersCache = chiefVoters(state).filter((seat) => !state.chief.tied.includes(seat));
  state.chief.votes = [];
  goTo(state, events, 'CHIEF_PK_VOTE');
}

function electChief(state: GameState, events: GameEvent[], seat: SeatId): void {
  setChief(state, seat);
  goTo(state, events, 'DAWN_ANNOUNCE');
}

function noChief(state: GameState, events: GameEvent[]): void {
  state.chief.badgeAlive = false;
  setChief(state, null);
  goTo(state, events, 'DAWN_ANNOUNCE');
}

function setChief(state: GameState, seat: SeatId | null): void {
  state.chief.elected = seat;
  for (const player of state.players) player.isChief = player.seat === seat;
}

// ────────────────────────────── 天亮结算 ──────────────────────────────

function phaseDawnAnnounce(state: GameState, events: GameEvent[]): void {
  state.resolutionStage = 'dawn';

  const unannounced = state.players.filter((p) => p.death !== null && !p.deathAnnounced);
  for (const player of unannounced) {
    player.deathAnnounced = true;
    emit(state, events, { t: 'died', seat: player.seat, cause: player.death!.cause });
    if (player.isChief && state.chief.badgeAlive) state.pendingChiefTransfer = player.seat;
  }

  if (state.winner !== null) return finishGame(state, events, state.winner);

  state.lastWordsQueue = unannounced.filter((p) => shouldHaveLastWords(state, p)).map((p) => p.seat);
  state.hunterQueue = unannounced.filter((p) => canHunterShoot(state, p)).map((p) => p.seat);
  proceedAfterDeaths(state, events);
}

/**
 * 死亡结算之后的统一推进：先处理警徽去向，再遗言，再猎人开枪，最后回到场景。
 * 所有分支都汇聚到这里，避免各处重复写顺序。
 */
function proceedAfterDeaths(state: GameState, events: GameEvent[]): void {
  if (state.pendingChiefTransfer !== null) return goTo(state, events, 'CHIEF_TRANSFER');
  if (state.lastWordsQueue.length > 0) return goTo(state, events, 'LAST_WORDS');
  if (state.hunterQueue.length > 0) return goTo(state, events, 'HUNTER_SHOOT');
  finishAftermath(state, events);
}

function finishAftermath(state: GameState, events: GameEvent[]): void {
  const winner = checkWinner(state);
  if (winner !== null) return finishGame(state, events, winner);

  if (state.resolutionStage === 'dawn') {
    state.speech = emptySpeech();
    state.speech.queue = speechOrder(state);
    if (state.speech.queue.length === 0) {
      state.vote = { round: 1, voters: aliveSeats(state), votes: [], tied: [] };
      return goTo(state, events, 'DAY_VOTE');
    }
    return goTo(state, events, 'DAY_SPEECH');
  }

  enterNight(state, events);
}

function phaseChiefTransfer(state: GameState, events: GameEvent[]): void {
  const chiefSeat = state.pendingChiefTransfer;
  if (chiefSeat === null) return proceedAfterDeaths(state, events);
  ask(state, chiefSeat, chiefTransferOptions(state, chiefSeat), state.rules.timeoutMs.lastWords);
}

function phaseLastWords(state: GameState, events: GameEvent[]): void {
  const seat = state.lastWordsQueue[0];
  if (seat === undefined) return proceedAfterDeaths(state, events);
  ask(state, seat, speakOptions('发表遗言'), state.rules.timeoutMs.lastWords);
}

function phaseHunterShoot(state: GameState, events: GameEvent[]): void {
  const seat = state.hunterQueue[0];
  if (seat === undefined) return proceedAfterDeaths(state, events);
  ask(state, seat, hunterShootOptions(state, seat), state.rules.timeoutMs.hunterShoot);
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

// ────────────────────────────── 白天 ──────────────────────────────

/** 发言顺序：从警长下一位开始顺时针，警长最后；无警长则从最小座位号开始 */
function speechOrder(state: GameState): SeatId[] {
  const alive = aliveSeats(state);
  const chief = state.players.find((p) => p.isChief && p.death === null)?.seat;
  if (chief === undefined) return alive;
  return [...alive.filter((seat) => seat > chief), ...alive.filter((seat) => seat < chief), chief];
}

function phaseDaySpeech(state: GameState, events: GameEvent[]): void {
  const speaker = state.speech.queue[0];
  if (speaker !== undefined) {
    ask(state, speaker, speakOptions('发表发言'), state.rules.timeoutMs.daySpeech);
    return;
  }
  state.vote = { round: 1, voters: aliveSeats(state), votes: [], tied: [] };
  goTo(state, events, 'DAY_VOTE');
}

function phaseDayVote(state: GameState, events: GameEvent[]): void {
  if (state.vote.round === 1 && state.vote.voters.length === 0) {
    state.vote = { round: 1, voters: aliveSeats(state), votes: [], tied: [] };
  }

  const remaining = state.vote.voters.filter((seat) => !state.vote.votes.some((v) => v.seat === seat));
  if (remaining.length > 0) {
    const pk = state.vote.round === 2 ? state.vote.tied : undefined;
    ask(state, remaining[0]!, dayVoteOptions(state, remaining[0]!, pk), state.rules.timeoutMs.dayVote);
    return;
  }

  const { counts, top } = tally(state.vote.votes, (seat) =>
    playerAt(state, seat).isChief ? state.rules.chiefVoteWeight : 1,
  );

  if (top.length === 1) {
    emit(state, events, { t: 'vote_tally', counts, eliminated: top[0]!, tie: false });
    return eliminateByVote(state, events, top[0]!);
  }

  if (top.length > 1 && state.vote.round === 1) {
    state.vote.round = 2;
    state.vote.tied = top;
    state.vote.voters = aliveSeats(state).filter((seat) => !top.includes(seat));
    state.vote.votes = [];
    state.speech.queue = [...top];
    emit(state, events, { t: 'vote_tally', counts, eliminated: null, tie: true });
    return goTo(state, events, 'DAY_PK_SPEECH');
  }

  // 无人出局（含 PK 再次平票、全员弃票）
  emit(state, events, { t: 'vote_tally', counts, eliminated: null, tie: top.length > 1 });
  state.resolutionStage = 'day';
  proceedAfterDeaths(state, events);
}

function phaseDayPkSpeech(state: GameState, events: GameEvent[]): void {
  const speaker = state.speech.queue[0];
  if (speaker !== undefined) {
    ask(state, speaker, speakOptions('PK 发言'), state.rules.timeoutMs.daySpeech);
    return;
  }
  goTo(state, events, 'DAY_PK_VOTE');
}

function eliminateByVote(state: GameState, events: GameEvent[], seat: SeatId): void {
  const player = playerAt(state, seat);
  player.death = { cause: 'vote', day: state.day };
  player.deathAnnounced = true;
  emit(state, events, { t: 'died', seat, cause: 'vote' });

  if (player.isChief && state.chief.badgeAlive) state.pendingChiefTransfer = seat;

  state.resolutionStage = 'day';
  state.lastWordsQueue = shouldHaveLastWords(state, player) ? [seat] : [];
  state.hunterQueue = canHunterShoot(state, player) ? [seat] : [];
  proceedAfterDeaths(state, events);
}

// ────────────────────────────── 胜负与夜循环 ──────────────────────────────

function checkWinner(state: GameState): Camp | null {
  const alive = state.players.filter((p) => p.death === null);
  if (alive.filter((p) => p.role === 'werewolf').length === 0) return 'good';

  const initialGods = state.players.filter((p) => isGodRole(p.role)).length;
  const initialVillagers = state.players.filter((p) => p.role === 'villager').length;
  const gods = alive.filter((p) => isGodRole(p.role)).length;
  const villagers = alive.filter((p) => p.role === 'villager').length;

  if (initialGods > 0 && gods === 0) return 'wolf';
  if (initialVillagers > 0 && villagers === 0) return 'wolf';
  return null;
}

function finishGame(state: GameState, events: GameEvent[], winner: Camp): void {
  state.winner = winner;
  state.pending = null;
  goTo(state, events, 'GAME_OVER');
  emit(state, events, {
    t: 'game_over',
    winner,
    reveal: state.players.map((p) => ({ seat: p.seat, role: p.role })),
  });
}

function enterNight(state: GameState, events: GameEvent[]): void {
  state.day += 1;
  state.night = emptyNight();
  state.vote = emptyVote();
  state.speech = emptySpeech();
  goTo(state, events, 'NIGHT_GUARD');
}

// ────────────────────────────── 计票 ──────────────────────────────

function tally(
  votes: { seat: SeatId; target: VoteTarget }[],
  weightOf: (voter: SeatId) => number,
): { counts: { seat: SeatId; votes: number }[]; top: SeatId[] } {
  const totals = new Map<SeatId, number>();
  for (const vote of votes) {
    if (vote.target === 'abstain') continue;
    totals.set(vote.target, (totals.get(vote.target) ?? 0) + weightOf(vote.seat));
  }

  const counts = [...totals.entries()]
    .map(([seat, votes_]) => ({ seat, votes: votes_ }))
    .sort((a, b) => b.votes - a.votes || a.seat - b.seat);

  const max = counts[0]?.votes ?? 0;
  const top = max > 0 ? counts.filter((c) => c.votes === max).map((c) => c.seat) : [];
  return { counts, top };
}

// ────────────────────────────── Action 校验与应用 ──────────────────────────────

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

  if (action.kind === 'speak' || action.kind === 'chief_signup') return null;

  if (action.kind === 'chief_withdraw') {
    const allowed = candidates.some((o) => o.params?.['withdraw']?.includes(action.withdraw));
    return allowed ? null : '当前不能提交这个退水意向';
  }

  if (action.kind === 'witch_act') {
    // 女巫同一个 kind 下有多个选项（解药 / 毒药 / 不用药），先按 use 挑出适用的那一个
    const matched = candidates.find((o) => o.params?.['use']?.includes(action.use));
    if (!matched) return `当前不能使用「${action.use}」（可能是药水已用完或规则不允许）`;
    if (action.use === 'pass') {
      return action.target === undefined ? null : '选择不用药时不应指定目标';
    }
    if (action.target === undefined) return `使用「${action.use}」必须指定目标`;
    return matched.targets.includes(action.target) ? null : `${action.target} 号不是合法目标`;
  }

  if (action.kind === 'hunter_shoot' || action.kind === 'chief_transfer') {
    if (action.target === null) {
      if (action.kind === 'hunter_shoot') return null;
      const allowDestroy = candidates.some((o) => o.params?.['allowDestroy']?.includes(true));
      return allowDestroy ? null : '当前不能撕毁警徽';
    }
    const targets = candidates.flatMap((o) => o.targets);
    return targets.includes(action.target) ? null : `${action.target} 号不是合法目标`;
  }

  const target = 'target' in action ? action.target : undefined;
  if (target === undefined) return `${action.kind} 必须指定目标`;
  if (target === 'abstain') {
    const allowAbstain = candidates.some((o) => o.params?.['allowAbstain']?.includes(true));
    return allowAbstain ? null : '当前不允许弃票';
  }
  const targets = candidates.flatMap((o) => o.targets);
  return targets.includes(target) ? null : `${target} 号不是合法目标`;
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
      emit(
        state,
        events,
        { t: 'seer_result', seat: action.actor, target: action.target, camp },
        seatsVisible(action.actor),
      );
      break;
    }
    case 'chief_signup':
      state.chief.signupAnswered.push(action.actor);
      if (action.join) state.chief.candidates.push(action.actor);
      break;
    case 'chief_withdraw':
      if (action.withdraw && !state.chief.withdrawn.includes(action.actor)) {
        state.chief.withdrawn.push(action.actor);
        emit(state, events, { t: 'chief_withdrawn', seat: action.actor });
      }
      state.chief.withdrawQueue = state.chief.withdrawQueue.filter((s) => s !== action.actor);
      break;
    case 'chief_transfer': {
      const transferTo = action.target;
      state.pendingChiefTransfer = null;
      if (transferTo === null) {
        state.chief.badgeAlive = false;
        setChief(state, null);
      } else {
        setChief(state, transferTo);
      }
      emit(state, events, { t: 'chief_transferred', from: action.actor, to: transferTo });
      break;
    }
    case 'speak':
      emit(state, events, {
        t: 'spoke',
        seat: action.actor,
        text: action.text,
        context: speechContextFor(state.phase),
        // 拿不到起点的一方不填 ms（可选字段），别瞎编一个耗时
        ...(action.ms !== undefined ? { ms: action.ms } : {}),
      });
      state.speech.spoken.push(action.actor);
      if (state.phase === 'LAST_WORDS') {
        playerAt(state, action.actor).lastWordsDone = true;
        state.lastWordsQueue = state.lastWordsQueue.filter((s) => s !== action.actor);
      } else {
        state.speech.queue = state.speech.queue.filter((s) => s !== action.actor);
      }
      break;
    case 'vote':
      // 投票是明票：收到一张就公开一张，后面的看得到已亮出的票型
      emit(state, events, { t: 'voted', seat: action.actor, target: action.target });
      if (state.phase === 'CHIEF_VOTE' || state.phase === 'CHIEF_PK_VOTE') {
        if (action.target !== 'abstain') state.chief.votes.push({ seat: action.actor, target: action.target });
      } else {
        state.vote.votes.push({ seat: action.actor, target: action.target });
      }
      break;
    case 'hunter_shoot': {
      state.hunterQueue = state.hunterQueue.filter((s) => s !== action.actor);
      emit(state, events, { t: 'hunter_shot', seat: action.actor, target: action.target });
      if (action.target === null) break;

      const victim = playerAt(state, action.target);
      victim.death = { cause: 'gun', day: state.day };
      victim.deathAnnounced = true;
      emit(state, events, { t: 'died', seat: action.target, cause: 'gun' });

      if (victim.isChief && state.chief.badgeAlive) state.pendingChiefTransfer = action.target;
      if (canHunterShoot(state, victim)) state.hunterQueue.push(action.target);
      break;
    }
  }

  if (isNightPhase(state.phase)) {
    state.night.actedSeats.push(action.actor);
  }
}

/** 行动之后该往哪走。留在原阶段的（如 NIGHT_SEER）由阶段函数自己处理后续推进。 */
function afterAction(state: GameState, events: GameEvent[]): void {
  // 夜间固定节拍开着时，换步交给会话服务的「到点了」—— 行动不换步
  if (state.rules.nightStepMs > 0 && isNightPhase(state.phase)) return;

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
