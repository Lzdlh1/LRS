<script setup lang="ts">
import type { ClientState } from '@lrs/server/protocol';
import { ROLE_GLYPHS } from '../labels';
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
  humanSeat: number;
}>();

const emit = defineEmits<{ pick: [seat: number] }>();

function markOf(seat: number): SeatMark | undefined {
  return props.marks[seat];
}

function pickable(seat: number): boolean {
  return (props.targets[seat]?.length ?? 0) > 0;
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
        <span class="avatar">
          <span class="num">{{ item.seat }}</span>
          <span v-if="!item.alive" class="cross">✕</span>
        </span>
        <span v-if="item.role" class="glyph" :title="`身份：${ROLE_GLYPHS[item.role]}`">
          {{ ROLE_GLYPHS[item.role] }}
        </span>
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

      <span class="name">{{ item.name }}</span>
      <span v-if="pickable(item.seat)" class="say">{{ targets[item.seat]?.[0] }}</span>
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

/* 身份角标：上帝视角或本人看得到 */
.glyph {
  position: absolute;
  left: -2px;
  top: -2px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: rgba(10, 13, 20, 0.9);
  border: 1px solid var(--accent-dim);
  color: var(--accent);
  font-size: 10px;
  line-height: 13px;
  text-align: center;
}

.chief-mark {
  position: absolute;
  right: -3px;
  top: -4px;
  font-size: 12px;
  line-height: 1;
  filter: drop-shadow(0 0 3px rgba(217, 178, 106, 0.6));
}

/* 已知阵营：压在头像下沿，字号给足 */
.mark {
  position: absolute;
  left: 50%;
  bottom: -5px;
  transform: translateX(-50%);
  padding: 0 6px;
  min-width: 22px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  white-space: nowrap;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}

.mark.wolf {
  background: #4a1c1c;
  border: 1px solid var(--blood);
  color: #ffb4ae;
}

.mark.good {
  background: #123a2c;
  border: 1px solid var(--jade);
  color: #9ff0cd;
}

.note {
  position: absolute;
  right: -4px;
  bottom: -4px;
  font-size: 11px;
  line-height: 1;
  filter: drop-shadow(0 0 3px rgba(0, 0, 0, 0.8));
}

.cross {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: calc(var(--avatar) * 0.62);
  color: rgba(210, 85, 74, 0.9);
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
</style>
