/**
 * 结构化日志端口。
 *
 * 设计约束：core-engine 是纯逻辑模块，不允许自己读环境变量、写文件。
 * 因此这里只定义「日志端口」（LogSink）与最简实现；文件落地、脱敏、
 * 保留期清理由 server 包在后续里程碑注册 sink 时负责。
 *
 * 注意：任何 API Key、token、完整 prompt 都不应该进入日志 —— 脱敏由
 * server 侧的 sink 统一做，这里是最后一道兜底。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  /** ISO 8601 时间戳 */
  ts: string;
  level: LogLevel;
  /** 模块作用域，如 "engine:night:wolf" */
  scope: string;
  msg: string;
  fields?: LogFields;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** 派生一个子作用域，如 child('night').child('wolf') → "engine:night:wolf" */
  child(scope: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LEVEL_ORDER;
}

export function createLogger(scope: string, sink: LogSink, minLevel: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[minLevel];

  const emit =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < threshold) return;
      const record: LogRecord = {
        ts: new Date().toISOString(),
        level,
        scope,
        msg,
      };
      if (fields !== undefined) record.fields = fields;
      sink.write(record);
    };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (sub: string) => createLogger(`${scope}:${sub}`, sink, minLevel),
  };
}

interface TextWriter {
  write(chunk: string): void;
}

/**
 * 取 stdout / stderr。
 * 用 globalThis 上的可选属性而不是裸写 process —— 这样这个模块在浏览器里
 * 也能安全地被导入（前端只想复用类型，不该被迫引入 Node 全局）。
 */
function streams(): { out: TextWriter | null; err: TextWriter | null } {
  const proc = (globalThis as { process?: { stdout?: TextWriter; stderr?: TextWriter } }).process;
  return { out: proc?.stdout ?? null, err: proc?.stderr ?? null };
}

/** 控制台 sink：逐行输出 JSON，开发期用。没有 stdout 时静默降级。 */
export const consoleSink: LogSink = {
  write(record) {
    const line = `${JSON.stringify(record)}\n`;
    const { out, err } = streams();
    if (record.level === 'warn' || record.level === 'error') err?.write(line);
    else out?.write(line);
  },
};

/** 丢弃一切日志，供测试使用。 */
export const nullSink: LogSink = {
  write() {
    /* 故意留空 */
  },
};

/** 内存 sink：把日志收进数组，供测试断言。 */
export function createMemorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    write(record) {
      records.push(record);
    },
  };
}
