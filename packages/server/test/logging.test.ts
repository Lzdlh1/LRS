import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSuspicious, redactDeep, redactText } from '../src/logging/redact.ts';
import { auditLogDirectory, cleanupOldLogs, createFileSink } from '../src/logging/sinks.ts';

const SECRETS = {
  github: 'github_pat_11ABCDEFG0abcdefghijklmnop',
  openai: 'sk-abcdefghijklmnopqrstuvwxyz',
  bearer: 'Bearer abcdefghijklmnopqrstuvwx',
  keyValue: 'api_key=abcdef123456',
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lrs-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('脱敏器', () => {
  it('把各类凭据打码', () => {
    expect(redactText(`token is ${SECRETS.github}`)).toBe('token is github_pat_***');
    expect(redactText(`key is ${SECRETS.openai}`)).toBe('key is sk-***');
    expect(redactText(`header ${SECRETS.bearer}`)).toBe('header Bearer ***');
    expect(redactText(SECRETS.keyValue)).toBe('api_key=***');
  });

  it('不碰普通文本', () => {
    const text = '3 号发言：我觉得 5 号有问题，狼味很重';
    expect(redactText(text)).toBe(text);
  });

  it('敏感字段名整体打码', () => {
    expect(redactDeep({ apiKey: 'whatever', api_key: 'x', authorization: 'y', name: '阿哲' })).toEqual({
      apiKey: '***',
      api_key: '***',
      authorization: '***',
      name: '阿哲',
    });
  });

  it('嵌套结构里的凭据也会被打码', () => {
    const result = redactDeep({
      request: { headers: { authorization: 'Bearer zzzzzzzzzzzz' }, note: `用 ${SECRETS.openai} 调用` },
      list: [`${SECRETS.github}`],
    }) as { request: { headers: { authorization: string }; note: string }; list: string[] };

    expect(result.request.headers.authorization).toBe('***');
    expect(result.request.note).toBe('用 sk-*** 调用');
    expect(result.list).toEqual(['github_pat_***']);
  });

  it('findSuspicious 能识别出凭据种类', () => {
    expect(findSuspicious(`x ${SECRETS.openai}`)).toContain('OpenAI 风格密钥');
    expect(findSuspicious('这是一句普通的话')).toEqual([]);
  });

  it('连续调用不会因为正则状态而漏判', () => {
    const text = `x ${SECRETS.github} y`;
    expect(findSuspicious(text)).toHaveLength(1);
    expect(findSuspicious(text)).toHaveLength(1);
  });
});

describe('日志落盘', () => {
  it('落盘内容已经过脱敏', () => {
    const dir = tempDir();
    const sink = createFileSink(dir, 'llm', false);

    sink.write({
      ts: '2026-09-27T10:00:00.000Z',
      level: 'error',
      scope: 'llm:deepseek',
      msg: `调用失败，key=${SECRETS.openai}`,
      fields: { authorization: `Bearer ${SECRETS.bearer}`, model: 'deepseek-chat' },
    });

    const file = join(dir, '2026-09-27', 'llm.log');
    const content = readFileSync(file, 'utf8');

    expect(content).not.toContain('sk-abcdefghijklmnop');
    expect(content).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(content).toContain('sk-***');
    expect(content).toContain('"authorization":"***"');
    expect(content).toContain('deepseek-chat');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('error 级别会额外落到 error.log', () => {
    const dir = tempDir();
    const sink = createFileSink(dir, 'error', false);
    sink.write({ ts: '2026-09-27T10:00:00.000Z', level: 'error', scope: 'x', msg: '炸了' });

    expect(readdirSync(join(dir, '2026-09-27'))).toContain('error.log');
  });
});

describe('启动自检与清理', () => {
  it('干净日志不会告警', () => {
    const dir = tempDir();
    createFileSink(dir, 'engine', false).write({
      ts: '2026-09-27T10:00:00.000Z',
      level: 'info',
      scope: 'engine',
      msg: '阶段推进',
      fields: { day: 1 },
    });
    expect(auditLogDirectory(dir)).toEqual([]);
  });

  it('日志里出现明文凭据会告警', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '2026-09-27'), { recursive: true });
    writeFileSync(join(dir, '2026-09-27', 'llm.log'), `{"msg":"key=${SECRETS.openai}"}\n`, 'utf8');

    const warnings = auditLogDirectory(dir);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OpenAI 风格密钥');
  });

  it('超过保留期的日期目录会被删掉', () => {
    const dir = tempDir();
    const oldDay = join(dir, '2020-01-01');
    const freshDay = join(dir, '2026-09-27');
    mkdirSync(oldDay, { recursive: true });
    mkdirSync(freshDay, { recursive: true });
    const longAgo = new Date('2020-01-01T00:00:00Z');
    utimesSync(oldDay, longAgo, longAgo);

    const removed = cleanupOldLogs(dir, 7);
    expect(removed).toEqual(['2020-01-01']);
    expect(readdirSync(dir)).toEqual(['2026-09-27']);
  });

  it('目录不存在时自检与清理都不报错', () => {
    const missing = join(tempDir(), 'not-created-yet');
    expect(auditLogDirectory(missing)).toEqual([]);
    expect(cleanupOldLogs(missing, 7)).toEqual([]);
  });
});
