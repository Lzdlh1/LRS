<script setup lang="ts">
import { computed } from 'vue';

/**
 * 票型图。
 *
 * 不画跨列连线（左右两列之间的连线在手机上会糊成一团），改成自带一张小图：
 * 座位横排一行，每张票一条弧线箭头，弃票单独画一竖。
 * 木刻那套：米纸号码格 + 墨蓝描边，票是朱砂。数据来自公开的 `voted` 事件。
 */
const props = defineProps<{
  seats: { seat: number; alive: boolean }[];
  votes: { seat: number; target: number | 'abstain' }[];
}>();

const CHIP = 26;
const GAP = 5;
const PAD = 9;
const BASE = 44;

const width = computed(() => PAD * 2 + props.seats.length * CHIP + Math.max(0, props.seats.length - 1) * GAP);
const height = 74;

function xOf(seat: number): number {
  const index = props.seats.findIndex((item) => item.seat === seat);
  return PAD + index * (CHIP + GAP) + CHIP / 2;
}

/** 同一个目标被投多次时，后一支箭抬得更高，免得叠在一条线上 */
const arrows = computed(() => {
  const stacked = new Map<number, number>();
  const out: { d: string; headX: number }[] = [];
  for (const vote of props.votes) {
    if (vote.target === 'abstain' || vote.target === vote.seat) continue;
    const nth = stacked.get(vote.target) ?? 0;
    stacked.set(vote.target, nth + 1);
    const x1 = xOf(vote.seat);
    const x2 = xOf(vote.target);
    const bow = Math.min(10 + nth * 9, 30);
    const cx = (x1 + x2) / 2;
    out.push({ d: `M ${x1} ${BASE} Q ${cx} ${BASE - bow * 2} ${x2} ${BASE}`, headX: x2 });
  }
  return out;
});

const abstains = computed(() =>
  props.votes.filter((vote) => vote.target === 'abstain').map((vote) => xOf(vote.seat)),
);

/** 被投到的座位描朱砂边，一眼看出火力在哪 */
const targeted = computed(
  () => new Set(props.votes.map((vote) => vote.target).filter((t): t is number => t !== 'abstain')),
);
</script>

<template>
  <svg
    class="vote-map"
    :viewBox="`0 0 ${width} ${height}`"
    :style="{ maxWidth: `${width}px` }"
    role="img"
    aria-label="本轮票型"
  >
    <path
      v-for="(arrow, index) in arrows"
      :key="`a${index}`"
      :d="arrow.d"
      class="arrow-draw"
      fill="none"
      stroke="#b8342a"
      stroke-width="1.8"
      stroke-linecap="round"
      pathLength="1"
      :style="{ animationDelay: `${index * 70}ms` }"
    />
    <polygon
      v-for="(arrow, index) in arrows"
      :key="`h${index}`"
      :points="`${arrow.headX - 3.6},${BASE - 7} ${arrow.headX + 3.6},${BASE - 7} ${arrow.headX},${BASE - 1}`"
      class="arrow-head"
      fill="#b8342a"
      :style="{ animationDelay: `${index * 70 + 120}ms` }"
    />

    <g v-for="(x, index) in abstains" :key="`s${index}`" class="abstain" :style="{ animationDelay: `${index * 60}ms` }">
      <path :d="`M ${x} ${BASE} v -13`" stroke="#6b7a99" stroke-width="1.6" fill="none" />
      <text :x="x" :y="BASE - 16" text-anchor="middle" font-size="8" fill="#6b7a99">弃</text>
    </g>

    <g v-for="item in seats" :key="item.seat">
      <rect
        :x="xOf(item.seat) - CHIP / 2"
        :y="BASE"
        :width="CHIP"
        :height="CHIP"
        rx="2"
        :fill="item.alive ? '#efe6d2' : '#9a8f7d'"
        :stroke="targeted.has(item.seat) ? '#b8342a' : '#16263f'"
        stroke-width="2"
      />
      <text
        :x="xOf(item.seat)"
        :y="BASE + CHIP / 2 + 4"
        text-anchor="middle"
        font-size="12"
        font-weight="700"
        fill="#16263f"
      >
        {{ item.seat }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.vote-map {
  display: block;
  flex: none;
  width: 100%;
  margin: 0 auto;
  padding: 2px 0 4px;
  border-bottom: 1px solid var(--line);
}

/* 票一条条画出来：路径描边走一遍（pathLength=1 归一化，与弧线长短无关），箭头在描线到位后再冒出来 */
.arrow-draw {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw 0.5s ease forwards;
}

@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}

.arrow-head {
  opacity: 0;
  animation: head-in 0.2s ease forwards;
}

@keyframes head-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.abstain {
  opacity: 0;
  animation: head-in 0.25s ease forwards;
}
</style>
