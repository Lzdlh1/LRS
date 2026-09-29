/**
 * 规则参数。设计文档 4.3 的全部默认值都集中在这里。
 *
 * 之所以不硬编码进状态机，是因为狼人杀的「村规」差异全集中在这几条
 * （女巫能不能自救、同守同救算不算死、警长票是 1.5 还是 2 …）。
 * 集中配置后，改规则不需要动状态机。
 */

export interface TimeoutRules {
  /** 上警报的时限 */
  chiefSignup: number;
  /** 竞选发言时限（PK 发言复用） */
  chiefSpeech: number;
  /** 警下投票时限（PK 投票复用） */
  chiefVote: number;
  /** 夜晚各角色行动时限 */
  night: number;
  /** 天亮公布死讯的展示时限 */
  dawnAnnounce: number;
  /** 遗言时限 */
  lastWords: number;
  /** 猎人开枪时限 */
  hunterShoot: number;
  /** 白天发言时限（PK 发言复用） */
  daySpeech: number;
  /** 白天投票时限 */
  dayVote: number;
}

export interface Rules {
  // ── 守卫 ──
  /** 不能连续两晚守同一人 */
  guardNoRepeatTarget: boolean;
  /** 可以守自己 */
  guardCanSelfProtect: boolean;

  // ── 女巫 ──
  witchAntidoteCount: number;
  witchPoisonCount: number;
  /** 一晚只能用一瓶药 */
  witchOnePotionPerNight: boolean;
  /** 可以自救 */
  witchCanSelfSave: boolean;

  // ── 技能交互 ──
  /** 同守同救导致死亡（奶穿） */
  guardedAndSavedDies: boolean;
  /** 猎人被女巫毒死时可以开枪 */
  hunterCanShootWhenPoisoned: boolean;

  // ── 警长 ──
  /** 警长票权 */
  chiefVoteWeight: number;
  /** 竞选再次平票则警徽流失 */
  chiefBadgeLostOnSecondTie: boolean;
  /** 第一天：竞选排在公布死讯之前（变体 A） */
  chiefElectionBeforeDawnAnnounce: boolean;

  // ── 遗言 ──
  /** 首夜死者有遗言 */
  firstNightDeathsHaveLastWords: boolean;
  /** 白天被投出局者有遗言 */
  votedOutHasLastWords: boolean;
  /** 第 2 夜起的夜间死亡者有遗言 */
  nightDeathsHaveLastWordsFromNight2: boolean;

  // ── 胜负 ──
  /** 狼刀在先：狼当夜达成胜利条件时，后手毒杀 / 开枪不改变结果 */
  wolfKillTakesPriority: boolean;
  /** 平票 PK 后再次平票则本轮无人出局 */
  tieMeansNoElimination: boolean;

  // ── 夜间节拍 ──
  /**
   * 夜间每一步的固定时长；0 = 关掉（行动者一提交就换步）。
   *
   * 打开之后：守卫→狼人→女巫→预言家四步**永远都走**（该角色出局也照走），
   * 每步走满这个时长才换步，**行动者提前提交也不提前换步**。
   * 这两条合起来才是「知道走到第几步、但看不出这一步有没有人动」——
   * 否则步数变少、或某一步只用了两秒，都能反推出那个角色还活着。
   */
  nightStepMs: number;

  // ── 时限（相对时限，引擎不持有真实时间）──
  timeoutMs: TimeoutRules;
}

export const DEFAULT_TIMEOUT_MS: TimeoutRules = {
  chiefSignup: 20_000,
  chiefSpeech: 60_000,
  chiefVote: 30_000,
  night: 45_000,
  dawnAnnounce: 15_000,
  lastWords: 60_000,
  hunterShoot: 30_000,
  daySpeech: 90_000,
  dayVote: 30_000,
};

export const DEFAULT_RULES: Rules = {
  guardNoRepeatTarget: true,
  guardCanSelfProtect: true,

  witchAntidoteCount: 1,
  witchPoisonCount: 1,
  witchOnePotionPerNight: true,
  witchCanSelfSave: false,

  guardedAndSavedDies: true,
  hunterCanShootWhenPoisoned: false,

  chiefVoteWeight: 1.5,
  chiefBadgeLostOnSecondTie: true,
  chiefElectionBeforeDawnAnnounce: true,

  firstNightDeathsHaveLastWords: true,
  votedOutHasLastWords: true,
  nightDeathsHaveLastWordsFromNight2: false,

  wolfKillTakesPriority: true,
  tieMeansNoElimination: true,

  // 默认关掉：纯引擎跑局时「提交即换步」最省事，产品端（会话服务）会打开它
  nightStepMs: 0,

  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/** 允许局部覆盖；timeoutMs 允许只覆盖其中几项。 */
export type RulesInput = Partial<Omit<Rules, 'timeoutMs'>> & {
  timeoutMs?: Partial<TimeoutRules>;
};

export function resolveRules(input?: RulesInput): Rules {
  const { timeoutMs, ...rest } = input ?? {};
  return {
    ...DEFAULT_RULES,
    ...rest,
    timeoutMs: { ...DEFAULT_RULES.timeoutMs, ...timeoutMs },
  };
}

/** 规则参数自检，返回错误说明列表，空数组表示合法。 */
export function validateRules(rules: Rules): string[] {
  const errors: string[] = [];

  if (rules.chiefVoteWeight < 1) {
    errors.push(`警长票权 ${rules.chiefVoteWeight} 小于 1，比普通玩家还弱`);
  }
  if (rules.witchAntidoteCount < 0 || rules.witchPoisonCount < 0) {
    errors.push('女巫药水数量不能为负');
  }
  if (!Number.isFinite(rules.nightStepMs) || rules.nightStepMs < 0) {
    errors.push(`夜间节拍 ${rules.nightStepMs} 不合法，应为 0（关闭）或正数毫秒`);
  }
  for (const [key, value] of Object.entries(rules.timeoutMs)) {
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`时限 ${key} 必须是正数，当前为 ${value}`);
    }
  }

  return errors;
}
