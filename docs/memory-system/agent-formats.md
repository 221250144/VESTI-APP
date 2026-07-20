# 各大 Agent 存储规范建模

更新时间：2026-07-19

调研归档：对六款主流 AI 编程 agent 的本地会话存储格式做横向建模。凡 VESTI 已采集的平台（Claude Code / Kimi Code / Codex / Cursor / aider），条目与 `packages/capture-core/src/adapters/` 的解析器实现核对一致；Gemini CLI 未采集，条目来自公开文档口径，仅作参照。

## Claude Code

**存储路径与目录结构**

- 会话：`~/.claude/projects/<项目路径 slug>/<sessionId>.jsonl`，一个项目一个目录，一个会话一个文件。
- 子代理：同目录下 `subagents/agent-<agentId>.jsonl`。
- 元数据补充：`~/.claude/usage-data/session-meta/<sessionId>.json`。
- 每行 JSON 带 `version` 字段，可从最新会话首行检测 CLI 版本。

**会话文件格式与协议**

JSONL 事件流，行类型含 user / assistant（含 thinking、tool_use、tool_result 块）与系统行；行内携带 `cwd`、`gitBranch`、`uuid`/`parentUuid`（树状消息链）、`isSidechain`（子代理侧链标记）等字段。

**子代理组织与关联键**

子代理转录独立成文件，关联键是 `agentId`：文件名 `agent-<agentId>.jsonl`，主会话消息内的 `agentId`/`slug` 字段指回同一键。子代理消息在主会话中以 `isSidechain` 区分。

**文件级信息**

行内 `cwd`/`gitBranch` 提供定位；文件编辑以 Edit/Write 等工具调用行（tool_use + tool_result）记录，无独立文件快照层——恢复依赖 git 与交互式 rewind。

**记忆机制**

CLAUDE.md 分层加载：项目 `./CLAUDE.md`、用户级 `~/.claude/CLAUDE.md`，支持 `@path` 导入；`.claude/agents/*.md` 定义具名子代理；hooks 配置在 settings 中。

**压缩与恢复机制**

auto-compact：上下文将满时自动压缩并在会话流中留下压缩事件（VESTI 采集为 `context_compactions` 行）；`/compact` 手动触发；`/resume` 恢复历史会话。

## Kimi Code

**存储路径与目录结构**

- 会话根：`~/.kimi-code/sessions/<workDirKey>/<sessionId>/`（home 解析顺序：`$KIMI_CODE_HOME` → `~/.kimi-code` → 旧名 `~/.kimi` 兜底探测）。
- 目录内：`state.json`（标题、workDir、agents 表、forkedFrom）+ `agents/<agentId>/wire.jsonl`（每个 agent 一条线，`agents/main` 为主线）。
- `~/.kimi-code/session_index.jsonl` 与 `workspaces.json` 可回推工作目录。

**会话文件格式与协议**

wire protocol 1.4 扁平事件流（JSONL）：`context.append_message`、`context.append_loop_event`（step / content.part / tool.call / tool.result）、`usage.record`、`llm.request`；兼容旧 envelope 协议（TurnBegin / ContentPart / ToolCall / StatusUpdate / Subagent / Compaction）。

**子代理组织与关联键**

天然目录归属：子代理与主线同处一个 `<sessionId>/` 目录，按 `agents/<agentId>/` 分线，`state.json` 的 agents 表登记各线元信息（type、swarmItem）。关联键 = 目录 + agentId，无需跨文件回链。

**文件级信息**

文件操作体现在 wire 的 tool.call / tool.result 事件参数中；`state.json` 的 `workDir` 给出项目锚点。

**记忆机制**

AGENTS.md 项目级指令文件；MCP 配置 `~/.kimi-code/mcp.json`（用户级）/ `.kimi-code/mcp.json`（项目级）。

**压缩与恢复机制**

压缩是协议内事件（旧 envelope 的 Compaction 类事件）；`state.json` 的 `forkedFrom` 显式记录 fork 谱系（父 sessionId），是六个平台中唯一自带谱系字段的实现。

## Codex CLI

**存储路径与目录结构**

- `~/.codex/sessions/YYYY/MM/DD/rollout-<时间戳>-<uuid>.jsonl`，按日期分层；`~/.codex/archived_sessions/` 存归档。

**会话文件格式与协议**

rollout JSONL：首行 `session_meta`（cli_version、cwd、git 等），正文为 `response_item` / `event_msg` / `turn_context` / `compacted` 行；兼容旧版 `ExecCommandBegin/End`、`PatchApplyBegin/End`；加密 reasoning（`encrypted_content`）不可读，只有公开 summary 可见。

**子代理组织与关联键**

无独立子代理文件层；多 agent 协作在 rollout 内以事件形式展开，父子关系不走文件组织。

**文件级信息**

`session_meta` 携带 git 信息；补丁经 apply_patch / PatchApply 事件记录；`turn_context` 记录每轮 cwd、模型与审批策略。无文件快照层，恢复依赖 git。

**记忆机制**

AGENTS.md 项目级指令（可嵌套覆盖），全局配置 `~/.codex/config.toml`。

**压缩与恢复机制**

`/compact` 产生 `compacted` 行（摘要替换前文）；`fork`/`resume` 会**把父会话全部历史复制进子 rollout**——文件层无任何谱系字段（已在 cli 0.144.5 上核实 session_meta 不含 lineage），谱系只能靠消息 id 重叠事后检测。

## Cursor

**存储路径与目录结构**

- 全局库：`<User>/globalStorage/state.vscdb`（Windows `%APPDATA%/Cursor/User/...`，macOS/Linux 有对应路径）；工作区级：`workspaceStorage/*/state.vscdb`。
- 一个 SQLite 文件内含多个会话，需批量解析。

**会话文件格式与协议**

不是文件协议而是 KV 存储：`cursorDiskKV` 表 key 分层——`composerData:<composerId>`（会话体）→ `bubbleId:<composerId>:<bubbleId>`（消息气泡）；会话头在 `composerHeaders` 表（或旧版 `ItemTable` 的 `composer.composerHeaders`），含 `createdAt`/`lastUpdatedAt`/`isArchived`/`isSubagent`。bubble 内含 thinking、modelInfo 等。

**子代理组织与关联键**

子代理会话同为 composer，以 `composerHeaders.isSubagent` 标记；层级靠 composerId / bubbleId 复合 key 维持。

**文件级信息**

编辑历史与 checkpoint 存于同一 KV 体系（checkpoint 机制支持回滚文件改动）；**整个 KV schema 不是稳定公开 API，每个大版本必须用脱敏样本回归**。

**记忆机制**

`.cursor/rules/` 项目规则目录（旧名 `.cursorrules`）；编辑器内置 Memories 功能。

**压缩与恢复机制**

checkpoint 恢复文件状态；会话侧无显式 compact 事件暴露给采集方。

## Gemini CLI

（未采集，公开文档口径）

- 存储：`~/.gemini/` 下按项目分目录保存 chat 会话 JSON；`/chat save|list|resume|delete` 管理命名会话。
- 会话格式：单会话单 JSON 文件，记录消息序列与工具调用。
- 子代理：无独立的子代理文件组织约定。
- 文件级信息：checkpointing（settings 开启）在工具改文件前保存文件快照，`/restore` 可回滚到指定工具调用点。
- 记忆机制：GEMINI.md 分层上下文文件（全局 `~/.gemini/GEMINI.md` + 项目级），`/memory` 命令查看与追加。
- 压缩与恢复：checkpoint 同时覆盖对话与文件状态恢复。

## Aider

**存储路径与目录结构**

- 单文件全局聊天日志 `~/.aider.chat.history.md`；配套 `.aider.input.history`（输入历史）。

**会话文件格式与协议**

Markdown 而非 JSONL：`# aider chat started at <时间>` 切分会话，`#### USER` / `#### ASSISTANT` 切分消息。人读友好，机器解析靠标题约定。

**子代理组织与关联键**

无子代理概念。

**文件级信息**

与 git 深度绑定：每轮编辑自动 commit（可被 `/undo` 回滚）；repo-map 提供仓库结构视图。文件级真相在 git 历史，不在聊天日志。

**记忆机制**

约定文件（如 CONVENTIONS.md）作为常驻上下文；`.aider.conf.yml` 配置。

**压缩与恢复机制**

`/clear`、`/drop` 控制上下文；上下文超限时自动摘要聊天历史；恢复完全走 git。

## 横向对比

| 平台 | 会话模型 | 子代理关联键 | 文件级信息 | 记忆机制 | 压缩与恢复 |
|---|---|---|---|---|---|
| Claude Code | 单会话单 JSONL + `subagents/` | `agentId`（文件名 + 消息字段） | cwd/gitBranch 行内字段；编辑=工具行 | CLAUDE.md 分层 + imports | auto-compact 事件；resume/rewind |
| Kimi Code | 会话目录多线（`agents/<id>/wire.jsonl`） | 目录归属 + `agents` 表 | state.json workDir；tool.call 事件 | AGENTS.md | 协议内压缩事件；`forkedFrom` 显式谱系 |
| Codex CLI | 单会话单 rollout JSONL | 无文件层 | session_meta git；patch 事件 | AGENTS.md + config.toml | `compacted` 行；fork 复制父历史（无谱系字段） |
| Cursor | 单库多会话（SQLite KV） | composerId/bubbleId 复合 key；`isSubagent` 头 | KV 内 checkpoint | `.cursor/rules/` + Memories | checkpoint 回滚 |
| Gemini CLI | 单会话单 JSON | 无约定 | checkpoint 文件快照 | GEMINI.md 分层 | checkpoint 恢复对话+文件 |
| Aider | 全局单 Markdown | 无 | git commit 即真相 | CONVENTIONS.md 约定文件 | /clear、自动摘要；git 恢复 |

## VESTI 的取舍

采集层不追求还原各家全部特性，只取四类可标准化、可跨平台对齐的信息：

1. **kimi 目录归属**：`<workDirKey>/<sessionId>/agents/<agentId>/` 的目录结构天然给出「项目 → 会话 → 子代理」三级，子代理线解析为独立会话后经 `subagent_links` 挂回主线；`state.json.forkedFrom` 直接映射为 `work_sessions.forked_from`（显式谱系，免检测）。
2. **claude agentId 链接**：以 `agentId` 为键建 `subagent_links`（file_path 记录子代理转录文件），同步末尾 `resolveSubagentLinks` 用 `sync_state.conversation_id` 反查补全 `child_session_id`；入库后树索引与召回统一做 A1 归属折叠。
3. **codex fork 检测**：接受「文件层无谱系」的现实，fork/resume 复制父历史这一行为本身成为检测信号——`refreshForkLineage` 按消息 id 重叠（≥5 条共享且占子会话 ≥50%）事后补边；消息去重键剥离 codex 的按会话命名空间前缀，使 fork 副本共享同一键。
4. **cursor bubble 层级**：`composerHeaders → composerData:<id> → bubbleId:<composerId>:<bubbleId>` 三级 key 映射为 会话 → 消息；`isSubagent` 头字段映射为子代理标记。整个 Cursor 解析按「非稳定 API」对待：只读打开、不复制库、逐版本回归。

不采集的部分：各家 rules/CLAUDE.md/AGENTS.md 记忆文件（属于项目仓库而非会话归档）、Cursor 内部 checkpoint、加密 reasoning——前者交给 git，中者无公开格式，后者本不可读。
