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
      <span class="title">事件日志</span>
      <span v-if="streaming" class="live-tag">发言生成中…</span>
      <span class="count">{{ lines.length }}</span>
    </header>
    <div ref="box" class="log-body">
      <div v-if="lines.length === 0 && !streaming" class="empty">还没有事件</div>
      <div
        v-for="line in lines"
        :key="line.key"
        class="line"
        :class="[line.tone, { speech: line.speech }]"
      >
        <span class="seq">{{ line.key }}</span>
        <span class="text">{{ line.text }}</span>
      </div>
      <div v-if="streaming" class="line live speech">
        <span class="seq">✍</span>
        <span class="text">{{ streaming.seat }} 号：{{ liveText }}<i class="caret" /></span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 中间这块是整个界面最值得给面积的地方：文字局全靠读它 */
.log {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(20, 25, 36, 0.9) 0%, rgba(14, 18, 27, 0.9) 100%);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--line);
}

.title {
  font-family: var(--font-display);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--text);
}

.live-tag {
  font-size: 10.5px;
  color: var(--accent);
}

.count {
  margin-left: auto;
  font-family: var(--font-mono);
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.log-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.empty {
  color: var(--text-faint);
}

.line {
  display: flex;
  gap: 9px;
  font-size: 12.5px;
  line-height: 1.7;
  border-radius: var(--radius-sm);
}

.seq {
  flex: none;
  width: 26px;
  padding-top: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-align: right;
  color: #3c465c;
  font-variant-numeric: tabular-nums;
}

.text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 发言是日志的主角：给一条月光，做成对白的样子 */
.line.speech {
  margin: 3px 0;
  padding: 5px 9px;
  background: rgba(147, 164, 255, 0.05);
  border-left: 2px solid rgba(147, 164, 255, 0.45);
}

.line.speech .seq {
  color: var(--accent-dim);
}

.line.speech .text {
  color: #dfe5f5;
}

.line.muted .text {
  color: var(--text-faint);
}

.line.highlight .text {
  color: #a9b6ff;
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
  color: #dfe5f5;
}

.caret {
  display: inline-block;
  width: 6px;
  height: 12px;
  margin-left: 3px;
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
