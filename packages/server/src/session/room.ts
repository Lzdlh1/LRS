import { randomUUID } from 'node:crypto';
import {
  createGame,
  eventsFor,
  pendingRequest,
  step,
  type EngineConfig,
  type GameState,
  type Viewer,
} from '@lrs/core-engine';
import type { Action, GameEvent, Logger } from '@lrs/shared';
import type { GameStore } from '../store/gameStore.ts';
import { defaultActionFor, randomActionFor } from './defaultAction.ts';
import { projectState, type ClientMessage, type ClientState, type ServerMessage } from './protocol.ts';

export interface Subscriber {
  id: string;
  viewer: Viewer;
  send: (message: ServerMessage) => void;
}

export interface GameRoomOptions {
  logger: Logger;
  store: GameStore | null;
  rules?: EngineConfig['rules'];
  id?: string;
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

  private currentGameId: string;
  private state: GameState;
  private history: GameEvent[] = [];
  private readonly subscribers = new Map<string, Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  private deadlineAt = 0;
  private finished = false;

  constructor(options: GameRoomOptions) {
    this.roomId = options.id ?? randomUUID();
    this.logger = options.logger;
    this.store = options.store;
    this.rules = options.rules;
    this.currentGameId = randomUUID();
    this.state = this.startNewGame();
    this.armTimer();
  }

  /** 当前这一局的 id（重开一局会变） */
  get gameId(): string {
    return this.currentGameId;
  }

  // ── 订阅 ──

  subscribe(subscriber: Subscriber): void {
    this.subscribers.set(subscriber.id, subscriber);
    this.sendSnapshot(subscriber, 0);
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
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
      default: {
        const unknown = message as { type?: string };
        this.logger.warn('收到未知消息', { channel: id, type: unknown.type });
      }
    }
  }

  // ── 推进 ──

  submit(action: Action, origin = 'debug'): void {
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
  }

  /** 调试面板用：连续代打若干步 */
  autoPlay(count = 1): void {
    for (let i = 0; i < count; i += 1) {
      const pending = pendingRequest(this.state);
      if (!pending || this.state.winner !== null) return;
      this.submit(randomActionFor(pending), 'auto');
    }
  }

  newGame(seed?: number): void {
    this.clearTimer();
    this.currentGameId = randomUUID();
    this.state = this.startNewGame(seed);
    this.armTimer();
    for (const subscriber of this.subscribers.values()) this.sendSnapshot(subscriber, 0);
  }

  dispose(): void {
    this.clearTimer();
    this.subscribers.clear();
  }

  // ── 内部 ──

  private startNewGame(seed?: number): GameState {
    this.finished = false;
    this.history = [];

    const rng = seed === undefined ? Math.random : mulberry32(seed);
    const result = createGame({ humanSeats: [1], rules: this.rules, rng });
    this.history.push(...result.events);

    this.logger.info('新对局开始', {
      gameId: this.gameId,
      board: result.state.board.name,
      seed: seed ?? null,
      day: result.state.day,
      phase: result.state.phase,
    });
    this.logEvents(result.events);

    if (this.store) {
      try {
        this.store.createGame({
          id: this.gameId,
          board: result.state.board.name,
          configJson: JSON.stringify({ humanSeats: [1], seed: seed ?? null }),
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

  /** 把新产生的事件记进内存历史、写日志、落库 */
  private record(newEvents: readonly GameEvent[]): void {
    if (newEvents.length === 0) return;
    this.history.push(...newEvents);
    this.logEvents(newEvents);
    this.persist(newEvents);
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

    const seat = pending.seat;
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
      deadlineAt: this.deadlineAt,
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

  private broadcast(delta: readonly GameEvent[]): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber.send({
        type: 'update',
        state: this.project(subscriber.viewer),
        events: eventsFor(delta, subscriber.viewer),
      });
    }
  }
}
