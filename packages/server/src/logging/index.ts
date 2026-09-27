import { createLogger, type LogSink, type Logger } from '@lrs/shared';
import type { ServerConfig } from '../config.ts';
import { auditLogDirectory, cleanupOldLogs, createFileSink, type LogChannel } from './sinks.ts';

export interface LoggingBundle {
  server: Logger;
  engine: Logger;
  agent: Logger;
  llm: Logger;
  ws: Logger;
  startup: {
    removedDays: string[];
    warnings: string[];
  };
}

/** 把 error 级别的记录额外镜像一份到 error.log，方便排障时只看一个文件 */
function withErrorMirror(logDir: string, sink: LogSink): LogSink {
  const errorSink = createFileSink(logDir, 'error', false);
  return {
    write(record) {
      sink.write(record);
      if (record.level === 'error') errorSink.write(record);
    },
  };
}

export function createLogging(config: ServerConfig): LoggingBundle {
  const echoAll = config.logLevel === 'debug';

  const build = (channel: LogChannel): Logger => {
    const echo = echoAll || channel === 'server';
    const sink = withErrorMirror(config.logDir, createFileSink(config.logDir, channel, echo));
    return createLogger(channel, sink, config.logLevel);
  };

  const startup = {
    removedDays: cleanupOldLogs(config.logDir, config.logRetentionDays),
    warnings: auditLogDirectory(config.logDir),
  };

  return {
    server: build('server'),
    engine: build('engine'),
    agent: build('agent'),
    llm: build('llm'),
    ws: build('ws'),
    startup,
  };
}

export { LOG_CHANNELS } from './sinks.ts';
export type { LogChannel } from './sinks.ts';
export { redactDeep, redactText, findSuspicious } from './redact.ts';
