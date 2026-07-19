// P3 upstream export: Notion orchestration (renderer side).
//
// The renderer owns the conversation → Notion blocks conversion (pure,
// unit-tested: >100-block batching, >2000-char rich-text splitting); the main
// process (src/main/notionService.ts) only performs net.fetch with the stored
// token. Re-exporting a conversation archives the old page and recreates it
// (see notionService), and the new page id replaces notion_page_id on the
// conversation record.

import type { AstNode } from "../db/ast";
import { db } from "../db/schema";
import { astNodeToPlainText, isAstRoot } from "../db/utils/astText";
import { resolveMessageExportBodyText } from "../db/utils/messageExportPackage";
import { runBatchExport, type BatchExportProgress, type BatchExportResult } from "./exportRunner";
import {
  formatLocalDateTime,
  type ConversationMarkdownInput,
  type UpstreamMessage,
} from "./markdownSerializer";
import {
  assembleConversationInput,
  listUpstreamExportableRecords,
  loadUpstreamExportContext,
  upstreamErrorText,
  type ExportableConversationRecord,
} from "./obsidianExport";

// ---------------------------------------------------------------------------
// Block primitives
// ---------------------------------------------------------------------------

export interface NotionRichText {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

export interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

export const NOTION_RICH_TEXT_LIMIT = 2_000;
export const NOTION_BLOCKS_PER_REQUEST = 100;
/** Notion caps rich_text arrays; keep paragraphs well under that. */
const MAX_RICH_TEXT_PER_BLOCK = 50;
const MAX_SUMMARY_CALLOUT_CHARS = 5_000;
const MAX_TOOL_FIELD_CHARS = 500;

/**
 * Split long text into ≤limit chunks, preferring newline/space boundaries so
 * every piece fits Notion's 2000-char rich_text limit.
 */
export function splitNotionText(text: string, limit = NOTION_RICH_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.length > 0 ? chunks : [""];
}

/** One logical text run → as many ≤2000-char rich_text items as needed. */
export function richTextFromText(
  text: string,
  extras: { link?: string; annotations?: NotionRichText["annotations"] } = {},
): NotionRichText[] {
  return splitNotionText(text).map((content) => ({
    type: "text",
    text: {
      content,
      ...(extras.link ? { link: { url: extras.link } } : {}),
    },
    ...(extras.annotations ? { annotations: extras.annotations } : {}),
  }));
}

/** Split a block list into ≤100-block batches for the append-children API. */
export function chunkNotionBlocks<T>(blocks: T[], size = NOTION_BLOCKS_PER_REQUEST): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < blocks.length; index += size) {
    batches.push(blocks.slice(index, index + size));
  }
  return batches;
}

function paragraph(richText: NotionRichText[]): NotionBlock {
  return { type: "paragraph", paragraph: { rich_text: richText } };
}

function paragraphsFromText(text: string): NotionBlock[] {
  const chunks = splitNotionText(text);
  const blocks: NotionBlock[] = [];
  for (let index = 0; index < chunks.length; index += MAX_RICH_TEXT_PER_BLOCK) {
    blocks.push(paragraph(chunks.slice(index, index + MAX_RICH_TEXT_PER_BLOCK)
      .map((content) => ({ type: "text", text: { content } }))));
  }
  return blocks;
}

function heading(level: 2 | 3, text: string): NotionBlock {
  const key = level === 2 ? "heading_2" : "heading_3";
  return { type: key, [key]: { rich_text: richTextFromText(text) } };
}

const NOTION_CODE_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  py: "python",
  python: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  sql: "sql",
  go: "go",
  rust: "rust",
  java: "java",
  c: "c",
  cpp: "c++",
  "c++": "c++",
  cs: "c#",
  "c#": "c#",
  markdown: "markdown",
  md: "markdown",
  xml: "xml",
  ruby: "ruby",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kotlin: "kotlin",
  toml: "toml",
  ini: "ini",
  dockerfile: "dockerfile",
  diff: "diff",
};

export function mapNotionCodeLanguage(language: string | null | undefined): string {
  if (!language) return "plain text";
  return NOTION_CODE_LANGUAGES[language.trim().toLowerCase()] ?? "plain text";
}

function codeBlock(code: string, language: string | null | undefined): NotionBlock {
  return {
    type: "code",
    code: {
      rich_text: richTextFromText(code.replace(/\n+$/g, "")),
      language: mapNotionCodeLanguage(language),
    },
  };
}

function callout(richText: NotionRichText[], icon: string): NotionBlock {
  return { type: "callout", callout: { rich_text: richText, icon: { type: "emoji", emoji: icon } } };
}

function quote(richText: NotionRichText[]): NotionBlock {
  return { type: "quote", quote: { rich_text: richText } };
}

function listItem(kind: "bulleted_list_item" | "numbered_list_item", richText: NotionRichText[]): NotionBlock {
  return { type: kind, [kind]: { rich_text: richText } };
}

// ---------------------------------------------------------------------------
// content_ast → blocks
// ---------------------------------------------------------------------------

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function inlineNodesToRichText(nodes: AstNode[], style: InlineStyle = {}): NotionRichText[] {
  const runs: NotionRichText[] = [];
  const annotations = style.bold || style.italic || style.code ? { ...style } : undefined;
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        runs.push(...richTextFromText(node.text, { annotations }));
        break;
      case "strong":
        runs.push(...inlineNodesToRichText(node.children, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inlineNodesToRichText(node.children, { ...style, italic: true }));
        break;
      case "code_inline":
        runs.push(...richTextFromText(node.text, { annotations: { ...annotations, code: true } }));
        break;
      case "math":
        runs.push(...richTextFromText(node.display ? `$$${node.tex}$$` : `$${node.tex}$`, { annotations }));
        break;
      case "br":
        runs.push({ type: "text", text: { content: "\n" } });
        break;
      case "attachment":
        runs.push(...richTextFromText(`[附件: ${node.name}]`, { annotations }));
        break;
      case "fragment":
        runs.push(...inlineNodesToRichText(node.children, style));
        break;
      default:
        runs.push(...richTextFromText(astNodeToPlainText(node), { annotations }));
        break;
    }
  }
  return runs;
}

function listBlocks(
  node: AstNode & { type: "ul" | "ol" },
  depth: number,
): NotionBlock[] {
  const kind = node.type === "ol" ? "numbered_list_item" : "bulleted_list_item";
  const blocks: NotionBlock[] = [];
  for (const item of node.children) {
    if (item.type !== "li") continue;
    const inlineParts: AstNode[] = [];
    const nested: Array<AstNode & { type: "ul" | "ol" }> = [];
    for (const child of item.children) {
      if (child.type === "ul" || child.type === "ol") nested.push(child);
      else inlineParts.push(child);
    }
    // Nested lists are flattened with a two-space indent per depth; Notion
    // list children would complicate the flat >100-block batching.
    const prefix = depth > 0 ? [{ type: "text" as const, text: { content: "  ".repeat(depth) } }] : [];
    blocks.push(listItem(kind, [...prefix, ...inlineNodesToRichText(inlineParts)]));
    for (const child of nested) {
      blocks.push(...listBlocks(child, depth + 1));
    }
  }
  return blocks;
}

function astChildrenToBlocks(children: AstNode[]): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  for (const node of children) {
    switch (node.type) {
      case "p":
        blocks.push(paragraph(inlineNodesToRichText(node.children)));
        break;
      case "h1":
      case "h2":
      case "h3":
        blocks.push(heading(3, inlineNodesToRichText(node.children).map(run => run.text.content).join("")));
        break;
      case "ul":
      case "ol":
        blocks.push(...listBlocks(node, 0));
        break;
      case "code_block":
        blocks.push(codeBlock(node.code, node.language));
        break;
      case "math":
        if (node.display === false) blocks.push(paragraph(richTextFromText(`$${node.tex}$`)));
        else blocks.push({ type: "equation", equation: { expression: node.tex } });
        break;
      case "table":
        // Notion table blocks need row children (awkward with flat batching);
        // a monospace code block keeps the pipe-table readable.
        blocks.push(codeBlock(astNodeToPlainText(node), null));
        break;
      case "blockquote":
        blocks.push(quote(richTextFromText(
          node.children.map(astNodeToPlainText).filter(Boolean).join("\n"),
        )));
        break;
      case "attachment":
        blocks.push(paragraph([
          ...richTextFromText("附件：", { annotations: { bold: true } }),
          ...richTextFromText(`${node.name}${node.mime ? ` (${node.mime})` : ""}`),
        ]));
        break;
      default:
        blocks.push(...paragraphsFromText(astNodeToPlainText(node)));
        break;
    }
  }
  return blocks;
}

/** Plain-text body fallback: fenced code blocks + blank-line paragraphs. */
export function plainTextToNotionBlocks(text: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  let language = "";
  let codeLines: string[] | null = null;
  let paragraphLines: string[] = [];
  const flushParagraph = () => {
    const value = paragraphLines.join("\n").trim();
    paragraphLines = [];
    if (value) blocks.push(...paragraphsFromText(value));
  };
  const flushCode = () => {
    if (codeLines) blocks.push(codeBlock(codeLines.join("\n"), language));
    codeLines = null;
  };
  for (const line of text.split("\n")) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (codeLines) flushCode();
      else {
        flushParagraph();
        language = fence[1] ?? "";
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraphLines.push(line);
    }
  }
  flushParagraph();
  flushCode();
  return blocks;
}

function messageBodyToBlocks(message: UpstreamMessage): NotionBlock[] {
  if (isAstRoot(message.content_ast)) {
    return astChildrenToBlocks(message.content_ast.children);
  }
  return plainTextToNotionBlocks(resolveMessageExportBodyText(message).trim());
}

// ---------------------------------------------------------------------------
// conversation → blocks
// ---------------------------------------------------------------------------

function collapseInline(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

function digestCallout(input: ConversationMarkdownInput): NotionBlock | null {
  const lines: string[] = [];
  if (input.digest?.oneLiner) lines.push(input.digest.oneLiner);
  if ((input.digest?.keyTopics?.length ?? 0) > 0) lines.push(`关键主题：${input.digest!.keyTopics!.join("、")}`);
  if ((input.digest?.decisions?.length ?? 0) > 0) lines.push(`关键决策：${input.digest!.decisions!.join("；")}`);
  if (input.summary?.trim()) {
    const summary = input.summary.trim();
    lines.push(summary.length > MAX_SUMMARY_CALLOUT_CHARS
      ? `${summary.slice(0, MAX_SUMMARY_CALLOUT_CHARS)}…`
      : summary);
  }
  if (lines.length === 0) return null;
  return callout(richTextFromText(lines.join("\n")), "💡");
}

function metaQuote(input: ConversationMarkdownInput): NotionBlock {
  const { conversation } = input;
  const lines = [
    `来源：${input.sourceLabel} · 项目：${input.projectLabel}`,
    ...(input.topicPath ? [`主题：${input.topicPath}`] : []),
    `更新：${formatLocalDateTime(conversation.updated_at)} · 消息数：${input.messages.length}`,
    `uuid：${conversation.uuid}`,
    ...(conversation.url ? [`链接：${conversation.url}`] : []),
  ];
  return quote(richTextFromText(lines.join("\n")));
}

function messageSectionBlocks(message: UpstreamMessage): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  if (message._tool_name) {
    const lines = [`工具：${message._tool_name}`];
    if (message._tool_input) lines.push(`输入：${collapseInline(message._tool_input, MAX_TOOL_FIELD_CHARS)}`);
    if (message._tool_output) lines.push(`输出：${collapseInline(message._tool_output, MAX_TOOL_FIELD_CHARS)}`);
    blocks.push(callout(richTextFromText(lines.join("\n")), "🔧"));
  }
  for (const citation of message.citations ?? []) {
    blocks.push(listItem("bulleted_list_item", [
      ...richTextFromText(citation.label, { link: citation.href }),
      ...richTextFromText(` (${citation.host})`),
    ]));
  }
  for (const attachment of message.attachments ?? []) {
    const label = attachment.label && attachment.label !== attachment.indexAlt
      ? `${attachment.indexAlt} — ${attachment.label}`
      : attachment.indexAlt;
    blocks.push(listItem("bulleted_list_item", richTextFromText(
      `附件：${label}${attachment.mime ? ` (${attachment.mime})` : ""}`,
    )));
  }
  return blocks;
}

/** Conversation → Notion page blocks (digest callout + meta + role sections). */
export function conversationToNotionBlocks(input: ConversationMarkdownInput): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const calloutBlock = digestCallout(input);
  if (calloutBlock) blocks.push(calloutBlock);
  blocks.push(metaQuote(input));
  blocks.push({ type: "divider", divider: {} });
  for (const message of [...input.messages].sort((a, b) => a.created_at - b.created_at)) {
    const roleLabel = message.role === "user" ? "用户" : "AI";
    blocks.push(heading(2, `${roleLabel} · ${formatLocalDateTime(message.created_at)}`));
    blocks.push(...messageBodyToBlocks(message));
    blocks.push(...messageSectionBlocks(message));
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Minimal Markdown → blocks (SendToMenu payload mode: summaries / derived)
// ---------------------------------------------------------------------------

export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  let paragraphLines: string[] = [];
  const flushParagraph = () => {
    const value = paragraphLines.join("\n").trim();
    paragraphLines = [];
    if (value) blocks.push(...paragraphsFromText(value));
  };
  let codeLines: string[] | null = null;
  let codeLanguage = "";
  const flushCode = () => {
    if (codeLines) blocks.push(codeBlock(codeLines.join("\n"), codeLanguage));
    codeLines = null;
  };
  for (const line of markdown.split("\n")) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (codeLines) flushCode();
      else {
        flushParagraph();
        codeLanguage = fence[1] ?? "";
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = Math.min(3, headingMatch[1].length) as 1 | 2 | 3;
      const key = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
      blocks.push({ type: key, [key]: { rich_text: richTextFromText(headingMatch[2].trim()) } });
      continue;
    }
    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push(listItem("bulleted_list_item", richTextFromText(bulletMatch[1].trim())));
      continue;
    }
    const numberedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push(listItem("numbered_list_item", richTextFromText(numberedMatch[1].trim())));
      continue;
    }
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      blocks.push(quote(richTextFromText(quoteMatch[1])));
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ type: "divider", divider: {} });
      continue;
    }
    if (line.trim() === "") flushParagraph();
    else paragraphLines.push(line);
  }
  flushParagraph();
  flushCode();
  return blocks;
}

// ---------------------------------------------------------------------------
// Orchestration (IPC + Dexie export state)
// ---------------------------------------------------------------------------

export interface NotionExportOutcome {
  pageId: string;
  url: string;
}

async function assertNotionConfigured(): Promise<void> {
  const settings = await window.vesti.getSettings();
  if (!settings.upstream.notionTokenConfigured) {
    throw new Error("请先在设置页保存 Notion Integration Token");
  }
  if (!settings.upstream.notionParentId.trim()) {
    throw new Error("请先在设置页填写 Notion 目标页面 / 数据库 ID");
  }
}

async function recordNotionError(conversationId: number, error: unknown): Promise<void> {
  await db.conversations
    .update(conversationId, { notion_export_error: upstreamErrorText(error) })
    .catch(() => undefined);
}

async function exportRecordToNotion(
  record: ExportableConversationRecord,
  context: Awaited<ReturnType<typeof loadUpstreamExportContext>>,
): Promise<NotionExportOutcome> {
  const input = await assembleConversationInput(record, context);
  const blocks = conversationToNotionBlocks(input);
  const result = await window.vesti.exportNotionPage({
    title: record.title || "未命名会话",
    iconEmoji: "🦉",
    blocks,
    existingPageId: typeof record.notion_page_id === "string" ? record.notion_page_id : undefined,
  });
  await db.conversations.update(record.id as number, {
    notion_page_id: result.pageId,
    exported_notion_at: Date.now(),
    notion_export_error: null,
  });
  return result;
}

/** SendToMenu single export: conversation → Notion page under the configured parent. */
export async function exportConversationToNotion(conversationId: number): Promise<NotionExportOutcome> {
  await assertNotionConfigured();
  const record = (await db.conversations.get(conversationId)) as
    | ExportableConversationRecord
    | undefined;
  if (!record || record.id === undefined) throw new Error("找不到该会话，请先重新同步");
  const context = await loadUpstreamExportContext();
  try {
    return await exportRecordToNotion(record, context);
  } catch (error) {
    await recordNotionError(conversationId, error);
    throw new Error(upstreamErrorText(error));
  }
}

/** SendToMenu payload mode: derived Markdown (summary / AITI) → Notion page. */
export async function exportMarkdownPayloadToNotion(input: {
  title: string;
  markdown: string;
}): Promise<NotionExportOutcome> {
  await assertNotionConfigured();
  return window.vesti.exportNotionPage({
    title: input.title || "Vesti 导出",
    iconEmoji: "🦉",
    blocks: markdownToNotionBlocks(input.markdown),
  });
}

/** Batch entry reused from the Obsidian side (task 2): same runner + progress. */
export async function exportConversationsToNotion(
  onProgress?: (progress: BatchExportProgress) => void,
): Promise<BatchExportResult> {
  await assertNotionConfigured();
  const records = await listUpstreamExportableRecords();
  const context = await loadUpstreamExportContext();
  const recordById = new Map(records.map((record) => [record.id as number, record]));
  return runBatchExport(
    records.map((record) => ({ id: record.id as number, title: record.title || "未命名会话" })),
    async (item) => {
      const record = recordById.get(item.id);
      if (!record) throw new Error("找不到该会话");
      try {
        await exportRecordToNotion(record, context);
      } catch (error) {
        await recordNotionError(item.id, error);
        throw new Error(upstreamErrorText(error));
      }
    },
    onProgress,
  );
}
