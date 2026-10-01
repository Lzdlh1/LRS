<script setup lang="ts">
import { choicesFor, type ActionChoice } from '@lrs/core-engine';
import { ROLE_LABELS, type Action, type Phase } from '@lrs/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ActionPanel from './components/ActionPanel.vue';
import EventLog from './components/EventLog.vue';
import GameOverOverlay from './components/GameOverOverlay.vue';
import InfoCard from './components/InfoCard.vue';
import ReplayPanel from './components/ReplayPanel.vue';
import RoleCard from './components/RoleCard.vue';
import SeatColumn from './components/SeatColumn.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StageOverlay from './components/StageOverlay.vue';
import UsagePanel from './components/UsagePanel.vue';
import VoteMap from './components/VoteMap.vue';
import { formatEvent, buildAckCard, type EventLine } from './format';
import { faceStyle } from './faces';
import {
  isNightPhase,
  nightStepLabel,
  NIGHT_STEP_NAMES,
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

/**
 * 开局看牌。
 *
 * 只做一件客户端自己的事：本局第一次拿到自己的角色时，把立绘摆出来给人看一眼。
 * 每局只弹一次（记 gameId），点了「知道了」就不再打扰 —— 不加服务端闸门，
 * 因为这里没有任何东西需要等服务端确认，硬塞进 ack 机制反而会把对局卡住。
 * 已确认的局号写进 sessionStorage：刷新页面后不会再被同一张牌糊一脸。
 */
const roleCardOpen = ref(false);
const ROLE_CARD_KEY = 'lrs:role-card-seen';

function roleCardSeen(gameId: string): boolean {
  try {
    return sessionStorage.getItem(ROLE_CARD_KEY) === gameId;
  } catch {
    return false;
  }
}

watch([myRole, () => state.value?.gameId], ([role, gameId]) => {
  if (!role || !gameId || roleCardSeen(gameId)) return;
  roleCardOpen.value = true;
});

function closeRoleCard(): void {
  try {
    sessionStorage.setItem(ROLE_CARD_KEY, state.value?.gameId ?? '');
  } catch {
    // 隐私模式下存不进就算了 —— 代价只是下次刷新再看一眼牌
  }
  roleCardOpen.value = false;
}

/** 流程提示：夜里写明是第几步、谁在行动（四步永远都走，写出来不泄漏谁还活着） */
const phaseLabel = computed(() => {
  const current = state.value;
  if (!current) return '';
  if (isNightPhase(current.phase)) {
    return `夜晚 · ${NIGHT_STEP_NAMES[current.phase] ?? ''}`;
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

/**
 * 真人这一手的倒计时。
 *
 * 与夜间节拍同一个套路：服务端给的 deadlineMs 是相对时长，本地锚定收到那一刻，
 * 之后靠 500ms 心跳自己往下走 —— 不等服务端每秒推一次，省消息也避免跳变。
 * 新待办的 identity 用 deadlineAt：每次派发都不同，拿它当「换了一手」的信号。
 */
const actionLeftBase = ref(0);
const actionTotalMs = ref(0);
let actionAnchor = 0;

watch(
  () => state.value?.pending?.deadlineAt ?? 0,
  (deadlineAt) => {
    const pending = state.value?.pending;
    if (!pending || deadlineAt === 0 || pending.seat !== humanSeat.value) {
      actionLeftBase.value = 0;
      actionTotalMs.value = 0;
      return;
    }
    actionLeftBase.value = pending.deadlineMs;
    actionTotalMs.value = pending.deadlineMs;
    actionAnchor = Date.now();
  },
);

const actionLeftMs = computed(() => {
  if (actionLeftBase.value <= 0) return null;
  const elapsed = tickNow.value - actionAnchor;
  return Math.max(0, actionLeftBase.value - elapsed);
});

const pendingSeat = computed(() => state.value?.pending?.seat ?? null);
const speakingSeat = computed(() => streaming.value?.seat ?? null);

/**
 * 各席位最近一次发言的用时（秒），来自 spoke 事件上的 ms。
 * 服务端测的是「发起生成/下发待办 → 说完」的墙钟，所以这里只是换算与展示，不做任何推断。
 */
const spokeSeconds = computed(() => {
  const out: Record<number, number> = {};
  for (const event of events.value) {
    if (event.payload.t === 'spoke' && typeof event.payload.ms === 'number') {
      out[event.payload.seat] = Math.max(1, Math.round(event.payload.ms / 1000));
    }
  }
  return out;
});

/** 投票阶段才画票型图，别的时候不占地方 */
const VOTE_PHASES: Phase[] = ['CHIEF_VOTE', 'CHIEF_PK_VOTE', 'DAY_VOTE', 'DAY_PK_VOTE'];

/** 有人说话的阶段：气泡只在这些阶段里挂着，进夜/投票就摘掉 */
const SPEECH_PHASES: ReadonlySet<Phase> = new Set([
  'CHIEF_SPEECH',
  'CHIEF_PK_SPEECH',
  'DAY_SPEECH',
  'DAY_PK_SPEECH',
  'LAST_WORDS',
]);

/**
 * 座位旁的发言气泡。
 *
 * 打字机还在吐字时跟着 streaming 走；落地成 spoke 事件后留在原座位上，
 * 直到下一个发言者接管或离开发言阶段 —— 让人不用盯着中间日志也知道谁在说话。
 */
const lastSpoke = ref<{ seat: number; text: string } | null>(null);
/** 已处理到哪条 spoke 的 seq：事件数组每来一条新消息都会整体重建，拿游标跳过旧事件 */
let lastSpokeSeq = 0;

watch(
  () => events.value,
  (list) => {
    for (const event of list) {
      if (event.payload.t !== 'spoke' || event.seq <= lastSpokeSeq) continue;
      lastSpokeSeq = event.seq;
      lastSpoke.value = { seat: event.payload.seat, text: event.payload.text };
    }
  },
);

// 换局/重连后游标归零，免得把上一局的发言带到这一局的气泡里
watch(
  () => state.value?.gameId,
  () => {
    lastSpokeSeq = 0;
    lastSpoke.value = null;
  },
);

// 离开发言阶段就摘气泡：夜里飘着一个白天的气泡很出戏
watch(
  () => state.value?.phase,
  (phase) => {
    if (!phase || !SPEECH_PHASES.has(phase)) lastSpoke.value = null;
  },
);

const bubble = computed(() => {
  const current = state.value;
  if (!current || !SPEECH_PHASES.has(current.phase)) return null;
  const live = streaming.value;
  if (live) {
    return {
      seat: live.seat,
      text: live.text.replace(/\s*\n+\s*/g, ' '),
      live: !live.done,
    };
  }
  if (lastSpoke.value) return { ...lastSpoke.value, live: false };
  return null;
});

/**
 * 本轮票型。`voted` 事件是公开的（谁投给谁本来就会念出来），
 * 这里只按「当天」筛出来，不做任何推断。
 */
const votePairs = computed(() => {
  const day = state.value?.day ?? -1;
  const out: { seat: number; target: number | 'abstain' }[] = [];
  for (const event of events.value) {
    if (event.day !== day) continue;
    if (event.payload.t === 'voted') out.push({ seat: event.payload.seat, target: event.payload.target });
  }
  return out;
});

const showVoteMap = computed(
  () => Boolean(state.value) && VOTE_PHASES.includes(state.value!.phase) && votePairs.value.length > 0,
);

/** 终局数据：game_over 事件一出来就弹出结算卡 */
const gameOverPayload = computed(() => {
  if (!state.value || state.value.winner === null) return null;
  // 从已收事件里抓最后一条 game_over（只可能有一条）
  for (let i = events.value.length - 1; i >= 0; i -= 1) {
    const ev = events.value[i]!;
    if (ev.payload.t === 'game_over') {
      return {
        winner: ev.payload.winner,
        reveal: ev.payload.reveal,
        seats: state.value.seats.map((s) => ({
          seat: s.seat,
          name: s.name,
          alive: s.alive,
          isChief: s.isChief,
        })),
        humanSeat: state.value.humanSeat,
        days: state.value.day,
      };
    }
  }
  return null;
});
/** 手动关掉结算卡后不再自动弹（点了「看看现场」时有用） */
const gameOverDismissed = ref(false);
watch(() => state.value?.gameId, () => { gameOverDismissed.value = false; });

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
      <!-- 底牌：自己的身份做成一张米纸小卡，左边是自己的立绘（只有自己看得到，不会泄漏） -->
      <span v-if="myRole && !godView" class="chip mine">
        <span class="mine-face">
          <i :style="faceStyle(myRole)" />
        </span>
        {{ humanSeat }} 号 · {{ ROLE_LABELS[myRole] }}
      </span>

      <span v-if="state?.stopped" class="chip aborted">已中止</span>
      <span v-else-if="state?.paused" class="chip paused">⏸ 已暂停</span>

      <span class="spacer" />
      <span class="conn" :class="{ ok: connected }">{{ connected ? '已连接' : '未连接' }}</span>

      <!-- 终局结算卡关掉之后想再看一眼的入口 -->
      <button
        v-if="gameOverPayload && gameOverDismissed"
        class="ghost tiny"
        title="再看一眼终局结算"
        @click="gameOverDismissed = false"
      >
        结果
      </button>

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
        side="left"
        :seats="leftSeats"
        :marks="marks"
        :targets="targetLabels"
        :pending-seat="pendingSeat"
        :speaking-seat="speakingSeat"
        :spoke-seconds="spokeSeconds"
        :human-seat="humanSeat"
        :bubble="bubble"
        @pick="pickSeat"
      />

      <div class="center">
        <VoteMap v-if="showVoteMap" :seats="state!.seats" :votes="votePairs" />
        <EventLog :lines="lines" :streaming="streaming" />
        <ActionPanel
          :state="state"
          :connected="connected"
          :error="lastError"
          :action-left-ms="actionLeftMs"
          :action-total-ms="actionTotalMs"
          @send="submit"
        />
      </div>

      <SeatColumn
        side="right"
        :seats="rightSeats"
        :marks="marks"
        :targets="targetLabels"
        :pending-seat="pendingSeat"
        :speaking-seat="speakingSeat"
        :spoke-seconds="spokeSeconds"
        :human-seat="humanSeat"
        :bubble="bubble"
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

    <!-- 开局看牌：自己的立绘。纯客户端，每局一次，不拦对局 -->
    <RoleCard v-if="roleCardOpen && myRole" :seat="humanSeat" :role="myRole" @confirm="closeRoleCard" />

    <!-- 终局结算：胜负横幅 + 亮底牌，点掉后才回到现场 -->
    <GameOverOverlay
      v-if="gameOverPayload && !gameOverDismissed"
      :winner="gameOverPayload.winner"
      :reveal="gameOverPayload.reveal"
      :seats="gameOverPayload.seats"
      :human-seat="gameOverPayload.humanSeat"
      :days="gameOverPayload.days"
      @dismiss="gameOverDismissed = true"
      @replay="openReplay()"
      @new-game="newGame"
    />

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
 * 图是 AI 生的漫画场景（狼在月光松林里 / 白天的村子），上面压一层深色纱 ——
 * 纱是必须的：面板、站位卡都是暗底的，背景一亮就全糊了。
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
    linear-gradient(180deg, rgba(4, 7, 12, 0.94) 0%, rgba(4, 7, 12, 0.74) 46%, rgba(4, 7, 12, 0.5) 100%),
    url('/art/scenes/night.jpg') center bottom / cover no-repeat;
}

.bg-day {
  background:
    linear-gradient(180deg, rgba(6, 10, 16, 0.92) 0%, rgba(6, 10, 16, 0.72) 46%, rgba(6, 10, 16, 0.48) 100%),
    url('/art/scenes/day.jpg') center bottom / cover no-repeat;
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
  background: var(--surface-bar);
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
  background: var(--surface-chip);
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

/* 底牌：米纸小卡 + 自己的立绘。立绘是全身方图，放大到 210% 贴顶，只露头肩 */
.chip.mine {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 9px 1px 3px;
  border-radius: 3px;
  border-width: 2px;
  background: #efe6d2;
  border-color: #16263f;
  color: #16263f;
  font-weight: 700;
}

.chip.mine .mine-face {
  position: relative;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  overflow: hidden;
  background: #16263f;
}

.chip.mine .mine-face i {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
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
