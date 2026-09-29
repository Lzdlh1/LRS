<script setup lang="ts">
import { computed } from 'vue';
import type { AckCard } from '../format';

/**
 * 「重大信息」卡片。
 *
 * 查验结果、死讯这类信息一出来局面就往前跳（预言家验人是夜里最后一步，
 * 紧接着就是天亮），所以服务端会停在那里等这张卡被点掉 —— 不是纯装饰。
 *
 * 样式走「木刻平涂」：米纸底 + 墨蓝粗框 + 内细线，中间一块墨蓝印版放徽记；
 * 查验结果直接用现成的朱砂/青玉印章。四个颜色，不铺大面积亮色。
 */
const props = defineProps<{ card: AckCard }>();
const emit = defineEmits<{ confirm: [] }>();

/** 印版上的图：查验用印章（查杀 / 金水），其余用对应角色的徽记 */
const emblemSrc = computed(() => {
  const { kind, tone } = props.card;
  if (kind === 'seer') return tone === 'wolf' ? '/art/stamps/wolf.svg' : '/art/stamps/good.svg';
  if (kind === 'witch') return '/art/sigils/witch.svg';
  if (kind === 'shot') return '/art/sigils/hunter.svg';
  if (kind === 'death') return '/art/sigils/villager.svg';
  return '/art/sigils/villager.svg';
});
</script>

<template>
  <div class="mask">
    <div class="card" :class="card.tone">
      <div class="art">
        <img class="emblem" :src="emblemSrc" :alt="card.title">
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

/* 米纸卡：粗墨框 + 收进去一圈细线 */
.card {
  position: relative;
  width: min(300px, 84vw);
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 15px 15px 17px;
  border-radius: 5px;
  background: #efe6d2;
  border: 3px solid #16263f;
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.7);
  animation: card-in 0.34s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

.card::before {
  content: '';
  position: absolute;
  inset: 6px;
  border: 1px solid rgba(22, 38, 63, 0.32);
  border-radius: 2px;
  pointer-events: none;
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.9);
  }
}

/* 印版：一块墨蓝，徽记/印章压在上面 */
.art {
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 34dvh;
  border-radius: 3px;
  overflow: hidden;
  background: #16263f;
  border: 1px solid rgba(22, 38, 63, 0.55);
  display: grid;
  place-items: center;
}

.emblem {
  width: 66%;
  height: auto;
  display: block;
}

.title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-indent: 0.2em;
  color: #16263f;
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
  border-radius: 2px;
  background: #e5d9be;
  border-left: 3px solid #46586e;
  font-size: 14px;
  line-height: 1.5;
  color: #1b2a3f;
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

/* 阵营配色：狼是朱砂、好人是青玉、其余保持墨蓝 */
.card.wolf .title {
  color: #a32b22;
}

.card.wolf .lines li {
  border-left-color: #b8342a;
}

.card.good .title {
  color: #23604d;
}

.card.good .lines li {
  border-left-color: #2f6a58;
}

/* 无阵营情报（死讯、女巫夜况）走墨蓝，别抢信息 */
.card.neutral .title {
  color: #16263f;
}
</style>
