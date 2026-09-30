<script setup lang="ts">
import { computed } from 'vue';
import { ROLE_LABELS, type Role } from '@lrs/shared';
import { faceUrl } from '../faces';

/**
 * 开局看牌。
 *
 * 立绘是全身方图，塞进 44px 头像只能看出一团颜色，放在这里才是它的正常尺寸。
 * 数据只有「自己的位次 + 自己的角色」——都是本人本来就该知道的，不涉及任何隐藏信息。
 */
const props = defineProps<{ seat: number; role: Role }>();
const emit = defineEmits<{ confirm: [] }>();

const CAMP: Record<Role, string> = {
  werewolf: '狼人阵营',
  seer: '好人阵营',
  witch: '好人阵营',
  hunter: '好人阵营',
  guard: '好人阵营',
  villager: '好人阵营',
};

const camp = computed(() => CAMP[props.role]);
</script>

<template>
  <div class="mask" @click.self="emit('confirm')">
    <div class="card" :class="role === 'werewolf' ? 'wolf' : 'good'">
      <div class="art">
        <i
          class="face"
          :style="{ backgroundImage: faceUrl(role) }"
          :aria-label="ROLE_LABELS[role]"
        />
      </div>

      <div class="row">
        <span class="seat">{{ seat }} 号</span>
        <span class="camp">{{ camp }}</span>
      </div>
      <div class="role">{{ ROLE_LABELS[role] }}</div>

      <button class="primary confirm" @click="emit('confirm')">知道了</button>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  /* 压在 InfoCard(95) 之下：重大信息要等服务端，优先级更高 */
  z-index: 94;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(3, 5, 10, 0.8);
  backdrop-filter: blur(3px);
  animation: mask-in 0.2s ease;
}

@keyframes mask-in {
  from {
    opacity: 0;
  }
}

.card {
  width: min(320px, 86vw);
  max-height: 92dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 14px 14px 16px;
  border-radius: 5px;
  background: #efe6d2;
  border: 3px solid #16263f;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.75);
  animation: card-in 0.36s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.92);
  }
}

/* 立绘本来就是方的，给个正方形印版，铺满不裁切 */
.art {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 52dvh;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid rgba(22, 38, 63, 0.5);
  background: #16263f;
}

.art .face {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-size: cover;
  background-position: 50% 0;
}

.row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.seat {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: #5d6675;
  font-variant-numeric: tabular-nums;
}

.camp {
  padding: 1px 8px;
  border-radius: 2px;
  border: 2px solid #16263f;
  font-size: 11px;
  font-weight: 700;
  color: #efe6d2;
  background: #2f6a58;
}

.role {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-indent: 0.22em;
  color: #16263f;
}

.confirm {
  width: 100%;
  margin-top: 2px;
  border: none;
  border-radius: 2px;
  background: #16263f;
  color: #efe6d2;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-indent: 0.18em;
}

.confirm:hover {
  background: #22385a;
}

/* 狼人阵营翻成朱砂 */
.card.wolf .camp {
  background: #b8342a;
}

.card.wolf .role {
  color: #a32b22;
}
</style>
