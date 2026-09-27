# AI 狼人杀 · MVP1 实施计划

- 日期：2026-09-27
- 依据：[2026-09-27-ai-werewolf-mvp1-design.md](../specs/2026-09-27-ai-werewolf-mvp1-design.md)
- 执行方式：按里程碑推进，**每个任务都必须先能验证，再进入下一个**

---

## 1. 技术栈锁定

| 项 | 选择 | 备注 |
|---|---|---|
| 运行时 | Node 24.12.0 | 本机已装 |
| 包管理 | npm workspaces | 本机 npm 11.6.2 |
| 语言 | TypeScript 5.x，strict | |
| 测试 | Vitest | 引擎用纯单测，无需 mock |
| 校验 | Zod | Action / Event / LLM 输出三处共用 |
| 服务端 | Fastify + `ws` | |
| 存储 | better-sqlite3 | 若原生编译失败，回落 Node 24 内置 `node:sqlite` |
| 前端 | Vue3 + Vite + Pinia | 不引入重型 UI 框架，自写圆桌 CSS |

---

## 2. 目录结构

```
狼人杀/
├─ package.json                    npm workspaces 根
├─ tsconfig.base.json
├─ vitest.config.ts
├─ .env.example                    仅占位，不含真实 Key
├─ docs/superpowers/
│  ├─ specs/2026-09-27-ai-werewolf-mvp1-design.md
│  └─ plans/2026-09-27-ai-werewolf-mvp1-plan.md
├─ packages/
│  ├─ shared/                      类型 + Zod schema（各模块共用）
│  ├─ core-engine/                 纯逻辑引擎（无 IO / 无 LLM）
│  ├─ llm-router/                  Provider 适配 + 分级路由 + 用量
│  ├─ agent-host/                  AI 玩家（人设 / 记忆 / 决策 / 发言）
│  ├─ server/                      session-service（WS + 裁剪 + SQLite + 日志）
│  └─ web/                         Vue3 前端
└─ logs/                           运行期生成，已在 .gitignore
```

**依赖方向（单向，不允许反向依赖）**

```
shared ← core-engine ← server ← web
shared ← llm-router ← agent-host ← server
```

---

## 3. 里程碑总览

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| **M1** | 引擎 + 单元测试 | 脚本化 Action 能跑完整局，胜负正确 |
| **M2** | 会话服务 + 最小前端 | **能手动扮演全部 9 人打完一局**（尚无 AI） |
| **M3** | AI 智能体接入 | 8 个 AI 全自动，有人设、有记忆 |
| **M4** | 流式 + 视角 + 复盘 + 用量 | 设计文档第 13 节 7 条验收标准全绿 |

---

## 4. M1 · 游戏引擎

**M1 全部任务不碰网络、不碰 LLM、不碰文件。** 每个任务都能用 `npm test -w packages/core-engine` 验证。

| # | 任务 | 产出 | 验证方式 |
|---|---|---|---|
| M1-1 | 初始化 workspace 骨架 | 根 `package.json`(workspaces) / `tsconfig.base.json` / `vitest.config.ts` / `shared` 与 `core-engine` 的 package.json | `npm install` 成功；`npm test` 能跑（0 个用例也算通过） |
| M1-2 | 领域类型与 Zod schema | `shared/src/{ids,roles,phases,actions,events,schemas}.ts` | 单测：合法 Action/Event 通过，非法被拒 |
| M1-3 | 板子与规则参数 | `core-engine/src/{board,rules}.ts`；9 人预女猎守 + 设计文档 4.3 全部默认值 | 单测：板子人数与角色数一致；规则参数可被覆盖 |
| M1-4 | 状态机骨架 | `machine.ts`：`createGame(config)` → `applyAction(a)` → 返回新事件数组；发出 `phase_changed` / `action_requested` | 单测：能走通「开局 → 第 1 夜 → 天亮 → 上警报」最小路径 |
| M1-5 | 夜晚四阶段 | `roles/{guard,wolf,witch,seer}.ts` | 单测：顺序固定为 守卫→狼→女巫→预言家；`action_requested.options` 正确排除非法项（连守 / 无药 / 自救）；女巫能收到 `witch_night_info` |
| M1-6 | 天亮结算 | 死讯公布、遗言、猎人开枪、**同守同救** | 单测：同守同救判定；女巫毒死猎人不能开枪；首夜死亡有遗言 |
| M1-7 | 白天阶段 | **警长竞选**（上警 / 竞选发言 / 退水 / 投票 / PK）、公布死讯、依次发言、投票、平票 PK 再投、遗言、警徽转移 | 单测：平票 → PK → 再平票则无人出局；警长 1.5 票；警长被刀后警徽转移；**首夜死者照常参与竞选与投票** |
| M1-8 | 昼夜循环与胜负判定 | 天数推进 + 屠边判定 + **狼刀在先** | 单测：狼全灭 / 屠神 / 屠民 三种结局；狼刀在先时后手毒杀与开枪不改变结果 |
| M1-9 | visibility 与事件流 | `visibility.ts`；所有私密事件带 `seats[...]` | 单测：以某座位为观察者过滤事件流，看不到别人的 `role_assigned` / `seer_result` |
| M1-10 | 整局端到端 + 黄金回放 | `test/fixtures/*.jsonl`（脚本化 Action 序列 + 期望事件流） | `npm test` 全绿；能跑完一局 9 人局到 `game_over` |

**M1 完成判据**：设计文档 4.8 列出的 8 类边界情况全部有测试且通过；一局完整对局可被脚本跑通。

---

## 5. M2 · 会话服务 + 最小前端

| # | 任务 | 产出 | 验证方式 |
|---|---|---|---|
| M2-1 | 服务骨架 | Fastify + `ws`，健康检查端点 | `curl` 健康检查返回 200 |
| M2-2 | 数据库层 | SQLite 建表 + store（`games` / `game_events` / `game_seats` / `ai_profiles` / `llm_usage` / `settings`） | 单测：写一条事件再读回，seq 单调 |
| M2-3 | 对局生命周期 | 建房 → 发牌 → 开局 → 结束 | 单测 + 手工：能创建一局并落库 |
| M2-4 | 事件裁剪与广播 | 按 `visibility` 过滤；视角开关；按 seq 补发 | **单测：玩家 A 的连接收不到 A 不该看的事件** |
| M2-5 | Action 入口与超时兜底 | 真人 Action 提交；`deadline` 到点提交默认 Action | 单测：超时后引擎能继续推进 |
| M2-6 | 日志模块与脱敏 | `logs/<date>/{engine,agent,llm,ws,error}.log`；统一脱敏器；启动自检 | 单测：喂入含 `sk-xxx` 的字符串，落盘后已打码 |
| M2-7 | 前端骨架与圆桌 | Vue3 + Vite；圆桌组件按设计文档 8.1 渲染（只读） | 手工：浏览器能看到 9 个座位与事件日志 |
| M2-8 | 操作区 + 调试面板 | 提交 Action 的 UI；「扮演所有人」的调试面板 | **手工：一个人扮演 9 人打完一局** |

**M2 是 M3 的前置门槛。** 这一步用你自己的脑子验证规则引擎 —— 如果规则有错，现在就暴露，成本远低于之后 debug AI。

---

## 6. M3 · AI 智能体接入

| # | 任务 | 产出 | 验证方式 |
|---|---|---|---|
| M3-1 | Provider 抽象与适配 | DeepSeek / OpenAI 适配器；统一 `chat()` 接口 | 单测（Mock）+ 手工：真实 Key 跑一次最小调用 |
| M3-2 | 分级路由与容错 | `tier: cheap \| strong` 路由；并发限流；重试 / 超时降级 | 单测：strong 超时能降级；限流生效 |
| M3-3 | 输出校验与降级 | Zod 校验 LLM JSON；失败重试一次，再失败退化默认 Action | 单测：喂非法 JSON 走完降级路径 |
| M3-4 | 用量统计 | 每次调用写 `llm_usage` | 单测 + 手工：一局后能查到花费 |
| M3-5 | 9 个人设 | `ai_profiles` 内置 9 条人设 | 手工：开局随机分配且不重复 |
| M3-6 | 记忆 M1 事实层 | 从事件流投影出存活 / 票型 / 宣称 / 死亡 | 单测：给定事件流，投影结果正确 |
| M3-7 | 记忆 M2 / M3 层 | 信念层结构与更新；摘要层压缩 | 单测：信念层 schema 校验；摘要压缩调用被正确触发 |
| M3-8 | 决策调用 | 产出结构化 JSON（action + reasoning + belief_update） | 手工：决策结果能通过 Zod 校验且语义合理 |
| M3-9 | 发言调用 | 基于决策结论 + 人设生成自然语言，流式 | 手工：8 个 AI 发言风格可区分 |
| M3-10 | 反思与 mood | 投票后反思调用，更新信念层与 mood | 手工：连续押错后发言明显变急躁 |
| M3-11 | 接入 server | 用 agent-host 替换 M2 的调试面板 | **手工：8 个 AI 自动打完一局** |

---

## 7. M4 · 体验与验收

| # | 任务 | 产出 | 验证方式 |
|---|---|---|---|
| M4-1 | 流式输出 | LLM 流式 → WS 分片 → 前端打字机 | 手工：发言逐字出现，不是一次性蹦出 |
| M4-2 | 预思考优化 | 用户发言时并行预生成其他 AI 草稿 | 手工：用户发言结束后，下一个 AI 几乎立刻开口 |
| M4-3 | 视角切换 | 玩家视角 ⇄ 上帝模式开关 | 手工：切换后座位标记与夜间面板同步变化 |
| M4-4 | 复盘视图 | 事件回放 + 亮底牌 + 查看每轮 AI 推理依据 | 手工：能回看任意一天，看到 AI 的 reasoning |
| M4-5 | 用量看板 | 按局 / 按任务 / 按模型的花费展示 | 手工：数字与 `llm_usage` 对得上 |
| M4-6 | 安全验证 | 抓包确认玩家视角下前端拿不到未公开信息 | **抓包：WS 报文中不含他人身份、验人结果** |
| M4-7 | 验收走查 | 设计文档第 13 节 7 条逐条过 | 7 条全绿 |

---

## 8. 提交策略

- 每个任务（M1-1、M1-2 …）完成后单独提交，提交信息格式：`feat(engine): 实现夜晚四阶段`
- 每个里程碑结束后推送一次，并在此处勾选：

- [ ] M1 完成并推送
- [ ] M2 完成并推送
- [ ] M3 完成并推送
- [ ] M4 完成并推送（MVP1 交付）

---

## 9. 已知风险与回退方案

| 风险 | 回退方案 |
|---|---|
| `better-sqlite3` 在 Windows + Node 24 原生编译失败 | 改用 Node 24 内置 `node:sqlite`，store 层接口不变 |
| DeepSeek 推理质量撑不住狼人杀 | 关键决策切到更强 provider —— llm-router 已抽象，只改配置 |
| 8 个 AI 串行发言延迟过高 | M4-2 预思考；必要时白天发言改为「只让关键玩家详细发言」 |
| 引擎规则与你的预期不符 | 规则参数在 `rules.ts` 集中配置，改一处即可，不动状态机 |
