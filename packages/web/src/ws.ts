import type { GameEvent } from '@lrs/shared';
import type {
  ClientMessage,
  ClientState,
  ReplayPayload,
  ServerMessage,
  UsageReport,
  UsageScope,
} from '@lrs/server/protocol';
import { onBeforeUnmount, ref } from 'vue';

const MAX_KEPT_EVENTS = 600;

/** 正在生成中的发言（打字机） */
export interface LiveSpeech {
  seat: number;
  text: string;
  /** 生成已结束，等 spoke 事件落地后就清掉 */
  done: boolean;
}

/**
 * 与 session-service 的唯一连接。
 *
 * 前端只做两件事：把收到的事件渲染出来、把玩家的选择发回去。
 * 任何规则判断、任何「谁是什么身份」的推断都不在这里 —— 拿不到就是拿不到。
 */
export function useGameSocket() {
  const state = ref<ClientState | null>(null);
  const events = ref<GameEvent[]>([]);
  const streaming = ref<LiveSpeech | null>(null);
  /** 复盘面板的数据；null 表示面板没打开 */
  const replay = ref<ReplayPayload | null>(null);
  /** 用量看板的数据；null 表示面板没打开 */
  const usage = ref<UsageReport | null>(null);
  const connected = ref(false);
  const lastError = ref<string | null>(null);

  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let disposed = false;

  function scheduleReconnect(): void {
    if (disposed) return;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, 1200);
  }

  function appendStream(seat: number, delta: string): void {
    const current = streaming.value;
    if (!current || current.seat !== seat || current.done) {
      streaming.value = { seat, text: delta, done: false };
      return;
    }
    current.text += delta;
  }

  function markStreamDone(seat: number): void {
    if (streaming.value?.seat === seat) streaming.value = { ...streaming.value, done: true };
  }

  function clearStream(seat: number): void {
    if (streaming.value?.seat === seat) streaming.value = null;
  }

  function connect(): void {
    if (disposed) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws`);

    socket.onopen = () => {
      connected.value = true;
      lastError.value = null;
    };

    socket.onclose = () => {
      connected.value = false;
      scheduleReconnect();
    };

    socket.onerror = () => {
      lastError.value = '连接服务端失败，正在重试…';
    };

    socket.onmessage = (raw: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.data) as ServerMessage;
      } catch {
        lastError.value = '收到无法解析的消息';
        return;
      }

      if (message.type === 'error') {
        lastError.value = message.message;
        return;
      }
      if (message.type === 'stream') {
        appendStream(message.seat, message.delta);
        return;
      }
      if (message.type === 'stream-done') {
        markStreamDone(message.seat);
        return;
      }
      if (message.type === 'replay') {
        replay.value = message.payload;
        return;
      }
      if (message.type === 'usage') {
        usage.value = message.payload;
        return;
      }

      state.value = message.state;
      if (message.type === 'snapshot') {
        events.value = message.events;
        // 整份快照意味着换了局或刚连上，打字机内容一律作废
        streaming.value = null;
        // 换了局的话，复盘面板里那份也过期了
        if (replay.value && replay.value.gameId !== message.state.gameId) replay.value = null;
        // 用量看的是「本局」时同理；看历史的那份不受换局影响
        if (usage.value?.scope === 'game' && usage.value.gameId !== message.state.gameId) {
          usage.value = null;
        }
      } else {
        events.value = [...events.value, ...message.events].slice(-MAX_KEPT_EVENTS);
      }

      // 正式发言落地后，用事件里的干净文本取代打字机内容
      for (const event of message.events) {
        if (event.payload.t === 'spoke') clearStream(event.payload.seat);
      }
    };
  }

  function send(message: ClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  onBeforeUnmount(() => {
    disposed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
  });

  function openReplay(day?: number): void {
    send({ type: 'replay', ...(day === undefined ? {} : { day }) });
  }

  function closeReplay(): void {
    replay.value = null;
  }

  function openUsage(scope: UsageScope): void {
    send({ type: 'usage', scope });
  }

  function closeUsage(): void {
    usage.value = null;
  }

  function pause(): void {
    send({ type: 'pause' });
  }

  function resume(): void {
    send({ type: 'resume' });
  }

  /** 中止本局：立刻停手，且不会自己恢复 */
  function stopGame(): void {
    send({ type: 'stop' });
  }

  return {
    state,
    events,
    streaming,
    replay,
    usage,
    connected,
    lastError,
    connect,
    send,
    openReplay,
    closeReplay,
    openUsage,
    closeUsage,
    pause,
    resume,
    stopGame,
  };
}
