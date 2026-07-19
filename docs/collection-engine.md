# 收集引擎设计说明

适用范围：`packages/capture-core`（`@vesti/capture-core`）及其在 App 主进程中的装配（`src/main/captureService.ts`）。实现以代码为准。

## 设计哲学：原始全量保留 + 轻量二次整理

收集引擎分三层，各层失败域互相隔离：

1. **原始层（vault）**：源文件以 gzip 原样备份，解析器升级后可以随时重放，任何解析 bug 都不丢数据。
2. **标准化层（capture SQLite）**：各平台会话统一为 WorkSession / Turn / Message / ToolExecution 关系模型，幂等 upsert，重复同步不产生重复行。
3. **整理层（digest + 树索引 + 向量）**：在归档之上做轻量二次整理——LLM 压缩摘要、确定性项目归类、可选向量。这一层**全部可降级**：没有模型服务时归档与浏览不受影响，向量不可用时检索退化为纯全文。

这样设计的原因：原始数据是唯一的真相来源，必须零风险；而 LLM/embedding 是易失败、有成本的外部依赖，只能作为增强，不能成为采集链路的单点。

## 适配器矩阵

`AgentPlatform = 'claude-code' | 'codex' | 'cursor' | 'kimi-code' | 'aider' | 'unknown'`。5 个适配器注册于 `adapters/AdapterManager.ts`：

| 平台 | 会话发现 | 解析 | WSL | vault 备份 |
|---|---|---|---|---|
| Codex | `~/.codex/sessions/**` 与 `~/.codex/archived_sessions/**` 的 `*.jsonl` | JSONL（response_item / event_msg / turn_context / compacted，兼容旧 Exec/Patch 事件） | ✅ | ✅ |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb`，否则 `workspaceStorage/*/state.vscdb`（macOS/Linux 有对应路径） | 只读 SQLite：`composerHeaders` → `composerData` → `bubbleId`，单库多会话批量解析 | ❌ | ❌（`shouldBackupSource=false`，不复制整个 Cursor 库） |
| Kimi Code | `~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/<agentId>/wire.jsonl`（含 `agents/main` 主线与子代理线；兼容旧名 `~/.kimi`，优先 `$KIMI_CODE_HOME`） | wire protocol 1.4 扁平事件（context.append_message / append_loop_event / usage.record 等），兼容旧 envelope 协议（TurnBegin / ToolCall…） | ✅ | ✅ |
| Claude Code | `~/.claude/projects/**/*.jsonl`（含 `**/subagents/**`，子代理作为独立会话入库后由 `resolveSubagentLinks` 回链） | JSONL；另读 `~/.claude/usage-data/session-meta/<id>.json` 补元数据 | ✅ | ✅ |
| aider | 单文件 `~/.aider.chat.history.md` | Markdown：`# aider chat started at` 切会话，`#### USER/ASSISTANT` 切消息 | ✅ | ✅ |

注意：capture-core 注册了全部 5 个适配器，但 App 的默认采集清单 `PRIMARY_PLATFORMS = ['codex', 'cursor', 'kimi-code', 'claude-code']`（`src/main/captureService.ts`），aider 在 App 内暂未被同步/监听/WSL 轮询覆盖。

适配器对「home」无平台假设：`AdapterManager.setWslHomes()` 把每个 WSL home 以 `{ host: 'wsl:<distro>', homeDir: <UNC> }` 注入，与原生 home 走同一套发现逻辑。

监听使用 chokidar（`ignoreInitial`，`awaitWriteFinish` 500ms 稳定阈值，排除 `**/subagents/**`），文件事件按 `platform:filePath` 串行排队入库。

## 统一数据模型

SQLite（better-sqlite3，WAL + 外键）。核心表：

| 表 | 要点 |
|---|---|
| `work_sessions` | 一行一个会话。主键 `{platform}:{sessionId}`（WSL 侧 id 已重写）。含 project_path、git_branch、model(s)、title/summary/tags、起止与活跃时间、消息/工具/代码块/轮次计数、四类 token 累计、`has_subagents`、`has_context_compaction`、`session_type`、`host` |
| `turns` | 会话内轮次：用户输入 + AI 应答 + 轮级 token/耗时 |
| `messages` | 消息级全量：role、文本/思考/工具名/工具输入输出、`cwd`、五类 token、`parent_id`/`depth`/`is_sidechain`（子代理链）、时间戳。外键 CASCADE |
| `tool_executions` | 工具调用对（use + result）：工具名、分类、outcome、输入/输出摘要、exit_code、耗时 |
| `subagent_links` / `context_compactions` / `system_events` | 子代理父子链、上下文压缩事件、系统事件；同步末尾会用 `sync_state.conversation_id` 反查补全子代理链 |
| `sync_state` | 增量游标：`file_path` 主键，`last_position`（文件大小）、`last_modified`（mtime）、所属 session/conversation |
| `session_digests` | 每会话 digest：`one_liner`、`key_topics`、`key_files`、`decisions`、`open_questions`、`embedding`（BLOB）、`embedding_status`、`digest_version`、`message_count` |
| `project_registry` | 项目注册表：`project_key` 主键、`kind`、`label`、`path_or_domain`、`first_seen`/`last_seen` |

全文检索虚表：`messages_fts`（content_text/thinking/tool_* 五列，external content）与 `sessions_fts`（title/summary），各配 insert/delete/update 触发器自动同步。

所有写入幂等（`ON CONFLICT DO UPDATE`），sync 计数取 `max(0, 新-旧)`。

## 增量同步与 vault

**增量判定是文件级 skip，不是字节级续解析**：`SyncEngine.syncFile` 比对 `sync_state`，`lastPosition === 文件大小 && lastModified >= mtimeMs` 则整文件跳过；否则全量重解析 + 幂等 upsert。解析器升级或 bug 修复后清 `sync_state` 即可强制全量重放。（claude-code parser 留有字节偏移增量接口 `parseIncremental`，当前无调用方。）

**vault**：`<数据目录>/vault/<platform>/raw/[wsl-<distro>/]<sessionId>.jsonl.gz`，gzip level 9 流式复制；目标 mtime 不旧于源则跳过；备份失败只记日志，不阻断入库。`sync_state` 存 SQLite 而不是 vault 目录。

## WSL 多 root 抽象

详见 [architecture.md](architecture.md)「WSL 检测与多 root 抽象」。要点：

- `WslDetector`：`wsl.exe -l -q`（UTF-16LE 启发式解码、容忍本地化输出）→ `\\wsl$`（回退 `\\wsl.localhost`）→ 枚举 `\home` 用户 + 探测 `\root` → 按平台特征目录判定来源。
- `PathResolver.hostFromPath()`：`native` 或 `wsl:<distro>`（distro 小写）。host 写入 `work_sessions.host`、参与 project key 哈希、作为 vault 子目录名（`:` 转 `-`）。
- id 重写：WSL 会话入库前 sessionId 变为 `wsl-<distro>-<原 id>`，避免与 native 同 id 撞主键。
- 9P 共享上文件事件不可靠：App 以 60 秒间隔对非 native 文件重走 `syncFile` 兜底（未变文件仅一次 stat）。

## 对话树索引与 project_registry

- project key 派生（`storage/projectRegistry.ts`）：`project_path` 归一化（正斜杠、收敛分隔符、Windows 盘符小写）为空则回退归一化 git remote，再空为 `'unknown'`；`project_key = 'cli_' + sha256(platform|host|basis) 前 16 位`。
- `project_registry` 由 `upsertWorkSession` 同步维护：`kind='cli_path'`，`label` 取路径末段，`first_seen`/`last_seen` 按 min/max 更新。
- `TreeIndex.buildConversationTree(db)` 是纯函数：一条 `work_sessions LEFT JOIN session_digests` SQL（`session_type='conversation'`，按最近活跃倒序）+ 内存装配成 来源(platform+host) → 项目 → 会话。无缓存、无事件监听，每次调用重算，registry/digest 缺失时会话仍出现（key 可独立重算，registry 仅补充展示信息）。浏览器来源不进此库，渲染层合并 `browser` 子树（项目键为 `web:<domain>`）。

## digest 管线与降级链

- 触发：同步实际入库后 2 秒防抖扫描 + 启动全量补扫。候选：无 digest 行 / `message_count` 增长 / `digest_version < DIGEST_VERSION`。
- 生成：串行队列（去重），取最近 60 条消息、6000 字符预算拼 transcript，`AgentService` 以 `digest` kind 请求 LLM，要求严格 JSON：`one_liner`（≤50 字）、`key_topics` / `key_files` / `decisions` / `open_questions`（各 ≤6 条）。解析容忍代码围栏；`one_liner` 截 200 字符、列表各截 8 条。
- embedding：LLM digest 成功后对 `one_liner + key_topics` 请求 embedding，Float32 小端序列化为 BLOB 入库，`embedding_status='ok'`。EmbeddingService 带熔断缓存：首次失败后标记不可用，直到设置变更，期间不再重复付失败代价；批量 32、超时 90 秒、默认模型 `text-embedding-3-small`。
- 降级链（逐级独立）：
  1. 无 API key / LLM 失败 / 输出非法（重试 2 次）→ 兜底行：首条用户消息前 100 字符作 `one_liner`，`embedding_status='skipped'`，不再尝试 embedding；
  2. embedding 单独失败 → `embedding_status='skipped'`，LLM 字段正常落库；
  3. 存储类意外异常 → 重试 2 次后写 `embedding_status='failed'` 行，仅当会话再增长才重试。
- 结论：digest 任一环节失败都不阻塞采集与会话浏览。

## 检索：FTS5 + RRF 向量融合

`search/SessionRecall.ts` 融合三个信号，各产出排序会话 id 列表后做标准 RRF：

```
score(session) = Σ 1 / (RRF_K + rank)，RRF_K = 60，平手按 id 字典序
```

1. `messages_fts` 命中（按会话去重，取前 30）；
2. `sessions_fts` 命中（title/summary，前 30）；
3. 向量候选：`embedding_status='ok'` 的 digest 与 query 向量做**暴力余弦相似度**（`search/VectorSearch.ts` 纯函数，无索引；BLOB 为 Float32 小端，维度由 embedding 模型决定，代码不做假设）。

FTS 查询由 Unicode token 加引号 OR 连接生成；`SearchEngine` 另有普通全文搜索，FTS MATCH 失败时回退 `LIKE`。无向量（无 key / 模型不支持 / 全量 skipped）时信号 3 为空，RRF 自动退化为双信号融合——向量是增强不是依赖。

## 与浏览器扩展导入的关系

扩展经 bridge 导入的网页端对话**不进入** capture SQLite：bridge 的 import 回调把数据包经 IPC 转发渲染进程，在渲染端 Dexie 按 `[platform+uuid]` 幂等合并。两套存储各自独立，在渲染层的会话树（CLI 子树 + browser 子树）与统计处合并呈现。因此扩展数据不参与本库的 digest/FTS/向量管线，也不触发 vault 备份。

## 迁移机制

见 [architecture.md](architecture.md)「数据库迁移机制」。约定摘要：`MIGRATIONS` 只增不改、`up` 幂等、`schema_migrations` 表记录、迁移与记录同事务。当前 v1–v3（`session_type`、`host`、`session_digests` + `project_registry`）。
