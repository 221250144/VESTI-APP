// Pipeline-level regression tests for 常用提示词 extraction: the heuristic
// path (scanUserPromptInputs → selectClustersForExtraction) is the always-on
// fallback when no LLM is configured or the distill call fails. Two earlier
// bugs made "提取" look broken: agent CLI sessions never fed the scanner, and
// unreachable curation gates made the selection deterministically empty.

import { describe, expect, it } from "vitest";
import { selectClustersForExtraction } from "./promptCuration";
import { scanUserPromptInputs, type PromptScanUserInput } from "./promptScanner";

// A realistic, well-structured prompt body: instruction verb + 60–1200 chars +
// bullets + a template variable clears both curation gates (recurring 0.5,
// singleton 0.6) without any LLM enrichment.
const REVIEW_PROMPT = [
  "请扮演资深工程师，帮我审查下面这段代码：",
  "- 先列出正确性 bug，按严重程度排序",
  "- 再指出可读性与性能问题",
  "- 每条给出具体修改建议",
  "代码：{{code}}",
].join("\n");

const SUMMARY_PROMPT =
  "请把下面的会议记录总结成要点列表，每条不超过 50 字，保留所有日期、人名和数字，最后单独列出待办事项：{{notes}}";

function input(overrides: Partial<PromptScanUserInput> = {}): PromptScanUserInput {
  return {
    origin: "agent",
    conversationId: "agent-session-1",
    conversationTitle: "代码审查会话",
    text: REVIEW_PROMPT,
    ...overrides,
  };
}

describe("extraction pipeline (scan → curate, no LLM)", () => {
  it("produces a non-empty selection from realistic mixed agent + browser input", () => {
    const inputs: PromptScanUserInput[] = [
      // The same prompt recurs across two agent sessions and one browser chat.
      input({ origin: "agent", conversationId: "s1", text: REVIEW_PROMPT }),
      input({ origin: "agent", conversationId: "s2", text: REVIEW_PROMPT }),
      input({ origin: "browser", conversationId: "101", conversationTitle: "网页对话", text: REVIEW_PROMPT }),
      // A second pattern, seen once.
      input({ origin: "agent", conversationId: "s3", text: SUMMARY_PROMPT }),
      // Noise that must be filtered out.
      input({ conversationId: "s1", text: "好的" }),
      input({ conversationId: "s2", text: "继续" }),
      input({ conversationId: "s3", text: "嗯" }),
    ];

    const clusters = scanUserPromptInputs(inputs);
    expect(clusters.length).toBe(2);

    const selected = selectClustersForExtraction(clusters);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0].body).toBe(REVIEW_PROMPT);
  });

  it("keeps agent-session provenance on the extracted clusters", () => {
    const clusters = scanUserPromptInputs([
      input({ origin: "agent", conversationId: "cli-1" }),
      input({ origin: "agent", conversationId: "cli-2" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceCount).toBe(2);
    expect(clusters[0].sources.every((source) => source.origin === "agent")).toBe(true);
  });

  it("merges template-similar fills from agent and browser into one cluster", () => {
    const clusters = scanUserPromptInputs([
      input({
        origin: "agent",
        conversationId: "cli-1",
        text: "请总结下面的会议记录：{{项目周报}}\n要求分点输出，保留所有数字。",
      }),
      input({
        origin: "browser",
        conversationId: "55",
        conversationTitle: "浏览器会话",
        text: "请总结下面的会议记录：{{客户拜访}}\n要求分点输出，保留所有数字。",
      }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceCount).toBe(2);
  });
});
