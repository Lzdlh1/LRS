import { randomUUID } from 'node:crypto';
import type { AgentHost, DecisionLogEntry } from '@lrs/agent-host';
import {
  choicesFor,
  concurrentBatch,
  createGame,
  DEFAULT_BOARD,
  eventsFor,
  needsSpeech,
  pendingRequest,
  step,
  type EngineConfig,
  type GameState,
  type PendingRequest,
  type Viewer,
} from '@lrs/core-engine';
import type { Action, GameEvent, Logger, SeatId } from '@lrs/shared';
import type { GameStore } from '../store/gameStore.ts';
import { defaultActionFor, randomActionFor } from './defaultAction.ts';
import {
  projectState,
  type ClientMessage,
  type ClientState,
  type ReplayDecision,
  type ReplayPayload,
  type ServerMessage,
  type UsageReport,
  type UsageScope,
} from './protocol.ts';

export interface Subscriber {
  id: string;
  viewer: Viewer;
  send: (message: ServerMessage) => void;
}

/** 每开一局都要重建 AI（记忆不能跨局残留） */
export type AgentHostFactory = (input: {
  seatCount: number;
  names: string[];
  /** 本局真人坐哪个座位 —— AI 要绕开它思考 */
  humanSeat: SeatId;
  /** AI 发言的增量片段，房间负责转发给前端 */
  onSpeechDelta: (seat: SeatId, delta: string) => void;
  /** 每次决策完成，房间负责记下来供复盘 */
  onDecision: (entry: DecisionLogEntry) => void;
}) => AgentHost;

export interface GameRoomOptions {
  logger: Logger;
  store: GameStore | null;
  rules?: EngineConfig['rules'];
  id?: string;
  /** 不传就是纯手动模式（M2 的调试玩法） */
  hostFactory?: AgentHostFactory;
}

/** 确定性随机源，便于用固定种子复现一局 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 一个房间 = 一局对局 + 一组订阅者。
 *
 * 职责：驱动引擎、按视角裁剪事件与状态、广播、超时兜底、落库。
 * 这里不含任何游戏规则判断 —— 规则全在 core-engine。
 */
export class GameRoom {
  readonly roomId: string;

  private readonly logger: Logger;
  private readonly store: GameStore | null;
  private readonly rules: EngineConfig['rules'];
  private readonly hostFactory: AgentHostFactory | undefined;

  private host: AgentHost | null = null;
  private aiToken = '';
  /** 并行预思考的结果，key 是「天:阶段:座位」 */
  private readonly prefetch = new Map<string, Promise<Action | null>>();
  /** 已经批量发起过的「天:阶段」，避免同一阶段重复补发 */
  private prefetchBatch = '';
  /** 本局的 AI 决策记录，供复盘查看「它当时在想什么」 */
  private decisions: ReplayDecision[] = [];
  private currentGameId: string;
  private state: GameState;
  private history: GameEvent[] = [];
  private readonly subscribers = new Map<string, Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  private deadlineAt = 0;
  private finished = false;
  /**
   * 真人按下的暂停。
   *
   * 为什么必须有：真人座位的待办会超时兜底，兜底之后轮到 AI 就会发起真实模型调用，
   * 一局就这么自己走完了 —— 界面开着没人管的时候，这是真金白银。
   */
  private paused = false;
  /** 中止：终态，不再有任何推进，只能新开一局 */
  private stopped = false;
  /**
   * 本局真人坐哪个座位。
   *
   * 每局随机重抽 —— 固定坐 1 号会让「1 号必是真人」变成一条公开信息，
   * 狼人（AI）据此就能反推出身份分布。视角、待办判断都要读它，不能写死 1。
   */
  private humanSeat: SeatId = 1;

  constructor(options: GameRoomOptions) {
    this.roomId = options.id ?? randomUUID();
    this.logger = options.logger;
    this.store = options.store;
    this.rules = options.rules;
    this.hostFactory = options.hostFactory;
    this.currentGameId = randomUUID();
    this.state = this.startNewGame();
    this.armTimer();
    this.scheduleAi();
  }

  /** 当前这一局的 id（重开一局会变） */
  get gameId(): string {
    return this.currentGameId;
  }

  /** 本局真人的座位（重开一局会变） */
  get humanSeatId(): SeatId {
    return this.humanSeat;
  }

  // ── 订阅 ──

  subscribe(subscriber: Subscriber): void {
    this.subscribers.set(subscriber.id, subscriber);
    this.sendSnapshot(subscriber, 0);
    // 人回来了就把推进接上：空闲期间计时器是停着的
    this.armTimer();
    this.scheduleAi();
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
    // 最后一个人走了就别再往下打 —— 超时兜底是为了「有人在等」而存在的
    if (this.subscribers.size === 0) this.clearTimer();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  setViewer(id: string, viewer: Viewer): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    subscriber.viewer = viewer;
    this.logger.debug('切换视角', { channel: id, viewer });
    this.sendSnapshot(subscriber, 0);
  }

  handleMessage(id: string, message: ClientMessage): void {
    switch (message.type) {
      case 'action':
        this.submit(message.action, `ws:${id}`);
        return;
      case 'setViewer':
        this.setViewer(id, message.viewer);
        return;
      case 'resync': {
        const subscriber = this.subscribers.get(id);
        if (subscriber) this.sendSnapshot(subscriber, message.sinceSeq);
        return;
      }
      case 'newGame':
        this.newGame(message.seed);
        return;
      case 'autoPlay':
        this.autoPlay(message.count ?? 1);
        return;
      case 'replay':
        this.sendReplay(id, message.day);
        return;
      case 'usage':
        this.sendUsage(id, message.scope);
        return;
      case 'pause':
        this.setPaused(true);
        return;
      case 'resume':
        this.setPaused(false);
        return;
      case 'stop':
        this.stopGame();
        return;
      default: {
        const unknown = message as { type?: string };
        this.logger.warn('收到未知消息', { channel: id, type: unknown.type });
      }
    }
  }

  // ── 推进 ──

  submit(action: Action, origin = 'debug'): void {
    if (this.paused || this.stopped) {
      this.logger.warn('对局处于暂停/中止状态，忽略这次推进', {
        origin,
        kind: action.kind,
        actor: action.actor,
        paused: this.paused,
        stopped: this.stopped,
      });
      return;
    }

    this.clearTimer();
    const result = step(this.state, action);
    this.state = result.state;

    this.logger.debug('提交行动', {
      gameId: this.currentGameId,
      origin,
      kind: action.kind,
      actor: action.actor,
      emitted: result.events.length,
    });

    this.record(result.events);
    this.checkFinished();
    this.broadcast(result.events);
    this.scheduleAi();
  }

  /** 调试面板用：连续代打若干步 */
  autoPlay(count = 1): void {
    for (let i = 0; i < count; i += 1) {
      const pending = pendingRequest(this.state);
      if (!pending || this.state.winner !== null) return;
      this.submit(randomActionFor(pending), 'auto');
    }
  }

  /**
   * 暂停 / 继续。
   *
   * 暂停期间：不排超时兜底、不发起 AI 调用、外部推进一律拒绝 ——
   * 也就是说这个开关一按，模型花销就是 0。
   */
  private setPaused(paused: boolean): void {
    if (this.stopped || this.state.winner !== null || this.paused === paused) return;
    this.paused = paused;

    this.logger.info(paused ? '对局已暂停' : '对局已继续', {
      gameId: this.currentGameId,
      seq: this.state.seq,
    });

    if (paused) {
      this.clearTimer();
      this.deadlineAt = 0;
    }
    this.broadcastState();
    if (!paused) {
      this.armTimer();
      this.scheduleAi();
    }
  }

  /** 中止本局：立刻停手且不再恢复，要接着玩只能新开一局 */
  private stopGame(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.paused = false;
    this.clearTimer();
    this.deadlineAt = 0;

    this.logger.info('对局被中止', {
      gameId: this.currentGameId,
      seq: this.state.seq,
      pending: this.state.pending?.seat ?? null,
    });
    this.broadcastState();
  }

  newGame(seed?: number): void {
    this.clearTimer();
    this.currentGameId = randomUUID();
    const previousSeat = this.humanSeat;
    this.state = this.startNewGame(seed);
    this.armTimer();
    for (const subscriber of this.subscribers.values()) {
      // 位次每局重抽，真人视角要跟着挪到新座位，否则会莫名其妙看到别人的牌
      if (subscriber.viewer === previousSeat) subscriber.viewer = this.humanSeat;
      this.sendSnapshot(subscriber, 0);
    }
    this.scheduleAi();
  }

  dispose(): void {
    this.clearTimer();
    this.subscribers.clear();
  }

  // ── 内部 ──

  private startNewGame(seed?: number): GameState {
    this.finished = false;
    this.paused = false;
    this.stopped = false;
    this.history = [];
    this.aiToken = '';
    this.prefetch.clear();
    this.prefetchBatch = '';
    this.decisions = [];

    const rng = seed === undefined ? Math.random : mulberry32(seed);
    // 位次每局重抽：先抽座位，再抽牌 —— 固定种子依然能完整复现一局
    this.humanSeat = 1 + Math.floor(rng() * DEFAULT_BOARD.seatCount);
    const result = createGame({ humanSeats: [this.humanSeat], rules: this.rules, rng });
    this.history.push(...result.events);

    this.logger.info('新对局开始', {
      gameId: this.currentGameId,
      board: result.state.board.name,
      seed: seed ?? null,
      humanSeat: this.humanSeat,
      day: result.state.day,
      phase: result.state.phase,
      aiSeats: this.hostFactory ? result.state.players.filter((p) => !p.isHuman).length : 0,
    });
    this.logEvents(result.events);

    // AI 的记忆不能跨局，所以每局重建一次
    this.host = this.hostFactory
      ? this.hostFactory({
          seatCount: result.state.board.seatCount,
          names: result.state.players.map((player) => player.name),
          humanSeat: this.humanSeat,
          onSpeechDelta: (seat, delta) => this.broadcastStream(seat, delta),
          onDecision: (entry) => this.recordDecision(entry),
        })
      : null;
    this.host?.observe(result.events);

    if (this.store) {
      try {
        this.store.createGame({
          id: this.gameId,
          board: result.state.board.name,
          configJson: JSON.stringify({ humanSeats: [this.humanSeat], seed: seed ?? null }),
          startedAt: new Date().toISOString(),
          endedAt: null,
          winner: null,
        });
        this.store.saveSeats(
          this.gameId,
          result.state.players.map((player) => ({
            seat: player.seat,
            role: player.role,
            isHuman: player.isHuman,
            profileId: null,
          })),
        );
      } catch (error) {
        this.logger.error('初始化对局落库失败', { gameId: this.currentGameId, error: String(error) });
      }
    }

    this.persist(result.events);
    return result.state;
  }

  /** 把新产生的事件记进内存历史、写日志、落库，并喂给所有 AI */
  private record(newEvents: readonly GameEvent[]): void {
    if (newEvents.length === 0) return;
    this.history.push(...newEvents);
    this.logEvents(newEvents);
    this.persist(newEvents);
    this.host?.observe(newEvents);
  }

  private checkFinished(): void {
    if (this.state.winner === null) {
      this.armTimer();
      return;
    }
    if (this.finished) return;

    this.finished = true;
    this.clearTimer();
    this.logger.info('对局结束', {
      gameId: this.currentGameId,
      winner: this.state.winner,
      day: this.state.day,
      seq: this.state.seq,
    });

    if (this.store) {
      try {
        this.store.finishGame(this.currentGameId, this.state.winner, new Date().toISOString());
      } catch (error) {
        this.logger.error('对局结束落库失败', { gameId: this.currentGameId, error: String(error) });
      }
    }
  }

  private armTimer(): void {
    this.clearTimer();
    const pending = pendingRequest(this.state);
    if (!pending) {
      this.deadlineAt = 0;
      return;
    }

    // 暂停/中止期间一律不排兜底计时器：兜底会往前推局面，往前推就要花钱
    if (this.paused || this.stopped) {
      this.deadlineAt = 0;
      return;
    }

    const seat = pending.seat;

    // AI 的节奏由模型路由层的超时与降级控制，这里不再叠一层定时器
    if (this.host?.handles(seat)) {
      this.deadlineAt = 0;
      return;
    }

    // 没人在看的时候不装计时器：否则一个闲置的服务会自己把整局打完，
    // 每一次 AI 发言都是真金白银。人一连上来 subscribe() 会重新装。
    if (this.subscribers.size === 0) {
      this.deadlineAt = 0;
      return;
    }

    this.deadlineAt = Date.now() + pending.deadlineMs;
    this.timer = setTimeout(() => {
      const current = pendingRequest(this.state);
      // 期间可能已经有人提交或换了阶段，确认一下再兜底
      if (!current || current.seat !== seat) return;
      this.logger.info('行动超时，提交兜底动作', { gameId: this.currentGameId, seat });
      this.submit(defaultActionFor(current), 'timeout');
    }, pending.deadlineMs);
    // 测试里用的是假定时器，unref 可能不存在
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 如果当前轮到 AI，就让它去思考。
   *
   * 用 `seq:seat` 做去重令牌：同一轮待办只会触发一次，
   * 换阶段或换人之后令牌自然失效，不会重复调用模型。
   */
  private scheduleAi(): void {
    const host = this.host;
    if (!host) return;

    // 暂停/中止期间连想都不去想
    if (this.paused || this.stopped) {
      this.aiToken = '';
      return;
    }

    // 没人看着就别动：否则服务一启动，AI 会先自己把一整夜加 8 个上警全走完。
    // 人一连上来 subscribe() 会重新叫一次。
    if (this.subscribers.size === 0) {
      this.aiToken = '';
      return;
    }

    // 预思考要在「轮到真人」时也照跑 —— 真人思考的这段时间正是它存在的意义
    this.startPrefetch(host);

    const pending = pendingRequest(this.state);
    if (!pending || !host.handles(pending.seat)) {
      this.aiToken = '';
      return;
    }

    const token = `${this.state.seq}:${pending.seat}`;
    if (this.aiToken === token) return;
    this.aiToken = token;

    void this.runAiTurn(pending);
  }

  /**
   * 并行预思考。
   *
   * 上警、退水这类阶段的待办彼此独立（规则上本来就是同时发生的），
   * 所以一进入这些阶段就把所有 AI 座位的决策一起发出去。
   * 真人玩家思考的这段时间正好被 AI 用来「想」—— 他一点下去，后面几位几乎立刻过完。
   *
   * 每个「天:阶段」只批量发起一次：否则某个座位的结果被消费掉之后，
   * 下一次调用又会把它当成「还没想过」而重复发一遍。
   *
   * 发言与投票**不做**预思考：后发言的人必须听到前面说了什么，
   * 后投票的人看得到已亮出的票型，提前算就是让 AI 凭空猜。
   */
  private startPrefetch(host: AgentHost): void {
    const batch = concurrentBatch(this.state);
    if (!batch) {
      this.prefetch.clear();
      this.prefetchBatch = '';
      return;
    }

    const batchId = `${this.state.day}:${this.state.phase}`;
    if (this.prefetchBatch === batchId) return;
    this.prefetchBatch = batchId;
    this.prefetch.clear();

    for (const item of batch) {
      if (!host.handles(item.seat)) continue;

      const request: PendingRequest = {
        seat: item.seat,
        options: item.options,
        deadlineMs: item.deadlineMs,
      };
      this.prefetch.set(
        this.prefetchKey(item.seat),
        host.act(this.state, request).catch((error: unknown) => {
          // 预思考失败不算事故：轮到它时走正常路径重新决策
          this.logger.warn('预思考失败，轮到该座位时会重新决策', {
            seat: item.seat,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }),
      );
    }

    this.logger.debug('并行预思考已发起', { batchId, seats: batch.length });
  }

  private prefetchKey(seat: SeatId): string {
    return `${this.state.day}:${this.state.phase}:${seat}`;
  }

  /**
   * 取出这一手的行动：优先复用预思考结果。
   * 但必须先确认它仍是当前合法选项之一 —— 局面万一变了就退回正常路径。
   */
  private async resolveAction(host: AgentHost, pending: PendingRequest): Promise<Action> {
    const key = this.prefetchKey(pending.seat);
    const cached = this.prefetch.get(key);
    if (!cached) return host.act(this.state, pending);

    this.prefetch.delete(key);
    const action = await cached;
    if (action && this.isStillAllowed(pending, action)) {
      this.logger.debug('复用预思考结果', { seat: pending.seat, kind: action.kind });
      return action;
    }

    this.logger.debug('预思考结果已不适用，改为当场决策', { seat: pending.seat });
    return host.act(this.state, pending);
  }

  /**
   * 这个行动还算不算当前待办的合法选择。
   *
   * 非发言阶段直接比对按钮摊平出来的合法动作；发言阶段没有按钮，
   * 只要求「是这个座位在发言」—— 少了这一支，AI 的发言会被全部误丢弃。
   */
  private isStillAllowed(pending: PendingRequest, action: Action): boolean {
    if (needsSpeech(pending)) return action.kind === 'speak' && action.actor === pending.seat;

    const signature = JSON.stringify(action);
    return choicesFor(pending).some((choice) => JSON.stringify(choice.action) === signature);
  }

  private async runAiTurn(pending: PendingRequest): Promise<void> {
    const host = this.host;
    if (!host) return;

    const startedAt = Date.now();
    try {
      const action = await this.resolveAction(host, pending);

      // 不管这次行动最终会不会被采纳，都要告诉前端「这段打字机结束」，避免光标一直闪
      if (action.kind === 'speak') this.broadcastStreamDone(pending.seat);

      // 模型思考期间局面可能已经变了（比如人工代打或超时兜底先提交了），先确认再提交。
      // 只比座位号不够 —— 同一个座位可能在下一个阶段又被点到，
      // 那时上一阶段的行动（比如夜里的刀人）会被误当成当前阶段的行动提交。
      const current = pendingRequest(this.state);
      if (!current || current.seat !== pending.seat || !this.isStillAllowed(current, action)) {
        this.logger.warn('AI 想好了但这一手已不适用，丢弃', {
          seat: pending.seat,
          kind: action.kind,
          currentKind: current?.options[0]?.kind ?? null,
          costMs: Date.now() - startedAt,
        });
        return;
      }

      this.logger.info('AI 完成思考', {
        seat: pending.seat,
        kind: action.kind,
        costMs: Date.now() - startedAt,
      });
      this.submit(action, 'ai');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('AI 行动失败，改用兜底动作', { seat: pending.seat, error: message });
      this.broadcastStreamDone(pending.seat);

      const current = pendingRequest(this.state);
      if (current && current.seat === pending.seat) {
        this.submit(defaultActionFor(current), 'ai-fallback');
      }
    }
  }

  private persist(events: readonly GameEvent[]): void {
    if (!this.store) return;
    try {
      this.store.appendEvents(this.gameId, events);
    } catch (error) {
      this.logger.error('事件落库失败', { gameId: this.gameId, error: String(error) });
    }
  }

  private logEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      this.logger.debug(`事件 ${event.payload.t}`, {
        gameId: this.gameId,
        seq: event.seq,
        day: event.day,
        phase: event.phase,
        visibility: event.visibility.scope,
        payload: event.payload,
      });
    }
  }

  private project(viewer: Viewer): ClientState {
    return projectState({
      roomId: this.roomId,
      gameId: this.gameId,
      state: this.state,
      viewer,
      humanSeat: this.humanSeat,
      deadlineAt: this.deadlineAt,
      paused: this.paused,
      stopped: this.stopped,
    });
  }

  private sendSnapshot(subscriber: Subscriber, sinceSeq: number): void {
    subscriber.send({
      type: 'snapshot',
      state: this.project(subscriber.viewer),
      events: eventsFor(
        this.history.filter((event) => event.seq > sinceSeq),
        subscriber.viewer,
      ),
    });
  }

  /**
   * 只同步房间状态、不带引擎事件的广播。
   *
   * 暂停/中止这类开关不产生事件流，但界面必须立刻看到。
   */
  private broadcastState(): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber.send({ type: 'update', state: this.project(subscriber.viewer), events: [] });
    }
  }

  private broadcast(delta: readonly GameEvent[]): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber.send({
        type: 'update',
        state: this.project(subscriber.viewer),
        events: eventsFor(delta, subscriber.viewer),
      });
    }
  }

  /**
   * 转发 AI 发言的增量片段。
   *
   * 发言内容本身是公开信息（大家都会听到），所以不做视角过滤；
   * 真正的「说了什么」仍以随后的 spoke 事件为准，这里只负责打字机效果。
   */
  private broadcastStream(seat: SeatId, delta: string): void {
    if (delta.length === 0) return;
    for (const subscriber of this.subscribers.values()) {
      subscriber.send({ type: 'stream', seat, delta });
    }
  }

  private broadcastStreamDone(seat: SeatId): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber.send({ type: 'stream-done', seat });
    }
  }

  // ── 复盘 ──

  private recordDecision(entry: DecisionLogEntry): void {
    this.decisions.push({
      // 此刻 state.seq 正好落在本次 action_requested 之后，用它把决策插回时间线
      seq: this.state.seq,
      day: this.state.day,
      phase: this.state.phase,
      seat: entry.seat,
      kind: entry.kind,
      reasoning: entry.reasoning,
      stance: entry.stance,
      push: entry.push,
      mood: entry.mood,
      claim: entry.claim,
    });
  }

  private sendReplay(id: string, day?: number): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    subscriber.send({ type: 'replay', payload: this.buildReplay(subscriber.viewer, day) });
  }

  /**
   * 组装复盘数据。
   *
   * 事件照旧走视角裁剪，所以玩家视角回看时也不会多看到别人的私密事件；
   * 而「AI 的推理依据」和「底牌」在局中一律封存 —— 推理里带着身份信息，
   * 局中看到等于直接作弊。本局结束（或本身是上帝视角）才解封。
   */
  private buildReplay(viewer: Viewer, requestedDay?: number): ReplayPayload {
    const days = [...new Set(this.history.map((event) => event.day))].sort((a, b) => a - b);
    const day =
      requestedDay !== undefined && days.includes(requestedDay)
        ? requestedDay
        : (days[days.length - 1] ?? 0);

    const sealed = viewer !== 'god' && this.state.winner === null;

    return {
      gameId: this.currentGameId,
      days,
      day,
      events: eventsFor(
        this.history.filter((event) => event.day === day),
        viewer,
      ),
      sealed,
      decisions: sealed ? [] : this.decisions.filter((item) => item.day === day),
      roles: sealed
        ? null
        : this.state.players.map((player) => ({ seat: player.seat, role: player.role })),
    };
  }

  // ── 用量看板 ──

  private sendUsage(id: string, scope: UsageScope): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    subscriber.send({ type: 'usage', payload: this.buildUsage(scope) });
  }

  /**
   * 用量数据全部来自 llm_usage 表，这里只负责挑范围。
   *
   * store 为 null（纯内存模式的测试）时返回一份空报告 —— 界面显示 0，而不是报错。
   */
  private buildUsage(scope: UsageScope): UsageReport {
    const gameId = scope === 'game' ? this.currentGameId : null;
    if (!this.store) {
      return {
        scope,
        gameId,
        totals: { calls: 0, inTokens: 0, outTokens: 0, cost: 0 },
        byTask: [],
        byModel: [],
        byGame: [],
      };
    }
    return { scope, ...this.store.usageReport(gameId) };
  }
}
