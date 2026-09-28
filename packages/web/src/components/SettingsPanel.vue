<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  fetchAdminState,
  lock,
  revealKey,
  saveAccessToken,
  saveConfig,
  setupPassphrase,
  unlock,
  type AdminState,
  type Provider,
} from '../admin';

const emit = defineEmits<{ (event: 'close'): void }>();

const PROVIDER_LABELS: Record<Provider, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  custom: '自定义（OpenAI 兼容）',
};

const PROVIDER_ITEMS = Object.keys(PROVIDER_LABELS) as Provider[];

const state = ref<AdminState | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/** 口令表单 */
const pass1 = ref('');
const pass2 = ref('');
const newPass1 = ref('');
const newPass2 = ref('');
const newToken1 = ref('');
const newToken2 = ref('');

/** 表单草稿；Key 用 null 表示「这一项没动」，空串表示「明确清空」 */
const form = reactive({
  provider: 'deepseek' as Provider,
  cheapModel: '',
  strongModel: '',
  baseUrl: '',
});
const keyEdits = reactive<Record<Provider, string | null>>({ deepseek: null, openai: null, custom: null });
const revealed = reactive<Record<Provider, string | null>>({ deepseek: null, openai: null, custom: null });

const needSetup = computed(() => state.value !== null && !state.value.passphraseSet);
const needUnlock = computed(() => state.value !== null && state.value.passphraseSet && !state.value.unlocked);
const ready = computed(() => state.value !== null && state.value.unlocked);

function applyState(next: AdminState): void {
  state.value = next;
  form.provider = next.llm.provider;
  form.cheapModel = next.llm.cheapModel;
  form.strongModel = next.llm.strongModel;
  form.baseUrl = next.llm.baseUrl;
  for (const item of PROVIDER_ITEMS) {
    keyEdits[item] = null;
    revealed[item] = null;
  }
}

async function refresh(): Promise<void> {
  try {
    applyState(await fetchAdminState());
    error.value = null;
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function run(work: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await work();
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem);
  } finally {
    busy.value = false;
  }
}

const submitSetup = (): void =>
  void run(async () => {
    if (pass1.value.length < 6) throw new Error('口令至少 6 位');
    if (pass1.value !== pass2.value) throw new Error('两次输入的口令不一致');
    await setupPassphrase(pass1.value);
    pass1.value = '';
    pass2.value = '';
    await refresh();
    notice.value = '口令已创建。以后新设备打开设置时，输入这个口令才能进来。';
  });

const submitUnlock = (): void =>
  void run(async () => {
    await unlock(pass1.value);
    pass1.value = '';
    await refresh();
  });

const submitLock = (): void =>
  void run(async () => {
    await lock();
    await refresh();
    notice.value = '已锁定，这台设备下次要重新输口令。';
  });

const submitChangePassphrase = (): void =>
  void run(async () => {
    if (newPass1.value.length < 6) throw new Error('口令至少 6 位');
    if (newPass1.value !== newPass2.value) throw new Error('两次输入的口令不一致');
    await setupPassphrase(newPass1.value);
    newPass1.value = '';
    newPass2.value = '';
    await refresh();
    notice.value = '口令已更新，其它设备上的解锁状态已失效。';
  });

/** 访问口令：改完这台设备要带着新口令重进一次 */
const submitAccessToken = (): void =>
  void run(async () => {
    const token = newToken1.value.trim();
    if (!/^[A-Za-z0-9._~-]{8,64}$/.test(token)) {
      throw new Error('口令要 8~64 位，只能用字母、数字和 . _ ~ -');
    }
    if (token !== newToken2.value.trim()) throw new Error('两次输入的口令不一致');
    if (
      !window.confirm(
        '改完之后：这台设备会自动带着新口令重进一次；其它设备（含手机）要重新输一次新口令才能进。继续？',
      )
    ) {
      return;
    }
    await saveAccessToken(token);
    // 手里那个 cookie 已经是旧的了，带着新口令重新访问一次换发
    window.location.href = `/?token=${encodeURIComponent(token)}`;
  });

const submitSave = (): void =>
  void run(async () => {
    const keys: Partial<Record<Provider, string>> = {};
    for (const item of PROVIDER_ITEMS) {
      const edit = keyEdits[item];
      if (edit !== null) keys[item] = edit;
    }
    const keysPayload = Object.keys(keys).length > 0 ? { keys } : {};
    const result = await saveConfig({
      provider: form.provider,
      cheapModel: form.cheapModel.trim(),
      strongModel: form.strongModel.trim(),
      baseUrl: form.baseUrl.trim(),
      ...keysPayload,
    });
    applyState(result.state);
    notice.value = '已保存。对下一局生效，正在跑的这局不受影响。';
  });

const toggleReveal = (provider: Provider): void =>
  void run(async () => {
    revealed[provider] = revealed[provider] === null ? await revealKey(provider) : null;
  });

function clearKey(provider: Provider): void {
  keyEdits[provider] = '';
  revealed[provider] = null;
}

function resetKey(provider: Provider): void {
  keyEdits[provider] = null;
}

/** 手动清空输入框 = 不改动；真要清掉 Key 得点「清空」再保存 */
function onKeyInput(provider: Provider, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  keyEdits[provider] = value === '' ? null : value;
}

function keyHint(provider: Provider): string {
  const view = state.value?.llm.keys[provider];
  if (!view || view.source === 'none') return '未配置';
  if (view.source === 'env') return `${view.masked} · 当前就用它，可点「查看」`;
  return `${view.masked} · 由界面管理`;
}

const accessHint = computed(() => {
  const view = state.value?.access;
  if (!view) return '';
  if (!view.set) return '未设置：拿到地址的人都能进（只在自己电脑上跑时可以不管）';
  return view.source === 'env' ? `${view.masked} · 当前来自 .env` : `${view.masked} · 由界面设置`;
});
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <section class="panel">
      <header class="head">
        <span class="title">设置</span>
        <span v-if="state" class="chip" :class="{ ok: state.llm.live }">
          {{ state.llm.live ? '模型可用' : '模型不可用' }}
        </span>
        <button class="close" @click="emit('close')">✕</button>
      </header>

      <div class="body">
        <div v-if="loading" class="hint">读取中…</div>

        <!-- 首次：设一个管理口令 -->
        <template v-else-if="needSetup">
          <p class="lead">
            先给「设置」设一个管理口令。它和访问口令是两回事：访问口令管整个站点，
            这个口令专管设置页 —— 新设备要看或改 API Key，必须先输它。
          </p>
          <label class="field">
            <span>管理口令（至少 6 位）</span>
            <input v-model="pass1" type="password" autocomplete="new-password" />
          </label>
          <label class="field">
            <span>再输一遍</span>
            <input v-model="pass2" type="password" autocomplete="new-password" />
          </label>
          <p class="foot-note">
            口令只存哈希，丢了只能清库重设。服务器上看不到原文，也不会写进日志。
          </p>
        </template>

        <!-- 有口令但没解锁 -->
        <template v-else-if="needUnlock">
          <p class="lead">这台设备还没解锁。输入管理口令后，浏览器会记住 30 天。</p>
          <label class="field">
            <span>管理口令</span>
            <input v-model="pass1" type="password" autocomplete="current-password" @keydown.enter="submitUnlock" />
          </label>
        </template>

        <!-- 已解锁：真正的设置表单 -->
        <template v-else-if="ready && state">
          <label class="field">
            <span>供应商</span>
            <select v-model="form.provider">
              <option v-for="item in PROVIDER_ITEMS" :key="item" :value="item">
                {{ PROVIDER_LABELS[item] }}
              </option>
            </select>
          </label>

          <div class="two">
            <label class="field">
              <span>便宜档模型（发言、反思）</span>
              <input v-model="form.cheapModel" spellcheck="false" />
            </label>
            <label class="field">
              <span>强力档模型（决策）</span>
              <input v-model="form.strongModel" spellcheck="false" />
            </label>
          </div>

          <label v-if="form.provider === 'custom'" class="field">
            <span>自定义地址（http/https，OpenAI 兼容）</span>
            <input v-model="form.baseUrl" spellcheck="false" placeholder="https://your-endpoint/v1" />
          </label>

          <div class="block">
            <h4>API Key</h4>
            <p class="foot-note">
              输入框留空表示不改动；点「清空」保存后会真的清掉（不会再回落到 .env）。
            </p>

            <div v-for="item in PROVIDER_ITEMS" :key="item" class="key-row">
              <div class="key-head">
                <b>{{ PROVIDER_LABELS[item] }}</b>
                <span class="dim">{{ keyHint(item) }}</span>
                <span v-if="keyEdits[item] === ''" class="tag danger">保存后将清空</span>
                <span class="grow" />
                <button
                  class="ghost tiny"
                  :disabled="busy || state.llm.keys[item].source === 'none'"
                  @click="toggleReveal(item)"
                >
                  {{ revealed[item] === null ? '查看' : '收起' }}
                </button>
                <button class="ghost tiny" :disabled="busy" @click="clearKey(item)">清空</button>
                <button v-if="keyEdits[item] !== null" class="ghost tiny" :disabled="busy" @click="resetKey(item)">
                  撤销
                </button>
              </div>
              <input
                :value="keyEdits[item] ?? ''"
                type="password"
                spellcheck="false"
                autocomplete="off"
                :placeholder="`留空 = 不改动${state.llm.keys[item].source === 'none' ? '' : '（当前已配置）'}`"
                @input="onKeyInput(item, $event)"
              />
              <code v-if="revealed[item] !== null" class="revealed" @click="revealed[item] = null">
                {{ revealed[item] }}
              </code>
            </div>
          </div>

          <p class="foot-note">
            保存后**对下一局生效**，正在跑的那局还用旧的模型配置。想看当前生效的是哪家，
            看顶部的「模型可用」标记即可。
          </p>

          <div class="block">
            <h4>访问口令（进站点的门）</h4>
            <p class="foot-note">
              当前：{{ accessHint }}。<br />
              它和下面的管理口令是两回事：这个管<b>整个站点</b>能不能打开，
              新设备第一次进来要在那页输入框里填一次。改完其它设备会被踢回门口。
            </p>
            <div class="two">
              <label class="field">
                <span>新口令（8~64 位，字母数字与 . _ ~ -）</span>
                <input v-model="newToken1" type="password" autocomplete="new-password" spellcheck="false" />
              </label>
              <label class="field">
                <span>再输一遍</span>
                <input v-model="newToken2" type="password" autocomplete="new-password" spellcheck="false" />
              </label>
            </div>
            <div>
              <button class="ghost" :disabled="busy || newToken1 === ''" @click="submitAccessToken">
                修改访问口令
              </button>
            </div>
          </div>

          <div class="block">
            <h4>管理口令</h4>
            <p class="foot-note">改口令会把其它设备上已解锁的会话全部踢掉（这台会重新发一个）。</p>
            <div class="two">
              <label class="field">
                <span>新口令（至少 6 位）</span>
                <input v-model="newPass1" type="password" autocomplete="new-password" />
              </label>
              <label class="field">
                <span>再输一遍</span>
                <input v-model="newPass2" type="password" autocomplete="new-password" />
              </label>
            </div>
            <div>
              <button class="ghost" :disabled="busy || newPass1 === ''" @click="submitChangePassphrase">
                修改口令
              </button>
            </div>
          </div>
        </template>

        <p v-if="error" class="msg danger">{{ error }}</p>
        <p v-if="notice" class="msg ok">{{ notice }}</p>
      </div>

      <footer class="foot">
        <template v-if="needSetup">
          <button class="primary" :disabled="busy" @click="submitSetup">创建口令并进入</button>
        </template>
        <template v-else-if="needUnlock">
          <button class="primary" :disabled="busy" @click="submitUnlock">解锁</button>
        </template>
        <template v-else-if="ready">
          <button class="primary" :disabled="busy" @click="submitSave">保存</button>
          <button class="ghost" :disabled="busy" @click="submitLock">锁定这台设备</button>
        </template>
        <span class="grow" />
        <button class="ghost" @click="emit('close')">关闭</button>
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
  width: min(620px, 100%);
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}

.title {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 0.12em;
}

.chip {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 10.5px;
  background: rgba(210, 85, 74, 0.12);
  border: 1px solid rgba(210, 85, 74, 0.45);
  color: var(--danger);
}

.chip.ok {
  background: rgba(88, 211, 166, 0.12);
  border-color: rgba(88, 211, 166, 0.45);
  color: var(--jade);
}

.close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-faint);
  font-size: 15px;
  cursor: pointer;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lead {
  margin: 0;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.75;
}

.hint,
.dim {
  color: var(--text-faint);
  font-size: 11.5px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field > span {
  font-size: 11.5px;
  color: var(--text-dim);
}

.two {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}

.block {
  border-top: 1px dashed #232a3a;
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block h4 {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
}

.key-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: #171b28;
  border: 1px solid #232838;
}

.key-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.grow {
  flex: 1 1 auto;
}

.tag {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
}

.tag.danger {
  background: rgba(210, 85, 74, 0.16);
  border: 1px solid rgba(210, 85, 74, 0.5);
  color: var(--danger);
}

button.tiny {
  padding: 3px 8px;
  min-height: 24px;
  font-size: 10.5px;
}

.revealed {
  display: block;
  padding: 5px 8px;
  border-radius: 5px;
  background: #0b0e15;
  border: 1px solid #2b3450;
  color: #cdd6ff;
  font-family: var(--font-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.msg {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}

.msg.danger {
  color: var(--danger);
}

.msg.ok {
  color: var(--jade);
}

.foot-note {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.7;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}

select {
  font-family: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--ink-0);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}

select:focus {
  outline: none;
  border-color: var(--accent-dim);
}
</style>
