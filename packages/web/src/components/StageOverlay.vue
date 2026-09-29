<script setup lang="ts">
/** 全屏瞬时提示：昼夜交替，以及环节切换 */
defineProps<{
  /** 正在播放的昼夜切换；null 表示没有 */
  sky: 'day' | 'night' | null;
  /** 正在播放的环节切换；null 表示没有 */
  flash: { key: string; kind: string; icon: string; text: string } | null;
  day: number;
}>();
</script>

<template>
  <!-- 昼夜：太阳/月亮升落 + 全屏报时 -->
  <div v-if="sky" class="sky" :class="sky">
    <div class="orb" />
    <div class="sky-title">{{ sky === 'day' ? '天亮了' : '天黑请闭眼' }}</div>
    <div class="sky-sub">{{ sky === 'day' ? `第 ${day} 天` : '夜里发生的事，天亮才知道' }}</div>
  </div>

  <!-- 环节切换：一闪而过的章节标题，免得整个过程平滑到不知道走到哪了 -->
  <div v-if="flash" :key="flash.key" class="flash" :class="flash.kind">
    <span class="flash-icon">{{ flash.icon }}</span>
    <span class="flash-text">{{ flash.text }}</span>
  </div>
</template>

<style scoped>
.sky {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  pointer-events: none;
  animation: sky-pass 2.6s ease forwards;
}

.sky.day {
  background: radial-gradient(circle at 50% 34%, rgba(255, 196, 110, 0.22) 0%, rgba(6, 9, 16, 0.86) 58%);
}

.sky.night {
  background: radial-gradient(circle at 50% 30%, rgba(147, 164, 255, 0.16) 0%, rgba(3, 5, 10, 0.9) 60%);
}

@keyframes sky-pass {
  0% {
    opacity: 0;
  }
  18% {
    opacity: 1;
  }
  78% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* 太阳/月亮：从地平线下面缓缓升上来 */
.orb {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  animation: orb-rise 2.6s cubic-bezier(0.22, 0.7, 0.3, 1) forwards;
}

.day .orb {
  background: radial-gradient(circle, #ffe6ad 0%, #f4b45c 58%, rgba(244, 180, 92, 0) 72%);
  box-shadow: 0 0 60px rgba(255, 190, 100, 0.5);
}

.night .orb {
  background: radial-gradient(circle at 38% 34%, #e8edff 0%, #9aa9f0 60%, rgba(147, 164, 255, 0) 74%);
  box-shadow: 0 0 54px rgba(147, 164, 255, 0.45);
}

@keyframes orb-rise {
  0% {
    transform: translateY(42vh) scale(0.5);
    opacity: 0;
  }
  40% {
    opacity: 1;
  }
  100% {
    transform: translateY(-6vh) scale(1);
    opacity: 0.95;
  }
}

.sky-title {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 700;
  letter-spacing: 0.28em;
  text-indent: 0.28em;
  color: #f5f7ff;
  text-shadow: 0 0 34px rgba(147, 164, 255, 0.5);
  animation: text-in 2.6s ease forwards;
}

.day .sky-title {
  color: #ffeccb;
  text-shadow: 0 0 34px rgba(255, 190, 100, 0.55);
}

.sky-sub {
  font-size: 13px;
  letter-spacing: 0.16em;
  color: var(--text-dim);
  animation: text-in 2.6s ease forwards;
}

@keyframes text-in {
  0% {
    opacity: 0;
    transform: translateY(10px);
  }
  24% {
    opacity: 1;
    transform: translateY(0);
  }
  80% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.flash {
  position: fixed;
  left: 50%;
  top: 38%;
  z-index: 70;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 26px;
  border-radius: 999px;
  background: rgba(8, 11, 18, 0.82);
  border: 1px solid var(--line-2);
  backdrop-filter: blur(6px);
  pointer-events: none;
  animation: flash-pass 1.8s ease forwards;
}

@keyframes flash-pass {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.82);
  }
  16% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  74% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(1.06);
  }
}

.flash-icon {
  font-size: 22px;
  line-height: 1;
}

.flash-text {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: #eef1fb;
}

.flash.chief {
  border-color: rgba(217, 178, 106, 0.6);
  box-shadow: 0 0 28px rgba(217, 178, 106, 0.18);
}

.flash.chief .flash-text {
  color: var(--gold);
}

.flash.vote {
  border-color: rgba(147, 164, 255, 0.6);
  box-shadow: 0 0 28px rgba(147, 164, 255, 0.2);
}

.flash.vote .flash-text {
  color: #b3c0ff;
}

.flash.dawn {
  border-color: rgba(255, 196, 110, 0.6);
  box-shadow: 0 0 28px rgba(255, 196, 110, 0.2);
}

.flash.dawn .flash-text {
  color: #f4c98a;
}

.flash.death {
  border-color: rgba(210, 85, 74, 0.6);
  box-shadow: 0 0 28px rgba(210, 85, 74, 0.22);
}

.flash.death .flash-text {
  color: #e09a94;
}

.flash.skill {
  border-color: rgba(88, 211, 166, 0.6);
  box-shadow: 0 0 28px rgba(88, 211, 166, 0.2);
}

.flash.skill .flash-text {
  color: var(--jade);
}

.flash.speech {
  border-color: var(--line-2);
}
</style>
