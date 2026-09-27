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

export function seatLabel(seat: number): string {
  return `${seat} 号`;
}
