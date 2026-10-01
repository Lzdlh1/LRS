<script setup lang="ts">
import { ROLE_LABELS, type Camp, type Role } from '@lrs/shared';
import { computed } from 'vue';
import { faceStyle } from '../faces';

/**
 * 终局结算卡。
 *
 * game_over 事件里带的亮底牌（reveal）此前只在日志里滚过一行字，
 * 打完一局的人最想看的就是「大家到底都是谁」—— 所以给它一个正经的收尾场面：
 * 胜负横幅 + 全员底牌墙，再加上去路（复盘 / 新开一局 / 回去看现场）。
 */
const props = defineProps<{
  winner: Camp;
  /** 亮底牌：座位 → 角色（来自 game_over 事件，公开信息） */
  reveal: { seat: number; role: Role }[];
  /** 座位表：名字、存活、警长标记都从这里取 */
  seats: { seat: number; name: string; alive: boolean; isChief: boolean }[];
  humanSeat: number;
  /** 打了几天 */
  days: number;
}>();

const emit = defineEmits<{ replay: []; newGame: []; dismiss: [] }>();

interface Row {
  seat: number;
  name: string;
  role: Role | null;
  alive: boolean;
  isChief: boolean;
  isHuman: boolean;
  wolf: boolean;
}

/** 按座位号对齐 seats 与 reveal，没拿到角色的（不该发生）兜底为 null */
const rows = computed<Row[]>(() => {
  const revealMap = new Map(props.reveal.map((item) => [item.seat, item.role]));
  return props.seats.map((seat) => {
    const role = revealMap.get(seat.seat) ?? null;
    return {
      seat: seat.seat,
      name: seat.name,
      role,
      alive: seat.alive,
      isChief: seat.isChief,
      isHuman: seat.seat === props.humanSeat,
      wolf: role === 'werewolf',
    };
  });
});

const wolfWin = computed(() => props.winner === 'wolf');
</script>

<template>
  <div class="mask" @click.self="emit('dismiss')">
    <div class="card" :class="wolfWin ? 'wolf' : 'good'">
      <div class="banner">
        <div class="result">{{ wolfWin ? '狼人阵营获胜' : '好人阵营获胜' }}</div>
        <div class="sub">第 {{ days }} 天终局</div>
      </div>

      <!-- 底牌墙：立绘圆 + 位次 + 身份；出局压暗，警长与人类玩家各有标记 -->
      <div class="grid">
        <div
          v-for="row in rows"
          :key="row.seat"
          class="cell"
          :class="{ dead: !row.alive, wolf: row.wolf, me: row.isHuman }"
        >
          <span class="avatar">
            <i v-if="row.role" class="face" :style="faceStyle(row.role)" />
            <span v-else class="unk">?</span>
            <span v-if="row.isChief" class="chief" title="警长">🎖</span>
            <span v-if="row.isHuman" class="me" title="这是你">我</span>
          </span>
          <span class="seat">{{ row.seat }} 号</span>
          <span class="role" :class="{ unknown: row.role === null }">
            {{ row.role ? ROLE_LABELS[row.role] : '未知' }}
          </span>
        </div>
      </div>

      <div class="actions">
        <button class="primary" @click="emit('newGame')">新开一局</button>
        <button @click="emit('replay')">复盘</button>
        <button class="ghost" @click="emit('dismiss')">看看现场</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  /* 压在看牌卡(94)之下、普通面板之上：开局与终局不会同屏，无需更高 */
  z-index: 93;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(3, 5, 10, 0.78);
  backdrop-filter: blur(4px);
  animation: mask-in 0.24s ease;
}

@keyframes mask-in {
  from {
    opacity: 0;
  }
}

.card {
  width: min(430px, 92vw);
  max-height: 92dvh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 18px 16px 16px;
  border-radius: 5px;
  background: #efe6d2;
  border: 3px solid #16263f;
  box-shadow: 0 26px 80px rgba(0, 0, 0, 0.78);
  animation: card-in 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.15);
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.92);
  }
}

.banner {
  text-align: center;
}

.result {
  font-family: var(--font-display);
  font-size: 27px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-indent: 0.2em;
  color: #23604d;
}

.card.wolf .result {
  color: #a32b22;
}

.sub {
  margin-top: 2px;
  font-size: 12px;
  letter-spacing: 0.12em;
  color: #5d6675;
}

.grid {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 9px 6px;
}

.cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 7px 2px 6px;
  border-radius: 3px;
  background: #e5d9be;
  border: 1.5px solid #46586e;
  animation: cell-in 0.3s ease backwards;
}

/* 底牌墙逐个翻开：按格子序错位入场，比一整面同时砸下来有「翻牌」感 */
.cell:nth-child(3n + 1) { animation-delay: 0.05s; }
.cell:nth-child(3n + 2) { animation-delay: 0.1s; }
.cell:nth-child(3n + 3) { animation-delay: 0.15s; }

@keyframes cell-in {
  from {
    opacity: 0;
    transform: translateY(8px) rotateY(24deg);
  }
}

.cell.wolf {
  border-color: #b8342a;
}

.cell.dead .avatar {
  filter: grayscale(0.7) brightness(0.72);
}

.cell.dead .role,
.cell.dead .seat {
  color: #8a7f6d;
}

.avatar {
  position: relative;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  overflow: hidden;
  background: #16263f;
  border: 1.5px solid #16263f;
}

.cell.wolf .avatar {
  border-color: #b8342a;
}

.cell.me .avatar {
  border-color: #2f6a58;
  box-shadow: 0 0 0 2px rgba(47, 106, 88, 0.3);
}

.face {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
}

.unk {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #efe6d2;
  font-weight: 700;
}

.chief {
  position: absolute;
  right: -4px;
  top: -4px;
  z-index: 2;
  font-size: 12px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}

.me {
  position: absolute;
  left: -4px;
  top: -4px;
  z-index: 2;
  min-width: 16px;
  height: 16px;
  line-height: 12px;
  border-radius: 2px;
  background: #2f6a58;
  border: 1.5px solid #16263f;
  color: #efe6d2;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}

.seat {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: #5d6675;
}

.role {
  font-size: 12.5px;
  font-weight: 700;
  color: #16263f;
}

.cell.wolf .role {
  color: #a32b22;
}

.role.unknown {
  color: #8a7f6d;
  font-weight: 400;
}

.actions {
  width: 100%;
  display: flex;
  gap: 8px;
}

.actions button {
  flex: 1;
  border-radius: 2px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.actions .primary {
  border: none;
  background: #16263f;
  color: #efe6d2;
}

.actions .primary:hover {
  background: #22385a;
}

.actions .ghost {
  background: transparent;
  border-color: #46586e;
  color: #46586e;
}
</style>
