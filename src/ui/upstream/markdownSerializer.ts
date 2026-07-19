// P3 upstream export: conversation → Markdown serialization layer.
//
// Pure functions shared by the Obsidian vault export, the plain Markdown
// directory export, and (as path/placement helpers) the orchestration code.
// Everything here is deterministic and unit-tested; no Dexie / IPC access.

import type { AstNode, AstRoot, AstTableNode } from "../db/ast";
import { getPlatformLabel } from "../db/platform";
import { getConversationOriginAt } from "../db/timestamps";
import type { Conversation, Message } from "../db/types";
import { astNodeToPlainText, isAstRoot } from "../db/utils/astText";
import {
  buildMessageExportSections,
  resolveMessageExportBodyText,
} from "../db/utils/messageExportPackage";

/** Conversation shape plus the capture provenance fields stamped at sync time. */
export type UpstreamConversation = Conversation & {
  _source?: string;
  _cli_id?: string;
  _cli_platform?: string;
  _project_path?: string;
};

/** Message shape plus local-terminal tool-call fields. */
export type UpstreamMessage = Message & {
  _thinking?: string;
  _tool_name?: string;
  _tool_input?: string;
  _tool_output?: string;
};

/** Structural digest mirror (matches @vesti/ui ConversationDigest). */
export interface UpstreamDigest {
  oneLiner?: string | null;
  keyTopics?: string[];
  keyFiles?: string[];
  decisions?: string[];
}

export interface ConversationMarkdownInput {
  conversation: UpstreamConversation;
  messages: UpstreamMessage[];
  sourceLabel: string;
  projectLabel: string;
  /** Topic path joined with " / ", when the conversation is classified. */
  topicPath?: string;
  digest?: UpstreamDigest | null;
  summary?: string | null;
}

export interface ExportPlacement {
  sourceLabel: string;
  projectLabel: string;
}

export const EXPORT_ROOT_FOLDER = "VestiExport";

const MAX_SEGMENT_LENGTH = 60;
const MAX_TOOL_FIELD_LENGTH = 500;

// ---------------------------------------------------------------------------
// Path / filename hygiene
// ---------------------------------------------------------------------------

/**
 * Strip characters that are illegal on Windows/macOS or meaningful to
 * Obsidian (`#^[]|`), collapse whitespace, and cap the length. Returns the
 * fallback when nothing usable remains.
 */
export function sanitizePathSegment(value: string, fallback = "untitled"): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*^#[\]\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const sliced = cleaned.slice(0, MAX_SEGMENT_LENGTH).replace(/[. ]+$/g, "").trim();
  return sliced || fallback;
}

export function sanitizeFileBaseName(title: string): string {
  return sanitizePathSegment(title, "untitled");
}

/** ` (2)`-style suffix inserted before the extension when a name is taken. */
export function resolveConflictRelativePath(
  relativePath: string,
  takenPaths: ReadonlySet<string>,
): string {
  if (!takenPaths.has(relativePath)) return relativePath;
  const dotIndex = relativePath.lastIndexOf(".");
  const base = dotIndex > 0 ? relativePath.slice(0, dotIndex) : relativePath;
  const extension = dotIndex > 0 ? relativePath.slice(dotIndex) : "";
  for (let attempt = 2; ; attempt += 1) {
    const candidate = `${base} (${attempt})${extension}`;
    if (!takenPaths.has(candidate)) return candidate;
  }
}

/**
 * Standard layout: `VestiExport/<来源标签>/<项目或平台域名>/YYYY-MM-DD-<标题>.md`.
 */
export function buildConversationRelativePath(input: {
  sourceLabel: string;
  projectLabel: string;
  originAt: number;
  title: string;
}): string {
  const source = sanitizePathSegment(input.sourceLabel, "Unknown");
  const project = sanitizePathSegment(input.projectLabel, "Unknown");
  const fileName = `${toLocalDate(input.originAt)}-${sanitizeFileBaseName(input.title)}.md`;
  return `${EXPORT_ROOT_FOLDER}/${source}/${project}/${fileName}`;
}

// ---------------------------------------------------------------------------
// Placement (which source/project folders a conversation belongs to)
// ---------------------------------------------------------------------------

function domainOf(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function projectFolderFromPath(projectPath: string | undefined): string | null {
  if (!projectPath) return null;
  const segments = projectPath.split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/**
 * Mirror of the P2 tree placement (来源 → 项目): browser captures group under
 * `Browser/<domain>`, CLI captures under `<平台>/<项目目录名>`.
 */
export function resolveExportPlacement(conversation: {
  platform: string;
  url?: string | null;
  _source?: string;
  _project_path?: string;
}): ExportPlacement {
  if (conversation._source === "browser_extension") {
    return { sourceLabel: "Browser", projectLabel: domainOf(conversation.url ?? "") };
  }
  const sourceLabel = getPlatformLabel(conversation.platform) || "Unknown";
  const projectLabel =
    projectFolderFromPath(conversation._project_path) ??
    (conversation.url ? domainOf(conversation.url) : null) ??
    sourceLabel;
  return { sourceLabel, projectLabel };
}

// ---------------------------------------------------------------------------
// Date helpers (local copies of the exportSerializers formatting)
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDate(value: number): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toLocalDateTime(value: number): string {
  const d = new Date(value);
  return `${toLocalDate(value)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Shared with the Notion block builder (message role headings). */
export { toLocalDateTime as formatLocalDateTime };

function toIsoWithOffset(value: number): string {
  const d = new Date(value);
  const tzOffsetMinutes = -d.getTimezoneOffset();
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(tzOffsetMinutes);
  return `${toLocalDate(value)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** YAML-safe scalar: plain when harmless, JSON double-quoted otherwise. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value) ? value : JSON.stringify(value);
}

function yamlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

export function buildFrontmatter(input: ConversationMarkdownInput): string {
  const { conversation } = input;
  const originAt = getConversationOriginAt(conversation);
  const lines: string[] = [
    "---",
    `platform: ${yamlScalar(conversation.platform)}`,
    `source: ${yamlScalar(conversation._source ?? "unknown")}`,
    `project: ${yamlScalar(input.projectLabel)}`,
  ];
  if (input.topicPath) lines.push(`topic: ${yamlScalar(input.topicPath)}`);
  lines.push(
    `tags: ${yamlStringArray(conversation.tags ?? [])}`,
    `uuid: ${yamlScalar(conversation.uuid)}`,
    `created: ${yamlScalar(toIsoWithOffset(originAt))}`,
    `updated: ${yamlScalar(toIsoWithOffset(conversation.updated_at))}`,
    `message_count: ${input.messages.length}`,
    "---",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// content_ast → Markdown
// ---------------------------------------------------------------------------

const HEADING_OFFSET_INSIDE_MESSAGE = 3;

function inlineNodesToMarkdown(children: AstNode[]): string {
  return children.map(inlineNodeToMarkdown).join("");
}

function inlineNodeToMarkdown(node: AstNode): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "strong":
      return `**${inlineNodesToMarkdown(node.children)}**`;
    case "em":
      return `*${inlineNodesToMarkdown(node.children)}*`;
    case "code_inline":
      return `\`${node.text.replace(/`/g, "\\`")}\``;
    case "math":
      return node.display ? `$$${node.tex}$$` : `$${node.tex}$`;
    case "br":
      return "\n";
    case "attachment":
      return `[附件: ${node.name}]`;
    case "fragment":
      return inlineNodesToMarkdown(node.children);
    default:
      // Block-level node in an inline position: degrade to plain text.
      return astNodeToPlainText(node);
  }
}

function tableCellToMarkdown(children: AstNode[]): string {
  return inlineNodesToMarkdown(children).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function tableToMarkdown(node: AstTableNode): string {
  const header = node.kind === "v2"
    ? node.columns.map((column) => tableCellToMarkdown(column.header))
    : node.headers.map((cell) => cell.replace(/\|/g, "\\|").trim());
  const rows = node.kind === "v2"
    ? node.rows.map((row) => row.cells.map((cell) => tableCellToMarkdown(cell.children)))
    : node.rows.map((row) => row.map((cell) => cell.replace(/\|/g, "\\|").trim()));
  const separator = header.map(() => "---");
  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function listToMarkdown(node: AstNode & { type: "ul" | "ol" }, depth: number): string {
  const indent = "  ".repeat(depth);
  return node.children
    .map((item, index) => {
      const marker = node.type === "ol" ? `${index + 1}.` : "-";
      const inlineParts: AstNode[] = [];
      const nestedLists: Array<AstNode & { type: "ul" | "ol" }> = [];
      if (item.type !== "li") return null;
      for (const child of item.children) {
        if (child.type === "ul" || child.type === "ol") nestedLists.push(child);
        else inlineParts.push(child);
      }
      const lines = [`${indent}${marker} ${inlineNodesToMarkdown(inlineParts).trim()}`];
      for (const nested of nestedLists) {
        lines.push(listToMarkdown(nested, depth + 1));
      }
      return lines.join("\n");
    })
    .filter((block): block is string => block !== null)
    .join("\n");
}

function blockNodeToMarkdown(node: AstNode, headingOffset: number): string {
  switch (node.type) {
    case "p":
      return inlineNodesToMarkdown(node.children).trim();
    case "h1":
    case "h2":
    case "h3": {
      const level = Math.min(6, (node.type === "h1" ? 1 : node.type === "h2" ? 2 : 3) + headingOffset);
      return `${"#".repeat(level)} ${inlineNodesToMarkdown(node.children).trim()}`;
    }
    case "ul":
    case "ol":
      return listToMarkdown(node, 0);
    case "code_block": {
      const fence = node.code.includes("```") ? "~~~~" : "```";
      const language = node.language ?? "";
      return `${fence}${language}\n${node.code.replace(/\n+$/g, "")}\n${fence}`;
    }
    case "math":
      return node.display === false ? `$${node.tex}$` : `$$\n${node.tex}\n$$`;
    case "table":
      return tableToMarkdown(node);
    case "blockquote":
      return node.children
        .map((child) => blockNodeToMarkdown(child, headingOffset))
        .filter(Boolean)
        .map((block) => block.split("\n").map((line) => `> ${line}`).join("\n"))
        .join("\n>\n");
    case "attachment":
      return `**附件：**${node.name}${node.mime ? ` (${node.mime})` : ""}`;
    default:
      return astNodeToPlainText(node).trim();
  }
}

/** Render a full AST root as Markdown blocks separated by blank lines. */
export function astRootToMarkdown(root: AstRoot, headingOffset = 0): string {
  return root.children
    .map((node) => blockNodeToMarkdown(node, headingOffset))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Message body
// ---------------------------------------------------------------------------

function collapseInline(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function pushToolCallLines(lines: string[], message: UpstreamMessage): void {
  if (!message._tool_name) return;
  lines.push("");
  lines.push(`> **工具：**${message._tool_name}`);
  if (message._tool_input) {
    lines.push(`> **输入：**\`${collapseInline(message._tool_input, MAX_TOOL_FIELD_LENGTH).replace(/`/g, "'")}\``);
  }
  if (message._tool_output) {
    lines.push(`> **输出：**\`${collapseInline(message._tool_output, MAX_TOOL_FIELD_LENGTH).replace(/`/g, "'")}\``);
  }
}

function messageBodyToMarkdown(message: UpstreamMessage): string {
  if (isAstRoot(message.content_ast)) {
    return astRootToMarkdown(message.content_ast, HEADING_OFFSET_INSIDE_MESSAGE);
  }
  return resolveMessageExportBodyText(message).trim();
}

function messageToMarkdown(message: UpstreamMessage): string {
  const roleLabel = message.role === "user" ? "用户" : "AI";
  const lines: string[] = [`### ${roleLabel} · ${toLocalDateTime(message.created_at)}`, ""];
  const body = messageBodyToMarkdown(message);
  if (body) lines.push(body);
  pushToolCallLines(lines, message);
  for (const section of buildMessageExportSections(message, "md")) {
    lines.push("");
    lines.push(`**${section.title}**`);
    lines.push(...section.lines);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

export function serializeConversationMarkdown(input: ConversationMarkdownInput): string {
  const { conversation, messages } = input;
  const originAt = getConversationOriginAt(conversation);
  const parts: string[] = [buildFrontmatter(input), "", `# ${conversation.title || "未命名会话"}`, ""];

  const metaLines = [
    `> **来源：**${input.sourceLabel} · **项目：**${input.projectLabel}`,
    `> **时间：**${toLocalDateTime(originAt)} · **更新：**${toLocalDateTime(conversation.updated_at)} · **消息数：**${messages.length}`,
  ];
  if (input.topicPath) metaLines.push(`> **主题：**${input.topicPath}`);
  if ((conversation.tags ?? []).length > 0) metaLines.push(`> **标签：**${conversation.tags.join("、")}`);
  if (conversation.url) metaLines.push(`> **链接：**${conversation.url}`);
  parts.push(metaLines.join("\n"), "");

  const digest = input.digest;
  const hasDigest = Boolean(
    digest?.oneLiner ||
    (digest?.keyTopics?.length ?? 0) > 0 ||
    (digest?.decisions?.length ?? 0) > 0,
  );
  if (hasDigest || input.summary) {
    parts.push("## 摘要", "");
    if (digest?.oneLiner) parts.push(`> ${digest.oneLiner}`, "");
    if ((digest?.keyTopics?.length ?? 0) > 0) parts.push(`- **关键主题：**${digest!.keyTopics!.join("、")}`);
    if ((digest?.keyFiles?.length ?? 0) > 0) parts.push(`- **关键文件：**${digest!.keyFiles!.join("、")}`);
    if ((digest?.decisions?.length ?? 0) > 0) parts.push(`- **关键决策：**${digest!.decisions!.join("；")}`);
    if (hasDigest) parts.push("");
    if (input.summary) parts.push(input.summary.trim(), "");
  }

  parts.push("---", "");
  const sortedMessages = [...messages].sort((a, b) => a.created_at - b.created_at);
  for (const message of sortedMessages) {
    parts.push(messageToMarkdown(message), "");
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
