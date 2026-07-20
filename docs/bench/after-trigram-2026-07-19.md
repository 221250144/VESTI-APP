# 修复后报告：trigram + 时序衰减 + 拒答信号（2026-07-19）

对照 [baseline-2026-07-19.md](baseline-2026-07-19.md)。同一语料（corpus.mjs 重新生成，seed=42、60 会话/12 针/4 更新对/5 拒答探针，topK=5，纯 FTS 无向量），机器报告原文在 `docs/bench/out/bench-a-2026-07-19.{json,md}`。

修复内容：① 迁移 5 把 `messages_fts`/`sessions_fts` 重建为 **FTS5 trigram**（运行时探测，不可用则跳过并记 `schema_migrations.note`）；② RRF 融合后加**有界时序衰减**（τ=90 天，地板 0.9）；③ 命中带 **`confidence`** 拒答信号（查询 token 覆盖率启发式）；④ vesti-mcp 同步全部三项（按 `sqlite_master` 检测 tokenizer，老库 unicode61 走兼容路径）。

## 对比表

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| Recall@1（单针，n=12） | 83.3% | **100%** |
| Recall@5（单针） | 83.3% | **100%** |
| MRR | 0.833 | **1.000** |
| — 分写针（n=9） | 100% | 100%（不回退） |
| — CJK 连写针（n=3） | **33.3%** | **100%** |
| 多键双命中率（n=4） | 50% | **75%**（平均键命中 0.75 → 0.875） |
| 时序 top1=新值（n=4） | **25%** | **75%**（达标线 ≥75%） |
| 时序 top1=旧值 | **50%** | **0%** |
| 时序 新值排在旧值前 | 25% | **75%** |
| 拒答零结果率（n=5） | 40% | 40% |
| 拒答 top1 误导率 | 60% | 60%（见「拒答信号校准」） |
| confidence：误导 top1 标 low | —（无此信号） | **1/3** |
| confidence：真命中 top1 误标 low | — | 2/12（均为 env_var 型，见下） |

基线的三根失踪针全部找回：2 根 CJK 连写针（trigram 子串匹配）+ 「支付模块」类连写更新对中的单针形态；「CI 平台」针靠短 token 合并 span（`"CI 平台"` 逐字短语）命中。

## 关键取舍

**时序衰减地板从 0.5 改为 0.9（实测驱动）**。按任务建议的 `0.5 + 0.5·exp(−age/τ)` 首跑：Recall@1 跌到 **66.7%**（三根针被 8 天内的新噪声会话反超），违反「普通针回退 ≤5pp」约束。原因：RRF k=60 把顶部相邻位次压到仅差 ~2%（实测 top8 分数 0.0157→0.0126），最大 50% 的衰减摆动压过一切词法差距。改为 `0.9 + 0.1·exp(−age/90)` 后摆动 ≤10%（约 6 个 RRF 位次）：词法明显更优的旧命中保持领先（三根回退针全部回到 @1），而更新对词法得分本就接近，几个百分点的摆动足以让新值稳定压过旧值（3/4 对翻转，旧值 top1 归零）。τ=90 与地板均做成导出常量（`RECENCY_TAU_DAYS`/`RECENCY_FLOOR`）。

**英文/数字在 trigram 下不回退，但子串更宽松（已评估，可接受）**。trigram 下 quoted token 即子串短语：`'app'` 能中 `createApp`、`'memo'` 能中 `maxmemory`、`'256'` 能中 `256mb`。实测影响：近失噪声会话排名上升（top8 中噪声增多），但全部 9 根拉丁/英文针保持 @1，未造成回退。关于「精确短语包装」：FTS5 trigram 没有更严格的整词模式可用，quoted phrase 已是其最精确形态；我们转而把短语包装用在**短 token 合并 span**上（见下），收益明确。

**短 token 合并 span（查询侧，trigram 固有边界的修补）**。trigram 索引 3 字滑窗，<3 字符 token（`的`、`CI`、`v2`、`M3`、`平台`）单独永不可匹配——这会让「CI 平台」「M3 里程碑」类查询退化甚至归零。方案（`buildQueryPlan`）：连续短 token 按原文分隔符合并为逐字 span 分支（`CI 平台 选型` → `"CI 平台"`），仍不足 3 字的吸收邻近长 token 前缀（`M3 里程碑…` → `"M3 里"`）；长 token 分支全部保留，span 只是增量分支。孤立单短 token（如整句只有一个 `平台`）仍无解，属 trigram 固有边界，已用测试固化。

**拒答信号校准（coverage floor=0.5，诚实版结论）**。基线指出误导命中与真命中 RRF 分数完全相同（k=60 压平），分数阈值无区分能力——实测修复后依然如此，故 confidence 改用**查询可匹配单元的逐字覆盖率**：最佳命中消息覆盖 <50% 可匹配单元（长 token + 内容性合并 span；`的 xx` 类虚词 span 不计）或无有效 token → low。效果：3 条误导 top1 中 1 条被标 low（PostgreSQL 案，覆盖 1/3）；redis 案（2/4=0.5）与 staging 案（1/2=0.5）仍标 high——它们与 decision/owner/deadline 型真命中（也是 0.5）同点，阈值再抬高会把真命中误伤从 2/12 拉到约 6/12，不划算。scope 语义（「生产环境」vs「本地」）超出词法能力，留给下游阅读 snippet 或向量召回。误伤侧：2 根 env_var 针（`部署时 X 设置成了什么？` 的措辞 token 不逐字出现在陈述句中）被标 low，属已知假阳性模式。

## 真实库迁移验证

在真实库快照副本（`~/.vesti/db/vesti.db` 的 backup，106 会话 / 18,488 消息，schema v3）上跑 `DatabaseManager.initialize`：v4+v5 一并应用，总耗时 **3.5 秒**（含打开与 v4）；回填完整 `messages_fts` 18,488/18,488、`sessions_fts` 106/106；`schema_migrations` 记录 v5、`note=NULL`；trigram 生效，真实中文查询毫秒级返回。降级路径由单测覆盖（probe 注入 false → 跳过、返回原因、旧表不动）；`probeFtsTokenizer` 对不存在 tokenizer 返回 false。better-sqlite3 12.10（SQLite 3.53.1）与 node:sqlite（Node 24，SQLite 3.53.1）均探测通过。

## 测试与回归

- capture-core：106 → **122 全过**（Electron node vitest）。新增：迁移 5（新库 trigram / v4 老库升级回填完整 / 触发器重建后增量同步 / 探测降级跳过）、`buildQueryPlan` 合并 span、`recencyFactor` 数学、时序排序积分、confidence 高低置信、CJK 连写回归、孤立短 token 边界。
- vesti-mcp：23 → **33 全过**。新增 `tests/recall.test.ts`：tokenizer 检测（unicode61/trigram 双 fixture）、老库兼容查询、时序排序、trigram 库 CJK 连写、`vesti_search` 透出 confidence。
- 根 `tsc --noEmit` 通过；根 vitest 408 全过。

## 遗留事项

1. **「支付模块」更新对仍双双零命中**：查询是单个 12 字 CJK token，与陈述句的逐字重叠仅「支付模块」（4 字），不构成独立查询 token——需要 CJK 分词或向量召回（embedding 目前 100% skipped）才能解决；评估过查询侧 3 字块切分，通用块（「现在是」「了什么」）引入噪声风险大于收益，未采纳。基线同样 miss，非回退。
2. **redis/staging 诱饵 confidence=high**：覆盖率 0.5 与真命中同点不可分（见上）；snippet 仍含 scope 限定语的截断风险（基线短板 7 未动）。
3. **env_var 型真命中误标 low（2/12）**：问句措辞 token 不逐字出现的系统性假阳性。
4. **孤立 <3 字符 token 查询**（如单独搜「平台」）trigram 下零结果，固有边界。
5. bench C（digest 保真度）未重跑（任务范围外）；基线短板 4–6（digest 数值盲区/窗口/退化打标）未动。
