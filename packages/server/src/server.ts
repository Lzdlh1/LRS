import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Logger } from '@lrs/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AdminHandler } from './admin.ts';
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

const TOKEN_COOKIE = 'lrs_token';

/**
 * 没带（或带错）访问口令时给的一页。
 *
 * 原来只回一行纯文本「请在地址后面加上 ?token=…」，等于让人自己拼 URL ——
 * 手机上根本没法用。改成一个输入框：填一次，服务端换成 cookie，
 * 之后这台设备直接打开就行。
 */
function unlockPage(wrong: boolean): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>需要访问口令</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0a0d14;color:#d9dfee;
       font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;}
  form{width:min(340px,86vw);display:flex;flex-direction:column;gap:12px;}
  h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.08em;}
  p{margin:0;font-size:12.5px;line-height:1.8;color:#8f99b0;}
  input,button{font-family:inherit;font-size:14px;border-radius:8px;padding:11px 12px;}
  input{background:#05070c;border:1px solid #222a3a;color:#d9dfee;}
  input:focus{outline:none;border-color:#6b7bd6;}
  button{background:#2a3350;border:1px solid #4d5a94;color:#cdd6ff;cursor:pointer;}
  .bad{color:#d2554a;}
</style></head>
<body>
  <form method="get" action="/">
    <h1>需要访问口令</h1>
    <p>${wrong ? '<span class="bad">口令不对</span>，再试一次：' : '这是一个私人站点，进来要口令。'}</p>
    <input name="token" type="password" autofocus autocomplete="off" placeholder="访问口令"/>
    <button type="submit">进入</button>
    <p>注意：这里要的是<b>访问口令</b>（进站点的门），不是你 DeepSeek 的 API Key，
       也不是设置页里的管理口令。填对一次之后这台设备记 30 天。</p>
  </form>
</body></html>`;
}

/**
 * 一道极简门：口令非空才启用。
 *
 * 口令是**取值函数**而不是启动时的快照：设置页可以改它，改完要立刻生效。
 *
 * 认两种形式 —— 地址里带的 `?token=xxx`，以及换到手之后的 cookie。
 * 前者用过一次就重定向掉，免得口令留在地址栏和浏览记录里。
 */
function createGate(current: () => string): {
  enabled: boolean;
  matches: (url: URL) => boolean;
  allows: (req: IncomingMessage, url: URL) => boolean;
} {
  const fromQuery = (url: URL): boolean => {
    const token = current();
    return token !== '' && url.searchParams.get('token') === token;
  };
  const fromCookie = (req: IncomingMessage): boolean => {
    const token = current();
    if (token === '') return true;
    return (req.headers.cookie ?? '')
      .split(';')
      .some((part) => part.trim() === `${TOKEN_COOKIE}=${token}`);
  };

  return {
    get enabled() {
      return current() !== '';
    },
    matches: fromQuery,
    allows: (req, url) => current() === '' || fromQuery(url) || fromCookie(req),
  };
}

export interface StartServerOptions {
  config: ServerConfig;
  logger: Logger;
  wsLogger: Logger;
  store: GameStore | null;
  /** 传入就由 AI 接管非真人座位；不传就是纯手动模式 */
  hostFactory?: AgentHostFactory;
  /** 模型当前是否可用（设置界面能改，所以是个取值函数而不是快照） */
  isAiLive?: () => boolean;
  /** 设置界面的后台；不传就关掉 /admin 这一块 */
  admin?: AdminHandler;
  /**
   * 当前生效的访问口令。
   *
   * 不传就用 `config.accessToken`。传了的话每次请求都现取 —— 设置页改完
   * 立刻生效，不需要重启。
   */
  accessTokenOf?: () => string;
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
  /** 每次现取：设置页改完口令立刻生效 */
  const currentToken = (): string => options.accessTokenOf?.() ?? config.accessToken;
  const gate = createGate(currentToken);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // 口令带对了就换成 cookie，并把地址里的 token 摘掉
    if (gate.matches(url)) {
      res.writeHead(302, {
        'set-cookie': `${TOKEN_COOKIE}=${currentToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        location: url.pathname,
      });
      res.end();
      return;
    }

    if (!gate.allows(req, url)) {
      // 带了 token 还是不过 = 填错了；什么都没带 = 第一次来
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(unlockPage(url.searchParams.has('token')));
      return;
    }

    // 设置界面（自己带管理口令那一层锁）
    if (options.admin?.handle(req, res, url)) return;

    if (url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        roomId: room.roomId,
        subscribers: room.subscriberCount,
        ai: options.isAiLive?.() ?? false,
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

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // WS 握手走同一道门；浏览器会把 cookie 带上，所以同源连接照常
    // （verifyClient 的类型是同步/异步两个重载的联合，参数得自己标出来）
    verifyClient: (info: { req: IncomingMessage }): boolean =>
      gate.allows(
        info.req,
        new URL(info.req.url ?? '/', `http://${info.req.headers.host ?? 'localhost'}`),
      ),
  });

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
