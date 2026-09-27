import type { GameEvent } from '@lrs/shared';
import type { ClientMessage, ClientState, ServerMessage } from '@lrs/server/protocol';
import { onBeforeUnmount, ref } from 'vue';

const MAX_KEPT_EVENTS = 600;

/**
 * 与 session-service 的唯一连接。
 *
 * 前端只做两件事：把收到的事件渲染出来、把玩家的选择发回去。
 * 任何规则判断、任何「谁是什么身份」的推断都不在这里 —— 拿不到就是拿不到。
 */
export function useGameSocket() {
  const state = ref<ClientState | null>(null);
  const events = ref<GameEvent[]>([]);
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

      state.value = message.state;
      if (message.type === 'snapshot') {
        events.value = message.events;
      } else {
        events.value = [...events.value, ...message.events].slice(-MAX_KEPT_EVENTS);
      }
    };
  }

  function send(message: ClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function lookupSeatRole(seat: number): string | null {
    return state.value?.seats.find((s) => s.seat === seat)?.role ?? null;
  }

  onBeforeUnmount(() => {
    disposed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
  });

  return { state, events, connected, lastError, connect, send, lookupSeatRole };
}
