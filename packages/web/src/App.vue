<script setup lang="ts">
import { choicesFor, type ActionChoice } from '@lrs/core-engine';
import { ROLE_LABELS, type Action, type Phase } from '@lrs/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ActionPanel from './components/ActionPanel.vue';
import EventLog from './components/EventLog.vue';
import InfoCard from './components/InfoCard.vue';
import ReplayPanel from './components/ReplayPanel.vue';
import SeatColumn from './components/SeatColumn.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StageOverlay from './components/StageOverlay.vue';
import UsagePanel from './components/UsagePanel.vue';
import { formatEvent, buildAckCard, type EventLine } from './format';
import {
  isNightPhase,
  nightStepIndex,
  nightStepLabel,
  NIGHT_STEP_NAMES,
  NIGHT_STEPS,
  PHASE_LABELS,
} from './labels';
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

// 倒计时每半秒走一格
onMounted(() => {
  const timer = window.setInterval(() => {
    tickNow.value = Date.now();
  }, 500);
  onBeforeUnmount(() => window.clearInterval(timer));
});

/**
 * 日志：一条事件一行。
 *
 * 夜里那四步现在都写出来（「夜晚 · 第 2 / 4 步 · 狼人行动」）—— 四步永远都走、步长固定，
 * 所以「走到哪一步」是公开信息，写出来不会泄漏「这一步有没有人行动」。
 */
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

/** 流程提示：夜里写明是第几步、谁在行动（四步永远都走，写出来不泄漏谁还活着） */
const phaseLabel = computed(() => {
  const current = state.value;
  if (!current) return '';
  if (isNightPhase(current.phase)) {
    return `夜晚 ${nightStepIndex(current.phase)}/${NIGHT_STEPS.length} · ${NIGHT_STEP_NAMES[current.phase] ?? ''}`;
  }
  return PHASE_LABELS[current.phase];
});

/**
 * 夜里那一步的倒计时。
 *
 * 服务端下发的是「还剩多少毫秒」，本地自己往下走 —— 用绝对时间的话，
 * 手机跟服务器差几秒就会显示成负数或跳变。
 */
const stepLeftBase = ref(0);
let stepAnchor = 0;
const tickNow = ref(0);

watch(
  () => state.value?.nightStepLeftMs ?? 0,
  (left) => {
    stepLeftBase.value = left;
    stepAnchor = Date.now();
    tickNow.value = stepAnchor;
  },
);

const stepSecondsLeft = computed(() => {
  if (stepLeftBase.value <= 0) return 0;
  const elapsed = tickNow.value - stepAnchor;
  return Math.max(0, Math.ceil((stepLeftBase.value - elapsed) / 1000));
});

const pendingSeat = computed(() => state.value?.pending?.seat ?? null);
const speakingSeat = computed(() => streaming.value?.seat ?? null);

/** 狼队友是不是已经「碰过面」：狼人睁眼那一刻就算认识了，之前（准备 / 守卫）还不知道 */
const teammatesKnown = computed(() => {
  const current = state.value;
  if (!current) return false;
  if (current.day > 1) return true;
  return current.phase !== 'SETUP' && current.phase !== 'NIGHT_GUARD';
});

/** 已按视角裁剪过的事件 → 头像上的身份标记 */
const marks = computed(() => deriveMarks(events.value, { teammatesKnown: teammatesKnown.value }));

/** 服务端停下来等人确认的重大信息 → 一张卡片 */
const ackCard = computed(() => {
  const current = state.value;
  if (!current || current.ackSeq.length === 0) return null;
  const wanted = new Set(current.ackSeq);
  // 事件被裁掉（很久以前的老局）时给一张兜底卡，免得卡在「等确认」里出不来
  return buildAckCard(events.value.filter((event) => wanted.has(event.seq)));
});

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
    // 夜里那一步也是公开流程：四步永远都走、步长固定，所以「第 2/4 步 · 狼人行动」人人可看
    if (current.phase === 'GAME_OVER') return;
    const item = FLASHES[phase];
    if (!item) return;
    const text = isNightPhase(phase) ? nightStepLabel(phase) : item.text;
    flash.value = { key: `${current.gameId}-${current.lastSeq}-${phase}`, ...item, text };
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

      <!-- 昼夜在流程提示上也要一眼看得出：白天太阳、夜里月亮，配色跟着换 -->
      <span v-if="state" class="chip phase" :class="{ night: night }">
        {{ night ? '🌙' : '☀' }} 第 {{ state.day }} 天 · {{ phaseLabel }}
      </span>
      <span v-if="stepSecondsLeft > 0" class="chip step" title="这一步的固定倒计时：到点就换下一步，与有没有人行动无关">
        ⏳ {{ stepSecondsLeft }}s
      </span>
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

    <!-- 重大信息卡片：服务端停着等这一下，点了才会继续推进 -->
    <InfoCard v-if="ackCard" :card="ackCard" @confirm="resume()" />

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

/*
 * 昼夜底色做两层叠着淡入淡出，比切换 background-image 平滑。
 * 白天/夜晚要**一眼分得出**（参考网易那版：同一间屋子，白天有斜进来的天光、夜里是月光和星点）。
 * 底子仍然偏暗 —— 面板、站位卡都是暗底的，背景一白就全糊了。
 */
.bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  transition: opacity 1.4s ease;
}

.bg-night {
  background:
    radial-gradient(circle at 19% 7%, rgba(222, 232, 255, 0.2) 0%, rgba(147, 164, 255, 0.07) 18%, transparent 40%),
    radial-gradient(1.6px 1.6px at 12% 15%, rgba(255, 255, 255, 0.7), transparent 100%),
    radial-gradient(1.3px 1.3px at 30% 8%, rgba(255, 255, 255, 0.5), transparent 100%),
    radial-gradient(1.7px 1.7px at 46% 21%, rgba(255, 255, 255, 0.55), transparent 100%),
    radial-gradient(1.2px 1.2px at 62% 10%, rgba(255, 255, 255, 0.45), transparent 100%),
    radial-gradient(1.5px 1.5px at 85% 19%, rgba(255, 255, 255, 0.5), transparent 100%),
    radial-gradient(1.3px 1.3px at 72% 30%, rgba(255, 255, 255, 0.35), transparent 100%),
    linear-gradient(180deg, #0a0f1a 0%, #05070c 100%);
}

.bg-day {
  background:
    radial-gradient(circle at 76% 6%, rgba(255, 216, 156, 0.28) 0%, rgba(255, 196, 120, 0.11) 20%, transparent 44%),
    repeating-linear-gradient(104deg, rgba(255, 226, 176, 0.05) 0 2px, transparent 2px 26px),
    linear-gradient(180deg, #2b3a55 0%, #1a2434 54%, #0f1622 100%);
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

/* 夜里换成月光色，跟白天一眼分得开 */
.chip.phase.night {
  background: rgba(147, 164, 255, 0.12);
  border-color: rgba(147, 164, 255, 0.5);
  color: #b3c0ff;
}

.chip.mine {
  background: rgba(88, 211, 166, 0.12);
  border-color: rgba(88, 211, 166, 0.42);
  color: var(--jade);
}

/* 夜间那一步的固定倒计时 */
.chip.step {
  background: rgba(147, 164, 255, 0.14);
  border-color: rgba(147, 164, 255, 0.5);
  color: #b3c0ff;
  font-variant-numeric: tabular-nums;
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
