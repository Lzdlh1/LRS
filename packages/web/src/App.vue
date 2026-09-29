<script setup lang="ts">
import { choicesFor, type ActionChoice } from '@lrs/core-engine';
import { ROLE_LABELS, type Action, type Phase } from '@lrs/shared';
import { computed, onMounted, ref, watch } from 'vue';
import ActionPanel from './components/ActionPanel.vue';
import EventLog from './components/EventLog.vue';
import ReplayPanel from './components/ReplayPanel.vue';
import SeatColumn from './components/SeatColumn.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StageOverlay from './components/StageOverlay.vue';
import UsagePanel from './components/UsagePanel.vue';
import { formatEvent, type EventLine } from './format';
import { isNightPhase, PHASE_LABELS } from './labels';
import { deriveMarks } from './marks';
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

/** 设置面板自己管取数，这里只负责开关 */
const settingsOpen = ref(false);
/** 折叠栏：把「继续/视角/复盘/用量/设置/新开一局」这些收起来，别占着画面 */
const foldOpen = ref(false);

const godView = computed(() => state.value?.viewer === 'god');
const humanSeat = computed(() => state.value?.humanSeat ?? 1);
const seats = computed(() => state.value?.seats ?? []);

/** 九人局 5 + 4，十二人局 6 + 6 —— 数一数就分好了，不用改布局 */
const half = computed(() => Math.ceil(seats.value.length / 2));
const leftSeats = computed(() => seats.value.slice(0, half.value));
const rightSeats = computed(() => seats.value.slice(half.value));

const myRole = computed(() => seats.value.find((seat) => seat.seat === humanSeat.value)?.role ?? null);

/** 夜里旁观者不该看到「轮到谁」，阶段名也一并含糊掉 */
const phaseLabel = computed(() => {
  if (!state.value) return '';
  return state.value.masked ? '夜晚' : PHASE_LABELS[state.value.phase];
});

const pendingSeat = computed(() => state.value?.pending?.seat ?? null);
const speakingSeat = computed(() => streaming.value?.seat ?? null);

/** 狼队友是不是已经「碰过面」：首夜的守卫/狼人阶段之前，狼也还不知道队友是谁 */
const teammatesKnown = computed(() => {
  const current = state.value;
  if (!current) return false;
  if (current.day > 1) return true;
  return current.phase !== 'SETUP' && current.phase !== 'NIGHT_GUARD' && current.phase !== 'NIGHT_WOLF';
});

/** 已按视角裁剪过的事件 → 头像上的身份标记 */
const marks = computed(() => deriveMarks(events.value, { teammatesKnown: teammatesKnown.value }));

/** 当前这手能点谁：座位 → 可提交的动作（女巫的解药/毒药可能落在同一个人身上） */
const targetMap = computed<Record<number, ActionChoice[]>>(() => {
  const map: Record<number, ActionChoice[]> = {};
  const current = state.value;
  if (!current?.pending || current.paused || current.stopped) return map;
  for (const choice of choicesFor(current.pending)) {
    const target = (choice.action as { target?: unknown }).target;
    if (typeof target !== 'number') continue;
    (map[target] ??= []).push(choice);
  }
  return map;
});

const targetLabels = computed<Record<number, string[]>>(() => {
  const map: Record<number, string[]> = {};
  for (const [seat, list] of Object.entries(targetMap.value)) map[Number(seat)] = list.map((c) => c.label);
  return map;
});

/** 一个人身上有多个可选动作时，先弹一个小菜单问清楚，别默认替他选 */
const pickMenu = ref<{ seat: number; choices: ActionChoice[] } | null>(null);

// 换人行动了就收起菜单，免得点到上一个环节的旧选项
watch(
  () => state.value?.pending?.seat,
  () => {
    pickMenu.value = null;
  },
);

function pickSeat(seat: number): void {
  const list = targetMap.value[seat];
  if (!list || list.length === 0) return;
  if (list.length === 1) {
    send({ type: 'action', action: list[0]!.action });
    return;
  }
  pickMenu.value = { seat, choices: list };
}

function chooseFrom(choice: ActionChoice): void {
  pickMenu.value = null;
  send({ type: 'action', action: choice.action });
}

// ── 昼夜与环节：现在是视觉叙事，不再靠一条平滑的文案暗示 ──

/** 天黑了还是天亮了：准备阶段与所有 NIGHT_* 都算夜里 */
function isNightPhaseNow(phase: Phase): boolean {
  return phase === 'SETUP' || isNightPhase(phase);
}

const night = computed(() => (state.value ? isNightPhaseNow(state.value.phase) : true));

interface Flash {
  key: string;
  kind: string;
  icon: string;
  text: string;
}

/** 每个环节配一个「章节标题」，切换时一闪而过 */
const FLASHES: Partial<Record<Phase, Omit<Flash, 'key'>>> = {
  NIGHT_GUARD: { kind: 'skill', icon: '🛡', text: '守卫行动' },
  NIGHT_WOLF: { kind: 'death', icon: '🐺', text: '狼人行动' },
  NIGHT_WITCH: { kind: 'skill', icon: '🧪', text: '女巫行动' },
  NIGHT_SEER: { kind: 'skill', icon: '🔮', text: '预言家验人' },
  CHIEF_SIGNUP: { kind: 'chief', icon: '🎖', text: '警长竞选' },
  CHIEF_SPEECH: { kind: 'chief', icon: '🎤', text: '竞选发言' },
  CHIEF_WITHDRAW: { kind: 'chief', icon: '🚪', text: '退水' },
  CHIEF_VOTE: { kind: 'chief', icon: '🗳', text: '警下投票' },
  CHIEF_PK_SPEECH: { kind: 'chief', icon: '🎤', text: '竞选 PK' },
  CHIEF_PK_VOTE: { kind: 'chief', icon: '🗳', text: 'PK 投票' },
  DAWN_ANNOUNCE: { kind: 'dawn', icon: '🌅', text: '公布死讯' },
  CHIEF_TRANSFER: { kind: 'chief', icon: '🎖', text: '警徽转移' },
  LAST_WORDS: { kind: 'death', icon: '🕯', text: '遗言' },
  HUNTER_SHOOT: { kind: 'skill', icon: '🔫', text: '猎人开枪' },
  DAY_SPEECH: { kind: 'speech', icon: '💬', text: '依次发言' },
  DAY_VOTE: { kind: 'vote', icon: '🗳', text: '放逐投票' },
  DAY_PK_SPEECH: { kind: 'speech', icon: '💬', text: 'PK 发言' },
  DAY_PK_VOTE: { kind: 'vote', icon: '🗳', text: 'PK 投票' },
};

const sky = ref<'day' | 'night' | null>(null);
const flash = ref<Flash | null>(null);
let skyTimer: number | null = null;
let flashTimer: number | null = null;

/**
 * 只在「同一局里昼夜真的翻面」时放动画。
 *
 * 用「局号 + 昼夜」当钥匙：刚连上、刷新页面、每一条普通更新都不会误触发 ——
 * 否则每次刷新都要被糊一脸「天亮了」。
 */
let lastSkyKey = '';

watch(
  () => state.value,
  (current) => {
    if (!current) return;
    const kind = isNightPhaseNow(current.phase) ? 'night' : 'day';
    const key = `${current.gameId}:${kind}`;
    const previous = lastSkyKey;
    lastSkyKey = key;
    if (previous === '' || previous === key) return;

    sky.value = kind;
    if (skyTimer !== null) window.clearTimeout(skyTimer);
    skyTimer = window.setTimeout(() => {
      sky.value = null;
    }, 2600);
  },
);

watch(
  () => state.value?.phase,
  (phase, previous) => {
    const current = state.value;
    if (!current || phase === undefined || previous === undefined || phase === previous) return;
    // 夜里「轮到谁」是致命信息，绝不剧透：夜里只放昼夜那一幕
    if (current.masked || phase === 'GAME_OVER') return;
    const item = FLASHES[phase];
    if (!item) return;
    flash.value = { key: `${current.gameId}-${current.lastSeq}-${phase}`, ...item };
    if (flashTimer !== null) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flash.value = null;
    }, 1800);
  },
);

// ── 操作 ──

const viewerLabel = computed(() =>
  godView.value ? '上帝视角' : `我的视角 · ${humanSeat.value} 号`,
);

function toggleViewer(): void {
  send({ type: 'setViewer', viewer: godView.value ? humanSeat.value : 'god' });
}

function submit(action: Action): void {
  send({ type: 'action', action });
}

function autoPlay(count: number): void {
  send({ type: 'autoPlay', count });
}

function newGame(): void {
  foldOpen.value = false;
  send({ type: 'newGame' });
}

/** 中止是不可逆的（这局就废了），所以问一句 */
function abort(): void {
  if (window.confirm('中止本局？这一局会直接作废，之后只能新开一局。')) {
    foldOpen.value = false;
    stopGame();
  }
}
</script>

<template>
  <div class="app" :class="night ? 'night' : 'day'">
    <div class="bg bg-night" :style="{ opacity: night ? 1 : 0 }" />
    <div class="bg bg-day" :style="{ opacity: night ? 0 : 1 }" />

    <header class="bar">
      <button
        class="fold-btn"
        :class="{ on: foldOpen }"
        :aria-expanded="foldOpen"
        title="展开/收起操作栏"
        @click="foldOpen = !foldOpen"
      >
        {{ foldOpen ? '✕' : '☰' }}
      </button>
      <span class="brand">AI 狼人杀</span>

      <span v-if="state" class="chip phase">第 {{ state.day }} 天 · {{ phaseLabel }}</span>
      <!-- 上帝视角下每张底牌都印在头像上，这里就不用再报一遍自己的身份了 -->
      <span v-if="myRole && !godView" class="chip mine">
        {{ humanSeat }} 号 · {{ ROLE_LABELS[myRole] }}
      </span>

      <span v-if="state?.stopped" class="chip aborted">已中止</span>
      <span v-else-if="state?.paused" class="chip paused">⏸ 已暂停</span>

      <span class="spacer" />
      <span class="conn" :class="{ ok: connected }">{{ connected ? '已连接' : '未连接' }}</span>

      <!-- 暂停时把「继续」单独提到最外层：这是唯一需要立刻够到的按钮 -->
      <button v-if="state?.paused" class="primary" @click="resume()">▶ 继续</button>
    </header>

    <!-- 折叠栏单独占一行，不做浮层：浮层会盖住最上面那两个座位 -->
    <div v-if="foldOpen" class="fold">
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
        class="ghost"
        :class="{ primary: godView }"
        :title="godView ? '当前是上帝视角，点击切回自己的视角' : '当前是自己的视角，点击可看全场底牌（调试用）'"
        @click="toggleViewer"
      >
        {{ viewerLabel }}
      </button>
      <button class="ghost" :disabled="!connected" @click="openReplay()">复盘</button>
      <button class="ghost" :disabled="!connected" @click="openUsage('game')">用量</button>
      <button class="ghost" @click="settingsOpen = true">设置</button>
      <button class="ghost" @click="newGame">新开一局</button>
      <span class="fold-label">调试</span>
      <button
        class="ghost tiny"
        :disabled="!state || state.winner !== null || state.paused || state.stopped"
        @click="autoPlay(1)"
      >
        代打一步
      </button>
      <button
        class="ghost tiny"
        :disabled="!state || state.winner !== null || state.paused || state.stopped"
        @click="autoPlay(30)"
      >
        代打 30 步
      </button>
    </div>

    <main class="board">
      <SeatColumn
        :seats="leftSeats"
        :marks="marks"
        :targets="targetLabels"
        :pending-seat="pendingSeat"
        :speaking-seat="speakingSeat"
        :human-seat="humanSeat"
        @pick="pickSeat"
      />

      <div class="center">
        <EventLog :lines="lines" :streaming="streaming" />
        <ActionPanel
          :state="state"
          :connected="connected"
          :error="lastError"
          @send="submit"
        />
      </div>

      <SeatColumn
        :seats="rightSeats"
        :marks="marks"
        :targets="targetLabels"
        :pending-seat="pendingSeat"
        :speaking-seat="speakingSeat"
        :human-seat="humanSeat"
        @pick="pickSeat"
      />
    </main>

    <StageOverlay :sky="sky" :flash="flash" :day="state?.day ?? 1" />

    <!-- 一个人身上有多个动作可选时（女巫的解药/毒药撞在一起），先问清楚 -->
    <div v-if="pickMenu" class="pick-mask" @click.self="pickMenu = null">
      <div class="pick-card">
        <div class="pick-title">{{ pickMenu.seat }} 号 · 选一个动作</div>
        <button
          v-for="choice in pickMenu.choices"
          :key="choice.key"
          class="primary"
          @click="chooseFrom(choice)"
        >
          {{ choice.label }}
        </button>
        <button class="ghost" @click="pickMenu = null">取消</button>
      </div>
    </div>

    <ReplayPanel v-if="replay" :payload="replay" @day="openReplay" @close="closeReplay" />
    <UsagePanel v-if="usage" :payload="usage" @scope="openUsage" @close="closeUsage" />
    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;

  /* 站位卡尺寸只在这里定义。用 vh 兜一层：屏幕矮的时候自动缩小，
     十二人局一侧 6 个也塞得下，不至于把中间说话的地方挤没 */
  --avatar: clamp(32px, 6.2vh, 46px);
  --col-w: calc(var(--avatar) + 10px);
}

@media (min-width: 720px) {
  .app {
    --avatar: clamp(44px, 6.4vh, 58px);
  }
}

/* 昼夜底色做两层叠着淡入淡出，比切换 background-image 平滑 */
.bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  transition: opacity 1.4s ease;
}

.bg-night {
  background:
    radial-gradient(120% 70% at 50% -12%, rgba(147, 164, 255, 0.16) 0%, transparent 58%),
    radial-gradient(90% 60% at 8% 106%, rgba(43, 26, 30, 0.7) 0%, transparent 62%),
    linear-gradient(180deg, #0c1018 0%, #05070c 100%);
}

.bg-day {
  background:
    radial-gradient(120% 70% at 50% -14%, rgba(255, 190, 108, 0.2) 0%, transparent 56%),
    radial-gradient(90% 60% at 92% 104%, rgba(60, 46, 30, 0.55) 0%, transparent 62%),
    linear-gradient(180deg, #1a2130 0%, #0b0f18 100%);
}

.bar {
  position: relative;
  z-index: 20;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 7px 10px;
  background: rgba(10, 13, 20, 0.74);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(8px);
}

.fold-btn {
  flex: none;
  min-height: 30px;
  padding: 4px 10px;
  font-size: 14px;
  line-height: 1;
}

.fold-btn.on {
  border-color: var(--accent-dim);
  color: #fff;
}

.brand {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.06em;
  color: #eef1fb;
  white-space: nowrap;
}

.spacer {
  flex: 1 1 0;
  min-width: 0;
}

.chip {
  padding: 2px 9px;
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

.chip.mine {
  background: rgba(88, 211, 166, 0.12);
  border-color: rgba(88, 211, 166, 0.42);
  color: var(--jade);
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

/* 折叠栏占自己那一行：浮层会压住最上面两个座位，点不到 */
.fold {
  position: relative;
  z-index: 30;
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  background: rgba(10, 13, 20, 0.97);
  border-bottom: 1px solid var(--line-2);
  animation: fold-in 0.18s ease;
}

@keyframes fold-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}

.fold-label {
  font-size: 10.5px;
  letter-spacing: 0.18em;
  color: var(--text-faint);
  padding-left: 4px;
}

button.tiny {
  padding: 4px 9px;
  min-height: 26px;
  font-size: 11px;
  opacity: 0.78;
}

button.tiny:hover:not(:disabled) {
  opacity: 1;
}

.board {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--col-w) minmax(0, 1fr) var(--col-w);
  align-items: stretch;
  gap: 6px;
  padding: 8px 7px;
  overflow: hidden;
}

.center {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 8px;
}

.pick-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  background: rgba(4, 6, 11, 0.72);
}

.pick-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 220px;
  padding: 14px;
  border-radius: var(--radius);
  background: var(--panel);
  border: 1px solid var(--line-2);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.6);
}

.pick-title {
  font-family: var(--font-display);
  font-size: 14px;
  letter-spacing: 0.08em;
  color: var(--text);
}

@media (max-width: 480px) {
  .bar {
    gap: 5px;
    padding: 6px 8px;
  }

  .brand {
    font-size: 13.5px;
  }
}
</style>
