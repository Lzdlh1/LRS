<script setup lang="ts">
import { computed } from 'vue';
import type { AckCard } from '../format';

/**
 * 「重大信息」卡片。
 *
 * 查验结果、死讯这类信息一出来局面就往前跳（预言家验人是夜里最后一步，
 * 紧接着就是天亮），所以服务端会停在那里等这张卡被点掉 —— 不是纯装饰。
 */
const props = defineProps<{ card: AckCard }>();
const emit = defineEmits<{ confirm: [] }>();

/** 徽记：代替立绘的位置，等真图到位再换 */
const emblem = computed(() => {
  const { kind, tone } = props.card;
  if (kind === 'seer') return tone === 'wolf' ? '🐺' : '🛡';
  if (kind === 'witch') return '🧪';
  if (kind === 'death') return '🕯';
  if (kind === 'shot') return '🔫';
  return '🃏';
});
</script>

<template>
  <div class="mask">
    <div class="card" :class="card.tone">
      <div class="art">
        <span class="emblem">{{ emblem }}</span>
      </div>

      <div class="title">{{ card.title }}</div>

      <ul v-if="card.lines.length > 0" class="lines">
        <li v-for="(line, index) in card.lines" :key="index">{{ line }}</li>
      </ul>

      <button class="primary confirm" @click="emit('confirm')">知道了</button>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(3, 5, 10, 0.74);
  backdrop-filter: blur(3px);
  animation: mask-in 0.2s ease;
}

@keyframes mask-in {
  from {
    opacity: 0;
  }
}

.card {
  width: min(300px, 84vw);
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 14px 14px 16px;
  border-radius: 14px;
  background: linear-gradient(180deg, #1b2130 0%, #0c1018 100%);
  border: 1px solid var(--line-2);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.7);
  animation: card-in 0.34s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.9);
  }
}

.art {
  width: 100%;
  aspect-ratio: 3 / 4;
  max-height: 42dvh;
  border-radius: 10px;
  overflow: hidden;
  background: radial-gradient(circle at 50% 38%, #232c44 0%, #0a0e16 72%);
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
}

.emblem {
  font-size: clamp(56px, 22vw, 88px);
  line-height: 1;
  filter: drop-shadow(0 6px 20px rgba(0, 0, 0, 0.7));
}

.title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-indent: 0.2em;
  color: #f2f4ff;
  text-shadow: 0 0 16px rgba(147, 164, 255, 0.35);
  text-align: center;
}

.lines {
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lines li {
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.04);
  border-left: 2px solid var(--accent-dim);
  font-size: 14px;
  line-height: 1.5;
  color: #dfe5f5;
}

.confirm {
  width: 100%;
  margin-top: 2px;
}

/* 阵营配色：狼是朱砂、好人是青玉 */
.card.wolf .title {
  color: #ffb4ae;
  text-shadow: 0 0 18px rgba(210, 85, 74, 0.5);
}

.card.wolf .lines li {
  border-left-color: var(--blood);
}

.card.wolf .art {
  border-color: rgba(210, 85, 74, 0.5);
}

.card.good .title {
  color: #9ff0cd;
  text-shadow: 0 0 18px rgba(88, 211, 166, 0.45);
}

.card.good .lines li {
  border-left-color: var(--jade);
}

.card.good .art {
  border-color: rgba(88, 211, 166, 0.5);
}
</style>
