import { describe, expect, it } from 'vitest';
import {
  createLogger,
  createMemorySink,
  isLogLevel,
  LOG_LEVELS,
  nullSink,
} from '../src/logger.ts';

describe('logger', () => {
  it('按最低级别过滤日志', () => {
    const sink = createMemorySink();
    const log = createLogger('engine', sink, 'info');

    log.debug('这条应该被丢掉');
    log.info('这条要留下');
    log.warn('这条也要留下');

    expect(sink.records.map((r) => r.msg)).toEqual(['这条要留下', '这条也要留下']);
  });

  it('debug 级别下全部放行', () => {
    const sink = createMemorySink();
    const log = createLogger('engine', sink, 'debug');

    LOG_LEVELS.forEach((level) => log[level]('msg'));

    expect(sink.records.map((r) => r.level)).toEqual([...LOG_LEVELS]);
  });

  it('child 会拼接作用域', () => {
    const sink = createMemorySink();
    createLogger('engine', sink, 'info').child('night').child('wolf').info('狼人行动');

    expect(sink.records[0]?.scope).toBe('engine:night:wolf');
  });

  it('fields 被原样带上', () => {
    const sink = createMemorySink();
    createLogger('engine', sink, 'info').info('阶段推进', { day: 2, phase: 'DAY_VOTE' });

    expect(sink.records[0]?.fields).toEqual({ day: 2, phase: 'DAY_VOTE' });
  });

  it('每条记录都带 ISO 时间戳', () => {
    const sink = createMemorySink();
    createLogger('engine', sink, 'info').info('x');

    const ts = sink.records[0]?.ts ?? '';
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });

  it('nullSink 不抛错', () => {
    expect(() => createLogger('x', nullSink).info('静默')).not.toThrow();
  });

  it('isLogLevel 能识别合法级别', () => {
    expect(isLogLevel('warn')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});
