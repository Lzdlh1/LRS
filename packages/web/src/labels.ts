import type { DeathCause, Phase, Role, SpeechContext } from '@lrs/shared';

/** 座位角标用的单字身份，比「预言家」这种全称省地方 */
export const ROLE_GLYPHS: Record<Role, string> = {
  werewolf: '狼',
  seer: '预',
  witch: '女',
  hunter: '猎',
  guard: '守',
  villager: '民',
};

export const PHASE_LABELS: Record<Phase, string> = {
  SETUP: '准备',
  NIGHT_GUARD: '夜晚 · 守卫行动',
  NIGHT_WOLF: '夜晚 · 狼人行动',
  NIGHT_WITCH: '夜晚 · 女巫行动',
  NIGHT_SEER: '夜晚 · 预言家验人',
  CHIEF_SIGNUP: '警长竞选 · 上警',
  CHIEF_SPEECH: '警长竞选 · 竞选发言',
  CHIEF_WITHDRAW: '警长竞选 · 退水',
  CHIEF_VOTE: '警长竞选 · 警下投票',
  CHIEF_PK_SPEECH: '警长竞选 · PK 发言',
  CHIEF_PK_VOTE: '警长竞选 · PK 投票',
  DAWN_ANNOUNCE: '天亮 · 公布死讯',
  CHIEF_TRANSFER: '警徽转移',
  LAST_WORDS: '遗言',
  HUNTER_SHOOT: '猎人开枪',
  DAY_SPEECH: '白天 · 依次发言',
  DAY_VOTE: '白天 · 放逐投票',
  DAY_PK_SPEECH: '白天 · PK 发言',
  DAY_PK_VOTE: '白天 · PK 投票',
  GAME_OVER: '对局结束',
};

export const DEATH_CAUSE_LABELS: Record<DeathCause, string> = {
  wolf: '被狼人杀害',
  poison: '被女巫毒杀',
  vote: '被投票放逐',
  gun: '被猎人带走',
};

export const SPEECH_CONTEXT_LABELS: Record<SpeechContext, string> = {
  chief_campaign: '竞选发言',
  chief_pk: '竞选 PK 发言',
  day: '发言',
  day_pk: 'PK 发言',
  last_words: '遗言',
};

export function isNightPhase(phase: Phase): boolean {
  return phase.startsWith('NIGHT_');
}

/**
 * 夜间四步的固定顺序。
 *
 * 打开 `Rules.nightStepMs` 之后这四步**永远都走**（该角色出局也照走），
 * 所以「现在第几步」是公开信息，日志与流程提示都可以放心写出来。
 */
export const NIGHT_STEPS: Phase[] = ['NIGHT_GUARD', 'NIGHT_WOLF', 'NIGHT_WITCH', 'NIGHT_SEER'];

/** 第几步（从 1 开始）；不是夜间阶段时返回 0 */
export function nightStepIndex(phase: Phase): number {
  return NIGHT_STEPS.indexOf(phase) + 1;
}

/** 夜间每一步的短名：去掉「夜晚 · 」前缀，因为流程提示里已经写了「夜晚」 */
export const NIGHT_STEP_NAMES: Record<string, string> = {
  NIGHT_GUARD: '守卫行动',
  NIGHT_WOLF: '狼人行动',
  NIGHT_WITCH: '女巫行动',
  NIGHT_SEER: '预言家验人',
};

/** 「第 2 / 4 步 · 狼人行动」这种流程提示 */
export function nightStepLabel(phase: Phase): string {
  return `第 ${nightStepIndex(phase)} / ${NIGHT_STEPS.length} 步 · ${NIGHT_STEP_NAMES[phase] ?? ''}`;
}

export function seatLabel(seat: number): string {
  return `${seat} 号`;
}
