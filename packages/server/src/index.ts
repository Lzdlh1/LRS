import { BUILTIN_PROFILES, createAgentHost } from '@lrs/agent-host';
import { describeLlm, loadConfig } from './config.ts';
import { createLlmRouter } from './llm.ts';
import { createLogging } from './logging/index.ts';
import { startServer } from './server.ts';
import type { GameRoom } from './session/room.ts';
import { openDatabase } from './store/db.ts';
import { GameStore } from './store/gameStore.ts';

function main(): void {
  const config = loadConfig();
  const logging = createLogging(config);

  logging.server.info('服务启动中', {
    host: config.host,
    port: config.port,
    logLevel: config.logLevel,
    logDir: config.logDir,
    dbPath: config.dbPath,
    webDir: config.webDir,
  });

  // 模型配置只记「用哪个模型、有没有配 Key」，绝不记 Key 本身
  logging.server.info('模型配置', describeLlm(config.llm));

  if (logging.startup.removedDays.length > 0) {
    logging.server.info('已清理过期日志', { removedDays: logging.startup.removedDays });
  }
  for (const warning of logging.startup.warnings) {
    logging.server.warn('日志自检发现疑似凭据', { detail: warning });
  }
  if (!config.logPrompts) {
    logging.server.info('prompt 全文不落盘（需要时用 LOG_PROMPTS=true 临时开启）');
  }

  const db = openDatabase(config.dbPath);
  const store = new GameStore(db);
  const profileCount = store.seedBuiltinProfiles(BUILTIN_PROFILES);
  logging.server.info('内置人设已就绪', { count: profileCount });

  // 用量落库需要拿到「当前是哪一局」，房间在启动之后才存在，所以用可变引用
  let currentRoom: GameRoom | null = null;

  const llm = createLlmRouter(config.llm, logging.llm, (usage) => {
    try {
      store.recordUsage({
        gameId: currentRoom?.gameId ?? null,
        task: usage.task,
        tier: usage.tier,
        provider: usage.provider,
        model: usage.model,
        inTokens: usage.inTokens,
        outTokens: usage.outTokens,
        cost: usage.cost,
        ts: new Date().toISOString(),
      });
    } catch (error) {
      logging.llm.error('用量落库失败', { error: String(error) });
    }
  });

  if (llm.live) logging.server.info(llm.summary);
  else logging.server.warn(llm.summary);

  const running = startServer({
    config,
    logger: logging.server,
    wsLogger: logging.ws,
    store,
    aiLive: llm.live,
    // 正式玩法默认就是玩家视角；想看全场底牌用界面右上角的开关切到上帝视角
    defaultViewer: 1,
    hostFactory: ({ seatCount, names, onSpeechDelta, onDecision }) =>
      createAgentHost({
        router: llm.router,
        logger: logging.agent,
        humanSeats: [1],
        seatCount,
        names,
        enableReflection: config.llm.reflection,
        onSpeechDelta,
        onDecision,
      }),
  });

  currentRoom = running.room;

  const shutdown = (signal: string): void => {
    logging.server.info('收到退出信号，开始关闭', { signal });
    void running.close().then(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
