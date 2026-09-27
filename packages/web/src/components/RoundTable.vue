<script setup lang="ts">
import type { Role } from '@lrs/shared';
import { ROLE_LABELS } from '@lrs/shared';
import type { ClientState } from '@lrs/server/protocol';
import { computed } from 'vue';
import { PHASE_LABELS } from '../labels';

const props = defineProps<{
  state: ClientState | null;
  latest: { seat: number; text: string } | null;
}>();

const SEAT_SIZE = 46;
const RADIUS = 178;
const CENTER = 230;

const placed = computed(() => {
  const seats = props.state?.seats ?? [];
  const total = seats.length || 9;
  return seats.map((seat, index) => {
    const angle = ((-90 + (index * 360) / total) * Math.PI) / 180;
    return {
      ...seat,
      left: CENTER + RADIUS * Math.cos(angle) - SEAT_SIZE / 2,
      top: CENTER + RADIUS * Math.sin(angle) - SEAT_SIZE / 2,
    };
  });
});

const pendingSeat = computed(() => props.state?.pending?.seat ?? null);

const roleBadge = (role: Role | null): string => (role ? ROLE_LABELS[role] : '?');
</script>

<template>
  <div class="table-wrap">
    <div class="table">
      <div class="stage">
        <div class="stage-title">{{ state ? PHASE_LABELS[state.phase] : '连接中…' }}</div>
        <template v-if="state?.winner">
          <div class="stage-big" :class="state.winner === 'wolf' ? 'wolf' : 'good'">
            {{ state.winner === 'wolf' ? '狼人胜' : '好人胜' }}
          </div>
        </template>
        <template v-else-if="state?.pending">
          <div class="stage-big">等待 {{ state.pending.seat }} 号</div>
          <div class="stage-sub">
            {{ state.pending.options[0]?.label ?? '行动中（非你的视角）' }}
          </div>
        </template>
        <template v-else>
          <div class="stage-sub">结算中…</div>
        </template>

        <div v-if="latest" class="stage-speech">
          <b>{{ latest.seat }} 号</b>：{{ latest.text }}
        </div>
      </div>

      <div
        v-for="item in placed"
        :key="item.seat"
        class="seat"
        :class="{
          pending: item.seat === pendingSeat,
          dead: !item.alive,
          me: state?.viewer === item.seat,
          chief: item.isChief,
        }"
        :style="{ left: `${item.left}px`, top: `${item.top}px`, width: `${SEAT_SIZE}px`, height: `${SEAT_SIZE}px` }"
      >
        <span class="num">{{ item.seat }}</span>
        <span v-if="!item.alive" class="cross">✕</span>
        <span v-if="item.isChief" class="badge chief-badge">🎖</span>
      </div>

      <div
        v-for="item in placed"
        :key="`label-${item.seat}`"
        class="seat-label"
        :class="{ dead: !item.alive }"
        :style="{ left: `${item.left}px`, top: `${item.top + SEAT_SIZE + 2}px`, width: `${SEAT_SIZE}px` }"
      >
        {{ item.name }}<template v-if="item.role"> · {{ roleBadge(item.role) }}</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-wrap {
  /* 视口矮的时候整体等比缩小，避免圆桌把底部操作区挤出屏幕 */
  --scale: 1;
  flex: none;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  width: calc(460px * var(--scale));
  height: calc(480px * var(--scale));
}

.table {
  position: relative;
  width: 460px;
  height: 480px;
  transform: scale(var(--scale));
  transform-origin: top left;
}

@media (max-height: 900px) {
  .table-wrap {
    --scale: 0.9;
  }
}

@media (max-height: 800px) {
  .table-wrap {
    --scale: 0.78;
  }
}

@media (max-height: 700px) {
  .table-wrap {
    --scale: 0.66;
  }
}

@media (max-height: 600px) {
  .table-wrap {
    --scale: 0.55;
  }
}

.stage {
  position: absolute;
  left: 130px;
  top: 140px;
  width: 200px;
  height: 200px;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, #232a3d 0%, #151824 100%);
  border: 1px solid #3a4260;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 18px;
  gap: 4px;
}

.stage-title {
  font-size: 11px;
  color: var(--text-dim);
}

.stage-big {
  font-size: 16px;
  font-weight: 700;
  color: #fff;
}

.stage-big.wolf {
  color: var(--wolf);
}

.stage-big.good {
  color: var(--good);
}

.stage-sub {
  font-size: 11px;
  color: var(--text-dim);
}

.stage-speech {
  font-size: 10px;
  color: #aab3c9;
  margin-top: 4px;
  max-height: 58px;
  overflow: hidden;
}

.seat {
  position: absolute;
  border-radius: 50%;
  background: #2a3146;
  border: 1px solid #444c63;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  transition: all 0.15s ease;
}

.seat.me {
  border-color: var(--good);
  background: #243b32;
}

.seat.pending {
  border-color: var(--accent);
  background: #3a4568;
  box-shadow: 0 0 0 4px rgba(124, 140, 255, 0.18);
}

.seat.dead {
  background: #241b1b;
  border-color: #5b3a3a;
  color: #8a6464;
}

.seat.chief {
  border-color: var(--warn);
}

.cross {
  position: absolute;
  font-size: 20px;
  color: #c05a5a;
}

.badge {
  position: absolute;
  right: -3px;
  top: -3px;
  font-size: 11px;
}

.seat-label {
  position: absolute;
  font-size: 9px;
  color: var(--text-dim);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.seat-label.dead {
  color: #7a5a5a;
}
</style>
