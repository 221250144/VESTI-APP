# VESTI 会话记忆系统评测基建（bench）

独立评测目录，不改动 `src/**` 业务代码；capture-core 只读使用（经 `packages/capture-core/dist`）。

## 组成

| 文件 | 作用 |
| --- | --- |
| `scripts/bench/corpus.mjs` | 合成会话语料生成器：按 capture-core schema 建 SQLite 库，埋针（K 根事实针 + 知识更新对 + 拒答诱饵），输出 ground truth JSON |
| `scripts/bench/bench-a.mjs` | Bench A 召回准确率：对合成库跑 `recallSessions`（FTS5+RRF），自动判分，输出 JSON+Markdown |
| `scripts/bench/bench-c.mjs` | Bench C digest 保真度：对真实库只读快照做关键事实清单核对（程序判分，无 LLM） |
| `scripts/bench/common.mjs` | 公共工具（路径、随机种子、报告写出） |
| `scripts/bench/debug-scores.mjs` | 诊断：打印时序对/未中针的 top-K 分数、置信与账龄分布（排名调参用） |
| `scripts/bench/tool-names.mjs` | 一次性：真实库工具名分布（校准文件写工具集） |
| `scripts/bench/fact-offsets.mjs` | 一次性：事实在消息内的偏移分布（窗口定参依据） |
| `scripts/bench/window-sweep.mjs` | 一次性：digest 窗口策略扫描（预算 × 单条上限 × recency，见 after 报告） |
| `docs/bench/out/` | 每次运行的机器报告（`bench-a-<date>.json/.md`、`bench-c-<date>.json/.md`） |
| `docs/bench/baseline-2026-07-19.md` | 首份基线报告（人读） |
| `docs/bench/after-trigram-2026-07-19.md` | trigram 迁移 + 时序衰减 + confidence 修复与 bench A 复跑对比报告（人读） |
| `docs/bench/after-digest-2026-07-19.md` | digest 短板修复与 bench C 复跑报告（人读） |

## 如何复跑

better-sqlite3 是 Electron ABI，所有脚本必须用 Electron 的 node 跑。以下命令在 **VESTI-APP 根目录**、Git Bash 下执行：

```bash
cd VESTI-APP
export ELECTRON_RUN_AS_NODE=1
E=node_modules/electron/dist/electron.exe

# 1) 生成合成语料（默认 60 会话 / 12 针 / 4 更新对 / seed=42）
$E scripts/bench/corpus.mjs

# 2) Bench A（读 .cache/bench-corpus.db + truth JSON）
$E scripts/bench/bench-a.mjs

# 3) Bench C（首次自动从 ~/.vesti/db/vesti.db 做 backup 快照；之后复用）
$E scripts/bench/bench-c.mjs
```

PowerShell 等价写法：`$env:ELECTRON_RUN_AS_NODE=1; node_modules/electron/dist/electron.exe scripts/bench/corpus.mjs`。

常用参数：

```bash
$E scripts/bench/corpus.mjs --sessions 120 --needles 24 --update-pairs 6 --seed 7
$E scripts/bench/bench-a.mjs --topk 10
$E scripts/bench/bench-c.mjs --db scripts/bench/.cache/vesti-real-snapshot.db
$E scripts/bench/bench-c.mjs --tag after-window   # 输出文件名加 tag，避免覆盖同日基线报告
```

想对最新真实库重跑 Bench C：删掉 `scripts/bench/.cache/vesti-real-snapshot.db` 再跑即可（会自动重新快照）。**不要**直接文件拷贝真实库——WAL 未 checkpoint 时拷出来的主文件缺表（已踩过），脚本用的是 SQLite backup API。

## 如何加针模板

编辑 `corpus.mjs` 的 `NEEDLE_TEMPLATES`：

```js
my_type: {
  pool: [ /* 2-4 个变体 {…, queryKey} */ ],
  make(v) {
    return {
      key: '唯一键（更新对/单针之间不许重复）',
      value: '事实值',
      statement: '用户口吻的陈述（针原文）',
      confirm: '助手确认（可复读键值）',
      // 可选：CJK 连写变体——键是中文时提供，bench-a 会按连写/分写分层对比
      tightStatement: '不带空格的连写版本',
      tightConfirm: '收到。',
      query: '自然语言查询（评测时发给召回器）',
      title: '针成为主题时的会话标题',
    };
  },
},
```

规则：
- 单针的 key 必须与 `UPDATE_PAIR_POOL` 的 key 不相交，否则 ground truth 冲突。
- 加更新对：往 `UPDATE_PAIR_POOL` 追加 `{type, key, oldValue, newValue, oldStatement, newStatement, query}`；旧会话自动安排在 30–45 天前，新会话 2–8 天前。
- 加拒答探针：往 `REFUSAL_PROBES` 追加 `{query, attributeToken, decoy}`；`decoy` 为 null 表示语料中完全没有该属性（测纯噪声上浮）。
- 改默认规模用命令行参数，不要改默认值常量。

## 指标口径

- **Recall@1/@5**：针会话是否出现在召回 top1/top5（hit 按会话判）。
- **多键双命中率**：一条查询提到两根针，两个针会话都进 top5 才算。
- **时序 top1 准确率**：更新对查询的 top1 是否为「新值」会话；`staleTop1Rate` 是 top1 为旧值会话的比例。
- **拒答**：`abstainRate` = 返回 0 条的比例；`misleadingTop1Rate` = top1 snippet 含被查属性词（会把诱饵当答案呈上）的比例；`confidentHitRate` = top1 分数达到正常命中分数线（单针 top1 分数的 P10）的比例。
- **Bench C 覆盖率**：程序从消息原文抽取的事实（决策句/文件路径/数值）在 digest 五字段（one_liner/key_topics/key_files/decisions/open_questions）拼接文本中出现的比例。「窗口内」指该事实所在消息会进入 digest 输入。bench-c 同时按两代口径计算：v1（基线复刻：最近 ≤60 条、尾部 6000 字符预算、不含 thinking）与 v2（现网新组装：预算 12000、最近 ≤500 条安全阀、首条用户消息小节、文件写回补 10 条、>10k 消息头尾截断 4000、普通消息整吞；按 kept-range 判定事实是否熬过截断）。退化行同时按「四字段全空」与精确规则（叠加 one_liner 复述首条用户消息）计数。
