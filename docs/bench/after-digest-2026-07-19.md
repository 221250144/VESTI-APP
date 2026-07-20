# digest 三类短板修复与 bench C 复跑（2026-07-19）

对应基线 `docs/bench/baseline-2026-07-19.md` 的短板 4（数值失明）、5（窗口结构性盲区）、6（退化 digest 静默）。机器报告：`docs/bench/out/bench-c-after-window-2026-07-19.{md,json}`（复跑命令见文末）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/main/digestTranscript.ts` | 新建：窗口组装纯函数（v2 策略，见下） |
| `src/main/digestService.ts` | DIGEST_VERSION 1→2；退化判定 `isDegradedDigest`（纯函数导出）；退化重排与放弃标记；`getDigestStats()` 统计透出 + 扫描后日志 |
| `src/main/agentPrompts.ts` | 仅 digest kind：数值保真硬规则（含反例）+ key_files 完整路径要求（relay/roundtable/prompt-improve/prompt-continue 区域未动） |
| `src/main/settingsService.ts` | 新增 `isLlmConfigured()`（demo_proxy 免 key / byok 看 encryptedApiKey） |
| `src/main.ts` | DigestService 第 4 参注入 `() => settings.isLlmConfigured()` |
| `packages/capture-core/src/types/unified.ts` | `DigestEmbeddingStatus` 增加 `'degraded'`；新增 `SessionDigestStats` |
| `packages/capture-core/src/storage/DatabaseManager.ts` | `listDegradedDigestCandidates()`（SQL 预筛）+ `getSessionDigestStats()`；**migrations.ts 未动**（迁移 5 属另一代理，无新列） |
| `src/main/captureService.ts` | 两个新方法的委托 |
| `src/main/digestTranscript.test.ts` | 新建：窗口组装 13 例 |
| `src/main/digestService.test.ts` | 退化判定 5 例 + 重排流程 4 例；FakeStore 补新方法 |
| `src/main/agentPrompts.test.ts` | digest prompt 数值规则断言 1 例 |
| `scripts/bench/bench-c.mjs` | v2 窗口镜像（逐字符复刻，含 kept-range 判定事实是否熬过截断）；精确退化判定；`--tag` 输出选项；事实 offset 跟踪 |
| `scripts/bench/{tool-names,fact-offsets,window-sweep}.mjs` | 新建：定参用一次性分析（真实工具名分布 / 事实偏移分布 / 窗口策略扫描） |

## ① 窗口盲区改善（静态重算，同一快照）

**事实可见性：51.8% → 57.1%（1264 → 1391 / 2438），盲区 48.2% → 42.9%。**

按类型（窗口内事实占比）：

| 类型 | v1 | v2 |
| --- | --- | --- |
| 决策句 | 40.9%（267/653） | **51.9%**（339/653） |
| 文件 | 44.6%（544/1219） | **50.9%**（621/1219） |
| 数值 | 80.0%（453/566） | 76.1%（431/566） |

窗口广度（最差会话）：44 消息会话 **1 → 39** 条；111 消息会话 1 → 76；25 消息会话 1 → 21；381 消息会话 43 → 183。

### 定参过程（为什么不是任务书里的 min(800, 预算/条数)）

盲区分解（v1 窗口外 1174 条事实）：**超 60 条旧文本 81.6%**、thinking 通道 10.1%、窗口内超预算仅 8.3%——主因是 recency 硬切，不是预算。事实偏移分布：消息中位数仅 45 字符，但事实偏移 p50=1265（事实集中在长消息深处）。

策略扫描（`window-sweep.mjs`，同一快照实测）：

| 策略 | 可见性 | 最差广度 | 平均字符/会话 |
| --- | --- | --- | --- |
| v1 基线 | 51.8% | 1 | — |
| 等分/统一 cap=800（任务示例公式） | **20.8%（回归，否决）** | 10 | — |
| cap=2400 | 36.1% | 10 | — |
| b12000 cap=2400 | 38.5% | 10 | — |
| **b12000 + 仅超大头尾 4000（采纳）** | **57.1%** | **10** | 9349 |
| b18000 + 超大头尾 6000（激进备选） | 61.3% | 10 | 12217 |

结论：统一单条上限会砍掉带事实的长消息，实测比基线更差；预算翻倍单独几乎无效（cap 才是瓶颈）。采纳方案保留任务全部机制（首条用户消息、文件写回补、超大头尾、动态于剩余预算、新者优先），但参数按实测修正：**预算 12000、recency 改为 500 安全阀（预算才是真正的截断）、普通消息整吞、仅 >10k 超大消息头尾截断至 min(4000, 剩余预算)**。代价：大会话 digest 输入约 1.5–2×（平均 9.3k 字符/会话；小会话不受影响）。

数值可见性 80.0%→76.1% 的小幅下降来自超大消息截断，可接受——见下节，数值的瓶颈本就不在窗口。

## ② prompt 层数值规则的预期作用与验证方式

**关键事实：数值事实 80% 本来就在 v1 窗口内，覆盖率却只有 6.4%**（窗口内数值覆盖 5.3%，窗口外反而 10.6%）。可见性不是数值覆盖的约束——LLM 摘要时把数值概括掉了。因此数值短板的正确杠杆是 prompt 而非窗口，本次修复与此互证。

改动：digest prompt 增加硬规则——one_liner/key_topics/decisions 涉及具体数值（版本号/配置值/端口/日期/数量/金额/时长/阈值）必须原样保留数值与单位，并写入三条反例（「超时时间定为 30s」不得写成「调整了超时参数」等）；key_files 要求完整路径。`DIGEST_VERSION` 升 2，存量 digest 经 `listSessionsNeedingDigest` 的 `digest_version < 2` 条件在用户侧自然重跑，不强制回刷。

验证方式（本次无法静态测）：bench C 是对既有 digest 的静态核对，prompt/窗口改动只影响**未来生成**的 digest。待真实 LLM 重生成后重跑 `bench-c.mjs`：预期 number 覆盖率从 6.4% 显著上升（窗口内可见基数 453→431 基本持平，瓶颈消除后覆盖率应贴近可见性）；decision/file 覆盖率随窗口改善（+11.0pp/+6.3pp 可见性）同步上升。建议补 LLM-as-judge 版 Bench C 复核数值保真（基线遗留项）。

## ③ 退化 digest 检测与重排

- **判定（运行时，不加列）**：`isDegradedDigest`——四结构化字段全空 且 one_liner 与首条用户消息重合（≥90 字符的截断原文前缀，或 bigram Dice > 0.8）。bench C 复跑验证：基线 7/106 四字段全空，精确规则 **7/7 全命中、零误判**。
- **重排**：`enqueuePending` 在正常候选外追加退化候选（SQL 预筛四字段空 + `embedding_status='skipped'`，服务层用首条用户消息精确复核），**仅 LLM 已配置时**（`isLlmConfigured`）重试一次；仍退化则写 `embedding_status='degraded'` 不再自动重试（复用现有 TEXT 列，未加列；会话增长或版本升级时仍会自然重跑）。
- **透出**：`DigestService.getDigestStats()`（运行计数 + 库级 `SessionDigestStats`：total/emptyStructured/gaveUp/failed）+ 每次扫描后的 `[digest] 健康检查` 日志。设置页/诊断展示留待后续。

## 验证结果

- `pnpm core:build`：成功；根 `tsc --noEmit`：无错误。
- 根 `vitest run`：**408/408 通过**（含新增 23 例：窗口 13、退化 9、prompt 断言 1）。
- capture-core `vitest run`（Electron node）：**122/122 通过**（含另一代理的迁移 5 测试）。注意：直接用系统 Node 跑 capture-core 测试会因 better-sqlite3 ABI（为 Electron 编译）失败——既有环境问题，与本次改动无关（基线代码同样失败）。
- bench C 复跑：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/bench-c.mjs --tag after-window`（`--tag` 避免覆盖基线机器报告）。

## 遗留事项

- prompt 数值规则效果待真实重生成后复跑 bench C 验证（预期 number 覆盖率 6.4% → 贴近可见性）；当前快照中的 digest 均为旧 prompt 产物，覆盖率 23.2% 不变属预期。
- `embedding_status='degraded'` 是借用现有列的约定值；迁移 5 落定后可评估是否转正式列（本次按约束未动 migrations.ts）。
- thinking 通道 119 条事实（4.9%）管线设计上永不可见；如要覆盖需另行决策是否把 thinking 纳入 digest 输入。
- 窗口预算 12000 使大会话 digest 输入翻倍（平均 9.3k 字符）；成本敏感可回退 6000（可见性数据见扫描表）。
- 2 条滞后 digest 随 version=2 一并重跑，无需单独处理。
- 基线短板 1/2/3（CJK 分词、时序、拒答）与迁移 5 由另一代理负责，不在本次范围。
