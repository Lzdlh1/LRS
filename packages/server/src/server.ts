import { createServer, type Server } from 'node:http';
import type { Logger } from '@lrs/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerConfig } from './config.ts';
import type { ClientMessage, ServerMessage } from './session/protocol.ts';
import { GameRoom } from './session/room.ts';
import type { GameStore } from './store/gameStore.ts';

export interface StartServerOptions {
  config: ServerConfig;
  logger: Logger;
  wsLogger: Logger;
  store: GameStore | null;
  /** 新连接的默认视角。默认上帝视角方便开发调试，M4 会改成玩家视角。 */
  defaultViewer?: 'god' | number;
}

export interface RunningServer {
  server: Server;
  room: GameRoom;
  close: () => Promise<void>;
}

export function startServer(options: StartServerOptions): RunningServer {
  const { config, logger, wsLogger, store } = options;
  const defaultViewer = options.defaultViewer ?? 'god';

  const room = new GameRoom({ logger: wsLogger.child('room'), store });
  let channelSeq = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        roomId: room.roomId,
        subscribers: room.subscriberCount,
        defaultViewer,
        uptimeSeconds: Math.round(process.uptime()),
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    channelSeq += 1;
    const channel = `c${channelSeq}`;
    wsLogger.info('连接建立', { channel, viewer: defaultViewer });

    room.subscribe({
      id: channel,
      viewer: defaultViewer,
      send: (message: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    });

    socket.on('message', (raw: unknown) => {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        wsLogger.warn('收到非 JSON 消息，已丢弃', { channel });
        return;
      }
      wsLogger.debug('收到消息', { channel, type: parsed.type });
      room.handleMessage(channel, parsed);
    });

    socket.on('close', () => {
      wsLogger.info('连接关闭', { channel });
      room.unsubscribe(channel);
    });

    socket.on('error', (error: Error) => {
      wsLogger.error('连接异常', { channel, error: error.message });
    });
  });

  server.listen(config.port, config.host, () => {
    logger.info('服务已启动', {
      http: `http://${config.host}:${config.port}`,
      ws: `ws://${config.host}:${config.port}/ws`,
      health: `http://${config.host}:${config.port}/health`,
    });
  });

  return {
    server,
    room,
    close: async () => {
      room.dispose();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
