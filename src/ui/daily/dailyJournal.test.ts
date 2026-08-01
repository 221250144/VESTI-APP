// Daily journal (P4c quality upgrade): unit tests for the pure work-model
// core — fork/continuation merging, project clustering, deterministic file
// anchors, pass-1/pass-2 transcript assembly, markdown composition (marker
// replacement + section repair) and the no-LLM local journal. No Dexie/IPC.

import { describe, expect, it } from "vitest";
import type { RelayFileTouchRow } from "../../shared/contracts";
import {
  KEY_FILES_MARKER,
  MAX_WEB_SECTION_LINES,
  buildClusterExtractionTranscript,
  buildDailySynthesisTranscript,
  buildDailyWorkModel,
  buildDeterministicClusterBrief,
  buildLocalDailyJournal,
  clusterHasLlmMaterial,
  composeDailyMarkdown,
  extractDailyFileAnchors,
  groupDailyClusters,
  isDeterministicDailyJournal,
  mergeDailyWorkItems,
  resolveDailyLogWrite,
  type DailyWorkItem,
} from "./dailyJournal";
import {
  journalDayRelativePath,
  journalDayUuid,
  journalIndexRelativePath,
  journalIndexUuid,
  buildJournalDayDocument,
  buildJournalMonthIndexDocument,
} from "./journalVault";
import { collectDailyActivity, type DailyConversationInput, type DailyDigestInput } from "./dailyActivity";

function localTs(
  year: number,
  month: number,
  day: number,
  hours = 12,
  minutes = 0
): number {
  return new Date(year, month - 1, day, hours, minutes, 0).getTime();
}

function makeWorkItem(overrides: Partial<DailyWorkItem> & { conversationId: number }): DailyWorkItem {
  return {
    cliId: null,
    title: `会话 ${overrides.conversationId}`,
    platform: "Codex",
    source: "cli",
    projectLabel: "vesti-app",
    messages: 10,
    updatedAt: localTs(2026, 7, 18, 9),
    digest: null,
    openQuestions: [],
    summary: null,
    subagents: [],
    forkParentCliId: null,
    ...overrides,
  };
}

// ---- Fork merging ---------------------------------------------------------------

describe("mergeDailyWorkItems", () => {
  it("merges a fork/continuation chain into one work item cited by the latest session", () => {
    const chains = mergeDailyWorkItems([
      makeWorkItem({ conversationId: 1, cliId: "s1", messages: 200, updatedAt: localTs(2026, 7, 18, 9) }),
      makeWorkItem({ conversationId: 2, cliId: "s2", messages: 35, forkParentCliId: "s1", updatedAt: localTs(2026, 7, 18, 11) }),
      makeWorkItem({ conversationId: 3, cliId: "s3", messages: 40, forkParentCliId: "s2", updatedAt: localTs(2026, 7, 18, 15) }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0].representative.conversationId).toBe(3);
    expect(chains[0].continuations).toBe(2);
    expect(chains[0].messages).toBe(275);
    expect(chains[0].items.map((item) => item.conversationId)).toEqual([1, 2, 3]);
  });

  it("keeps unrelated sessions as separate chains", () => {
    const chains = mergeDailyWorkItems([
      makeWorkItem({ conversationId: 1, cliId: "s1" }),
      makeWorkItem({ conversationId: 2, cliId: "s2" }),
    ]);
    expect(chains).toHaveLength(2);
  });

  it("treats a fork parent outside the day's set as a root", () => {
    const chains = mergeDailyWorkItems([
      makeWorkItem({ conversationId: 2, cliId: "s2", forkParentCliId: "s1-not-today" }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0].continuations).toBe(0);
  });

  it("orders chains busiest-first", () => {
    const chains = mergeDailyWorkItems([
      makeWorkItem({ conversationId: 1, cliId: "s1", messages: 5 }),
      makeWorkItem({ conversationId: 2, cliId: "s2", messages: 50 }),
    ]);
    expect(chains[0].representative.conversationId).toBe(2);
  });
});

describe("groupDailyClusters", () => {
  it("groups chains by project and keeps browser work separate", () => {
    const chains = mergeDailyWorkItems([
      makeWorkItem({ conversationId: 1, projectLabel: "vesti-app", messages: 30 }),
      makeWorkItem({ conversationId: 2, projectLabel: "vesti-app", messages: 20 }),
      makeWorkItem({
        conversationId: 3,
        source: "browser",
        projectLabel: "chatgpt.com",
        platform: "ChatGPT",
        messages: 10,
      }),
    ]);
    const clusters = groupDailyClusters(chains);
    expect(clusters).toHaveLength(2);
    const cli = clusters.find((cluster) => cluster.source === "cli");
    const browser = clusters.find((cluster) => cluster.source === "browser");
    expect(cli?.projectLabel).toBe("vesti-app");
    expect(cli?.chains).toHaveLength(2);
    expect(cli?.messages).toBe(50);
    expect(browser?.projectLabel).toBe("chatgpt.com");
  });
});

// ---- Deterministic file anchors ---------------------------------------------------

function touch(
  sessionId: string,
  toolCategory: string,
  filePath: string,
  timestamp: number
): RelayFileTouchRow {
  return {
    sessionId,
    toolName: toolCategory === "file_read" ? "Read" : toolCategory === "file_edit" ? "Edit" : "Write",
    toolCategory,
    inputSummary: JSON.stringify({ file_path: filePath }),
    timestamp,
  };
}

describe("extractDailyFileAnchors", () => {
  const resolve = (sessionId: string): number | null =>
    sessionId === "s1" ? 1 : sessionId === "s2" ? 2 : null;

  it("aggregates touches per file with the strongest change kind", () => {
    const anchors = extractDailyFileAnchors(
      [
        touch("s1", "file_read", "src/a.ts", 100),
        touch("s1", "file_edit", "src/a.ts", 200),
        touch("s2", "file_write", "src/b.ts", 300),
        touch("s2", "file_read", "src/c.ts", 400),
      ],
      resolve
    );
    const byPath = new Map(anchors.map((anchor) => [anchor.path, anchor]));
    expect(byPath.get("src/a.ts")?.kind).toBe("modified");
    expect(byPath.get("src/a.ts")?.touches).toBe(2);
    expect(byPath.get("src/b.ts")?.kind).toBe("created");
    expect(byPath.get("src/c.ts")?.kind).toBe("analyzed");
  });

  it("dedupes paths case/separator-insensitively and is fully deterministic", () => {
    const rows = [
      touch("s1", "file_edit", "src\\ui\\Daily.ts", 100),
      touch("s2", "file_edit", "src/ui/daily.ts", 200),
    ];
    const first = extractDailyFileAnchors(rows, resolve);
    const second = extractDailyFileAnchors(rows, resolve);
    expect(first).toHaveLength(1);
    expect(first[0].touches).toBe(2);
    expect(first).toEqual(second);
  });

  it("drops rows without a usable path and caps the list", () => {
    const rows = [
      { sessionId: "s1", toolName: "Bash", toolCategory: "shell", inputSummary: "npm test", timestamp: 1 },
      touch("s1", "file_read", "src/a.ts", 100),
    ];
    const anchors = extractDailyFileAnchors(rows as RelayFileTouchRow[], resolve);
    expect(anchors).toHaveLength(1);
    expect(extractDailyFileAnchors(rows as RelayFileTouchRow[], resolve, 0)).toHaveLength(0);
  });

  it("attributes touches to the resolved conversation ids", () => {
    const anchors = extractDailyFileAnchors([touch("s1", "file_edit", "src/a.ts", 100)], resolve);
    expect(anchors[0].conversationIds).toEqual([1]);
  });
});

// ---- Work model over collectDailyActivity ----------------------------------------

function makeConversation(
  overrides: Partial<DailyConversationInput> & { id: number }
): DailyConversationInput {
  return {
    title: `会话 ${overrides.id}`,
    platform: "Codex",
    updatedAt: 0,
    messageCount: 10,
    source: "cli",
    projectLabel: "vesti-app",
    ...overrides,
  };
}

function makeDigest(
  conversationId: number,
  overrides: Partial<DailyDigestInput> = {}
): DailyDigestInput {
  return {
    conversationId,
    oneLiner: "实现了日报功能",
    keyTopics: ["日报"],
    keyFiles: ["src/ui/daily/dailyService.ts"],
    decisions: ["采用两遍管线"],
    ...overrides,
  };
}

function buildModel() {
  const activity = collectDailyActivity("2026-07-18", {
    conversations: [
      makeConversation({ id: 1, updatedAt: localTs(2026, 7, 18, 9), messageCount: 235 }),
      // Fork of conversation 1: the raw count (521) includes the pre-fork
      // copies; the tree's deduped count (40) is what the journal reports.
      makeConversation({ id: 2, updatedAt: localTs(2026, 7, 18, 15), messageCount: 521 }),
      makeConversation({
        id: 9,
        updatedAt: localTs(2026, 7, 18, 20),
        source: "browser",
        platform: "ChatGPT",
        projectLabel: "chatgpt.com",
        messageCount: 12,
      }),
    ],
    digests: [makeDigest(1), makeDigest(2, { oneLiner: "修复了导出路径越界" })],
    summaries: [{ conversationId: 9, content: "调研了 vault 组织方式", createdAt: 1 }],
  });
  return buildDailyWorkModel({
    activity,
    enrichments: [
      {
        conversationId: 1,
        cliId: "s1",
        forkedFrom: null,
        uniqueMessageCount: null,
        openQuestions: ["周报要不要并入日报"],
        subagents: [{ role: "reviewer", title: "审查日报 diff", oneLiner: "发现两处回归" }],
      },
      {
        conversationId: 2,
        cliId: "s2",
        forkedFrom: "s1",
        uniqueMessageCount: 40,
        openQuestions: [],
        subagents: [],
      },
    ],
    fileTouches: [touch("s1", "file_edit", "src/ui/daily/dailyJournal.ts", localTs(2026, 7, 18, 10))],
    resolveTouchConversationId: (sessionId) => (sessionId === "s1" ? 1 : null),
  });
}

describe("buildDailyWorkModel", () => {
  it("merges fork chains, groups clusters and attaches anchors", () => {
    const model = buildModel();
    const cli = model.clusters.find((cluster) => cluster.source === "cli");
    expect(cli?.chains).toHaveLength(1);
    expect(cli?.chains[0].continuations).toBe(1);
    expect(cli?.chains[0].representative.conversationId).toBe(2);
    // 235 (no dedup info) + 40 (fork-deduped) — never the raw 235 + 521.
    expect(cli?.chains[0].messages).toBe(275);
    expect(model.clusters.some((cluster) => cluster.source === "browser")).toBe(true);
    expect(model.fileAnchors).toHaveLength(1);
    expect(model.fileAnchors[0].kind).toBe("modified");
  });
});

// ---- Transcripts ------------------------------------------------------------------

describe("buildClusterExtractionTranscript", () => {
  it("carries fork-merge notes, digests, open questions, subagents and anchors", () => {
    const model = buildModel();
    const cli = model.clusters.find((cluster) => cluster.source === "cli");
    const transcript = buildClusterExtractionTranscript(cli!, model.fileAnchors);
    expect(transcript).toContain("fork/续写合并 2 个会话");
    expect(transcript).toContain("实现了日报功能");
    expect(transcript).toContain("修复了导出路径越界");
    expect(transcript).toContain("未决问题");
    expect(transcript).toContain("周报要不要并入日报");
    expect(transcript).toContain("[reviewer] 审查日报 diff");
    expect(transcript).toContain("src/ui/daily/dailyJournal.ts");
  });

  it("marks clusters with no digest/summary material as not LLM-worthy", () => {
    const model = buildModel();
    const cli = model.clusters.find((cluster) => cluster.source === "cli");
    expect(clusterHasLlmMaterial(cli!)).toBe(true);
    const empty = {
      ...cli!,
      chains: cli!.chains.map((chain) => ({
        ...chain,
        items: chain.items.map((item) => ({ ...item, digest: null, openQuestions: [], subagents: [] })),
      })),
    };
    expect(clusterHasLlmMaterial(empty)).toBe(false);
  });
});

describe("buildDailySynthesisTranscript", () => {
  it("carries briefs, anchors with change kind, browser listing and yesterday's excerpt", () => {
    const model = buildModel();
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const transcript = buildDailySynthesisTranscript({
      model,
      briefs,
      projectMemory: [],
      previousLogMarkdown: "# 2026-07-17 日报\n\n## 今日完成\n- 昨天做完了调度器",
    });
    expect(transcript).toContain("日期：2026-07-18");
    expect(transcript).toContain("实现了日报功能");
    expect(transcript).toContain("src/ui/daily/dailyJournal.ts（修改");
    expect(transcript).toContain("《会话 9》（ChatGPT");
    expect(transcript).toContain("调研了 vault 组织方式");
    expect(transcript).toContain("昨天做完了调度器");
  });
});

// ---- Composition + local journal -----------------------------------------------------

describe("composeDailyMarkdown", () => {
  it("replaces the key-files marker with the deterministic section", () => {
    const model = buildModel();
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const llmBody = [
      "## 今日完成",
      "- 完成两遍日报管线联调",
      "",
      "## 项目工作流分解",
      "### vesti-app",
      "- 目标：落地日报升级",
      "",
      KEY_FILES_MARKER,
      "",
      "## 决策与发现",
      "- 决定 fork 链按最新消息数归并",
      "",
      "## 网页端对话摘要",
      "- 调研了 vault 组织方式",
      "",
      "## 明日线索",
      "- 周报联调",
    ].join("\n");
    const markdown = composeDailyMarkdown({ llmBody, model, briefs, locale: "zh" });
    expect(markdown).toMatch(/^# 2026-07-18 日报/);
    expect(markdown).not.toContain(KEY_FILES_MARKER);
    expect(markdown).toContain("## 关键文件\n- `src/ui/daily/dailyJournal.ts`（修改");
    expect(markdown).toContain("- 完成两遍日报管线联调");
    // LLM sections preserved, no duplicated repaired sections appended.
    expect(markdown.match(/## 今日完成/g)).toHaveLength(1);
    expect(markdown.match(/## 明日线索/g)).toHaveLength(1);
  });

  it("repairs sections the model skipped and drops a model-emitted H1", () => {
    const model = buildModel();
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const llmBody = [
      "# 2026-07-18 工作记录",
      "",
      "## 今日完成",
      "- 完成两遍日报管线联调",
    ].join("\n");
    const markdown = composeDailyMarkdown({ llmBody, model, briefs, locale: "zh" });
    expect(markdown.match(/^# /g)).toHaveLength(1);
    expect(markdown).toContain("## 项目工作流分解");
    expect(markdown).toContain("## 关键文件");
    expect(markdown).toContain("## 决策与发现");
    expect(markdown).toContain("## 网页端对话摘要");
    expect(markdown).toContain("## 明日线索");
    // Repaired sections carry deterministic content, not fabrications.
    expect(markdown).toContain("实现了日报功能");
    expect(markdown).toContain("周报要不要并入日报");
  });

  it("strips echoed writing guidance from heading lines", () => {
    const model = buildModel();
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const llmBody = [
      "## 今日完成（成就导向清单：每条具体、可验证，写清完成了什么、结果如何）",
      "- 完成两遍日报管线联调",
      "",
      "## 项目工作流分解(每个项目一个 ### 子节)",
      "### vesti-app",
      "- 目标：落地日报升级",
      "",
      "## 明日线索（至多 5 条）",
      "- 周报联调",
    ].join("\n");
    const markdown = composeDailyMarkdown({ llmBody, model, briefs, locale: "zh" });
    expect(markdown).toContain("## 今日完成\n");
    expect(markdown).not.toContain("成就导向清单");
    expect(markdown).not.toContain("每个项目一个 ### 子节）");
    expect(markdown).toContain("## 项目工作流分解\n");
    expect(markdown).toContain("## 明日线索\n");
    // Sanitized headings still count as present — no duplicate repairs.
    expect(markdown.match(/## 今日完成/g)).toHaveLength(1);
    expect(markdown.match(/## 明日线索/g)).toHaveLength(1);
  });

  it("ignores a marker mentioned inside prose (only standalone lines are replaced)", () => {
    const model = buildModel();
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const llmBody = [
      "## 今日完成",
      `- 文件小节改为程序渲染，模型只写 ${KEY_FILES_MARKER} 占位`,
      "",
      "## 决策与发现",
      "- 路径不允许编造",
    ].join("\n");
    const markdown = composeDailyMarkdown({ llmBody, model, briefs, locale: "zh" });
    // The prose mention stays prose; the section is inserted before decisions.
    expect(markdown).toContain(`模型只写 ${KEY_FILES_MARKER} 占位`);
    const filesIndex = markdown.indexOf("## 关键文件");
    const decisionsIndex = markdown.indexOf("## 决策与发现");
    expect(filesIndex).toBeGreaterThan(-1);
    expect(filesIndex).toBeLessThan(decisionsIndex);
  });

  it("inserts the file section before decisions when the marker is missing", () => {
    const model = buildModel();
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const llmBody = "## 今日完成\n- x\n\n## 决策与发现\n- y";
    const markdown = composeDailyMarkdown({ llmBody, model, briefs, locale: "zh" });
    const filesIndex = markdown.indexOf("## 关键文件");
    const decisionsIndex = markdown.indexOf("## 决策与发现");
    expect(filesIndex).toBeGreaterThan(-1);
    expect(filesIndex).toBeLessThan(decisionsIndex);
  });
});

describe("buildLocalDailyJournal", () => {
  it("renders the full schema deterministically: fork-merged, project-grouped, anchored", () => {
    const model = buildModel();
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const markdown = buildLocalDailyJournal(model, briefs, "zh");
    expect(markdown).toMatch(/^# 2026-07-18 日报/);
    expect(markdown).toContain("配置模型后可为今天重新生成");
    for (const section of ["## 今日完成", "## 项目工作流分解", "## 关键文件", "## 决策与发现", "## 网页端对话摘要", "## 明日线索"]) {
      expect(markdown).toContain(section);
    }
    // The fork pair shows up as ONE cluster narrative, not per-session rows.
    expect(markdown.match(/### vesti-app/g)).toHaveLength(1);
    expect(markdown).toContain("实现了日报功能");
    expect(markdown).toContain("修复了导出路径越界");
    expect(markdown).toContain("- `src/ui/daily/dailyJournal.ts`（修改 · 触碰 1 次，来自《会话 1》）");
    expect(markdown).toContain("采用两遍管线");
    expect(markdown).toContain("《会话 9》（ChatGPT · chatgpt.com）：调研了 vault 组织方式");
    expect(markdown).toContain("周报要不要并入日报");
  });

  it("marks empty sections instead of fabricating content", () => {
    const activity = collectDailyActivity("2026-07-18", {
      conversations: [makeConversation({ id: 1, updatedAt: localTs(2026, 7, 18, 9) })],
      digests: [],
      summaries: [],
    });
    const model = buildDailyWorkModel({
      activity,
      enrichments: [],
      fileTouches: [],
      resolveTouchConversationId: () => null,
    });
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const markdown = buildLocalDailyJournal(model, briefs, "en");
    expect(markdown).toContain("## Key files\nNone");
    expect(markdown).toContain("## Decisions & findings\nNone");
    expect(markdown).toContain("## Browser conversation digest\nNone");
    expect(markdown).toContain("## Leads for tomorrow\nNone");
  });

  it("caps the web digest section and summarizes the overflow", () => {
    // A mass history import lands many web conversations on one day; the
    // fallback journal must not turn into a raw dump.
    const manyWeb = Array.from({ length: MAX_WEB_SECTION_LINES + 5 }, (_, i) =>
      makeConversation({
        id: 100 + i,
        updatedAt: localTs(2026, 7, 18, 10),
        source: "browser",
        platform: "Kimi",
        projectLabel: "kimi.com",
        title: `网页会话 ${i}`,
      })
    );
    const activity = collectDailyActivity("2026-07-18", {
      conversations: manyWeb,
      digests: [],
      summaries: [],
    });
    const model = buildDailyWorkModel({
      activity,
      enrichments: [],
      fileTouches: [],
      resolveTouchConversationId: () => null,
    });
    const briefs = model.clusters.map((cluster) => buildDeterministicClusterBrief(cluster));
    const markdown = buildLocalDailyJournal(model, briefs, "zh");
    const web = markdown.slice(markdown.indexOf("## 网页端对话摘要"));
    expect(web.match(/^- 《/gm)).toHaveLength(MAX_WEB_SECTION_LINES);
    expect(web).toContain("……以及另外 5 条对话（从略）");
  });
});

// ---- Regenerate write resolution (never downgrade to the fallback) ----------

describe("isDeterministicDailyJournal / resolveDailyLogWrite", () => {
  const polished = "# 2026-07-18 日报\n\n## 今日完成\n- 实现了日报功能";
  const fallbackZh = buildLocalDailyJournal(
    buildDailyWorkModel({
      activity: collectDailyActivity("2026-07-18", {
        conversations: [makeConversation({ id: 1, updatedAt: localTs(2026, 7, 18, 9) })],
        digests: [],
        summaries: [],
      }),
      enrichments: [],
      fileTouches: [],
      resolveTouchConversationId: () => null,
    }),
    [],
    "zh"
  );

  it("detects the deterministic fallback in both locales", () => {
    expect(isDeterministicDailyJournal(fallbackZh)).toBe(true);
    expect(isDeterministicDailyJournal("# 2026-07-18 Daily log\n\n> No model configured — rest")).toBe(true);
    expect(isDeterministicDailyJournal(polished)).toBe(false);
  });

  it("never overwrites an AI-polished log with the deterministic fallback", () => {
    expect(resolveDailyLogWrite({ contentMarkdown: polished }, fallbackZh)).toBe("keep");
  });

  it("writes in every other case", () => {
    expect(resolveDailyLogWrite(null, fallbackZh)).toBe("write");
    expect(resolveDailyLogWrite(null, polished)).toBe("write");
    // Fallback over fallback (regenerate while the model is still down).
    expect(resolveDailyLogWrite({ contentMarkdown: fallbackZh }, fallbackZh)).toBe("write");
    // Polished over fallback (model came back) — the upgrade path.
    expect(resolveDailyLogWrite({ contentMarkdown: fallbackZh }, polished)).toBe("write");
    // Polished over polished (normal regenerate).
    expect(resolveDailyLogWrite({ contentMarkdown: polished }, polished)).toBe("write");
  });
});

// ---- Vault journal paths/documents ----------------------------------------------------

describe("journalVault", () => {
  it("builds stable day/index paths and uuids", () => {
    expect(journalDayRelativePath("2026-07-18")).toBe("journal/2026/2026-07-18.md");
    expect(journalIndexRelativePath("2026-07-18")).toBe("journal/2026/2026-07.md");
    expect(journalDayUuid("2026-07-18")).toBe("vesti-daily-2026-07-18");
    expect(journalIndexUuid("2026-07")).toBe("vesti-daily-index-2026-07");
  });

  it("embeds the log body with frontmatter identity", () => {
    const doc = buildJournalDayDocument({
      date: "2026-07-18",
      contentMarkdown: "# 2026-07-18 日报\n\n## 今日完成\n- x",
      source: "auto",
    });
    expect(doc).toContain('uuid: "vesti-daily-2026-07-18"');
    expect(doc).toContain("date: 2026-07-18");
    expect(doc).toContain("## 今日完成");
  });

  it("builds the month index with newest-first links", () => {
    const doc = buildJournalMonthIndexDocument("2026-07", ["2026-07-18", "2026-07-16"], "zh");
    expect(doc).toContain("# 2026-07 工作日志索引");
    const first = doc.indexOf("[[journal/2026/2026-07-18|2026-07-18]]");
    const second = doc.indexOf("[[journal/2026/2026-07-16|2026-07-16]]");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });
});
