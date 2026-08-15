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
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb`（否则 `workspaceStorage/*/state.vscdb`）**加** `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`（Cursor 2.x agent 会话不再写 vscdb） | 只读 SQLite：`composerHeaders` → `composerData` → `bubbleId`；JSONL 转录 + `subagents/` 目录谱系 + chats 侧 meta 补全；同一会话两库并存时 vscdb 优先。`parserVersion=2` | ❌ | ❌（`shouldBackupSource=false`，不复制整个 Cursor 库） |
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
| `subagent_links` / `context_compactions` / `system_events` | 子代理父子链（含 `agent_role` 角色标签）、上下文压缩事件、系统事件；child 侧解析见下节「子代理链接解析」 |
| `sync_state` | 增量游标：`file_path` 主键，`last_position`（文件大小）、`last_modified`（mtime）、所属 session/conversation、`parser_version`（v7：写入时的适配器解析器版本） |
| `session_digests` | 每会话 digest：`one_liner`、`key_topics`、`key_files`、`decisions`、`open_questions`、`embedding`（BLOB）、`embedding_status`、`digest_version`、`message_count` |
| `project_registry` | 项目注册表：`project_key` 主键、`kind`、`label`、`path_or_domain`、`first_seen`/`last_seen` |

全文检索虚表：`messages_fts`（content_text/thinking/tool_* 五列，external content）与 `sessions_fts`（title/summary），各配 insert/delete/update 触发器自动同步。schema v5 起两张表使用 **trigram tokenizer**（迁移 5 运行时探测、重建并全量回填；unicode61 会把整段 CJK 连写当作一个 token，中文事实对分写查询完全不可见；trigram 的 3 字滑窗使 ≥3 字 CJK 子串可匹配）。探测不到 trigram 的 SQLite 构建会跳过迁移并在 `schema_migrations.note` 记录原因，保持 unicode61。

所有写入幂等（`ON CONFLICT DO UPDATE`），sync 计数取 `max(0, 新-旧)`。

## 增量同步与 vault

**增量判定是文件级 skip，不是字节级续解析**：`SyncEngine.syncFile` 比对 `sync_state`，`lastPosition === 文件大小 && lastModified >= mtimeMs && parser_version 不低于适配器当前版本` 则整文件跳过；否则全量重解析 + 幂等 upsert。解析器升级只需 bump 适配器的 `parserVersion`（如 Cursor v2：子代理谱系 + 用量估算），旧文件自动重放一次——2026-07-22 的教训：没有版本项时，「文件没变就跳过」把升级前的解析结果永久冻结（Cursor 全局库 13 个子代理修完 parser 仍不建链）。（claude-code parser 留有字节偏移增量接口 `parseIncremental`，当前无调用方。）

**vault**：`<数据目录>/vault/<platform>/raw/[wsl-<distro>/]<sessionId>.jsonl.gz`，gzip level 9 流式复制；目标 mtime 不旧于源则跳过；备份失败只记日志，不阻断入库。`sync_state` 存 SQLite 而不是 vault 目录。

## 子代理链接解析（resolveSubagentLinks）

链接行在**父会话**同步时写入（child 侧为 NULL），child 只有在子代理转录自身进了 `sync_state` 之后才能反查补全。因此 `SyncEngine.resolveSubagentLinks()` 是公开方法，**每条同步路径末尾都必须调用**（全量扫描、文件监听、WSL 轮询——App 侧统一经 `captureService.resolveSubagentLinksSafe()`，失败不阻断同步）。两遍解析：

1. 用 `sync_state.conversation_id` 反查未解析链接（file_path 容忍正反斜杠差异）；
2. 仍未解析且文件在盘上的（典型：监听排除了 `**/subagents/**`，子代理转录从未被同步过），**按需 syncFile 补同步**后重试一遍。

Cursor 是例外：父子 composer 同库同批解析，`attachLineage` 在解析期就写好 `childSessionId`（`cursor:<childComposerId>`），不经过文件路径反查；headless 子代理（empty-window 无工作区）继承父 `projectPath`，角色（`subagentTypeName`）落 `agent_role`。

无 LLM、纯确定性；空闲时代价是一条 SELECT。审计与修复前后对比见 Bench T（`docs/bench/out/bench-t-*.md`）：修复前真实库 125/125 条链接未解析、全部子代理泄漏为顶层对话；修复后 138/138 解析、挂载率 100%。

**下游折叠合约（2026-07-21）**：解析出的链接经三个面向下游生效——
1. `exportConversations` 给子代理会话盖 `_subagent_of` / `_agent_role` 印章（一次 `getSubagentLineageByChild()` 查询），渲染端 Dexie 镜像随行携带，`listConversations` 默认排除（library 以 `includeSubagents: true` 拿全量自行折叠）；
2. `getStats` / `getSessions`：对话计数只数 main（`id NOT IN (subagent children)` 或条件聚合），消息/token 总量保留全部；
3. 复用面：`agentService.buildTranscript` 尾部追加 `[子代理工作摘要]` 块，`relayContext` 会话头带有界子代理 rollup，`vesti_timeline` 返回 `subagents` 列表——折叠不等于丢失，委派工作以 digest 简报形态保持可见。详见 `docs/memory-system/design.md`「下游消费与复用」。

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
- 子代理归属折叠（A1）：出现在 `subagent_links` child 侧的会话标记 `role='subagent'`，挂载到同来源/项目内父会话的 `children` 数组（附 digest 字段，按活跃倒序），项目会话列表只含 main 会话。父节点聚合 `childCount`（直接子代理数）与 `descendantMessageCount`（全部后代消息数，支持子代理嵌套）；父会话缺失、跨项目链接或链接成环的子代理按 main 兜底并标 `orphan: true`。计数口径随之统一：来源/项目计数只算 main，子代理折叠进父节点徽章。`SessionRecall` 同口径：FTS/向量命中子代理时结果归属父会话条目（`hitSource='subagent'` + `attributedSessionId` + `subagentSessionId`），父会话已有直接命中时折叠计分不另列。渲染层 library 列表默认只列 main，父卡片下「N 个子代理」展开条进入子代理会话；父 digest 头部 chips 追加子代理 `key_topics` 去重合并（≤5 条，只读拼装不写库）。

## digest 管线与降级链

- 触发：同步实际入库后 2 秒防抖扫描 + 启动全量补扫。候选：无 digest 行 / `message_count` 增长 / `digest_version < DIGEST_VERSION`。
- 生成：串行队列（去重），取最近 60 条消息、6000 字符预算拼 transcript，`AgentService` 以 `digest` kind 请求 LLM，要求严格 JSON：`one_liner`（≤50 字）、`key_topics` / `key_files` / `decisions` / `open_questions`（各 ≤6 条）。解析容忍代码围栏；`one_liner` 截 200 字符、列表各截 8 条。
- embedding：LLM digest 成功后对 `one_liner + key_topics` 请求 embedding，Float32 小端序列化为 BLOB 入库，`embedding_status='ok'`。EmbeddingService 带熔断缓存：首次失败后标记不可用，直到设置变更，期间不再重复付失败代价；批量 32、超时 90 秒、默认模型 `text-embedding-3-small`。
- 降级链（逐级独立）：
  1. 无 API key / LLM 失败 / 输出非法（重试 2 次）→ 兜底行：首条用户消息前 100 字符作 `one_liner`，`embedding_status='skipped'`，不再尝试 embedding；
  2. embedding 单独失败 → `embedding_status='skipped'`，LLM 字段正常落库；
  3. 存储类意外异常 → 重试 2 次后写 `embedding_status='failed'` 行，仅当会话再增长才重试。
- 退化语义（v6 修订）：`'degraded'` **只**表示「LLM 解析成功但内容仍是用户 prompt 的复读」（`isDegradedDigest` 判定），是内容级终态；LLM 不可达/输出不可解析一律留 `'skipped'`（可恢复态），LLM 恢复健康后下一轮扫描自动重生成。防风暴：每会话每次 App 运行只做一次退化重试（`degradedAttempted` 集合）。迁移 v6 把旧语义下误锁为 `'degraded'` 的存量行（实测 160/161）批量改回 `'skipped'`。
- 结论：digest 任一环节失败都不阻塞采集与会话浏览。

## 检索：FTS5 + RRF 向量融合

`search/SessionRecall.ts` 融合三个信号，各产出排序会话 id 列表后做标准 RRF：

```
score(session) = Σ 1 / (RRF_K + rank)，RRF_K = 60，平手按 id 字典序
```

1. `messages_fts` 命中（按会话去重，取前 30）；
2. `sessions_fts` 命中（title/summary，前 30）；
3. 向量候选：`embedding_status='ok'` 的 digest 与 query 向量做**暴力余弦相似度**（`search/VectorSearch.ts` 纯函数，无索引；BLOB 为 Float32 小端，维度由 embedding 模型决定，代码不做假设）。

FTS 查询由 Unicode token 加引号 OR 连接生成（trigram 下另有短 token 合并 span：连续 <3 字符 token 按原文分隔符合并成逐字 span 分支，如 `CI 平台`；单独的 <3 字符 token 在 trigram 下不可匹配，直接丢弃）；`SearchEngine` 另有普通全文搜索，FTS MATCH 失败时回退 `LIKE`。无向量（无 key / 模型不支持 / 全量 skipped）时信号 3 为空，RRF 自动退化为双信号融合——向量是增强不是依赖。

RRF 融合后再做两项后处理（bench 依据见 `docs/bench/after-trigram-2026-07-19.md`）：

- **时序衰减**：`score' = rrf × (0.9 + 0.1·exp(−ageDays/90))`，按会话 `last_activity_at`。地板 0.9 把近因摆动限制在 ≤10%（RRF k=60 顶部相邻位次仅差 ~2%，更深的地板会让新噪声压过词法上明显更优的旧命中）；知识更新对词法得分接近，几个百分点的摆动足以让新值排在旧值前。
- **confidence 拒答信号**：每命中带 `confidence: 'high'|'low'`——查询无可匹配 token（如全是 <3 字符 token），或最佳命中消息逐字覆盖的可匹配单元（长 token + 内容性合并 span）占比低于 0.5 时标 low。RRF 分数本身无法区分诱饵与真命中（k=60 把分数压平），覆盖率是可用的判别信号；vesti-mcp 的 `vesti_search` 结果同样透出该字段。

## 与浏览器扩展导入的关系

扩展经 bridge 导入的网页端对话**不进入** capture SQLite：bridge 的 import 回调把数据包经 IPC 转发渲染进程，在渲染端 Dexie 按 `[platform+uuid]` 幂等合并。两套存储各自独立，在渲染层的会话树（CLI 子树 + browser 子树）与统计处合并呈现。因此扩展数据不参与本库的 digest/FTS/向量管线，也不触发 vault 备份。

## 迁移机制

见 [architecture.md](architecture.md)「数据库迁移机制」。约定摘要：`MIGRATIONS` 只增不改、`up` 幂等、`schema_migrations` 表记录、迁移与记录同事务；迁移可返回 note 字符串存入 `schema_migrations.note`（如探测失败跳过时记录原因）。当前 v1–v7（`session_type`、`host`、`session_digests` + `project_registry`、fork lineage + 分层项目记忆、FTS5 trigram 重建、degraded digest 重分类为 skipped、`sync_state.parser_version`）。

## 对外召回：vesti-mcp（MCP server）

`packages/vesti-mcp` 把本库的召回能力包装成 stdio MCP server，供 kimi-code / Claude Code / codex 等 agent 注册后自助检索历史会话。要点：

- `vesti_search_files` 的数据库查询适配仍在本包，纯路径提取、证据聚合和排序算法已由独立仓库 VESTI-SKILLS 的 `@vesti/search-files-core` 维护，并在构建时内联到单文件 MCP 产物中。

- 只读打开 `~/.vesti/db/vesti.db`（`VESTI_DB_PATH` 可覆盖）；不依赖 capture-core 与 better-sqlite3，改用 Node 内置 `node:sqlite`，规避桌面端 Electron ABI 原生模块的耦合。
- 三个工具对应三层渐进披露：`vesti_search`（会话级索引条目，复刻 `SessionRecall` 的 FTS5 + RRF 纯 FTS 路径——无 embedding 服务，向量信号自然缺席）→ `vesti_timeline`（turn 大纲；会话有子代理时附 `subagents` 列表——子会话 id、角色、one_liner，可用子会话 id 再调 timeline 下钻）→ `vesti_get_turns`（按 `max_chars` 截断的完整内容）。
- 注册方式与给 agent 的引导文本见 [packages/vesti-mcp/README.md](../packages/vesti-mcp/README.md)。
