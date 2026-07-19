# VESTI APP 架构说明

更新时间：2026-07-18

## 技术选型

运行时锁定为 Electron 41.10.1；该版本的 ABI 145 有 `better-sqlite3` 12.10.0 官方预编译包，可避免要求开发机安装 Visual C++ 编译链。升级 Electron 前必须先确认 SQLite 预编译 ABI 覆盖。

桌面端采用 Electron + React + TypeScript。采集层以仓库内 workspace 包 `@vesti/capture-core` 存在，Cursor 读取 SQLite，Codex/Kimi Code/Claude Code 读取和监听 JSONL，并支持经 `\\wsl$` UNC 路径采集 WSL 内的同名来源。Electron 主进程只依赖包接口，不依赖相邻的 CLI 目录，仓库可被单独克隆和构建。

该包边界是 CLI / APP 复用的稳定接缝：后续可把 `packages/capture-core` 原样迁移到独立仓库或内部包注册表，由两端锁定同一版本，避免复制解析器实现。

代价是安装包和运行内存高于 Tauri。当采集协议稳定、体积成为明确瓶颈后，再评估把纯采集内核下沉为 Rust sidecar。

| 维度 | Electron（当前） | Tauri |
|---|---|---|
| CLI 采集代码复用 | 直接复用 TypeScript | Rust 重写或 sidecar |
| Cursor SQLite | better-sqlite3 已验证 | rusqlite 可行但需重写 |
| VESTI React 逻辑复用 | 高 | 同样可复用 |
| 包体与内存 | 较高 | 较低 |
| 首版交付风险 | 低 | 中高 |

Electron 官方建议使用多进程、context isolation、renderer sandbox 和窄化后的 preload API；当前骨架均按这些边界实现：[Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)、[Security](https://www.electronjs.org/docs/latest/tutorial/security)。

## 分层结构

```text
Codex rollout JSONL ──────┐
Cursor state.vscdb ───────┤
Kimi wire.jsonl ──────────┼─> Adapter -> ParsedSession -> MessageConverter
Claude Code JSONL ────────┤                         │
(WSL \\wsl$ 同源来源) ────┘                         v
                                           ~/.vesti/db/vesti.db
VESTI 浏览器扩展 ── Bridge Protocol ──────┐         │
  (loopback HTTP 127.0.0.1:28765)         v         v
                                   Renderer Dexie 镜像 / 导入
                                                  │
             ┌────────────────────────────────────┴─────────┐
             v                                              v
      CLI package consumer                            Electron main
                                                             │ typed IPC
                                                             v
                                                     React renderer
                                                             │
                            整理 / 检索 / Summary / Explore / Relay / Deposits / Daily
```

浏览器扩展导入的数据不进 capture SQLite：bridge 接收后经 IPC 转发给渲染进程，在渲染端 Dexie（IndexedDB）做 `[platform+uuid]` 幂等合并；会话树在渲染层把 CLI 子树与浏览器子树合并呈现。

### 采集层

- `AgentAdapter`：检测安装、发现源、单会话或多会话解析、监听路径。已注册 5 个适配器：Codex、Cursor、Kimi Code、Claude Code、aider（App 默认采集清单为前四个，见 `src/main/captureService.ts` 的 `PRIMARY_PLATFORMS`）。
- `ParsedSession`：平台无关中间协议，保留用户输入、AI 文本、可见思考摘要、工具调用、Token 和项目元数据。
- `SyncEngine`：变化检测、幂等 upsert、原始 vault 策略和统一入库。
- `MessageConverter`：生成 WorkSession、Turn、SessionMessage、ToolExecution、SystemEvent。
- `WslDetector` / `PathResolver`：WSL 发行版检测、UNC home 枚举、`wsl:<distro>` host 标记与 session id 重写（详见下文「WSL 检测与多 root 抽象」）。

### 桌面主进程

`CaptureService` 是 APP 唯一的采集入口。`SettingsService` 负责版本化配置、数据目录和安全存储；`AgentService` 负责模型请求与本地结果；`DigestService` 维护会话压缩摘要与 embedding；`ExtensionBridgeService` 对浏览器扩展提供 loopback HTTP 桥；`VaultExportService` 与 `NotionService` 负责上游导出；`CapsuleWindowService` 管理桌面悬浮球。Renderer 不接触 Node.js、文件系统或数据库，只能调用白名单 IPC。

主进程同时持有 Windows 托盘、单实例锁、登录启动项和系统代理会话。关闭到托盘时窗口只被隐藏，采集服务继续运行；托盘菜单提供重新打开、同步、暂停采集和彻底退出。

### 消费层

会话浏览、知识整理（自动分类、树形导航、整理助手）、检索（FTS5 + 向量 RRF 融合）、Summary / Explore、AI 接力、知识提取、沉淀区、日总结/周报、上游导出均已落地。渲染层的纯逻辑（分类、接力上下文、沉淀版本链、日报聚合等）放在 `src/ui/*/`，面板组件复用 `packages/vesti-ui`，存储经 `StorageApi` 抽象：插件端使用 Dexie/Chrome Messaging，桌面端使用 SQLite IPC + Dexie 镜像。

## 数据库迁移机制

capture SQLite 的 schema 变更一律走 `packages/capture-core/src/storage/migrations.ts` 的 `MIGRATIONS` 数组，约定（文件头注释即契约）：

- 每个迁移条目为 `{ version, name, up(db) }`，新 schema 变更必须在数组末尾追加下一个版本号，**永不修改已发布的迁移**。
- `up` 必须幂等安全：虽然每个库只会执行一次，但仍应自查状态（如 `PRAGMA table_info` 的 `hasColumn()`），保证新版代码新建的库与迁移上来的库结构一致。
- `up` 可返回一个 note 字符串（如运行时探测失败选择跳过时的原因），由执行方写入 `schema_migrations.note`（v5 起新增的列，老库自动补齐）；版本照常记录，不重试。
- 执行由 `DatabaseManager.runMigrations()` 完成：先确保 `schema_migrations (version PK, name, applied_at)` 表存在，再把未应用的迁移按数组顺序逐个在事务内执行 `up` + 写入记录；任一步失败整体回滚并抛出，初始化即失败，不留半截 schema。

当前已发布迁移：v1 `work_sessions.session_type`、v2 `work_sessions.host`（WSL 来源标记）、v3 `session_digests` + `project_registry` 建表、v4 `work_sessions.forked_from` + digest 失效语义列 + `project_state`/`project_briefs`（记忆系统 v2）、v5 `messages_fts`/`sessions_fts` 重建为 trigram tokenizer（运行时探测，不可用时跳过并记 note；可用则 DROP 旧表与触发器、重建、`'rebuild'` 全量回填，修复 CJK 连写检索盲区）。

渲染端 Dexie（IndexedDB）另有独立的多版本 schema（`src/ui/db/schema.ts`），同样只增不改旧版本。

## WSL 检测与多 root 抽象

采集层把「一个 home 目录」抽象为可插拔的 root：Windows 原生 home 与每个 WSL 发行版的每个用户 home 地位相同，适配器只认 `setHomeRoots()` 注入的目录列表。

- **检测**：`WslDetector` 仅在 win32 生效，执行 `wsl.exe -l -q`（输出按 UTF-16LE 启发式解码，容忍 CRLF/NUL/`(Default)`/本地化表头）。对每个发行版先试 `\\wsl$` 再回退 `\\wsl.localhost`，读 `<root>\home` 枚举用户，并额外探测 `\root`。再按平台特征目录（如 `.claude/projects`、`.codex/sessions`、`.kimi-code/sessions`（旧名 `.kimi/sessions` 兜底）、`.aider.chat.history.md`）判定该 home 是否含对应来源。
- **host 标记**：`PathResolver.hostFromPath()` 依据路径首段返回 `'native'` 或 `wsl:<distro>`（distro 小写化）。该标记写入 `work_sessions.host`，并参与 project key 派生与 vault 子目录命名（`wsl-<distro>`）。
- **id 重写**：WSL 来源的 sessionId 在入库前重写为 `wsl-<distro>-<原 id>`。原因：同一会话在 native 与 WSL 各有一份时，`{platform}:{sessionId}` 主键会撞车；重写后 WSL 侧为 `{platform}:wsl-<distro>-<id>`，天然隔离。
- **60 秒轮询兜底**：chokidar 的文件事件在 9P 共享上不可靠，`CaptureService` 以固定 60 秒间隔对 host 非 native 的文件重走 `syncFile`；未变化的文件命中 `sync_state` 只做一次 stat 比对，代价很低。

## digest 管线与对话树索引

采集解决「全量归档」，digest 与树索引解决「轻量二次整理」，二者都挂在同步完成事件之后：

- **触发**：每次同步实际入库后（2 秒防抖）以及启动时，`DigestService` 扫描需要 digest 的会话——无 digest 行、消息数增长、或 `digest_version` 落后。
- **生成**：取最近 60 条消息、6000 字符预算拼 transcript，经 `AgentService` 以 `digest` kind 调用 LLM，产出严格 JSON（一句话摘要、关键主题、关键文件、决策、待决问题），写入 `session_digests`。
- **embedding**：LLM digest 成功后，对摘要文本请求 embedding，以 Float32 小端 BLOB 存入同行，供向量检索。
- **降级链**：无 API key / LLM 失败 / 输出非法 → 以首条用户消息前 100 字符作为兜底摘要，标记 `embedding_status='skipped'`；embedding 单独失败只影响向量字段，LLM 字段正常落库；存储类异常重试 2 次后标记 `'failed'`，待会话再增长时重试。任何一级失败都不阻塞采集。
- **对话树索引**：`TreeIndex.buildConversationTree()` 是一条 SQL（`work_sessions LEFT JOIN session_digests`）加内存装配的纯函数，每次调用重算，产出 来源（platform + host）→ 项目 → 会话 的树；`project_registry` 由入库管线同步维护，project key 为 `sha256(platform|host|归一化路径)` 前 16 位。浏览器来源不进该库，渲染层合并自己的 browser 子树。

记忆系统 v2（fork 谱系去重、A1 子代理归属折叠、L0–L3 分级说明系统、检索与评测）的设计与调研归档见 [memory-system/](memory-system/)：[agent-formats.md](memory-system/agent-formats.md)（各大 agent 存储规范建模）、[design.md](memory-system/design.md)（L0–L3 设计）、[bench.md](memory-system/bench.md)（评测方案）、[references.md](memory-system/references.md)（参考文献与工具）。

## ExtensionBridge 架构

`ExtensionBridgeService` 是一个纯 Node 的 loopback HTTP 服务（默认 `127.0.0.1:28765`），Electron 相关能力（safeStorage 加解密、settings.json 持久化、渲染进程转发）全部通过构造参数注入，因此可在 vitest 下直接测试。

- 端点与协议见 [bridge-protocol.md](bridge-protocol.md)：`GET /v1/status`（无鉴权，能力探测）、`POST /v1/pair`（配对码换 token）、`POST /v1/import`（Bearer 鉴权，全量/增量导入）、`GET /v1/outbox` 与 `POST /v1/outbox/ack`（v1.1 接力 outbox）。
- 配对码 6 位、5 分钟有效、一次性；token 为 24 字节随机值，App 侧只存 safeStorage 密文，比对使用 `timingSafeEqual`。
- import 体在 60 秒内未导入完成时返回 `202 {accepted:true}`：渲染端幂等导入允许扩展以相同数据安全重试。
- outbox 由 App 侧（relay 推送浏览器）入队，上限 50 条、单条 prompt 2 万字符，持久化在 settings.json 的 `bridge.outbox`；id 单调递增，扩展以排他游标轮询、注入成功后 ack 删除。
- 浏览器导入数据经 IPC 转发渲染端 Dexie 合并，不进 capture SQLite（见「分层结构」）。

## AgentService kind 注册表

所有 LLM 任务统一走 `AgentService` 的 kind 注册表（`src/main/agentPrompts.ts`），当前注册 8 种：`summary`、`explore`、`digest`、`classify`、`relay`、`extract`、`distill`、`daily`。

约定：

- 每个 kind 定义 `buildPrompt`（返回 system + user 两条消息，语言与洞察偏好由统一后缀注入）与可选 `parse`（结构化 kind 校验严格 JSON，distill/daily 宽松校验非空 Markdown）。
- 新增 kind 需要三处同步：`src/shared/contracts.ts` 的 `AgentKind` 联合类型、`agentPrompts.ts` 的注册条目、`src/main.ts` 的 IPC 入参白名单。
- `distill` 与 `daily` 以 `template` 参数化（日报/周报共用 `daily` kind）。
- 结果持久化分两类：`persist:true` 的任务（summary/explore）写入 `<数据目录>/agent-results/results.json`（封顶 100 条）；digest/classify/relay/extract/distill/daily 均以 `persist:false` 调用，结果分别落 `session_digests` 表、会话记录字段、`relay_packs`、`deposits`、`daily_logs` 等 Dexie 表。

## 四个平台的首版策略

### Codex

- `~/.codex/sessions/**/*.jsonl` 与 `archived_sessions`。
- 支持当前 `response_item`、`event_msg`、`turn_context`、`compacted`。
- 兼容旧版 `ExecCommandBegin/End`、`PatchApplyBegin/End`。
- 只保存可见消息和公开 reasoning summary，不处理 `encrypted_content`。

### Cursor

- 只读打开 Cursor `User/globalStorage/state.vscdb`。
- `composerHeaders` → `composerData:<id>` → `bubbleId:<composerId>:<bubbleId>`。
- 一个 SQLite 文件包含多个会话，使用 `parseSessions` 批量接口。
- 不复制整个 Cursor 数据库进 vault，只保存标准化结果。
- Cursor 存储结构不是稳定公开 API，每个大版本必须跑脱敏样本回归。

### Kimi Code

- `~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/<agentId>/wire.jsonl`（`agents/main` 为会话主线，其余为子代理线；旧名 `~/.kimi` 仅作探测兜底，`$KIMI_CODE_HOME` 优先）。
- 会话元数据在 `<sessionId>/state.json`（标题、workDir、agents 表），`~/.kimi-code/session_index.jsonl` 与 `workspaces.json` 可回推工作目录。
- 解析 wire protocol 1.4 扁平事件（`context.append_message`、`context.append_loop_event` 的 step/content.part/tool.call/tool.result、`usage.record`、`llm.request`），兼容旧 envelope 协议（TurnBegin / ContentPart / ToolCall / StatusUpdate / Subagent / Compaction）。
- 防静默：无法归类的事件行占比 >50%（或 ≥5 行却 0 消息）时，`ParsedSession.warnings` 记录警告并写入 `work_sessions.agent_meta.parse_warnings`。

### Claude Code

- `~/.claude/projects/**/*.jsonl`（排除 `**/subagents/**`）。
- 从最新会话首行的 `version` 字段检测版本；经 `~/.claude/usage-data/session-meta/` 补充会话元数据。
- 与 Codex/Kimi 一样支持 WSL 来源（多 home root）。

aider 适配器已在 capture-core 注册（解析 `~/.aider.chat.history.md`，含 WSL 探测），但 App 的默认采集清单（`PRIMARY_PLATFORMS`）暂未启用；启用前需补脱敏 fixture 与界面开关。

## 安全与隐私

- Renderer 开启 `contextIsolation` 和 sandbox，关闭 `nodeIntegration`。
- APP 只加载本地打包资源，拦截页面导航和新窗口。
- 浏览、同步和归档不上传会话。主动运行 Agent 任务时，会向用户选择的模型服务发送相关内容；设置页可排除思考摘要和工具详情。
- 扩展桥仅绑定 `127.0.0.1`；bridge token、API Key、Notion token 均通过 Electron `safeStorage` 加密落盘，Renderer 只知道是否已配置。
- 上游导出受限写盘：目标必须落在用户选择的导出根目录内，临时文件 + 原子重命名。
- 出网点只有模型服务与 Notion API；模型网络默认使用 Chromium 系统代理栈，也可显式选择直连或固定代理。
- 不读取凭据，不做键盘监听、屏幕录制或进程注入。

## 下一阶段

1. 建立四平台脱敏 fixture 和 schema 回归测试。
2. 将 `@vesti/capture-core` 发布为独立的版本化内部包，并让 CLI 迁移到同一包接口。
3. 评估 aider 适配器在 App 默认清单中的启用。
4. 增加 capture diagnostics，记录未知事件与解析覆盖率。
5. AITI 演进（P5 待定）。
