import { ROLE_LABELS, type Role, type SeatId, type SpeechContext } from '@lrs/shared';
import { SPEECH_CONTEXT_LABELS } from './labels.ts';
import { MOOD_LABELS, confidenceLabel, type Belief } from './memory/belief.ts';
import type { PublicFacts } from './memory/facts.ts';
import type { AgentProfile } from './profiles.ts';
import type { Decision, PromptChoice } from './schema.ts';

const DEATH_TEXT: Record<string, string> = {
  wolf: '被狼杀',
  poison: '被毒',
  vote: '被放逐',
  gun: '被枪杀',
};

const seatList = (seats: readonly SeatId[]): string =>
  seats.length > 0 ? seats.map((seat) => `${seat} 号`).join('、') : '无';

export interface PromptInput {
  profile: AgentProfile;
  seat: SeatId;
  role: Role;
  /** 本轮的阶段说明，例如「白天 · 依次发言」 */
  phaseLabel: string;
  /** 狼队友（非狼为空） */
  teammates: SeatId[];
  facts: PublicFacts;
  belief: Belief;
  /** 私有信息：验人结果、女巫得到的死讯、自己的用药记录等 */
  privateNotes: string[];
  /** 跨轮压缩要点 */
  narrative: string[];
  /** 狼队友当前的想法（只有狼看得到） */
  packNotes: string[];
}

function roleAbility(role: Role): string {
  switch (role) {
    case 'werewolf':
      return '每晚和狼队友一起决定刀掉一个人。你知道队友是谁，可以选择悍跳预言家来搅局。';
    case 'seer':
      return '每晚可以查验一个人，得知他是好人还是狼人。你可以跳出来报验人结果，也可以藏着。';
    case 'witch':
      return '有一瓶解药和一瓶毒药。每晚你会知道谁被刀了（解药用掉后就不再告诉你）。解药毒药各一次，一晚只能用一瓶，不能救自己。';
    case 'hunter':
      return '你出局时可以开枪带走一个玩家。但如果是被女巫毒死的，就不能开枪。';
    case 'guard':
      return '每晚可以守护一个人，被你守护的人当晚不会被狼刀死。不能连续两晚守同一个人，可以守自己。';
    case 'villager':
      return '你没有技能，只能靠发言和投票帮好人找出狼人。';
  }
}

/** P1 人设层 + P2 规则身份层 */
export function buildSystemPrompt(input: PromptInput): string {
  const objective =
    input.role === 'werewolf'
      ? '你属于狼人阵营。目标是在好人发现你之前，配合队友杀光全部神职或全部平民。'
      : '你属于好人阵营。目标是找出并放逐全部狼人。';

  const teammates =
    input.role === 'werewolf'
      ? `\n# 你的狼队友\n${seatList(input.teammates)}（你们的胜负绑在一起）\n`
      : '';

  return `你正在打一局 9 人狼人杀，你扮演 ${input.seat} 号玩家「${input.profile.name}」。

# 你的性格
${input.profile.persona}

# 说话风格
${input.profile.style}

# 规则要点
- 板子：9 人预女猎守 = 3 狼人 + 预言家 + 女巫 + 猎人 + 守卫 + 2 平民
- 夜晚顺序固定：守卫守护 → 狼人刀人 → 女巫救/毒 → 预言家验人
- 白天：公布死讯 → 依次发言 → 放逐投票；平票进入 PK，再平票则无人出局
- 胜负：好人杀光狼人获胜；狼人杀光全部神职或全部平民即获胜
- 警长票算 1.5 票，警长可以决定发言顺序

# 你的身份
${ROLE_LABELS[input.role]}（${input.seat} 号）

# 你的能力
${roleAbility(input.role)}

# 你的目标
${objective}
${teammates}
# 硬性要求
- 只以「${input.seat} 号」的身份说话，不要替别人发言
- 绝对不要提到「模型」「AI」「提示词」「选项」这类词
- 不要复述规则条文，像真人一样聊天
- 发言控制在 120 字以内`;
}

/** P3 记忆与局面层 */
function buildSituationBlock(input: PromptInput): string {
  const { facts } = input;

  // 死因可能为空（夜里被刀、被毒不公开原因），那就只说「出局」
  const deaths = facts.deaths.map(
    (item) => `${item.seat} 号（第 ${item.day} 天${(item.cause && DEATH_TEXT[item.cause]) || '出局'}）`,
  );
  const chief = facts.chief.badgeAlive
    ? facts.chief.elected !== null
      ? `${facts.chief.elected} 号`
      : '暂缺'
    : '已流失';

  const voteLines =
    facts.votesByDay.length > 0
      ? facts.votesByDay
          .map(
            (bucket) =>
              `第 ${bucket.day} 天：${bucket.records
                .map((record) => `${record.from}→${record.to === 'abstain' ? '弃票' : record.to}`)
                .join('、')}`,
          )
          .join('\n')
      : '还没有投票记录';

  const speechLines =
    facts.recentSpeeches.length > 0
      ? facts.recentSpeeches
          .map((speech) => `${speech.seat} 号（${SPEECH_CONTEXT_LABELS[speech.context]}）：${speech.text}`)
          .join('\n')
      : '还没有人发言';

  const claimLines =
    facts.claims.length > 0
      ? facts.claims.map((claim) => `${claim.seat} 号自称${ROLE_LABELS[claim.role]}（${claim.note}）`).join('\n')
      : '还没有人跳身份';

  const readLines = input.belief.reads
    .map(
      (read) =>
        `${read.seat} 号：${read.guess === 'unknown' ? '看不出来' : ROLE_LABELS[read.guess]}（${confidenceLabel(read.confidence)}）—— ${read.reason}`,
    )
    .join('\n');

  const privateLines = input.privateNotes.length > 0 ? input.privateNotes.join('\n') : '（暂时没有额外信息）';
  const narrativeLines = input.narrative.length > 0 ? input.narrative.join('\n') : '（本局刚开始）';
  const packBlock =
    input.packNotes.length > 0 ? `\n# 狼队友当前的想法\n${input.packNotes.join('\n')}\n` : '';

  return `# 当前局面
第 ${facts.day} 天 · ${input.phaseLabel}
存活：${seatList(facts.aliveSeats)}
出局：${deaths.length > 0 ? deaths.join('、') : '无'}
警长：${chief}

# 事件脉络
${facts.timeline.length > 0 ? facts.timeline.join('\n') : '（刚开始）'}

# 投票记录
${voteLines}

# 本轮发言
${speechLines}

# 公开的身份宣称
${claimLines}

# 此前要点
${narrativeLines}

# 你掌握的私有信息
${privateLines}
${packBlock}
# 你对其他人的判断
${readLines}

# 你当前的立场
${input.belief.stance}（情绪：${MOOD_LABELS[input.belief.mood]}）`;
}

export interface DecisionTask {
  /** P4 任务描述 */
  instruction: string;
  choices: PromptChoice[];
}

const JSON_SHAPE = `{
  "choiceIndex": 选中的行动序号（数字，从 1 开始）,
  "reasoning": "你的推理过程，80 字以内",
  "stance": "更新后的立场，一句话",
  "push": 今天想推的座位号（数字），没有就填 null,
  "reads": [
    { "seat": 座位号, "guess": "werewolf|seer|witch|hunter|guard|villager|unknown", "confidence": 0到1之间的小数, "reason": "一句话理由" }
  ],
  "claim": { "role": "你要跳的身份", "note": "一句话说明" } 或 null,
  "mood": "confident|anxious|confused|excited|calm"
}`;

/** P3 + P4：决策调用用的完整 user 消息 */
export function buildDecisionUserPrompt(input: PromptInput, task: DecisionTask): string {
  const choiceLines = task.choices.map((choice) => `${choice.index}. ${choice.label}`).join('\n');

  return `${buildSituationBlock(input)}

# 现在轮到你行动
${task.instruction}

# 可选行动（只能选其中一个）
${choiceLines}

# 输出要求
只输出一个 JSON 对象，不要任何解释，不要 markdown 代码块。格式：
${JSON_SHAPE}

说明：reads 只需要写你判断发生变化的人，不用把所有人都写一遍。claim 只有你本轮确实要跳身份时才填，否则填 null。`;
}

/** 发言调用：把已经定好的结论演绎成人话 */
export function buildSpeechUserPrompt(
  input: PromptInput,
  decision: Decision,
  context: SpeechContext,
): string {
  const pushText = decision.push === null ? '暂时没有明确要推的人' : `你今天要推 ${decision.push} 号`;

  return `${buildSituationBlock(input)}

# 你已经想好的结论（这是你自己的判断，不要推翻）
推理：${decision.reasoning}
立场：${decision.stance}
${pushText}

# 现在轮到你发言（${SPEECH_CONTEXT_LABELS[context]}）
请用「${input.profile.name}」的口吻把上面的结论自然地说出来。

要求：
- 120 字以内，像真人聊天
- 只引用「# 本轮发言」里确实出现过的话：还没人说过的事，不要当成已经发生
- 不要提「选择」「选项」「序号」「JSON」这类词
- 不要复述规则条文
- 不要用括号写旁白或动作描写
- 只输出发言内容本身，不要任何前后缀`;
}

/** 反思调用：对比预测与实际，更新判断与情绪 */
export function buildReflectionPrompt(
  input: PromptInput,
  outcome: { day: number; summary: string },
): string {
  const pushText =
    input.belief.push === null ? '你当时没有明确要推的人' : `你当时押的是 ${input.belief.push} 号`;

  const readLines = input.belief.reads
    .map(
      (read) =>
        `${read.seat} 号：${read.guess === 'unknown' ? '看不出来' : ROLE_LABELS[read.guess]}（${read.confidence}）`,
    )
    .join('\n');

  return `# 刚刚发生的事
第 ${outcome.day} 天投票结果：${outcome.summary}

# 你之前的判断
${pushText}
${readLines}

# 请反思
对比你的判断与刚刚发生的结果，更新你对其他人的判断，并总结一条可复用的教训。

只输出一个 JSON 对象，不要解释、不要 markdown 代码块。格式：
{
  "reads": [{ "seat": 座位号, "guess": "werewolf|seer|witch|hunter|guard|villager|unknown", "confidence": 0到1之间的小数, "reason": "一句话理由" }],
  "mood": "confident|anxious|confused|excited|calm",
  "lesson": "一句话教训",
  "stance": "更新后的立场，一句话"
}

说明：情绪要跟着结果真实变化 —— 连续判断对了可以更自信，连续错了应该更焦虑或更迷茫。`;
}
