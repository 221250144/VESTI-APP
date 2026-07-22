# 追踪树完整性修复报告（2026-07-21）

对应用户症状：**子 agent 被识别为独立对话**——树里每条子代理线都以顶层会话出现，而不是折叠在父会话之下。本轮定位出三个互相独立的根因，全部修复，并新增 Bench T 作为该维度的常驻评测。机器报告：[out/bench-t-2026-07-21.md](out/bench-t-2026-07-21.md)（增量路径）与 [out/bench-t-2026-07-21-full-resync.md](out/bench-t-2026-07-21-full-resync.md)（全量重放收敛态）。

## 结果先行

| 指标 | 修复前（current） | 修复后（full-resync after） |
| --- | --- | --- |
| subagent_links 解析率 | 0/125（0%） | 138/138（100%） |
| 泄漏为顶层对话的子代理 | 125 | 0 |
| 树挂载率 | 0% | 100% |
| orphan 降级节点 | 0 | 0 |
| Cursor 谱系链接 | 0（采不到） | 13（解析期直接建链） |

after 行不是模拟：Bench T 在真实库快照上跑的是与 App 相同的 `SyncEngine.syncPlatform + resolveSubagentLinks` dist 产物。

## 根因一：resolveSubagentLinks 从未被 App 调用（影响 125/125）

链接行在**父会话**同步时写入 `subagent_links`，此时 `child_session_id` 为 NULL；补全靠 `SyncEngine` 私有方法 `resolveSubagentLinks` 用 `sync_state.conversation_id` 反查。该方法只挂在 `syncAll` 末尾，而 App（`captureService`）从不走 `syncAll`——它逐平台调 `syncPlatform`、文件监听走 `syncFile`、WSL 轮询亦然。结果：链接行永远停在 NULL，`TreeIndex` 无从折叠，全部子代理按 main 呈现。

**修复**：方法公开化，App 三条同步路径（全量扫描 / 文件监听 / WSL 轮询）末尾统一经 `resolveSubagentLinksSafe` 调用（失败不阻断同步）。空闲时代价为一条 SELECT。

## 根因二：子代理转录可能从未被同步（监听排除 subagents 目录）

文件监听排除 `**/subagents/**`（避免高频小文件事件），代价是：只经监听路径入库的父会话，其子代理转录不在 `sync_state`，反查永远落空。

**修复**：`resolveSubagentLinks` 改两遍解析——第一遍 `sync_state` 反查；对仍未解析且转录文件在盘上的链接，**按需 `syncFile` 补同步**后重试。转录已删除的链接保持未解析且不报错（Bench T 单独统计 file-gone 类）。

## 根因三：Cursor 谱系字段完全未采集（影响 13 条）

Cursor 子代理是同库中的另一个 composer，谱系写在 `subagentInfo`（子侧 `parentComposerId`/`subagentTypeName`/`toolCallId`）与父侧 `subagentComposerIds` 数组，此前解析器一概不读；且 `composerHeaders.isSubagent` 在表里是整数 0/1，代码用 `=== true` 严格比较，连子代理标记本身都是丢的；headless 子代理跑在空窗口（`workspaceIdentifier.id === 'empty-window'`），无项目路径，即使建链也挂不进项目。

**修复**：解析器加 `attachLineage` 二遍扫描——双向汇总父子键、父侧直接写入 `childSessionId: cursor:<childId>`（同库同批解析，唯一不需要文件路径反查的平台）、`subagentTypeName` 落 `agent_role`、headless 子代理继承父 `projectPath`；整数/布尔两种取值都接受。实地建模详见 [../memory-system/agent-formats.md](../memory-system/agent-formats.md) Cursor 节。

## 顺带修复：digest 退化语义误锁（160/161）

审计中发现的旁支问题：退化重试的 LLM 调用因**任何**原因失败（含 LLM 不可达）都写 `embedding_status='degraded'`，而重扫只看 `'skipped'`——LLM 离线期间跑一轮就把行永久锁死，真实库 160/161 条 digest 被误锁。修复：`'degraded'` 收窄为「LLM 解析成功但内容仍是 prompt 复读」的内容级终态，传输/解析失败留 `'skipped'`（可恢复）；迁移 v6 批量改回存量误锁行；每会话每次运行至多一次退化重试防风暴。

## 渐进披露的配套增强

- 树节点：子代理带 `subagentRole` 角色标签（Cursor `generalPurpose`、Claude agent slug、kimi swarm item）。
- MCP `vesti_timeline`：会话有子代理时附 `subagents` 列表（子会话 id / 角色 / 标题 / one_liner），子会话 id 可再调 timeline 下钻——把树状层级接进 L3 定位层，agent 侧与 App 侧看到同一棵树。

## 验证

- 单元测试：capture-core（含新增 `SyncEngine.test.ts` 三例、Cursor 谱系解析一例、迁移 v6 一例）与 vesti-mcp（timeline subagents 一例）全部通过（Electron ABI 运行）。
- Bench T 两种模式复跑：增量路径 125/125 解析、挂载率 100%；全量重放 138/138（含 Cursor 新增 13 条）、泄漏 0。
- 真实 Cursor 库抽查：13 条链接全部解析、headless 子代理项目路径继承正确、树挂载 13/13。
