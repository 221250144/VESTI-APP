# 分级说明系统设计（L0–L3）

更新时间：2026-07-21（子代理归属修复 + timeline 子代理线 + degraded 语义修订）

适用范围：记忆系统 v2 的分层设计与取舍说明，实现位于 `packages/capture-core/src/{state,search,tree,storage}/`、`src/main/{digestService,projectMemoryService}.ts` 与 `packages/vesti-mcp`。本文写「是什么/为什么」，字段级细节以代码为准；评测依据见 [bench.md](bench.md)。

## 设计目标

同一套分层要同时服务三种消费方式：

1. **知识库视图**：App 会话树要让人一眼看到「项目现在是什么状态」，而不是一堆会话标题。
2. **下游需求**：Summary / Explore / 接力 / 沉淀区等 Agent 任务需要成本可控的上下文输入——先拿摘要，不够再取原文。
3. **agent 长期记忆**：外部 coding agent 经 MCP 自助召回历史会话，同样要求渐进披露，不能把整个库塞进上下文。

三种消费的共同约束：VESTI 是本地归档系统，**原始数据是唯一的真相来源**，LLM 是易失败、有成本的增强。因此分层的第一原则是「确定性层在下、LLM 层在上，上层全灭时下层仍然可用」。

## 分层定义

```text
L0  project_state     常驻索引层   每项目一张「当前状态卡」，确定性生成，永不失效
L1  session_digests   会话摘要层   每会话五要素 + 可选 embedding，带失效语义与访问计数
L2  project_briefs    结构化巩固层 LLM 维护的跨会话项目简报，版本化，可降级
L3  messages / vault  原文层       消息全量 + 源文件 gzip 备份，只增不改
```

### L0 常驻索引层：project_state

每项目一行的「当前状态卡」（`state/projectState.ts` 生成，`DatabaseManager.rebuildProjectStates` 落库）：

| 字段 | 内容 |
|---|---|
| `one_liner` | 最新一条会话 digest 的一句话摘要 |
| `active_files` | 近 30 天 `tool_executions` 中规则抽取的文件路径，按 触碰次数 → 最近触碰 → 路径字典序 取前 10 |
| `open_questions` | 最近 5 条 digest 的未决问题合并去重，上限 8 条 |
| `session_count` / `last_active` / `updated_at` | 纯聚合 |

更新时机：挂在采集同步完成信号之后（5 秒防抖），每次**全量重写**所有项目卡。它是纯 SQL + JS 的确定性计算，无 LLM、无事件订阅、无增量状态——所以**不失效、只重写**：没有 valid_to，没有脏标记，重建即真理。文件路径抽取是正则式的（`extractFilePaths`），不依赖 LLM 的 key_files 判断，代价是可能漏掉无扩展名路径，换来可复现。

### L1 会话摘要层：session_digests

每会话一条 digest，五要素：`one_liner`（≤50 字）、`key_topics`、`key_files`、`decisions`、`open_questions`（各 ≤6 条，严格 JSON）。生成管线：同步后 2 秒防抖扫描候选（无 digest 行 / 消息数增长 / `digest_version` 落后），取最近 60 条消息、6000 字符预算拼 transcript 请求 LLM；成功后对 `one_liner + key_topics` 求 embedding（Float32 小端 BLOB，`embedding_status='ok'`）。

失效语义（v4 迁移加入的列）：

- `valid_from` / `valid_to`：digest 所描述内容的时间区间——为「知识更新后旧摘要作废」预留；
- `superseded_by`：指向取代本 digest 的新 digest；
- `access_count`：访问计数，MCP `vesti_search` 每命中一次 +1，供时序/热度排序使用（这是 vesti-mcp 唯一的写操作，pre-v4 库上静默跳过）。

口径说明：三列失效语义当前是** schema 级预留**——尚无写入方，digest 重写仍走同行 upsert；`access_count` 已在 MCP 侧生效。把失效语义做进 schema 而不急于做写入方，是因为「何时作废一条摘要」需要评测支撑（见 bench 的时序探针），先把列定义钉死，避免二次迁移。

### L2 结构化巩固层：project_briefs

LLM 维护的跨会话项目简报（`src/main/projectMemoryService.ts`），一项目一份、版本化（`version` 单调递增，`last_ops` 记录最近一次合并操作日志）：

- **触发**：与 digest 同一同步完成信号，5 秒防抖；每轮扫描先 `refreshForkLineage`（见下）、再确定性重建全部 L0，然后挑出「digest 有更新且距上次维护 ≥10 分钟」的项目，每轮最多维护 2 个（成本闸门）。
- **distill + maintain 两步**：先以 `distill` kind（template `project_state`）对「L0 状态卡 + 项目全部 digest（新→旧，12000 字符预算）」做蒸馏；若已有旧版简报，再走 `deposit-maintain` 做 mem0 式合并——输入旧简报 + 新蒸馏，输出合并后全文与最小操作集（ops），而不是整篇重写。ops 存 `last_ops` 供审计。
- **文件时间线**（`state/fileTimeline.ts`）：L2 的确定性支撑查询——某文件在项目全部会话中的每次触碰（哪会话、何时、何工具、是否出错）。LIKE 预筛 + 路径抽取确认（basename / 全路径匹配），无 LLM，供简报与下游核事实用。

### L3 原文层：messages / vault

消息全量（文本/思考/工具名/工具输入输出、token、时间戳）幂等入库；源会话文件 gzip level 9 全量备份到 vault。**只增不改**：任何解析 bug 都可以通过清 `sync_state` 全量重放修复，上层（L0–L2）全部可由 L3 重建。

## 检索协议：渐进披露

```text
L0 直读 ──> L1 混合检索 ──> 下钻 L2（项目简报）/ L3（turn 大纲 → 原文）
```

- **L0 直读**：项目状态卡一次 SQL 读出，给「这个项目现在怎样」类问题。
- **L1 混合检索**（`search/SessionRecall.ts`）：`messages_fts` 命中（按会话去重，前 30）+ `sessions_fts` 命中（前 30）+ 可选 digest 向量候选（暴力余弦，无索引），三路排序列表做标准 RRF 融合（k=60，平手按 id 字典序）。无查询向量时向量路自然缺席，退化为双信号。
- **下钻 L3**：命中会话后先看 turn 大纲定位，再按预算取原文。

MCP 四工具映射（`packages/vesti-mcp`，stdio server，`node:sqlite` 只读打开）：

| 工具 | 层 | 成本 | 返回 |
|---|---|---|---|
| `vesti_project_brief(project)` | L0 + L2 | 一卡 + 一文 | 项目状态卡与维护版简报；项目名模糊匹配（精确 key > 精确 label > 子串） |
| `vesti_search(query, topK=8)` | L1 检索（snippet 来自 L3） | ~100 tokens/条 | 会话索引条目（标题/平台/项目/时间/one_liner/key_topics/snippet/分数），命中即 bump `access_count` |
| `vesti_timeline(session_id, around_turn?)` | L3 定位 | ~30 tokens/turn | turn 大纲：序号、时间、一句话用户意图、工具数、token；会话有子代理时附 `subagents` 列表（子会话 id / 角色 / one_liner），子会话 id 可再调 timeline 下钻——树状渐进披露的 MCP 面 |
| `vesti_get_turns(session_id, turn_ids\|range, max_chars=8000)` | L3 原文 | `max_chars` 封顶 | 所选 turn 的完整消息与工具摘要，超预算截断并标 `truncated` |

约定（README 中给 agent 的引导文本同样写明）：先 search 再 timeline 最后 get_turns，不允许不经定位直接取原文。

## 去重与谱系

**子代理归属（A1）的解析链**（2026-07-21 修复）：链接行在父会话同步时写入，child 侧靠 `SyncEngine.resolveSubagentLinks()` 补全——该方法此前只在 `syncAll` 内部调用而 App 从不走 `syncAll`，导致真实库 125/125 条链接全部未解析、所有子代理泄漏为顶层对话（Bench T current 行）。修复后它是公开方法，挂在 App 全部三条同步路径（全量/监听/WSL 轮询）末尾，且对「盘上存在但从未同步」的子代理转录按需补同步；Cursor 父子同库同批解析，`childSessionId` 解析期直接写入，另带 `agent_role` 角色标签（树节点显示 `subagentRole`）。修复后挂载率 100%（138/138），见 [../bench/out/bench-t-2026-07-21-full-resync.md](../bench/out/bench-t-2026-07-21-full-resync.md)。

两条谱系来源（`tree/forks.ts`）：

- **显式**：kimi `state.json.forkedFrom`，解析期映射为 `work_sessions.forked_from`；
- **检测**：codex `fork`/`resume` 把父历史整体复制进子 rollout，文件层无谱系字段（cli 0.144.5 已核实），故 `refreshForkLineage` 在同步后按消息 id 重叠补边：父子按开始时间定序，子会话与更早会话共享去重键 ≥5 且 ≥50% 时认亲，取共享最多者为父。父必早于子，环在构造上不可能。谱系一旦写入是粘性的（`forked_from = COALESCE(新值, 旧值)`），常规重同步不会冲掉。

消息去重键：codex 消息 id 带按会话命名空间（`codex-<sessionId>-message-<itemId>`），去重前剥离前缀；其他平台用原始 uuid，fork 复制时原样保留。

去重的三个消费点：

1. **树计数**（A1 + fork）：fork 链上重复消息只计在最早祖先，子会话显示 `uniqueMessageCount`/`duplicatedMessageCount`；子代理会话折叠进父节点，项目列表只列 main，父缺失/跨项目/成环时降级为 `orphan` main 节点。
2. **召回去重**：FTS 命中按去重键过滤，同一条消息的 fork 副本只保留排名最早的一份，不重复加会话、不覆盖 snippet。
3. **召回归属**（A1）：命中子代理会话时分数与 snippet 折叠进父会话条目（`hitSource='subagent'`），父会话不在库中才单列子代理。

## 下游消费与复用（A1 折叠合约，2026-07-21）

折叠只在树里做是不够的：仪表盘统计、Dexie 镜像列表、学习/AITI、自动分类、每日纪要等下游都各自读会话，子代理会泄漏为「未分类的顶层对话」。为此确立一条**折叠合约**，让所有下游用同一信号，而不是各自遍历树：

- **导出印章**：`exportConversations` 用一次 `subagent_links` 查询给每条导出会话盖 `_subagent_of`（父 work-session id）与 `_agent_role`。渲染端 Dexie 镜像随行携带；`captureSync` 指纹混入该字段，保证「链接晚于转录解析」时印章也能传播。
- **计数 vs 总量**：`getStats` 中对话**计数**（总数/平台/模型/每日/项目 Top）只数 main 会话；消息与 token **总量**保留全部（子代理的消耗真实发生）。`getSessions`（最近对话）过滤子代理。
- **渲染端默认排除**：`listConversations` 默认过滤 `_subagent_of`（学习模块、explore 起始牌、范围选择、周报、每日纪要、摘要覆盖率、自动分类候选全部随之收敛）；只有 library 以 `includeSubagents: true` 拿全量——它自己渲染折叠条并需要能打开子会话。`isSubagentConversation` 双信号：印章优先，树 lookup 兜底（覆盖印章出现前同步的旧记录）。

**复用面（渐进披露的下游延伸）**：折叠之后，被委派的工作不能从复用面上消失——

- **agent 转录**（`agentService.buildTranscript`）：单会话转录尾部追加 `[子代理工作摘要]` 块（角色/标题/消息数/digest 一句话，上限 12 行，绝不内联子转录），explore 问答与摘要生成因此能引用委派工作。
- **交接包/沉淀**（`relayContext.buildConversationHead`）：会话头新增有界子代理 rollup（4 行 + 折叠计数），数据来自树缓存中的子节点（标题 + one_liner），文件锚点继续经树折叠归属到父会话。
- **MCP**：`vesti_timeline` 的 `subagents` 列表（见上表）是同一披露层的 agent 面。

这与 OTel GenAI 的 span 树读法一致：父 span 汇总视图默认折叠子 span，但任何消费端都能沿 `parent_span_id`（此处 `_subagent_of` / `subagent_links`）按需下钻。

## 中文检索

**问题**（bench 基线短板 1，已实测）：FTS5 默认 unicode61 把整段 CJK 连写视作一个 token，查询与原文只要写法不逐字一致就**零召回**——连写针 Recall 33.3% vs 分写针 100%，而真实库 81/106 是中文为主的会话。

**决策与落地**：FTS 表已迁移到 FTS5 自带 trigram tokenizer（迁移 v5：运行时实测探测，不可用时跳过并在 `schema_migrations.note` 记录原因；可用则 DROP 旧表与触发器、trigram 重建、`'rebuild'` 全量回填）。trigram 下查询侧对连续 <3 字符 token 做逐字 span 合并（`buildQueryPlan`），unicode61 老库查询语法保持兼容。RRF 融合后另有有界时序衰减（τ=90 天、地板 0.9——更高衰减会压过词法差距，bench 实测否决）与命中置信度（`confidence:'high'|'low'`，按可匹配单元逐字覆盖率 <0.5 判定）。bench A 复跑对比（同 seed 同参数）：总 Recall@1/@5 83.3%→100%，CJK 连写针 33.3%→100% 且英文针不回退，时序题 top1=新值 25%→75%。详见 [../bench/after-trigram-2026-07-19.md](../bench/after-trigram-2026-07-19.md)。`SearchEngine` 普通全文搜索在 FTS MATCH 失败时回退 `LIKE` 子串匹配（兜底路径保留）。

## digest 质量

bench C 在真实库快照上测得（详见 [bench.md](bench.md)）：

- **数值保真**：数值类事实 digest 覆盖率仅 6.4%（决策句 31.1%、文件 26.7%），digest 当时只能回答主题级问题。已落地：digest prompt 增加数值保真硬规则（版本号/配置值/端口/日期/数量/金额原样保留，含反例），`digest_version` 升至 2 使存量自然重生成；窗口分析同时证明数值短板的瓶颈在 prompt 压缩而非窗口可见性（80% 数值事实本就在窗口内）。
- **窗口适配**：digest 输入原只看最近 ≤60 条、尾部 6000 字符，48% 事实落在窗口外；单条超大消息（实测最大 59246 字符）可吃光整个预算。已落地：`digestTranscript.ts` 自适应窗口（首条用户消息 400 字符 + 新者优先填充 + 阀外最近 10 条文件写操作回补 + >10k 超大消息头尾截断，预算 12000），真实快照静态重算事实可见性 51.8%→57.1%（最差广度 44 消息会话 1→39 条）。
- **退化检测**：7/106 digest 四字段全空（LLM 失败回退，one_liner 是首条用户消息截断），另有 2 条滞后于会话增长。已落地：`isDegradedDigest` 运行时判定（四字段全空 + one_liner 截断原文前缀/bigram Dice>0.8），LLM 已配置时重试一次。**语义修订（迁移 v6，2026-07-21）**：初版把「重试的 LLM 调用因任何原因失败」都写 `'degraded'`，而退化重扫只看 `'skipped'`——LLM 不可达期间跑一轮就把行永久锁死（真实库 160/161 被误锁）。现语义：`'degraded'` 仅指「LLM 解析成功但内容仍是 prompt 复读」（内容级终态）；传输/解析失败留 `'skipped'`（可恢复），配合每会话每次运行一次的重试上限防风暴；迁移 v6 把存量误锁行批量改回 `'skipped'`。

## 可降级原则

无 LLM（无 key / 服务失败）时每层的行为：

| 层 | 无 LLM 时行为 |
|---|---|
| L0 | 不受影响：纯确定性计算，照常重建 |
| L1 | digest 降级链逐级独立：LLM 失败 → 兜底行（首条用户消息前 100 字符，`embedding_status='skipped'`）；embedding 单独失败只缺向量字段；存储异常重试后标 `'failed'`。检索自动退化为纯 FTS（无向量信号） |
| L2 | 蒸馏/合并失败 → 简报落为 L0 状态卡的 Markdown 渲染，不空白；**已有 LLM 简报绝不被兜底内容覆盖**（失败时保留旧版） |
| L3 | 不受影响：采集、归档、浏览与 LLM 无关 |
| MCP | 无 embedding 服务 → 纯 FTS；pre-v4 库上 `access_count` 跳过、`project_state`/`project_briefs` 字段为 null 而非报错 |

任何一级失败都不阻塞采集——LLM 是增强，不是采集链路的单点。

## 与记忆系统方案的对照

| 方案 | 我们采用了 | 我们刻意不采用 |
|---|---|---|
| mem0 | 「维护操作」思想：L2 用 distill + maintain 合并（最小 ops + `last_ops` 审计），而非整篇重写 | 以向量库为主存储、记忆条目全走 LLM 抽取——VESTI 主存是 SQLite + FTS，LLM 只在 L1/L2 |
| Zep | 时序/失效语义：`valid_from`/`valid_to`/`superseded_by` 列（schema 预留） | **实体级知识图谱**：构建与维护成本高、本地小数据量收益有限、正确性难验证；用确定性文件时间线替代「实体关系」的高频用途 |
| MemGPT | 分层记忆 + 渐进披露：L0 直读 → L1 检索 → L3 下钻，对应其 main context / archival storage 的换页思想 | agent 自管理分页：VESTI 是归档检索系统，不是 agent 运行时内存，换页策略交给调用方 agent |
| claude-mem | 会话摘要作为记忆单元的形态参照（五要素 vs 其压缩摘要） | hook 进 agent 运行时自动注入：VESTI 走 MCP 让 agent 自助查询，不改写任何 agent 的会话路径 |

共同底线：L3 原文永远在，任何上层记忆都可在原文上重建——这与上述方案把摘要当作事实来源的做法相反，是本地归档场景下的刻意选择。
