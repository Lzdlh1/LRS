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
 * 夜间每一步的短名：去掉「夜晚 · 」前缀，因为流程提示里已经写了「夜晚」。
 * 顺序就是引擎里那四步的顺序，但界面**不再显示第几步** ——
 * 四步永远都走，写明轮次对玩家没有信息量，看着像进度条。
 */
export const NIGHT_STEP_NAMES: Record<string, string> = {
  NIGHT_GUARD: '守卫行动',
  NIGHT_WOLF: '狼人行动',
  NIGHT_WITCH: '女巫行动',
  NIGHT_SEER: '预言家验人',
};

/** 夜间每一步的流程提示：只写「谁在行动」，不写「第几步」——
 *  四步是固定顺序、永远都走，写出轮次对玩家没有信息量，反而像在报进度条。 */
export function nightStepLabel(phase: Phase): string {
  return NIGHT_STEP_NAMES[phase] ?? PHASE_LABELS[phase] ?? '';
}

export function seatLabel(seat: number): string {
  return `${seat} 号`;
}
