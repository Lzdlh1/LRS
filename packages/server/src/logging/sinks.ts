import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogRecord, LogSink } from '@lrs/shared';
import { findSuspicious, redactDeep, redactText } from './redact.ts';

export const LOG_CHANNELS = ['server', 'engine', 'agent', 'llm', 'ws', 'error'] as const;
export type LogChannel = (typeof LOG_CHANNELS)[number];

const ensuredDirs = new Set<string>();

function ensureDir(dir: string): void {
  if (ensuredDirs.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

/** 日志落盘路径：logs/<YYYY-MM-DD>/<channel>.log */
export function dayDir(logDir: string, iso: string): string {
  return join(logDir, iso.slice(0, 10));
}

export function createFileSink(logDir: string, channel: LogChannel, echoToConsole: boolean): LogSink {
  return {
    write(record) {
      // 落盘前必须过脱敏 —— 这是防泄密的最后一道闸门
      const safe: LogRecord = {
        ts: record.ts,
        level: record.level,
        scope: record.scope,
        msg: redactText(record.msg),
      };
      if (record.fields !== undefined) {
        safe.fields = redactDeep(record.fields) as LogRecord['fields'];
      }

      const dir = dayDir(logDir, safe.ts);
      ensureDir(dir);
      const line = `${JSON.stringify(safe)}\n`;
      appendFileSync(join(dir, `${channel}.log`), line, 'utf8');

      if (echoToConsole) {
        if (safe.level === 'warn' || safe.level === 'error') process.stderr.write(line);
        else process.stdout.write(line);
      }
    },
  };
}

/** 保留期清理，返回被删掉的日期目录 */
export function cleanupOldLogs(logDir: string, retentionDays: number, now = new Date()): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(logDir);
  } catch {
    return removed;
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const full = join(logDir, entry);
    let mtime: number;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) {
      rmSync(full, { recursive: true, force: true });
      removed.push(entry);
    }
  }
  return removed;
}

/**
 * 启动自检：扫一遍已有日志，发现疑似凭据就告警。
 * 正常情况永远返回空数组 —— 有返回说明脱敏器漏了规则。
 */
export function auditLogDirectory(logDir: string, tailBytes = 512 * 1024): string[] {
  const warnings: string[] = [];
  let dayEntries: string[];
  try {
    dayEntries = readdirSync(logDir);
  } catch {
    return warnings;
  }

  for (const day of dayEntries) {
    const dir = join(logDir, day);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      try {
        const content = readFileSync(join(dir, file), 'utf8').slice(-tailBytes);
        for (const kind of findSuspicious(content)) warnings.push(`${day}/${file} 疑似出现${kind}`);
      } catch {
        // 读不了就跳过，自检不该因为一个坏文件中断
      }
    }
  }
  return warnings;
}
