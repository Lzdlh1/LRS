<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { EventLine } from '../format';

const props = defineProps<{ lines: EventLine[] }>();

const box = ref<HTMLElement | null>(null);

watch(
  () => props.lines.length,
  () => {
    void nextTick(() => {
      if (box.value) box.value.scrollTop = box.value.scrollHeight;
    });
  },
);
</script>

<template>
  <section class="log">
    <header class="log-head">
      <span>事件日志</span>
      <span class="count">{{ lines.length }}</span>
    </header>
    <div ref="box" class="log-body">
      <div v-if="lines.length === 0" class="empty">还没有事件</div>
      <div v-for="line in lines" :key="line.key" class="line" :class="line.tone">
        <span class="seq">{{ line.key }}</span>
        <span class="text">{{ line.text }}</span>
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
</style>
