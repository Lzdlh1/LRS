<script setup lang="ts">
import { choicesFor, needsSpeech } from '@lrs/core-engine';
import type { Action } from '@lrs/shared';
import type { ClientState } from '@lrs/server/protocol';
import { computed, ref, watch } from 'vue';
import { seatLabel } from '../labels';

const props = defineProps<{
  state: ClientState | null;
  connected: boolean;
  error: string | null;
  /**
   * 真人这手还剩多久（毫秒）；null 表示不在等真人。
   * 服务端超时会代打，这条进度条就是「再不动手就替你动了」的明示。
   */
  actionLeftMs: number | null;
  actionTotalMs: number;
}>();

const emit = defineEmits<{ send: [action: Action] }>();

const speech = ref('');

const pending = computed(() => props.state?.pending ?? null);
const choices = computed(() => choicesFor(pending.value));
const canSpeak = computed(() => needsSpeech(pending.value));
const stopped = computed(() => props.state?.stopped === true);
const paused = computed(() => props.state?.paused === true);
const isOver = computed(() => props.state?.winner != null || stopped.value);
/** 服务端正停着等真人把重大信息卡片点掉 */
const waitingAck = computed(() => (props.state?.ackSeq.length ?? 0) > 0);
/** 冻结中：这时候点什么都会被服务端拒绝，干脆不给点 */
const frozen = computed(() => paused.value || stopped.value || waitingAck.value);
/** 玩家视角下，如果不是轮到自己，选项会是空的 */
const observing = computed(() => pending.value !== null && pending.value.options.length === 0);
const mine = computed(() => pending.value !== null && pending.value.options.length > 0);

/** 需要选目标的动作统一改成「点头像」，这里只留不需要选人的那些按钮 */
const seatChoiceCount = computed(
  () => choices.value.filter((choice) => typeof (choice.action as { target?: unknown }).target === 'number').length,
);
const plainChoices = computed(() =>
  choices.value.filter((choice) => typeof (choice.action as { target?: unknown }).target !== 'number'),
);

/** 倒计时百分比（100 → 0）；低于三成换朱砂色 */
const deadlinePct = computed(() => {
  if (props.actionLeftMs === null || props.actionTotalMs <= 0) return null;
  return Math.max(0, Math.min(100, (props.actionLeftMs / props.actionTotalMs) * 100));
});
const deadlineSeconds = computed(() =>
  props.actionLeftMs === null ? null : Math.max(0, Math.ceil(props.actionLeftMs / 1000)),
);

watch(pending, () => {
  speech.value = '';
});

function submitSpeech(): void {
  const text = speech.value.trim();
  const seat = pending.value?.seat;
  if (!text || seat === undefined) return;
  emit('send', { kind: 'speak', actor: seat, text });
  speech.value = '';
}
</script>

<template>
  <footer class="panel">
    <!-- 真人行动倒计时：到点服务端会代打，不能让人死得不明不白 -->
    <div v-if="deadlinePct !== null && mine && !frozen" class="deadline" :class="{ tight: deadlinePct < 30 }">
      <div class="deadline-fill" :style="{ width: `${deadlinePct}%` }" />
      <span class="deadline-text">{{ deadlineSeconds }}s</span>
    </div>

    <div class="status">
      <template v-if="stopped">
        <span class="tag danger">本局已中止</span>
        <span class="dim">在 ☰ 里点「新开一局」重来</span>
      </template>
      <template v-else-if="waitingAck">
        <span class="tag warn">等你确认</span>
        <span class="dim">看完卡片点「知道了」才继续推进</span>
      </template>
      <template v-else-if="isOver">
        <span class="tag success">{{ state?.winner === 'wolf' ? '狼人胜' : '好人胜' }}</span>
        <span class="dim">对局已结束，可以在 ☰ 里新开一局</span>
      </template>
      <template v-else-if="paused">
        <span class="tag warn">已暂停</span>
        <span class="dim">局面冻结中，点顶部「▶ 继续」接着打</span>
      </template>
      <template v-else-if="pending">
        <span class="tag" :class="{ active: mine }">
          {{ mine ? '轮到你' : `轮到 ${seatLabel(pending.seat)}` }}
        </span>
        <span class="dim">{{ pending.options[0]?.label ?? '等这一手走完' }}</span>
      </template>
      <template v-else>
        <span class="dim">等待服务端推进…</span>
      </template>

      <span v-if="state?.witchPotions" class="tag potion">
        🧪 解药 {{ state.witchPotions.antidote }} · 毒药 {{ state.witchPotions.poison }}
      </span>
      <span v-if="!connected" class="tag danger">未连接</span>
      <span v-if="error" class="tag danger">{{ error }}</span>
    </div>

    <div v-if="pending && !frozen" class="body">
      <div v-if="canSpeak" class="speech">
        <textarea
          v-model="speech"
          rows="2"
          placeholder="输入你的发言，回车或点发送提交"
          @keydown.enter.exact.prevent="submitSpeech"
        />
        <button class="primary send" :disabled="!speech.trim()" @click="submitSpeech">发送</button>
      </div>

      <!-- 要选人的动作不再铺一屏按钮：直接点两边的头像，既看得清是谁也省地方 -->
      <div v-if="seatChoiceCount > 0" class="pick-hint">
        <span class="dot" />
        点两边闪光的头像选目标（{{ seatChoiceCount }} 个可选）
      </div>

      <div v-if="plainChoices.length > 0" class="choices">
        <button v-for="choice in plainChoices" :key="choice.key" @click="emit('send', choice.action)">
          {{ choice.label }}
        </button>
      </div>

      <div v-else-if="observing" class="dim hint">
        当前是玩家视角，看不到别人的可选行动。需要代打时在 ☰ 里切到「上帝视角」。
      </div>
    </div>
  </footer>
</template>

<style scoped>
.panel {
  flex: none;
  background: linear-gradient(180deg, var(--surface-panel) 0%, var(--surface-panel-2) 100%);
  backdrop-filter: blur(8px);
  border-radius: var(--radius);
  border: 1px solid var(--line);
  padding: 9px 11px 11px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 行动倒计时条：月光色，低于三成转朱砂 —— 不是装饰，是「要被代打了」的警告 */
.deadline {
  position: relative;
  height: 16px;
  border-radius: 999px;
  background: var(--ink-0);
  border: 1px solid var(--line);
  overflow: hidden;
}

.deadline-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent-dim) 0%, var(--accent) 100%);
  transition: width 0.45s linear;
}

.deadline.tight .deadline-fill {
  background: linear-gradient(90deg, #a33a32 0%, var(--danger) 100%);
}

.deadline-text {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tag {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--panel-2);
  border: 1px solid var(--line-2);
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
}

.tag.active {
  background: #2a3350;
  border-color: #4d5a94;
  color: #cdd6ff;
}

.tag.warn {
  background: rgba(217, 178, 106, 0.16);
  border-color: rgba(217, 178, 106, 0.6);
  color: var(--gold);
}

.tag.success {
  background: rgba(88, 211, 166, 0.12);
  border-color: rgba(88, 211, 166, 0.5);
  color: var(--jade);
}

.tag.danger {
  background: rgba(210, 85, 74, 0.12);
  border-color: rgba(210, 85, 74, 0.5);
  color: var(--danger);
}

.tag.potion {
  background: rgba(88, 211, 166, 0.1);
  border-color: rgba(88, 211, 166, 0.4);
  color: var(--jade);
}

.dim {
  color: var(--text-dim);
  font-size: 11.5px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.speech {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.speech textarea {
  flex: 1;
  min-width: 0;
  resize: vertical;
}

.send {
  flex: none;
  align-self: stretch;
  min-width: 64px;
}

/* 目标类按钮排成规整网格，比一行行乱折好看也好点 */
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
  gap: 7px;
  max-height: 132px;
  overflow-y: auto;
}

.pick-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: rgba(147, 164, 255, 0.09);
  border: 1px dashed rgba(147, 164, 255, 0.45);
  color: #b3c0ff;
  font-size: 12px;
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: hint-pulse 1.4s ease-in-out infinite;
}

@keyframes hint-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(147, 164, 255, 0.5);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(147, 164, 255, 0);
  }
}

.hint {
  padding: 2px 0;
}
</style>
