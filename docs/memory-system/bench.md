# 记忆系统评测方案（bench）

更新时间：2026-07-19

适用范围：`scripts/bench/` 评测基建与 `docs/bench/` 报告。操作细节（命令、参数、指标口径）以 [docs/bench/README.md](../bench/README.md) 为准，本文说明设计与结论。首份基线报告：[../bench/baseline-2026-07-19.md](../bench/baseline-2026-07-19.md)。

## 设计原则

- **不改业务代码**：bench 独立成目录，只读使用 capture-core（经 `packages/capture-core/dist` 编译产物）；评测对象是真实代码路径——`recallSessions` 与 digest 管线，不是复刻实现。
- **纯本地判分**：Bench A/C 都是程序化判定，不引入 LLM-as-judge，保证可复现（固定 seed）、可进 CI。
- **better-sqlite3 是 Electron ABI**：所有脚本必须用 Electron 的 node 跑（`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/...`）。
- **真实库只读**：Bench C 用 SQLite backup API 做快照后评测（WAL 未 checkpoint 时直接拷文件会缺表——已踩过）。

## 组成

| 文件 | 作用 |
|---|---|
| `scripts/bench/corpus.mjs` | 合成语料生成器：按 capture-core schema 建 SQLite 库，埋针并输出 ground truth JSON |
| `scripts/bench/bench-a.mjs` | Bench A 召回准确率：对合成库跑 `recallSessions`（FTS5+RRF），自动判分 |
| `scripts/bench/bench-c.mjs` | Bench C digest 保真度：真实库只读快照上做关键事实清单核对 |
| `scripts/bench/common.mjs` | 公共工具（路径、随机种子、报告写出） |
| `docs/bench/out/` | 每次运行的机器报告（`bench-a-<date>.json/.md`、`bench-c-<date>.json/.md`） |

## Bench A：召回准确率

RULER 式埋针 + 本地判分。

**语料**：默认 60 会话（4 平台 × 15、8 项目、1794 条消息，seed=42），含工具调用、闲聊与 near-miss 干扰噪声；规模与种子可用命令行覆盖（`--sessions --needles --update-pairs --seed`）。

**针与探针**：

- 12 根单针，8 类模板：`config_value` / `file_state` / `decision` / `owner` / `version` / `deadline` / `api_endpoint` / `env_var`；其中 3 根为 **CJK 连写变体**（键不加空格——中文真实写法，用于分层对比连写/分写）。
- 4 组知识更新对：同键改两次值，旧会话 30–45 天前、新会话 2–8 天前，测时序。
- 4 条多键查询（一问提两根针）、5 条拒答查询（3 条带跨 scope 诱饵，如「本地开发的 redis」对「生产 redis」之问）。

**评测方式**：查询集直接跑 `recallSessions`（topK=5，无向量——与线上一致，真实库 embedding 全部 skipped，向量路从未生效）。

**指标**：Recall@1/@5 与 MRR（按会话判）、多键双命中率、时序 top1=新值比例（`staleTop1Rate` 为其反面）、拒答三率（`abstainRate` 零结果率 / `misleadingTop1Rate` top1 snippet 含被查属性 / `confidentHitRate` top1 分数达正常命中分数线 P10）。

## Bench C：digest 保真度

**语料**：真实库只读快照（106 会话 / 17719+ 消息 / 106 digest）。

**方法**：规则抽取器从消息原文抽关键事实 2438 条（决策句 653 / 文件路径 1219 / 数值 566），核对其在 digest 五字段拼接文本中的覆盖率；每条事实标注是否落在 digest 输入窗口内（复刻 `buildDigestTranscript`：最近 ≤60 条、尾部 6000 字符、不含 thinking）。决策句用 CJK 4-gram 包含判定，数值/路径用精确匹配。

**指标**：总覆盖率、分类型覆盖率、窗口内/外对比、会话覆盖率分布、退化 digest（四字段全空）/ 滞后 / 缺失计数。

## 基线结果摘要（2026-07-19）

Bench A（合成库）：单针 Recall@1/@5 **83.3%**（10/12，MRR 0.833）；分写针 100%、**CJK 连写针 33.3%**；多键双命中率 50%；**时序 top1=新值仅 25%**（top1=旧值 50%）；拒答零结果率 40%、top1 误导率 60%。

Bench C（真实库）：事实总覆盖率 **23.2%**（565/2438）；决策句 / 文件 / 数值 = 31.1% / 26.7% / **6.4%**；数值窗口内覆盖率（5.3%）甚至低于窗口外（10.6%）；事实 ≥5 的 92 个会话中覆盖率 ≥75% 的 **0 个**；退化 digest 7/106（6.6%）、滞后 2。

七个系统短板（按严重度，证据见基线报告与 `docs/bench/out/`）：

1. CJK 连写事实整段从 FTS 消失（unicode61 整段一个 token，零召回而非排名靠后）——最严重；
2. 召回无时序概念，知识更新后旧值压过新值（RRF 无时间维度）；
3. 无拒答机制，诱饵被当答案呈上，且 RRF 分数无法区分真假命中；
4. digest 对数值类事实近乎失明（6.4%）；
5. digest 输入窗口结构性盲区（48% 事实在窗口外，超大消息吃光预算）；
6. 退化 digest 静默存在（用户 prompt 原文当摘要）；
7. snippet 不携带 scope 限定（诱饵的「本地开发用的」恰在 ±80 字符窗口外）。

改进建议按性价比排序见基线报告：① CJK 检索增强（trigram 迁移 / bigram / 查询侧展开）② 启用向量召回补位 ③ 召回融合加时间维度 ④ 命中置信信号 ⑤ digest 管线四项（程序兜底字段、双段窗口、退化打标、滞后重跑）⑥ bench 自身扩量。

**已落地（2026-07-19）**：①③④ 随迁移 v5 与召回层改造落地——bench A 总 Recall 83.3%→100%、CJK 连写针 33.3%→100%、时序 top1=新值 25%→75%、命中 confidence 透出（见 [after-trigram-2026-07-19.md](../bench/after-trigram-2026-07-19.md)）；⑤ 随 digest v2 落地——窗口事实可见性 51.8%→57.1%、数值保真硬规则入 prompt、退化检测与重排生效（见 [after-digest-2026-07-19.md](../bench/after-digest-2026-07-19.md)）。

## 改进回路

1. 修复落在业务代码（如 FTS tokenizer 迁移、digest 窗口改造）；
2. 复跑 `corpus.mjs`（**同一 seed**，保证语料可比）→ `bench-a.mjs`；Bench C 删除 `scripts/bench/.cache/vesti-real-snapshot.db` 后重跑以取最新真实库快照；
3. 新报告按日期落 `docs/bench/out/`，与基线逐项对比——重点看：CJK 连写针 Recall、时序 top1=新值、数值事实覆盖率、退化 digest 数；
4. 趋势可信、个位数抖动不可信（单针 n=12、时序 n=4 颗粒粗），小幅波动不回滚修复。

## 如何扩展

**加针模板**：编辑 `corpus.mjs` 的 `NEEDLE_TEMPLATES`（结构见 [docs/bench/README.md](../bench/README.md)）。规则：单针 key 不得与 `UPDATE_PAIR_POOL` 相交；更新对往 `UPDATE_PAIR_POOL` 追加（时间自动安排）；拒答探针往 `REFUSAL_PROBES` 追加（`decoy=null` 测纯噪声上浮）；改规模用命令行参数，不改默认常量。

**引入外部题型**（LoCoMo / LongMemEval 改造方向）：

- LoCoMo 的多会话长对话可转换为「同项目多会话 + 跨会话事实针」，对应我们的多键查询与时序对；
- LongMemEval 的五类题型中，信息抽取≈单针、时序推理≈更新对、拒答≈拒答探针，可直接映射；多会话推理与知识更新整合是下一步扩量重点（当前 n=4/5 太小）；
- 引入时保持「程序判分」底线：题型答案必须是可精确核对的值，自由文本题型留给后续 LLM-as-judge 版。

**规划中的评测层**：Bench B（端到端：经 vesti-mcp 三/四工具 + LLM 阅读 snippet 后的最终回答质量）与 LLM-as-judge 版 Bench C——基线报告已注明当前评测未覆盖这两层。

## 已知局限

合成语料噪声为模板化生成，比真实库干净；小样本指标颗粒粗；Bench C 抽取器是规则式（决策句精确率抽样约 80%，框架名会误判为文件），覆盖率应读作趋势性下界；拒答「误导率」按 snippet 含属性词判定，对含否定语义的命中偏严。完整声明见基线报告末节。
