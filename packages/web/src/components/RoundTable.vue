<script setup lang="ts">
import type { Role } from '@lrs/shared';
import type { ClientState } from '@lrs/server/protocol';
import { computed } from 'vue';
import { PHASE_LABELS, ROLE_GLYPHS } from '../labels';
import type { LiveSpeech } from '../ws';

const props = defineProps<{
  state: ClientState | null;
  latest: { seat: number; text: string } | null;
  streaming: LiveSpeech | null;
}>();

/** 座位环的半径，单位是圆桌边长的百分比 */
const RING = 36.5;

const placed = computed(() => {
  const seats = props.state?.seats ?? [];
  const total = seats.length || 9;
  return seats.map((seat, index) => {
    const angle = ((-90 + (index * 360) / total) * Math.PI) / 180;
    return {
      ...seat,
      index,
      left: `${50 + RING * Math.cos(angle)}%`,
      top: `${50 + RING * Math.sin(angle)}%`,
    };
  });
});

const pendingSeat = computed(() => props.state?.pending?.seat ?? null);

/** 待办落在 AI 身上时是「思考中」，落在真人身上才是「等待」 */
const pendingIsAi = computed(() => {
  const seat = pendingSeat.value;
  if (seat === null) return false;
  return props.state?.seats.find((item) => item.seat === seat)?.isHuman === false;
});

const stageTitle = computed(() => {
  if (!props.state) return '连接中…';
  return props.state.masked ? '夜晚' : PHASE_LABELS[props.state.phase];
});

/** 身份标记的颜色：狼是朱砂，神是月光，民压暗 */
function roleTone(role: Role | null): string {
  if (role === null) return 'unknown';
  if (role === 'werewolf') return 'wolf';
  if (role === 'villager') return 'villager';
  return 'god';
}
</script>

<template>
  <div class="table-wrap">
    <div class="table">
      <div class="felt" />
      <div class="glow" />

      <div class="stage">
        <div class="stage-title">{{ stageTitle }}</div>

        <template v-if="state?.winner">
          <div class="stage-big" :class="state.winner === 'wolf' ? 'wolf' : 'good'">
            {{ state.winner === 'wolf' ? '狼人胜' : '好人胜' }}
          </div>
        </template>

        <template v-else-if="state?.masked">
          <div class="stage-big">天黑请闭眼</div>
          <div class="stage-sub">夜里发生的事，天亮才知道</div>
        </template>

        <template v-else-if="streaming">
          <div class="stage-big">{{ streaming.seat }} 号发言中</div>
          <div class="dots"><i /><i /><i /></div>
        </template>

        <template v-else-if="state?.pending">
          <div class="stage-big">
            {{ pendingIsAi ? `${state.pending.seat} 号思考中` : `等待 ${state.pending.seat} 号` }}
          </div>
          <div class="stage-sub">
            {{ state.pending.options[0]?.label ?? '行动中（非你的视角）' }}
          </div>
        </template>

        <template v-else>
          <div class="stage-sub">结算中…</div>
        </template>

        <div v-if="latest && !streaming" class="stage-speech">
          <b>{{ latest.seat }} 号</b>{{ latest.text }}
        </div>
      </div>

      <div
        v-for="item in placed"
        :key="item.seat"
        class="seat"
        :class="{
          pending: item.seat === pendingSeat,
          speaking: item.seat === streaming?.seat,
          dead: !item.alive,
          me: state?.viewer === item.seat,
          chief: item.isChief,
        }"
        :style="{ left: item.left, top: item.top, '--i': item.index }"
      >
        <span class="num">{{ item.seat }}</span>
        <span class="who">{{ item.name }}</span>
        <span v-if="item.role" class="role" :class="roleTone(item.role)">
          {{ ROLE_GLYPHS[item.role] }}
        </span>
        <span v-if="item.isChief" class="role chief-mark">🎖</span>
        <span v-if="!item.alive" class="cross">✕</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-wrap {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/*
 * 整张桌子是一个正方形，所有尺寸都用容器查询单位（cqmin）推出来 ——
 * 换设备时不是「分档缩放」，而是连续变化，任何宽度下都不会有座位被裁掉。
 */
.table {
  position: relative;
  width: 100%;
  max-width: min(100%, 680px, calc(100dvh - 250px));
  aspect-ratio: 1;
  container-type: size;
  margin: 0 auto;
}

/* 桌面本体：一圈比座位环略大的暗盘 */
.felt {
  position: absolute;
  inset: 2.5%;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 34%, rgba(41, 54, 88, 0.55) 0%, rgba(12, 16, 25, 0.9) 62%),
    var(--ink-2);
  border: 1px solid rgba(78, 96, 148, 0.28);
  box-shadow:
    inset 0 0 8cqmin rgba(6, 9, 16, 0.85),
    0 2cqmin 6cqmin rgba(0, 0, 0, 0.5);
}

/* 桌子中央的月色，缓慢呼吸 */
.glow {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 74%;
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(147, 164, 255, 0.14) 0%, transparent 68%);
  animation: breathe 6.5s ease-in-out infinite;
  pointer-events: none;
}

@keyframes breathe {
  0%,
  100% {
    opacity: 0.55;
    transform: translate(-50%, -50%) scale(1);
  }
  50% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.06);
  }
}

.stage {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44%;
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle at 50% 36%, #1d2436 0%, #0d1119 100%);
  border: 1px solid rgba(88, 104, 160, 0.45);
  box-shadow:
    inset 0 0 5cqmin rgba(0, 0, 0, 0.6),
    0 0 7cqmin rgba(60, 80, 160, 0.18);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 0.8cqmin;
  padding: 6cqmin;
  overflow: hidden;
}

.stage-title {
  font-family: var(--font-display);
  font-size: 2.9cqmin;
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.stage-big {
  font-family: var(--font-display);
  font-size: 5.6cqmin;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #f2f4ff;
  text-shadow: 0 0 5cqmin rgba(147, 164, 255, 0.35);
  line-height: 1.25;
}

.stage-big.wolf {
  color: var(--blood);
  text-shadow: 0 0 5cqmin rgba(210, 85, 74, 0.4);
}

.stage-big.good {
  color: var(--jade);
  text-shadow: 0 0 5cqmin rgba(88, 211, 166, 0.35);
}

.stage-sub {
  font-size: 2.5cqmin;
  color: var(--text-dim);
  line-height: 1.45;
}

.stage-speech {
  max-width: 100%;
  margin-top: 0.8cqmin;
  font-size: 2.4cqmin;
  line-height: 1.5;
  color: #a9b3cc;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.stage-speech b {
  color: var(--accent);
  font-weight: 600;
  margin-right: 0.4em;
}

.seat {
  position: absolute;
  width: 13.5cqmin;
  height: 13.5cqmin;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: linear-gradient(180deg, #2b3348 0%, #1e2534 100%);
  border: 1px solid #465171;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  overflow: hidden;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;
  animation: seat-in 0.5s ease backwards;
  animation-delay: calc(var(--i) * 45ms);
}

@keyframes seat-in {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.7);
  }
}

.num {
  font-family: var(--font-mono);
  font-size: 4.4cqmin;
  font-weight: 700;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  color: #e7ebf7;
}

.who {
  max-width: 92%;
  font-size: 2.2cqmin;
  line-height: 1.2;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 身份角标：上帝视角或本人看得到 */
.role {
  position: absolute;
  right: 0.6cqmin;
  top: 0.6cqmin;
  font-size: 2.2cqmin;
  line-height: 1;
  padding: 0.5cqmin 0.9cqmin;
  border-radius: 3cqmin;
  background: rgba(10, 13, 20, 0.75);
  border: 1px solid currentColor;
}

.role.wolf {
  color: var(--blood);
}

.role.god {
  color: var(--accent);
}

.role.villager {
  color: var(--text-dim);
}

.chief-mark {
  right: auto;
  left: 0.6cqmin;
  border: none;
  background: transparent;
  font-size: 2.4cqmin;
  padding: 0;
}

.seat.me {
  border-color: var(--jade);
  background: linear-gradient(180deg, #24463a 0%, #1b3329 100%);
  box-shadow: 0 0 0 0.7cqmin rgba(88, 211, 166, 0.12);
}

.seat.chief {
  border-color: var(--gold);
}

.seat.pending {
  border-color: var(--accent);
  background: linear-gradient(180deg, #3a4677 0%, #2a3354 100%);
  box-shadow: 0 0 0 0.9cqmin rgba(147, 164, 255, 0.2);
}

.seat.speaking {
  border-color: #b3c0ff;
  animation: speaking 1.2s ease-in-out infinite;
}

@keyframes speaking {
  0%,
  100% {
    box-shadow: 0 0 0 0.8cqmin rgba(147, 164, 255, 0.16);
  }
  50% {
    box-shadow: 0 0 0 2.1cqmin rgba(147, 164, 255, 0.3);
  }
}

.seat.dead {
  background: linear-gradient(180deg, #2a1c1e 0%, #20161a 100%);
  border-color: #5b3a3a;
}

.seat.dead .num,
.seat.dead .who {
  color: #7d5a5a;
}

.cross {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 5.4cqmin;
  color: rgba(210, 85, 74, 0.85);
}

.dots {
  display: flex;
  gap: 1cqmin;
}

.dots i {
  width: 1.4cqmin;
  height: 1.4cqmin;
  border-radius: 50%;
  background: var(--accent);
  animation: dot 1.2s ease-in-out infinite;
}

.dots i:nth-child(2) {
  animation-delay: 0.15s;
}

.dots i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes dot {
  0%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(-0.5cqmin);
  }
}
</style>
