// Two-pass pipeline orchestration tests: an injected fake LLM runner drives
// pass 1 (per-cluster extraction) and pass 2 (synthesis) end to end, covering
// fork-merged input, cluster-LLM degradation, synthesis degradation and the
// no-LLM deterministic path. No Electron/Dexie — the runner is a plain stub.

import { describe, expect, it } from "vitest";
import { collectDailyActivity, type DailyConversationInput, type DailyDigestInput } from "./dailyActivity";
import { buildDailyWorkModel, type DailyWorkModel } from "./dailyJournal";
import {
  extractDailyClusterBriefs,
  parseDailyClusterPayload,
  runDailyTwoPassPipeline,
  type DailyLlmRunner,
} from "./dailyPipeline";

function localTs(year: number, month: number, day: number, hours = 12): number {
  return new Date(year, month - 1, day, hours, 0, 0).getTime();
}

function makeModel(): DailyWorkModel {
  const conversations: DailyConversationInput[] = [
    {
      id: 1,
      title: "日报质量升级",
      platform: "Codex",
      updatedAt: localTs(2026, 7, 18, 9),
      messageCount: 235,
      source: "cli",
      projectLabel: "vesti-app",
    },
    {
      id: 2,
      title: "日报质量升级（续）",
      platform: "Codex",
      updatedAt: localTs(2026, 7, 18, 15),
      messageCount: 521,
      source: "cli",
      projectLabel: "vesti-app",
    },
    {
      id: 3,
      title: "relay 锚点复用调研",
      platform: "Kimi Code",
      updatedAt: localTs(2026, 7, 18, 17),
      messageCount: 88,
      source: "cli",
      projectLabel: "vesti-relay",
    },
    {
      id: 9,
      title: "Obsidian journal 组织方式",
      platform: "ChatGPT",
      updatedAt: localTs(2026, 7, 18, 20),
      messageCount: 12,
      source: "browser",
      projectLabel: "chatgpt.com",
    },
  ];
  const digests: DailyDigestInput[] = [
    {
      conversationId: 1,
      oneLiner: "设计并落地两遍日报管线",
      keyTopics: ["日报"],
      keyFiles: ["src/ui/daily/dailyJournal.ts"],
      decisions: ["文件小节只由程序渲染"],
    },
    {
      conversationId: 3,
      oneLiner: "确认 relay 锚点机制可复用",
      keyTopics: ["relay"],
      keyFiles: ["src/ui/relay/relayFiles.ts"],
      decisions: ["复用 extractTouchPath"],
    },
  ];
  const activity = collectDailyActivity("2026-07-18", {
    conversations,
    digests,
    summaries: [{ conversationId: 9, content: "确定按 journal/YYYY/ 组织长期日志", createdAt: 1 }],
  });
  return buildDailyWorkModel({
    activity,
    enrichments: [
      {
        conversationId: 1,
        cliId: "s1",
        forkedFrom: null,
        uniqueMessageCount: null,
        openQuestions: ["周报是否改为汇总日报"],
        subagents: [],
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
    fileTouches: [
      {
        sessionId: "s1",
        toolName: "Edit",
        toolCategory: "file_edit",
        inputSummary: JSON.stringify({ file_path: "src/ui/daily/dailyJournal.ts" }),
        timestamp: localTs(2026, 7, 18, 10),
      },
    ],
    resolveTouchConversationId: (sessionId) => (sessionId === "s1" ? 1 : null),
  });
}

/** Fake LLM: fixed JSON for cluster extraction, fixed Markdown for synthesis. */
function makeFakeRunner(overrides?: {
  clusterJson?: string;
  synthesisMarkdown?: string;
  failClustersFor?: (transcript: string) => boolean;
}): { run: DailyLlmRunner; calls: Array<{ template: string; transcript: string }> } {
  const calls: Array<{ template: string; transcript: string }> = [];
  const run: DailyLlmRunner = async ({ template, transcript }) => {
    calls.push({ template, transcript });
    if (template === "daily-cluster") {
      if (overrides?.failClustersFor?.(transcript)) throw new Error("模型超时");
      return (
        overrides?.clusterJson ??
        JSON.stringify({
          theme: "日报两遍管线",
          goal: "把日报升级为工作记录系统",
          completed: ["完成 pass1 簇提取并联调通过"],
          in_progress: ["周报联调停在用例编写"],
          decisions: ["fork 链按工作项归并"],
          open_questions: ["周报是否改为汇总日报"],
        })
      );
    }
    if (overrides?.synthesisMarkdown) return overrides.synthesisMarkdown;
    return [
      "## 今日完成",
      "- 完成两遍日报管线的设计与联调",
      "- 确定长期日志的 vault 组织方式",
      "",
      "## 项目工作流分解",
      "### vesti-app",
      "- 目标：落地日报质量升级",
      "- 今日进展：两遍管线联调通过",
      "- 当前状态：周报联调进行中",
      "",
      "{{KEY_FILES}}",
      "",
      "## 决策与发现",
      "- 文件小节只由程序渲染，杜绝模型编造路径",
      "",
      "## 网页端对话摘要",
      "- 确定按 journal/YYYY/ 组织长期日志",
      "",
      "## 明日线索",
      "- 完成周报汇总逻辑联调",
    ].join("\n");
  };
  return { run, calls };
}

describe("parseDailyClusterPayload", () => {
  it("parses strict JSON and tolerates code fences", () => {
    const payload = parseDailyClusterPayload(
      '```json\n{"theme": "日报", "goal": "g", "completed": ["a"], "in_progress": [], "decisions": [], "open_questions": ["q"]}\n```'
    );
    expect(payload.theme).toBe("日报");
    expect(payload.completed).toEqual(["a"]);
    expect(payload.open_questions).toEqual(["q"]);
  });

  it("rejects non-JSON and empty output", () => {
    expect(() => parseDailyClusterPayload("不是 JSON")).toThrow();
    expect(() => parseDailyClusterPayload('{"theme": "", "goal": "", "completed": []}')).toThrow();
  });
});

describe("extractDailyClusterBriefs", () => {
  it("runs pass 1 once per LLM-worthy cluster and merges fork chains into one cluster", () => {
    const model = makeModel();
    expect(model.clusters).toHaveLength(3); // vesti-app (fork-merged), vesti-relay, chatgpt.com
    const { run, calls } = makeFakeRunner();
    return extractDailyClusterBriefs(model, run).then((briefs) => {
      expect(briefs).toHaveLength(3);
      // All three clusters carry digest/summary material → three LLM calls.
      expect(calls.filter((call) => call.template === "daily-cluster")).toHaveLength(3);
      const vesti = briefs.find((brief) => brief.projectLabel === "vesti-app");
      expect(vesti?.fromLlm).toBe(true);
      expect(vesti?.theme).toBe("日报两遍管线");
      expect(vesti?.completed).toEqual(["完成 pass1 簇提取并联调通过"]);
    });
  });

  it("degrades a failing cluster call to the deterministic brief", async () => {
    const model = makeModel();
    const { run, calls } = makeFakeRunner({
      failClustersFor: (transcript) => transcript.includes("vesti-app"),
    });
    const briefs = await extractDailyClusterBriefs(model, run);
    const vesti = briefs.find((brief) => brief.projectLabel === "vesti-app");
    expect(vesti?.fromLlm).toBe(false);
    // Deterministic fallback still carries the digest-derived content.
    expect(vesti?.completed.join("\n")).toContain("设计并落地两遍日报管线");
    expect(vesti?.openQuestions).toContain("周报是否改为汇总日报");
    // The other clusters still got their LLM calls.
    expect(calls.filter((call) => call.template === "daily-cluster")).toHaveLength(3);
  });

  it("skips the LLM entirely without a runner (deterministic briefs)", async () => {
    const briefs = await extractDailyClusterBriefs(makeModel(), null);
    expect(briefs.every((brief) => !brief.fromLlm)).toBe(true);
    const vesti = briefs.find((brief) => brief.projectLabel === "vesti-app");
    expect(vesti?.completed.join("\n")).toContain("设计并落地两遍日报管线");
  });
});

describe("runDailyTwoPassPipeline", () => {
  it("orchestrates pass 1 + pass 2 and composes the final report", async () => {
    const model = makeModel();
    const { run, calls } = makeFakeRunner();
    const { contentMarkdown, briefs } = await runDailyTwoPassPipeline({
      model,
      projectMemory: [],
      previousLogMarkdown: null,
      run,
      locale: "zh",
    });
    // Pass 1: 3 cluster calls; pass 2: exactly 1 synthesis call, fed with the
    // pass-1 briefs.
    expect(calls.filter((call) => call.template === "daily-cluster")).toHaveLength(3);
    const synthesis = calls.filter((call) => call.template === "daily");
    expect(synthesis).toHaveLength(1);
    expect(synthesis[0].transcript).toContain("完成 pass1 簇提取并联调通过");
    expect(briefs.find((brief) => brief.projectLabel === "vesti-app")?.fromLlm).toBe(true);

    // The composed report: canonical title, LLM prose, deterministic files.
    expect(contentMarkdown).toMatch(/^# 2026-07-18 日报/);
    expect(contentMarkdown).toContain("- 完成两遍日报管线的设计与联调");
    expect(contentMarkdown).not.toContain("{{KEY_FILES}}");
    expect(contentMarkdown).toContain("## 关键文件\n- `src/ui/daily/dailyJournal.ts`（修改");
    expect(contentMarkdown).toContain("## 网页端对话摘要");
    expect(contentMarkdown).toContain("## 明日线索");
  });

  it("degrades to the deterministic journal when synthesis fails", async () => {
    const model = makeModel();
    const { run } = makeFakeRunner();
    const failing: DailyLlmRunner = async (request) => {
      if (request.template === "daily") throw new Error("模型服务不可用");
      return run(request);
    };
    const { contentMarkdown, briefs } = await runDailyTwoPassPipeline({
      model,
      projectMemory: [],
      previousLogMarkdown: null,
      run: failing,
      locale: "zh",
    });
    // Pass-1 briefs are still LLM-backed; the report is the deterministic
    // render over them (marked as local template output).
    expect(briefs.some((brief) => brief.fromLlm)).toBe(true);
    expect(contentMarkdown).toContain("配置模型后可为今天重新生成");
    expect(contentMarkdown).toContain("## 关键文件");
    expect(contentMarkdown).toContain("完成 pass1 簇提取并联调通过");
  });

  it("renders the full deterministic journal without any LLM", async () => {
    const model = makeModel();
    const { contentMarkdown } = await runDailyTwoPassPipeline({
      model,
      projectMemory: [],
      previousLogMarkdown: null,
      run: null,
      locale: "zh",
    });
    for (const section of ["## 今日完成", "## 项目工作流分解", "## 关键文件", "## 决策与发现", "## 网页端对话摘要", "## 明日线索"]) {
      expect(contentMarkdown).toContain(section);
    }
    expect(contentMarkdown).toContain("确定按 journal/YYYY/ 组织长期日志");
    expect(contentMarkdown).toContain("周报是否改为汇总日报");
    // The fork pair is one work item, not two session rows.
    expect(contentMarkdown.match(/### vesti-app/g)).toHaveLength(1);
  });
});
