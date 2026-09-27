<script setup lang="ts">
import type { Action } from '@lrs/shared';
import { computed, onMounted } from 'vue';
import ActionPanel from './components/ActionPanel.vue';
import EventLog from './components/EventLog.vue';
import RoundTable from './components/RoundTable.vue';
import { formatEvent, type EventLine } from './format';
import { PHASE_LABELS } from './labels';
import { useGameSocket } from './ws';

const { state, events, streaming, connected, lastError, connect, send } = useGameSocket();

onMounted(connect);

const lines = computed<EventLine[]>(() => events.value.map(formatEvent));

const latestSpeech = computed(() => {
  for (let i = events.value.length - 1; i >= 0; i -= 1) {
    const event = events.value[i];
    if (event?.payload.t === 'spoke') {
      return { seat: event.payload.seat, text: event.payload.text };
    }
  }
  return null;
});

const godView = computed(() => state.value?.viewer === 'god');

/** 夜里旁观者不该看到「轮到谁」，阶段名也一并含糊掉 */
const phaseLabel = computed(() => {
  if (!state.value) return '';
  return state.value.masked ? '夜晚' : PHASE_LABELS[state.value.phase];
});

const viewerLabel = computed(() =>
  godView.value ? '上帝视角 · 全场可见' : `我的视角 · ${state.value?.viewer ?? 1} 号`,
);

function toggleViewer(): void {
  send({ type: 'setViewer', viewer: godView.value ? 1 : 'god' });
}

function submit(action: Action): void {
  send({ type: 'action', action });
}

function autoPlay(count: number): void {
  send({ type: 'autoPlay', count });
}

function newGame(): void {
  send({ type: 'newGame' });
}
</script>

<template>
  <div class="app">
    <header class="bar">
      <span class="brand">🐺 AI 狼人杀</span>
      <span class="dim">{{ state?.board ?? '连接中…' }}</span>
      <span v-if="state" class="chip">第 {{ state.day }} 天</span>
      <span v-if="state" class="chip phase">{{ phaseLabel }}</span>
      <span v-if="state?.chief.elected" class="chip chief">🎖 {{ state.chief.elected }} 号</span>
      <span v-else-if="state && !state.chief.badgeAlive" class="chip dim-chip">警徽已流失</span>
      <span v-if="state?.witchPotions" class="chip potion">
        🧪 解药 {{ state.witchPotions.antidote }} · 毒药 {{ state.witchPotions.poison }}
      </span>

      <span class="spacer" />

      <span class="conn" :class="{ ok: connected }">{{ connected ? '● 已连接' : '○ 未连接' }}</span>
      <button
        :class="{ primary: godView }"
        :title="godView ? '当前是上帝视角，点击切回自己的视角' : '当前是自己的视角，点击可看全场底牌（调试用）'"
        @click="toggleViewer"
      >
        {{ viewerLabel }}
      </button>
      <button class="ghost" @click="newGame">新开一局</button>
    </header>

    <main class="main">
      <RoundTable :state="state" :latest="latestSpeech" :streaming="streaming" />
      <EventLog :lines="lines" :streaming="streaming" />
    </main>

    <ActionPanel :state="state" :connected="connected" :error="lastError" @send="submit" @auto="autoPlay" @new-game="newGame" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}

.brand {
  font-weight: 700;
  font-size: 14px;
}

.spacer {
  flex: 1;
}

.chip {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-dim);
}

.chip.phase {
  background: #2b2317;
  border-color: #6b5426;
  color: var(--warn);
}

.chip.chief {
  background: #2a3350;
  border-color: #465089;
  color: #9fb0ff;
}

.chip.potion {
  background: #1e2f24;
  border-color: #3c6b4a;
  color: #7ddc9b;
}

.dim-chip {
  background: #241b1b;
  border-color: #5b3a3a;
  color: #a06a72;
}

.dim {
  color: var(--text-dim);
  font-size: 11px;
}

.conn {
  font-size: 11px;
  color: var(--danger);
}

.conn.ok {
  color: var(--good);
}

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 12px;
  /* 滚动收在中间区域内部，保证底部操作区在任何视口高度下都不会被顶出屏幕 */
  overflow: auto;
}

.main > :deep(.log) {
  min-height: 0;
}

@media (max-width: 980px) {
  .main {
    flex-direction: column;
  }
}
</style>
