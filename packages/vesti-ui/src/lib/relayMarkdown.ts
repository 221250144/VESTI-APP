// P4a AI relay: handoff pack → Markdown serialization, in the style of the
// P3 conversation markdownSerializer (deterministic pure function, no IO).
// Shared by the RelayPanel (copy/export) and the desktop storage layer
// (CLI-launch file, extension outbox delivery).

import type { RelayPack } from "../types";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDateTime(value: number): string {
  const d = new Date(value);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toIsoWithOffset(value: number): string {
  const d = new Date(value);
  const tzOffsetMinutes = -d.getTimezoneOffset();
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(tzOffsetMinutes);
  return `${toLocalDateTime(value).slice(0, 10)}T${toLocalDateTime(value).slice(11)}${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
}

/** YAML-safe scalar: plain when harmless, JSON double-quoted otherwise. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value) ? value : JSON.stringify(value);
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "无";
  return items.map((item) => `- ${item}`).join("\n");
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function keyFilesTable(files: RelayPack["pack"]["key_files"]): string {
  if (files.length === 0) return "无";
  const rows = files.map(
    (file) => `| ${tableCell(file.path)} | ${tableCell(file.why)} | ${tableCell(file.last_state)} |`
  );
  return ["| 文件 | 作用 | 当前状态 |", "| --- | --- | --- |", ...rows].join("\n");
}

export function serializeRelayPackMarkdown(pack: RelayPack): string {
  const { pack: payload } = pack;
  const parts: string[] = [
    [
      "---",
      `relay_id: ${pack.id}`,
      `title: ${yamlScalar(pack.title)}`,
      `created: ${yamlScalar(toIsoWithOffset(pack.createdAt))}`,
      `source: ${pack.source}`,
      `conversations: ${pack.conversationIds.length}`,
      "---",
    ].join("\n"),
    "",
    `# 交接包：${pack.title}`,
    "",
    `> **生成时间：**${toLocalDateTime(pack.createdAt)} · **来源会话：**${pack.conversationIds.length} 个`,
    "",
    "## 目标",
    "",
    payload.goal || "无",
    "",
    "## 当前状态",
    "",
    payload.current_state || "无",
    "",
    "## 关键决策",
    "",
    bulletList(payload.key_decisions),
    "",
    "## 关键文件",
    "",
    keyFilesTable(payload.key_files),
    "",
    "## 未决问题",
    "",
    bulletList(payload.open_issues),
    "",
    "## 下一步",
    "",
    payload.next_steps.length === 0
      ? "无"
      : payload.next_steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
    "",
    "## 建议提示词",
    "",
    "```text",
    pack.suggestedPrompt,
    "```",
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
