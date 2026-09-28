<script setup lang="ts">
import type { Action } from '@lrs/shared';
import { computed, onMounted } from 'vue';
import ActionPanel from './components/ActionPanel.vue';
import EventLog from './components/EventLog.vue';
import ReplayPanel from './components/ReplayPanel.vue';
import RoundTable from './components/RoundTable.vue';
import UsagePanel from './components/UsagePanel.vue';
import { formatEvent, type EventLine } from './format';
import { PHASE_LABELS } from './labels';
import { useGameSocket } from './ws';

const {
  state,
  events,
  streaming,
  replay,
  usage,
  connected,
  lastError,
  connect,
  send,
  openReplay,
  closeReplay,
  openUsage,
  closeUsage,
  pause,
  resume,
  stopGame,
} = useGameSocket();

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
  godView.value ? '上帝视角' : `我的视角 · ${state.value?.viewer ?? 1} 号`,
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

/** 中止是不可逆的（这局就废了），所以问一句 */
function abort(): void {
  if (window.confirm('中止本局？这一局会直接作废，之后只能新开一局。')) stopGame();
}
</script>

<template>
  <div class="app">
    <header class="bar">
      <span class="brand"><i class="moon">🌒</i>AI 狼人杀</span>
      <span class="board">{{ state?.board ?? '连接中…' }}</span>

      <span v-if="state" class="chip">第 {{ state.day }} 天</span>
      <span v-if="state" class="chip phase">{{ phaseLabel }}</span>
      <span v-if="state?.chief.elected" class="chip chief">🎖 {{ state.chief.elected }} 号</span>
      <span v-else-if="state && !state.chief.badgeAlive" class="chip lost">警徽已流失</span>
      <span v-if="state?.witchPotions" class="chip potion">
        🧪 解药 {{ state.witchPotions.antidote }} · 毒药 {{ state.witchPotions.poison }}
      </span>

      <span v-if="state?.stopped" class="chip aborted">已中止</span>
      <span v-else-if="state?.paused" class="chip paused">⏸ 已暂停 · 不再消耗</span>

      <span class="spacer" />

      <span class="conn" :class="{ ok: connected }">{{ connected ? '已连接' : '未连接' }}</span>
      <button
        v-if="state && state.winner === null && !state.stopped"
        :class="{ primary: state.paused }"
        :title="state.paused ? '继续推进对局' : '冻结局面：暂停期间不排超时兜底，也不会发起任何模型调用'"
        @click="state.paused ? resume() : pause()"
      >
        {{ state.paused ? '▶ 继续' : '⏸ 暂停' }}
      </button>
      <button
        v-if="state && state.winner === null && !state.stopped"
        class="ghost"
        title="中止本局：立刻停手，不会再自动推进"
        @click="abort"
      >
        中止
      </button>
      <button
        class="viewer"
        :class="{ primary: godView }"
        :title="godView ? '当前是上帝视角，点击切回自己的视角' : '当前是自己的视角，点击可看全场底牌（调试用）'"
        @click="toggleViewer"
      >
        {{ viewerLabel }}
      </button>
      <button class="ghost" :disabled="!connected" @click="openReplay()">复盘</button>
      <button class="ghost" :disabled="!connected" @click="openUsage('game')">用量</button>
      <button class="ghost" @click="newGame">新开一局</button>
    </header>

    <main class="main">
      <RoundTable :state="state" :latest="latestSpeech" :streaming="streaming" />
      <EventLog :lines="lines" :streaming="streaming" />
    </main>

    <ActionPanel
      :state="state"
      :connected="connected"
      :error="lastError"
      @send="submit"
      @auto="autoPlay"
      @new-game="newGame"
    />

    <ReplayPanel v-if="replay" :payload="replay" @day="openReplay" @close="closeReplay" />
    <UsagePanel v-if="usage" :payload="usage" @scope="openUsage" @close="closeUsage" />
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
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  background: linear-gradient(180deg, rgba(22, 27, 38, 0.92) 0%, rgba(13, 17, 25, 0.92) 100%);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.06em;
  color: #eef1fb;
  white-space: nowrap;
}

.moon {
  font-style: normal;
  font-size: 15px;
  filter: drop-shadow(0 0 6px rgba(147, 164, 255, 0.5));
}

.board {
  color: var(--text-faint);
  font-size: 11.5px;
  white-space: nowrap;
}

.spacer {
  flex: 1 1 0;
  min-width: 0;
}

.chip {
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(26, 32, 48, 0.8);
  border: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.chip.phase {
  background: rgba(217, 178, 106, 0.1);
  border-color: rgba(217, 178, 106, 0.42);
  color: var(--gold);
}

.chip.chief {
  background: rgba(147, 164, 255, 0.12);
  border-color: rgba(147, 164, 255, 0.45);
  color: #b3c0ff;
}

.chip.potion {
  background: rgba(88, 211, 166, 0.1);
  border-color: rgba(88, 211, 166, 0.4);
  color: var(--jade);
}

.chip.lost {
  background: rgba(210, 85, 74, 0.1);
  border-color: rgba(210, 85, 74, 0.4);
  color: #c08480;
}

/* 暂停/中止是要看得见的状态：这两个 chip 用更实的底色 */
.chip.paused {
  background: rgba(217, 178, 106, 0.16);
  border-color: rgba(217, 178, 106, 0.65);
  color: var(--gold);
}

.chip.aborted {
  background: rgba(210, 85, 74, 0.16);
  border-color: rgba(210, 85, 74, 0.6);
  color: #e09a94;
}

.conn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--danger);
  white-space: nowrap;
}

.conn::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

.conn.ok {
  color: var(--jade);
}

.viewer {
  font-size: 11.5px;
  white-space: nowrap;
}

.main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
  overflow: auto;
}

/* 宽屏：圆桌在左当中，日志窄栏靠右，两边一起撑满高度 */
@media (min-width: 1024px) {
  .main {
    grid-template-columns: minmax(0, 1fr) minmax(320px, 460px);
    align-items: stretch;
    overflow: hidden;
  }
}

@media (max-width: 480px) {
  .bar {
    gap: 6px;
    padding: 8px 10px;
  }

  .brand {
    font-size: 14.5px;
  }

  .main {
    padding: 10px;
    gap: 10px;
  }
}
</style>
