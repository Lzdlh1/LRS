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
        <span class="tag">轮到 {{ seatLabel(pending.seat) }}</span>
        <span class="dim">{{ pending.options[0]?.label ?? '' }}</span>
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
        <button class="primary" :disabled="!speech.trim()" @click="submitSpeech">发送</button>
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
      <span class="dim">调试：</span>
      <button class="ghost" :disabled="isOver" @click="emit('auto', 1)">代打一步</button>
      <button class="ghost" :disabled="isOver" @click="emit('auto', 30)">代打 30 步</button>
      <button class="ghost" @click="emit('newGame')">新开一局</button>
    </div>
  </footer>
</template>

<style scoped>
.panel {
  flex: none;
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.status {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.tag {
  padding: 3px 10px;
  border-radius: 999px;
  background: #2a3350;
  border: 1px solid #465089;
  color: #9fb0ff;
  font-size: 11px;
}

.tag.success {
  background: #12211c;
  border-color: var(--good);
  color: var(--good);
}

.tag.danger {
  background: #2a1a1c;
  border-color: #7a3a3f;
  color: var(--danger);
}

.dim {
  color: var(--text-dim);
  font-size: 11px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.speech {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.speech textarea {
  flex: 1;
  resize: vertical;
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  max-height: 132px;
  overflow-y: auto;
}

.hint {
  padding: 6px 0;
}

.debug {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 8px;
  border-top: 1px dashed #262c3d;
}
</style>
