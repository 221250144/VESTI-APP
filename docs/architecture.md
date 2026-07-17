# VESTI APP 架构说明

更新时间：2026-07-17

## 技术选型

运行时锁定为 Electron 41.10.1；该版本的 ABI 145 有 `better-sqlite3` 12.10.0 官方预编译包，可避免要求开发机安装 Visual C++ 编译链。升级 Electron 前必须先确认 SQLite 预编译 ABI 覆盖。

桌面端采用 Electron + React + TypeScript。采集层以仓库内 workspace 包 `@vesti/capture-core` 存在，Cursor 读取 SQLite，Codex/Kimi 读取和监听 JSONL。Electron 主进程只依赖包接口，不依赖相邻的 CLI 目录，仓库可被单独克隆和构建。

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
Codex rollout JSONL ─┐
Cursor state.vscdb ──┼─> Adapter -> ParsedSession -> MessageConverter
Kimi wire.jsonl ─────┘                         │
                                               v
                                      ~/.vesti/db/vesti.db
                                               │
                   ┌───────────────────────────┴────────────────────┐
                   v                                                v
             CLI package consumer                            Electron main
                                                                    │ typed IPC
                                                                    v
                                                            React renderer
                                                                    │
                                              Summary / Explore / Network / Agent
```

### 采集层

- `AgentAdapter`：检测安装、发现源、单会话或多会话解析、监听路径。
- `ParsedSession`：平台无关中间协议，保留用户输入、AI 文本、可见思考摘要、工具调用、Token 和项目元数据。
- `SyncEngine`：变化检测、幂等 upsert、原始 vault 策略和统一入库。
- `MessageConverter`：生成 WorkSession、Turn、SessionMessage、ToolExecution、SystemEvent。

### 桌面主进程

`CaptureService` 是 APP 唯一的采集入口。`SettingsService` 负责版本化配置、数据目录和安全存储；`AgentService` 负责模型请求与本地结果。Renderer 不接触 Node.js、文件系统或数据库，只能调用白名单 IPC。

主进程同时持有 Windows 托盘、单实例锁、登录启动项和系统代理会话。关闭到托盘时窗口只被隐藏，采集服务继续运行；托盘菜单提供重新打开、同步、暂停采集和彻底退出。

### 消费层

当前已实现数据源状态、统计、会话列表、消息阅读、Summary 与 Explore。后续按 VESTI 插件现有代码迁移：

1. `embeddingService`、`vectorizationService`、`searchService`：检索。
2. Network / Notes：知识消费界面。
3. Gardener / Roundtable：Agent 编排与用户策展。

迁移时保留服务接口，只替换 `StorageApi` 实现：插件端使用 Dexie/Chrome Messaging，桌面端使用 SQLite IPC。

## 三个平台的首版策略

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

- `~/.kimi/sessions/<work-hash>/<session-id>/wire.jsonl`。
- 支持 Turn、ContentPart、ToolCall/ToolResult、StatusUpdate、Subagent、Compaction。
- 解析器来自 CLI 已有实现；仍需在装有 Kimi Code 的 Windows/macOS/Linux 环境补脱敏 fixture。

## 安全与隐私

- Renderer 开启 `contextIsolation` 和 sandbox，关闭 `nodeIntegration`。
- APP 只加载本地打包资源，拦截页面导航和新窗口。
- 浏览、同步和归档不上传会话。主动运行 Summary / Explore 时，会向用户选择的模型服务发送所选会话；设置页可排除思考摘要和工具详情。
- API Key 通过 Electron `safeStorage` 加密，Renderer 只知道是否已配置。
- 模型网络默认使用 Chromium 系统代理栈，也可显式选择直连或固定代理。
- 不读取凭据，不做键盘监听、屏幕录制或进程注入。

## 下一阶段

1. 建立三平台脱敏 fixture 和 schema 回归测试。
2. 将 `@vesti/capture-core` 发布为独立的版本化内部包，并让 CLI 迁移到同一包接口。
3. 增加 migration 版本表和 capture diagnostics，记录未知事件与解析覆盖率。
4. 优先迁移 Summary、全文检索、Explore。
5. 增加 VESTI 插件 `vesti_export.v1` 导入与双端去重。
