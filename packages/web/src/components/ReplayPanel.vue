<script setup lang="ts">
import type { ReplayDecision, ReplayPayload } from '@lrs/server/protocol';
import { ROLE_LABELS, type Role } from '@lrs/shared';
import { computed } from 'vue';
import { formatEvent } from '../format';

const props = defineProps<{ payload: ReplayPayload }>();
const emit = defineEmits<{ (event: 'day', day: number): void; (event: 'close'): void }>();

type Item =
  | { kind: 'event'; key: string; seq: number; text: string; tone: string }
  | { kind: 'decision'; key: string; seq: number; decision: ReplayDecision };

/** 事件与 AI 决策共用一套序号，按 seq 合并成一条时间线 */
const timeline = computed<Item[]>(() => {
  const items: Item[] = [];

  for (const event of props.payload.events) {
    const line = formatEvent(event);
    items.push({ kind: 'event', key: `e${event.seq}`, seq: event.seq, text: line.text, tone: line.tone });
  }
  for (const [index, decision] of props.payload.decisions.entries()) {
    items.push({
      kind: 'decision',
      key: `d${decision.seq}-${decision.seat}-${index}`,
      seq: decision.seq,
      decision,
    });
  }

  return items.sort((a, b) => a.seq - b.seq);
});

const dayLabel = (day: number): string => `第 ${day} 天`;
const isWolf = (role: Role): boolean => role === 'werewolf';
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <section class="panel">
      <header class="head">
        <span class="title">复盘</span>
        <nav class="days">
          <button
            v-for="day in payload.days"
            :key="day"
            :class="{ active: day === payload.day }"
            @click="emit('day', day)"
          >
            {{ dayLabel(day) }}
          </button>
        </nav>
        <button class="close" @click="emit('close')">✕</button>
      </header>

      <div v-if="payload.roles" class="roles">
        <span
          v-for="item in payload.roles"
          :key="item.seat"
          class="role-chip"
          :class="{ wolf: isWolf(item.role) }"
        >
          {{ item.seat }} 号 · {{ ROLE_LABELS[item.role] }}
        </span>
      </div>
      <div v-else class="sealed">
        底牌与 AI 的推理依据会在本局结束后解封 —— 推理里带着身份信息，局中看到等于作弊。
      </div>

      <div class="timeline">
        <div v-if="timeline.length === 0" class="empty">这一天还没有事件</div>

        <template v-for="item in timeline" :key="item.key">
          <div v-if="item.kind === 'event'" class="row">
            <span class="seq">{{ item.seq }}</span>
            <span class="text" :class="item.tone">{{ item.text }}</span>
          </div>

          <div v-else class="row decision-row">
            <span class="seq">{{ item.seq }}</span>
            <div class="decision">
              <div class="decision-head">
                <b>{{ item.decision.seat }} 号</b>
                <span class="tag">{{ item.decision.kind }}</span>
                <span v-if="item.decision.push !== null" class="tag push">
                  想推 {{ item.decision.push }} 号
                </span>
                <span class="tag mood">{{ item.decision.mood }}</span>
                <span v-if="item.decision.claim" class="tag claim">
                  跳 {{ ROLE_LABELS[item.decision.claim.role] }}
                </span>
              </div>
              <div class="reasoning">{{ item.decision.reasoning }}</div>
              <div v-if="item.decision.stance" class="stance">立场：{{ item.decision.stance }}</div>
            </div>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(8, 10, 16, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.panel {
  width: min(920px, 100%);
  max-height: 86dvh;
  display: flex;
  flex-direction: column;
  background: #12151f;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}

.title {
  font-weight: 600;
}

.days {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.days button {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #1a1e2b;
  color: var(--text-dim);
  cursor: pointer;
}

.days button.active {
  border-color: var(--accent);
  color: #c8d3ff;
  background: #2a3350;
}

.close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-faint);
  font-size: 15px;
  cursor: pointer;
}

.roles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid #262c3d;
}

.role-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #3c6b4a;
  background: #1e2f24;
  color: #7ddc9b;
}

.role-chip.wolf {
  border-color: #6b3c3c;
  background: #2f1e1e;
  color: #e08b8b;
}

.sealed {
  padding: 10px 14px;
  border-bottom: 1px solid #262c3d;
  color: var(--warn);
  font-size: 11.5px;
  background: #241f14;
}

.timeline {
  flex: 1;
  overflow-y: auto;
  padding: 8px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty {
  color: var(--text-faint);
}

.row {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.65;
}

.seq {
  flex: none;
  width: 30px;
  color: #414a63;
  font-size: 10px;
  text-align: right;
  padding-top: 2px;
}

.text.muted {
  color: var(--text-faint);
}
.text.normal {
  color: var(--text);
}
.text.highlight {
  color: #9fb0ff;
}
.text.danger {
  color: var(--danger);
}
.text.success {
  color: var(--good);
}
.text.private {
  color: var(--purple);
}

.decision {
  flex: 1;
  border-left: 2px solid #465089;
  background: #171b28;
  border-radius: 0 6px 6px 0;
  padding: 6px 10px;
  margin: 2px 0;
}

.decision-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #232838;
  color: var(--text-dim);
}

.tag.push {
  background: #2a2317;
  color: var(--warn);
}

.tag.mood {
  background: #1e2f24;
  color: #7ddc9b;
}

.tag.claim {
  background: #2f1e2c;
  color: #d78bd0;
}

.reasoning {
  margin-top: 3px;
  color: #c8d3ff;
}

.stance {
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 11px;
}
</style>
