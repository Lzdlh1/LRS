<script setup lang="ts">
import { ROLE_LABELS } from '@lrs/shared';
import type { ClientState } from '@lrs/server/protocol';
import { faceCrop, faceUrl } from '../faces';
import type { SeatMark } from '../marks';

type ClientSeat = ClientState['seats'][number];

const props = defineProps<{
  seats: ClientSeat[];
  /** 座位 → 已知情报（查验/队友/夜刀） */
  marks: Record<number, SeatMark>;
  /** 座位 → 可点的动作标签；长度大于 1 时点开菜单选 */
  targets: Record<number, string[]>;
  pendingSeat: number | null;
  speakingSeat: number | null;
  /** 座位 → 最近一次发言用时（秒），来自 spoke.ms */
  spokeSeconds: Record<number, number>;
  humanSeat: number;
}>();

const emit = defineEmits<{ pick: [seat: number] }>();

function markOf(seat: number): SeatMark | undefined {
  return props.marks[seat];
}

function pickable(seat: number): boolean {
  return (props.targets[seat]?.length ?? 0) > 0;
}

/** 自己那个座位显示底牌，不显示「玩家N」这种没有信息量的名字 */
function ownRoleText(item: ClientSeat): string {
  return item.role ? ROLE_LABELS[item.role] : '你的座位';
}
</script>

<template>
  <aside class="col">
    <!-- 用真 button：这样点得动，键盘 Tab + 回车也点得动 -->
    <button
      v-for="item in seats"
      :key="item.seat"
      type="button"
      class="seat"
      :class="{
        pending: item.seat === pendingSeat,
        speaking: item.seat === speakingSeat,
        dead: !item.alive,
        me: item.seat === humanSeat,
        chief: item.isChief,
        pickable: pickable(item.seat),
      }"
      :disabled="!pickable(item.seat)"
      :title="pickable(item.seat) ? `点这里：${targets[item.seat]?.[0]}` : `${item.seat} 号 ${item.name}`"
      @click="emit('pick', item.seat)"
    >
      <span class="head">
        <!--
          身份可见时（本人 / 上帝视角 / 终局）头像让给立绘。
          角色拿不到时一律退回号码 —— 所以这里不可能泄漏：
          item.role 本来就是服务端按可见性裁剪过的，null 就是真的看不到。
        -->
        <span class="avatar" :class="{ faced: Boolean(item.role) }" :title="item.role ? `身份：${ROLE_LABELS[item.role]}` : ''">
          <i
            v-if="item.role"
            class="face"
            :style="{ backgroundImage: faceUrl(item.role), backgroundPosition: faceCrop(item.role) }"
          />
          <span class="num">{{ item.seat }}</span>
        </span>
        <!-- 出局：盖一枚朱砂「出局」章。原来那个 ✕ 在小头像上几乎看不见 -->
        <span v-if="!item.alive" class="out-stamp">出局</span>
        <!-- 自己那个座位一眼要认得出来：不写「我」，就得回头翻日志数座位 -->
        <span v-if="item.seat === humanSeat" class="me-tag">我</span>
        <span v-if="item.isChief" class="chief-mark" title="警长">🎖</span>
        <!-- 身份标记压在头像上：给得大一点，手机上才看得清 -->
        <span
          v-if="markOf(item.seat)?.camp"
          class="mark"
          :class="markOf(item.seat)?.camp"
          :title="markOf(item.seat)?.from"
        >
          {{ markOf(item.seat)?.camp === 'wolf' ? '狼' : '好' }}
        </span>
        <span v-if="markOf(item.seat)?.note" class="note" :title="markOf(item.seat)?.note ?? ''">🗡</span>
      </span>

      <!-- 自己的底牌直接写在名字的位置上（「玩家N」这种名字没有信息量） -->
      <span class="name" :class="{ own: item.seat === humanSeat }">
        {{ item.seat === humanSeat ? ownRoleText(item) : item.name }}
      </span>
      <span v-if="pickable(item.seat)" class="say">{{ targets[item.seat]?.[0] }}</span>
      <!-- 能点的时候优先让位给「点这里」，否则显示上次发言用时 -->
      <span v-else-if="spokeSeconds[item.seat]" class="took" title="最近一次发言用时">
        用时 {{ spokeSeconds[item.seat] }}s
      </span>
    </button>
  </aside>
</template>

<style scoped>
/*
 * 站位列。九人局按 5 + 4 分到左右两侧，十二人局自然变成 6 + 6 ——
 * 数量由外面切好传进来，这里不关心一共几个座位。
 */
.col {
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  align-items: center;
  gap: 4px;
  width: var(--col-w);
  padding: 2px 0;
  /* 屏幕特别矮时的兜底：宁可让列自己滚，也不要座位被裁掉 */
  overflow-y: auto;
  scrollbar-width: none;
}

.col::-webkit-scrollbar {
  display: none;
}

.seat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 100%;
  min-width: 0;
  /* 覆掉全局 button 的底、边、内边距与 42px 最小高度 */
  min-height: 0;
  padding: 2px 0;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: default;
  transition: transform 0.15s ease;
}

/* 不能点的座位不该被全局 button:disabled 的 0.4 透明度压灰 */
.seat:disabled {
  opacity: 1;
}

.seat:hover:not(:disabled) {
  border: 0;
  color: inherit;
}

.head {
  position: relative;
  width: var(--avatar);
  height: var(--avatar);
  flex: none;
}

.avatar {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: linear-gradient(180deg, #2b3348 0%, #1e2534 100%);
  border: 1px solid #465171;
  display: grid;
  place-items: center;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    background 0.18s ease;
}

.num {
  font-family: var(--font-mono);
  font-size: calc(var(--avatar) * 0.42);
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #e7ebf7;
}

.name {
  max-width: 100%;
  font-size: 10.5px;
  line-height: 1.25;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * 已知身份时头像换成角色立绘。
 * 取景规则（放大与对位）在 ../faces.ts：立绘是全身方图，不放大就只能看出一团颜色；
 * 座位号压在胸口上，靠描边保证在浅色立绘上也能读。
 */
.avatar.faced {
  overflow: hidden;
}

.avatar .face {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-size: 340% auto;
  pointer-events: none;
}

.avatar.faced .num {
  position: relative;
  text-shadow:
    0 1px 4px rgba(0, 0, 0, 0.95),
    0 0 3px rgba(0, 0, 0, 0.85);
}

/* 自己的座位：实心青玉「我」牌，比边框加粗更认得出 */
.me-tag {
  position: absolute;
  left: -5px;
  top: -5px;
  min-width: 17px;
  height: 17px;
  line-height: 13px;
  padding: 0 4px;
  border-radius: 2px;
  background: #2f6a58;
  border: 2px solid #16263f;
  color: #efe6d2;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.65);
}

.name.own {
  color: var(--jade);
  font-weight: 700;
  font-size: 11px;
}

.chief-mark {
  position: absolute;
  right: -3px;
  top: -4px;
  font-size: 12px;
  line-height: 1;
  filter: drop-shadow(0 0 3px rgba(217, 178, 106, 0.6));
}

/* 已知阵营：压在头像下沿。木刻方角印 —— 狼是朱砂、好人是青玉 */
.mark {
  position: absolute;
  left: 50%;
  bottom: -5px;
  transform: translateX(-50%);
  padding: 0 6px;
  min-width: 22px;
  border-radius: 2px;
  border: 2px solid #16263f;
  font-size: 12px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  white-space: nowrap;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}

.mark.wolf {
  background: #b8342a;
  color: #efe6d2;
}

.mark.good {
  background: #2f6a58;
  color: #efe6d2;
}

.note {
  position: absolute;
  right: -4px;
  bottom: -4px;
  font-size: 11px;
  line-height: 1;
  filter: drop-shadow(0 0 3px rgba(0, 0, 0, 0.8));
}

/* 出局章：斜盖在头像上。小头像里那个 ✕ 根本看不清，改成两个字才读得出来 */
.out-stamp {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) rotate(-14deg);
  padding: 0 5px;
  border: 2px solid #b8342a;
  border-radius: 2px;
  background: rgba(8, 13, 24, 0.68);
  color: #e58379;
  font-size: 11px;
  font-weight: 700;
  line-height: 15px;
  letter-spacing: 0.06em;
  white-space: nowrap;
  pointer-events: none;
}

/* ── 状态 ── */

.seat.me .avatar {
  border-color: var(--jade);
  background: linear-gradient(180deg, #24463a 0%, #1b3329 100%);
  box-shadow: 0 0 0 2px rgba(88, 211, 166, 0.16);
}

.seat.chief .avatar {
  border-color: var(--gold);
}

.seat.pending .avatar {
  border-color: var(--accent);
  background: linear-gradient(180deg, #3a4677 0%, #2a3354 100%);
  box-shadow: 0 0 0 2px rgba(147, 164, 255, 0.22);
}

.seat.speaking .avatar {
  border-color: #b3c0ff;
  animation: speaking 1.2s ease-in-out infinite;
}

@keyframes speaking {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgba(147, 164, 255, 0.16);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(147, 164, 255, 0.28);
  }
}

.seat.dead .avatar {
  background: linear-gradient(180deg, #2a1c1e 0%, #20161a 100%);
  border-color: #5b3a3a;
}

.seat.dead .num,
.seat.dead .name {
  color: #7d5a5a;
}

/* 可以点：给一圈脉动的月光，手机上不用猜哪个能点 */
.seat.pickable {
  cursor: pointer;
}

.seat.pickable .avatar {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(147, 164, 255, 0.24);
  animation: pickable 1.6s ease-in-out infinite;
}

@keyframes pickable {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgba(147, 164, 255, 0.18);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(147, 164, 255, 0.34);
  }
}

.seat.pickable:active {
  transform: scale(0.94);
}

.say {
  max-width: 100%;
  font-size: 9.5px;
  line-height: 1.2;
  color: #b3c0ff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 发言用时：跟流程节奏有关，但要退到比「点这里」更弱的位置 */
.took {
  max-width: 100%;
  font-size: 9.5px;
  line-height: 1.2;
  color: #8b93a8;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
