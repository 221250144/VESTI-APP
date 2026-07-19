// P4b knowledge extract: extract result → Markdown serialization, in the
// style of the P4a relayMarkdown (deterministic pure function, no IO).
// Shared by the ExtractPanel (copy/export) and the deposits save flow (the
// serialized body becomes the deposit's content_markdown).

import type { ExtractResult } from "../types";

const MAX_SEGMENT_LENGTH = 60;

/** Strip characters illegal on Windows/macOS or meaningful to Obsidian,
 * collapse whitespace and cap the length (mirror of the desktop P3
 * markdownSerializer helper, kept tiny for download filenames). */
export function sanitizeFileBaseName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*^#[\]\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const sliced = cleaned.slice(0, MAX_SEGMENT_LENGTH).replace(/[. ]+$/g, "").trim();
  return sliced || "untitled";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDateTime(value: number): string {
  const d = new Date(value);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "无";
  return items.map((item) => `- ${item}`).join("\n");
}

function codeFence(code: string): string {
  // Longer than any backtick run inside the code, so the fence never breaks.
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function serializeExtractMarkdown(result: ExtractResult, createdAt: number = Date.now()): string {
  const { extract } = result;
  const parts: string[] = [
    `# ${result.title}`,
    "",
    `> **生成时间：**${toLocalDateTime(createdAt)} · **来源会话：**${result.conversationIds.length} 个`,
    "",
    "## 知识点",
    "",
    bulletList(extract.knowledge_points),
    "",
    "## 代码片段",
    "",
    extract.code_snippets.length === 0
      ? "无"
      : extract.code_snippets
          .map((snippet) => {
            const fence = codeFence(snippet.code);
            return [
              `### ${snippet.why || "代码片段"}`,
              "",
              `${fence}${snippet.language}`,
              snippet.code,
              fence,
            ].join("\n");
          })
          .join("\n\n"),
    "",
    "## 决策记录",
    "",
    extract.decisions.length === 0
      ? "无"
      : extract.decisions
          .map((decision, index) =>
            [
              `### ${index + 1}. ${decision.title}`,
              "",
              `- **背景：**${decision.context || "无"}`,
              `- **决策：**${decision.decision || "无"}`,
              `- **影响：**${decision.consequences || "无"}`,
            ].join("\n")
          )
          .join("\n\n"),
    "",
    "## 提示词",
    "",
    extract.prompts.length === 0
      ? "无"
      : extract.prompts
          .map((prompt, index) => `${index + 1}. ${prompt}`)
          .join("\n"),
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
