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
}>();

const emit = defineEmits<{
  send: [action: Action];
  auto: [count: number];
  newGame: [];
}>();

const speech = ref('');

const pending = computed(() => props.state?.pending ?? null);
const choices = computed(() => choicesFor(pending.value));
const canSpeak = computed(() => needsSpeech(pending.value));
const isOver = computed(() => props.state?.winner != null);
/** 玩家视角下，如果不是轮到自己，选项会是空的 */
const observing = computed(() => pending.value !== null && pending.value.options.length === 0);
const mine = computed(() => pending.value !== null && pending.value.options.length > 0);

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
    <div class="status">
      <template v-if="isOver">
        <span class="tag success">{{ state?.winner === 'wolf' ? '狼人胜' : '好人胜' }}</span>
        <span class="dim">对局已结束，可以点「新开一局」再来一把</span>
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

      <span v-if="!connected" class="tag danger">未连接</span>
      <span v-if="error" class="tag danger">{{ error }}</span>
    </div>

    <div v-if="pending" class="body">
      <div v-if="canSpeak" class="speech">
        <textarea
          v-model="speech"
          rows="2"
          placeholder="输入你的发言，回车或点发送提交"
          @keydown.enter.exact.prevent="submitSpeech"
        />
        <button class="primary send" :disabled="!speech.trim()" @click="submitSpeech">发送</button>
      </div>

      <div v-if="choices.length > 0" class="choices">
        <button v-for="choice in choices" :key="choice.key" @click="emit('send', choice.action)">
          {{ choice.label }}
        </button>
      </div>

      <div v-else-if="observing" class="dim hint">
        当前是玩家视角，看不到别人的可选行动。需要代打时切到「上帝视角」。
      </div>
    </div>

    <div class="debug">
      <span class="debug-label">调试</span>
      <button class="ghost tiny" :disabled="isOver" @click="emit('auto', 1)">代打一步</button>
      <button class="ghost tiny" :disabled="isOver" @click="emit('auto', 30)">代打 30 步</button>
      <button class="ghost tiny" @click="emit('newGame')">新开一局</button>
    </div>
  </footer>
</template>

<style scoped>
.panel {
  flex: none;
  border-top: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(18, 22, 31, 0.96) 0%, rgba(10, 13, 20, 0.96) 100%);
  backdrop-filter: blur(8px);
  padding: 11px 14px 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.status {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.tag {
  padding: 3px 11px;
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

.dim {
  color: var(--text-dim);
  font-size: 11.5px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  max-height: 148px;
  overflow-y: auto;
}

.hint {
  padding: 4px 0;
}

.debug {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 9px;
  border-top: 1px dashed #232a3a;
  flex-wrap: wrap;
}

.debug-label {
  font-size: 10.5px;
  letter-spacing: 0.18em;
  color: var(--text-faint);
}

button.tiny {
  padding: 4px 9px;
  min-height: 26px;
  font-size: 11px;
  opacity: 0.75;
}

button.tiny:hover:not(:disabled) {
  opacity: 1;
}
</style>
