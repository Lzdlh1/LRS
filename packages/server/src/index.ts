import { BUILTIN_PROFILES, createAgentHost } from '@lrs/agent-host';
import type { LlmUsage } from '@lrs/llm-router';
import { createAdmin } from './admin.ts';
import { describeLlm, loadConfig } from './config.ts';
import { createLlmRouter, resolveLlmConfig } from './llm.ts';
import { createLogging } from './logging/index.ts';
import { startServer } from './server.ts';
import type { GameRoom } from './session/room.ts';
import { openDatabase } from './store/db.ts';
import { GameStore } from './store/gameStore.ts';
import { SettingsStore } from './store/settingsStore.ts';

/**
 * 夜间每一步的固定时长。
 *
 * 这是本局「节奏」的总开关：一夜 = 4 × 这个数（守 → 刀 → 药 → 验）。
 * 定得比 AI 一次决策（通常 2~4 秒）宽一些，否则慢的调用会被节拍切掉。
 */
const NIGHT_STEP_MS = 10_000;

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

  const db = openDatabase(config.dbPath);
  const store = new GameStore(db);
  const settings = new SettingsStore(db);
  const profileCount = store.seedBuiltinProfiles(BUILTIN_PROFILES);
  logging.server.info('内置人设已就绪', { count: profileCount });

  // 用量落库需要拿到「当前是哪一局」，房间在启动之后才存在，所以用可变引用
  let currentRoom: GameRoom | null = null;

  const onUsage = (usage: LlmUsage): void => {
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
  };

  /**
   * 装配模型路由。
   *
   * 设置界面改完之后会再调一次 —— 新装配的 router 会在**下一局**生效，
   * 正在跑的那一局仍然用旧的（它在内存里已经持有旧 router 了）。
   */
  const loadLlm = () =>
    createLlmRouter(resolveLlmConfig(config.llm, settings), logging.llm, onUsage);

  let llm = loadLlm();

  // 模型配置只记「用哪个模型、有没有配 Key」，绝不记 Key 本身
  logging.server.info('模型配置', describeLlm(resolveLlmConfig(config.llm, settings)));
  if (llm.live) logging.server.info(llm.summary);
  else logging.server.warn(llm.summary);

  // 只记「开没开」，绝不记口令本身
  const tokenOf = (): string =>
    settings.hasOwnAccessToken() ? settings.accessToken() : config.accessToken;
  logging.server.info(
    tokenOf() === ''
      ? '访问口令未设置（任何人都能连，仅适合本地）'
      : '访问口令已启用（地址后需带 ?token=…，或在门口那一页填一次）',
  );
  if (settings.adminHash() === null) {
    logging.server.warn('设置口令还没创建：第一次打开「设置」时会被要求设一个');
  }

  const admin = createAdmin({
    settings,
    logger: logging.server,
    envKeys: {
      deepseek: config.llm.deepseekApiKey,
      openai: config.llm.openaiApiKey,
      custom: config.llm.customApiKey,
    },
    envAccessToken: config.accessToken,
    isLive: () => llm.live,
    onConfigChanged: () => {
      llm = loadLlm();
      logging.server.info('模型设置已重载', describeLlm(resolveLlmConfig(config.llm, settings)));
    },
  });

  const running = startServer({
    config,
    logger: logging.server,
    wsLogger: logging.ws,
    store,
    isAiLive: () => llm.live,
    admin,
    accessTokenOf: tokenOf,
    // 正式玩法默认就是玩家视角（位次每局随机，所以跟着房间走）；想看全场底牌用折叠栏里的开关切到上帝视角
    defaultViewer: 'human',
    // 夜间固定节拍：守→刀→药→验四步永远都走，每步走满 NIGHT_STEP_MS 才换步，
    // 行动者提前提交也不提前换步 —— 这样「走到第几步」是公开的，而「这一步有没有人动」看不出来
    rules: { nightStepMs: NIGHT_STEP_MS },
    hostFactory: ({ seatCount, names, humanSeat, onSpeechDelta, onDecision }) =>
      createAgentHost({
        router: llm.router,
        logger: logging.agent,
        humanSeats: [humanSeat],
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
