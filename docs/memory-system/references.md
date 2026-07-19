# 参考文献与工具

更新时间：2026-07-19

记忆系统 v2 调研与设计中参考的文献、工具与官方文档，按主题分类。arXiv 编号已逐条核实；每条一句话说明其与 VESTI 的关联。

## 记忆系统

- **MemGPT**（[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)）：OS 式分层内存（main context / external context 分页换出），VESTI L0–L3 分层与渐进披露的思想源头之一。
- **Sleep-time Compute**（[arXiv:2504.13171](https://arxiv.org/abs/2504.13171)）：把上下文加工移到离线「睡眠时间」预计算，对应 digest/简报挂在同步后异步生成而非查询时现算。
- **Zep**（[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)）：时序知识图谱记忆（Graphiti）与边失效语义，L1 `valid_from/valid_to/superseded_by` 列的参照；其图谱路线被我们刻意放弃。
- **mem0**（[arXiv:2504.19413](https://arxiv.org/abs/2504.19413)）：记忆的增量 ADD/UPDATE/DELETE 维护操作，L2 简报 distill + maintain 合并（ops 日志）直接借鉴。
- **LightMem**（[arXiv:2510.18866](https://arxiv.org/abs/2510.18866)）：轻量分层记忆，写入侧压缩 + 离线巩固，印证「在线轻、离线重」的成本分配。
- **MemoryOS**（[arXiv:2506.06326](https://arxiv.org/abs/2506.06326)）：OS 启发的短/中/长期记忆分层与更新策略，分层语义的又一独立佐证。
- **HippoRAG**（[arXiv:2405.14831](https://arxiv.org/abs/2405.14831)）：海马体启发的知识图谱 + Personalized PageRank 联想检索，作为图检索路线的对照评估。
- **A-MEM**（[arXiv:2502.12110](https://arxiv.org/abs/2502.12110)）：Zettelkasten 式记忆卡片动态链接与演化，L2 简报「持续演化文档」形态的参照。
- **ACE**（[arXiv:2510.04618](https://arxiv.org/abs/2510.04618)）：Agentic Context Engineering——上下文作为增量演化的 playbook（Generate-Reflect-Curate），与 maintain 合并的最小 ops 思路同构。
- **H-MEM**（[arXiv:2507.22925](https://arxiv.org/abs/2507.22925)）：层次化长期记忆组织，层级间索引关系的对照方案。

## 压缩与交接

- **COMEDY**（[arXiv:2402.11975](https://arxiv.org/abs/2402.11975)）：层级化压缩的对话记忆框架，压缩粒度分层的参照。
- **LLMLingua**（[arXiv:2310.05736](https://arxiv.org/abs/2310.05736)）：task-agnostic prompt 压缩，token 级预算分配的基线方法。
- **LongLLMLingua**（[arXiv:2310.06839](https://arxiv.org/abs/2310.06839)）：长上下文场景的压缩改进（重排序 + 动态比例），digest 窗口改造的备选技术。
- **LLMLingua-2**（[arXiv:2403.12968](https://arxiv.org/abs/2403.12968)）：数据蒸馏小模型做压缩，低成本离线压缩的可行路径。
- **ICAE**（[arXiv:2307.06945](https://arxiv.org/abs/2307.06945)）：In-context autoencoder，把长上下文压成 memory slots，神经压缩路线的对照。
- **Anthropic：Effective context engineering for AI agents**（[工程博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）：compaction、结构化 note-taking、子代理隔离上下文的工程实践，与 VESTI「摘要 + 原文下钻」同思路。
- **ai-muninn handoff 协议**：社区开源的 AI 会话交接协议实践，接力包（relay pack）结构设计的对照。
- **claude-handoff**：Claude Code 会话交接的社区工具，验证「交接包 = 状态 + 决策 + 待办」的最小完备集。
- **Codex compact prompt 分析**：社区对 Codex CLI `/compact` 提示词的逆向分析，digest prompt 设计与压缩信息保留清单的参照。

## 评测

- **LongMemEval**（[arXiv:2410.10813](https://arxiv.org/abs/2410.10813)）：长期记忆评测基准（信息抽取/多会话推理/时序/拒答等题型），Bench A 针型与拒答探针的题型蓝本。
- **LoCoMo**（[arXiv:2402.17753](https://arxiv.org/abs/2402.17753)）：超长多会话对话基准，多会话事实针改造方向的来源。
- **MemoryBench**（[arXiv:2510.17281](https://arxiv.org/abs/2510.17281)）：面向 agent 记忆系统的综合评测，指标口径的对照。
- **RULER**（[arXiv:2404.06654](https://arxiv.org/abs/2404.06654)）：长上下文大海捞针扩展（多针/多跳/干扰梯度），Bench A 埋针 + near-miss 噪声设计的直接范本。
- **Lost-in-the-Middle**（[arXiv:2307.03172](https://arxiv.org/abs/2307.03172)）：模型对上下文中段信息利用最差，digest 双段窗口（头 + 尾）改造的依据。
- **StoryBench**（[arXiv:2506.13356](https://arxiv.org/abs/2506.13356)）：故事级长程评测基准，长程一致性题型改造的备选参照。

## 工具

- **claude-mem**：Claude Code 的会话记忆插件（会话结束压缩 + 启动注入），对照方案见 [design.md](design.md) 对照表。
- **ccusage**：读取 Claude Code 本地 JSONL 做用量统计的 CLI，验证 JSONL 作为可挖掘数据源的成熟度。
- **ATIF / Harbor**：Agent Trajectory Interchange Format 与其评测运行器，会话轨迹标准化的社区参照（VESTI 的 ParsedSession 中间协议同思路）。
- **OpenTelemetry GenAI**：GenAI 语义约定，agent 遥测字段（token、模型、工具调用）命名的对齐标准。

## 官方文档

- **Claude Code docs**：[subagents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)（`.claude/agents/` 定义与转录组织）、[memory](https://docs.anthropic.com/en/docs/claude-code/memory)（CLAUDE.md 分层与 imports）、[hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)（会话生命周期钩子）。
- **Kimi Code docs**：[data-locations](https://www.kimi.com/code/docs/kimi-code-cli/guides/sessions.html)（`~/.kimi-code/sessions` 布局，适配器头注释同款引用）、wire protocol 与 sub-agents 指南（`agents/<agentId>/wire.jsonl` 多线组织）。
- **Codex docs**：AGENTS.md 指南（指令文件发现与嵌套覆盖规则）。
- **Cursor docs**：subagents 文档（composer 的 `isSubagent` 组织方式）。
- **Gemini CLI docs**：session-management（`/chat save|list|resume`）与 checkpointing（文件快照 + `/restore`）。
- **Aider docs**：[commands](https://aider.chat/docs/usage/commands.html)（`/clear`、`/drop`、`/tokens`、`/undo`）、[repomap](https://aider.chat/docs/repomap.html)（仓库结构上下文）。
