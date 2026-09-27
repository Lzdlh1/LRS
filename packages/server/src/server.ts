import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Logger } from '@lrs/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerConfig } from './config.ts';
import type { ClientMessage, ServerMessage } from './session/protocol.ts';
import { GameRoom, type AgentHostFactory } from './session/room.ts';
import type { GameStore } from './store/gameStore.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 让这个服务顺带托管前端构建产物 —— 部署时只需要开一个端口。
 *
 * 目录不存在就返回 null（本地 `vite dev` 时没有 dist，这条路径自然不生效）。
 * 请求路径必须落在 webDir 之内，避免用 `../` 穿出去读到别的文件。
 */
function createWebHandler(webDir: string): ((url: URL, res: ServerResponse) => boolean) | null {
  if (!existsSync(webDir)) return null;
  const root = resolve(webDir);

  return (url, res) => {
    const raw = decodeURIComponent(url.pathname);
    const candidate = resolve(join(root, normalize(raw === '/' ? '/index.html' : raw)));
    const inside = candidate === root || candidate.startsWith(root + sep);
    const hit = inside && existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;

    // SPA：找不到实体文件就回 index.html，保证直接刷新 /usage 这类路径不会 404
    const target = hit ?? join(root, 'index.html');
    if (!existsSync(target)) return false;

    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      // 带 hash 的产物可以长缓存，入口页必须每次问一遍
      'cache-control': hit !== null && raw.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(target).pipe(res);
    return true;
  };
}

export interface StartServerOptions {
  config: ServerConfig;
  logger: Logger;
  wsLogger: Logger;
  store: GameStore | null;
  /** 传入就由 AI 接管非真人座位；不传就是纯手动模式 */
  hostFactory?: AgentHostFactory;
  /** 模型是否已配置好（只用于健康检查展示） */
  aiLive?: boolean;
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

  const room = new GameRoom({
    logger: wsLogger.child('room'),
    store,
    hostFactory: options.hostFactory,
  });
  let channelSeq = 0;
  const serveWeb = createWebHandler(config.webDir);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        roomId: room.roomId,
        subscribers: room.subscriberCount,
        ai: options.aiLive ?? false,
        defaultViewer,
        web: serveWeb !== null,
        uptimeSeconds: Math.round(process.uptime()),
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && serveWeb !== null && serveWeb(url, res)) return;

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
