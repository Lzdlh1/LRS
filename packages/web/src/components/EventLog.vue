<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { EventLine } from '../format';
import type { LiveSpeech } from '../ws';

const props = defineProps<{
  lines: EventLine[];
  streaming: LiveSpeech | null;
}>();

const box = ref<HTMLElement | null>(null);

/**
 * 流式文本要按和最终落地文本一样的规则压平空白。
 * 否则打字机里的换行会在正式发言落地那一刻「消失」，看起来像文字被改了。
 */
const liveText = computed(() => (props.streaming?.text ?? '').replace(/\s*\n+\s*/g, ' '));

function scrollToBottom(): void {
  void nextTick(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  });
}

watch(() => props.lines.length, scrollToBottom);
// 打字机每来一段就跟着滚，让最新吐出来的字始终可见
watch(() => liveText.value.length, scrollToBottom);
</script>

<template>
  <section class="log">
    <header class="log-head">
      <span>事件日志</span>
      <span v-if="streaming" class="live-tag">发言生成中…</span>
      <span class="count">{{ lines.length }}</span>
    </header>
    <div ref="box" class="log-body">
      <div v-if="lines.length === 0 && !streaming" class="empty">还没有事件</div>
      <div v-for="line in lines" :key="line.key" class="line" :class="line.tone">
        <span class="seq">{{ line.key }}</span>
        <span class="text">{{ line.text }}</span>
      </div>
      <div v-if="streaming" class="line live">
        <span class="seq">✍</span>
        <span class="text">{{ streaming.seat }} 号：{{ liveText }}<i class="caret" /></span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.log {
  flex: 1;
  min-width: 260px;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #262c3d;
  font-weight: 600;
}

.live-tag {
  font-size: 10px;
  font-weight: 400;
  color: var(--accent);
}

.count {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 400;
}

.log-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.empty {
  color: var(--text-faint);
}

.line {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.65;
}

.seq {
  flex: none;
  width: 28px;
  color: #414a63;
  font-size: 10px;
  text-align: right;
}

.line.muted .text {
  color: var(--text-faint);
}

.line.highlight .text {
  color: #9fb0ff;
}

.line.danger .text {
  color: var(--danger);
}

.line.success .text {
  color: var(--good);
}

.line.private .text {
  color: var(--purple);
}

.line.normal .text {
  color: var(--text);
}

.line.live .text {
  color: #c8d3ff;
}

.caret {
  display: inline-block;
  width: 6px;
  height: 12px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}
</style>
