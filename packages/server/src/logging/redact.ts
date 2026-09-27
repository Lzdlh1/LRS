/**
 * 统一脱敏器。
 *
 * 所有落盘日志都必须先经过这里 —— 目标是「日志可以随便给人看，不会带出任何凭据」。
 * 这是防泄密的最后一道闸门，不能绕过。
 */

/** 字段名命中就直接整体打码 */
const SENSITIVE_KEY = /^(api[-_]?key|apikey|token|access[_-]?token|secret|password|authorization|credential)$/i;

interface RedactRule {
  pattern: RegExp;
  replacement: string;
  /** 命中后用于告警的可读名字 */
  label: string;
}

const RULES: RedactRule[] = [
  { pattern: /github_pat_[A-Za-z0-9_]{10,}/g, replacement: 'github_pat_***', label: 'GitHub 细粒度令牌' },
  { pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g, replacement: 'gh*_***', label: 'GitHub 经典令牌' },
  { pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-***', label: 'OpenAI 风格密钥' },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: '$1***', label: 'Bearer 令牌' },
  {
    pattern: /((?:api[_-]?key|apikey|access[_-]?token|secret|password)["'\s]*[:=]["'\s]*)[^\s"',}]{6,}/gi,
    replacement: '$1***',
    label: '键值对形式的凭据',
  },
];

export function redactText(input: string): string {
  return RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replacement), input);
}

export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[层级过深，已截断]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '***' : redactDeep(val, depth + 1);
    }
    return output;
  }
  return value;
}

/** 找出文本里疑似凭据的种类，用于启动自检告警 */
export function findSuspicious(text: string): string[] {
  const hits: string[] = [];
  for (const rule of RULES) {
    const probe = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
    if (probe.test(text)) hits.push(rule.label);
  }
  return hits;
}
