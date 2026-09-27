<script setup lang="ts">
import type { UsageReport, UsageScope } from '@lrs/server/protocol';
import { computed } from 'vue';

const props = defineProps<{ payload: UsageReport }>();
const emit = defineEmits<{ (event: 'scope', scope: UsageScope): void; (event: 'close'): void }>();

const TABS: { scope: UsageScope; label: string }[] = [
  { scope: 'game', label: '本局' },
  { scope: 'all', label: '全部历史' },
];

const empty = computed(() => props.payload.totals.calls === 0);

const fmtInt = (value: number): string => value.toLocaleString('zh-CN');
const fmtCost = (value: number): string => `¥${value.toFixed(4)}`;
const shortId = (id: string): string => id.slice(0, 8);

function startedAtLabel(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

const campLabel = (camp: string | null): string =>
  camp === 'wolf' ? '狼人胜' : camp === 'good' ? '好人胜' : '未结束';

/** 调用失败时 router 不上报 provider/model，分组键会是空串 */
const modelLabel = (model: string): string => model || '（调用失败）';
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <section class="panel">
      <header class="head">
        <span class="title">用量</span>
        <nav class="tabs">
          <button
            v-for="tab in TABS"
            :key="tab.scope"
            :class="{ active: tab.scope === payload.scope }"
            @click="emit('scope', tab.scope)"
          >
            {{ tab.label }}
          </button>
        </nav>
        <span class="scope-hint">
          {{ payload.scope === 'game' ? `当前对局 ${shortId(payload.gameId ?? '')}` : '全部已落库的对局' }}
        </span>
        <button class="close" @click="emit('close')">✕</button>
      </header>

      <div class="totals">
        <div class="cell">
          <span class="num">{{ fmtInt(payload.totals.calls) }}</span>
          <span class="cap">次调用</span>
        </div>
        <div class="cell">
          <span class="num">{{ fmtInt(payload.totals.inTokens) }}</span>
          <span class="cap">输入 tokens</span>
        </div>
        <div class="cell">
          <span class="num">{{ fmtInt(payload.totals.outTokens) }}</span>
          <span class="cap">输出 tokens</span>
        </div>
        <div class="cell cost">
          <span class="num">{{ fmtCost(payload.totals.cost) }}</span>
          <span class="cap">估算花费</span>
        </div>
      </div>

      <div class="body">
        <div v-if="empty" class="empty">
          还没有任何模型调用记录。跑一局（或 <code>npm run ai:game</code>）之后再回来看看。
        </div>

        <template v-else>
          <section v-if="payload.byTask.length > 0" class="block">
            <h4>按任务</h4>
            <div class="table">
              <div class="row thead">
                <span>任务</span><span>次数</span><span>输入</span><span>输出</span><span>花费</span>
              </div>
              <div v-for="row in payload.byTask" :key="row.task" class="row">
                <span class="key">{{ row.task }}</span>
                <span>{{ fmtInt(row.calls) }}</span>
                <span>{{ fmtInt(row.inTokens) }}</span>
                <span>{{ fmtInt(row.outTokens) }}</span>
                <span class="cost">{{ fmtCost(row.cost) }}</span>
              </div>
            </div>
          </section>

          <section v-if="payload.byModel.length > 0" class="block">
            <h4>按模型</h4>
            <div class="table">
              <div class="row thead">
                <span>模型</span><span>次数</span><span>输入</span><span>输出</span><span>花费</span>
              </div>
              <div v-for="row in payload.byModel" :key="row.model" class="row">
                <span class="key">{{ modelLabel(row.model) }}</span>
                <span>{{ fmtInt(row.calls) }}</span>
                <span>{{ fmtInt(row.inTokens) }}</span>
                <span>{{ fmtInt(row.outTokens) }}</span>
                <span class="cost">{{ fmtCost(row.cost) }}</span>
              </div>
            </div>
          </section>

          <section v-if="payload.byGame.length > 0" class="block">
            <h4>按局</h4>
            <div class="table">
              <div class="row thead">
                <span>对局</span><span>次数</span><span>输入</span><span>输出</span><span>花费</span>
              </div>
              <div v-for="row in payload.byGame" :key="row.gameId" class="row">
                <span class="key">
                  <b>{{ shortId(row.gameId) }}</b>
                  <em>{{ startedAtLabel(row.startedAt) }} · {{ campLabel(row.winner) }} · {{ row.board }}</em>
                </span>
                <span>{{ fmtInt(row.calls) }}</span>
                <span>{{ fmtInt(row.inTokens) }}</span>
                <span>{{ fmtInt(row.outTokens) }}</span>
                <span class="cost">{{ fmtCost(row.cost) }}</span>
              </div>
            </div>
          </section>
        </template>
      </div>

      <footer class="foot">
        费用按 <code>pricing.ts</code> 的价格表估算，只用于看量级；精确对账请以供应商账单为准。
      </footer>
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
  width: min(760px, 100%);
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
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}

.title {
  font-weight: 600;
}

.tabs {
  display: flex;
  gap: 6px;
}

.tabs button {
  padding: 3px 12px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #1a1e2b;
  color: var(--text-dim);
  cursor: pointer;
}

.tabs button.active {
  border-color: var(--accent);
  color: #c8d3ff;
  background: #2a3350;
}

.scope-hint {
  font-size: 10.5px;
  color: var(--text-faint);
}

.close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-faint);
  font-size: 15px;
  cursor: pointer;
}

.totals {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #262c3d;
}

.cell {
  flex: 1 1 120px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #171b28;
  border: 1px solid #232838;
}

.cell .num {
  font-size: 16px;
  font-weight: 600;
  color: #c8d3ff;
}

.cell.cost .num {
  color: var(--warn);
}

.cell .cap {
  font-size: 10.5px;
  color: var(--text-faint);
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 14px;
}

.empty {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.8;
}

.block {
  margin-bottom: 16px;
}

.block h4 {
  margin: 0 0 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-dim);
}

/* 窄屏时让表格自己横向滚，而不是把列挤到互相压住 */
.table {
  overflow-x: auto;
}

.row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 48px 78px 78px 86px;
  gap: 6px;
  align-items: center;
  min-width: 460px;
  padding: 5px 6px;
  font-size: 11.5px;
  border-radius: 5px;
}

.row > span:not(.key) {
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.row.thead {
  color: var(--text-faint);
  font-size: 10.5px;
}

.row.thead > span {
  color: var(--text-faint);
}

.row:not(.thead):nth-child(even) {
  background: #171b28;
}

.key {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  color: var(--text);
  overflow-wrap: anywhere;
}

.key em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-faint);
}

.row .cost {
  color: var(--warn);
}

.foot {
  padding: 8px 14px;
  border-top: 1px solid #262c3d;
  font-size: 10.5px;
  color: var(--text-faint);
}

code {
  font-size: 10.5px;
  color: var(--text-dim);
}
</style>
