import { loadConfig } from './config.ts';
import { createLogging } from './logging/index.ts';
import { startServer } from './server.ts';
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
  });

  if (logging.startup.removedDays.length > 0) {
    logging.server.info('已清理过期日志', { removedDays: logging.startup.removedDays });
  }

  // 启动自检：日志里出现疑似凭据说明脱敏器有漏，必须立刻看见
  for (const warning of logging.startup.warnings) {
    logging.server.warn('日志自检发现疑似凭据', { detail: warning });
  }

  if (!config.logPrompts) {
    logging.server.info('prompt 全文不落盘（需要时用 LOG_PROMPTS=true 临时开启）');
  }

  const db = openDatabase(config.dbPath);
  const store = new GameStore(db);

  const running = startServer({
    config,
    logger: logging.server,
    wsLogger: logging.ws,
    store,
  });

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
