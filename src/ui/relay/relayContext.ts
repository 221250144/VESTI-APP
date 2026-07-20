// P4a AI relay: condensed multi-conversation context assembly for the relay
// agent kind. Pure functions — the caller (desktopStorage) gathers digests,
// summaries and recent messages from Dexie and passes them in; everything
// budget-related is deterministic and unit-tested here.

import {
  formatRelayFileAnchorBlock,
  type RelayFileAnchor,
} from "./relayFiles";

/** Total transcript budget handed to the relay agent (~24K chars). The main
 * process caps transcriptOverride at 30K, so this always fits. */
export const RELAY_CONTEXT_BUDGET_CHARS = 24_000;
const RECENT_MESSAGE_LIMIT = 6;
const MESSAGE_EXCERPT_MAX_CHARS = 500;
const SUMMARY_FALLBACK_MAX_CHARS = 600;
const SNIPPET_FALLBACK_MAX_CHARS = 200;

export interface RelayContextDigest {
  oneLiner?: string | null;
  keyTopics?: string[];
  keyFiles?: string[];
  decisions?: string[];
  openQuestions?: string[];
}

export interface RelayContextMessage {
  role: string;
  content: string;
}

export interface RelayContextConversation {
  id: number;
  title: string;
  platform: string;
  /** Structured digest (P1.5); preferred context source when present. */
  digest?: RelayContextDigest | null;
  /** Git info from work_sessions (P4a v2), when the capture carries it. */
  git?: { branch?: string | null; remote?: string | null } | null;
  /** Latest summary text; fallback when no digest exists. */
  summary?: string | null;
  /** Plain snippet; last-resort fallback after digest/summary. */
  snippet?: string | null;
  /** Chronological messages; only the most recent ones are excerpted. */
  messages: RelayContextMessage[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function joinList(items: string[] | undefined, maxItems: number): string {
  return (items ?? [])
    .map((item) => collapseWhitespace(item))
    .filter(Boolean)
    .slice(0, maxItems)
    .join("、");
}

/** Digest → summary → title+snippet priority for the per-conversation head. */
function buildConversationHead(
  conversation: RelayContextConversation,
  index: number
): string {
  const lines: string[] = [
    `## 会话 ${index + 1}：《${truncateText(conversation.title || "未命名会话", 80)}》（${conversation.platform}）`,
  ];
  // Git metadata (work_sessions) rides above the digest: it is session-level
  // facts, independent of which text source the head falls back to.
  const gitParts = [
    conversation.git?.branch?.trim(),
    conversation.git?.remote?.trim(),
  ].filter((part): part is string => Boolean(part));
  if (gitParts.length > 0) {
    lines.push(`Git：${truncateText(gitParts.join(" · "), 200)}`);
  }
  const digest = conversation.digest;
  const hasDigest = Boolean(
    digest?.oneLiner ||
      (digest?.keyTopics?.length ?? 0) > 0 ||
      (digest?.decisions?.length ?? 0) > 0
  );
  if (hasDigest && digest) {
    if (digest.oneLiner) lines.push(`一句话：${truncateText(digest.oneLiner, 200)}`);
    const topics = joinList(digest.keyTopics, 6);
    if (topics) lines.push(`关键主题：${topics}`);
    const files = joinList(digest.keyFiles, 6);
    if (files) lines.push(`关键文件：${files}`);
    const decisions = joinList(digest.decisions, 6);
    if (decisions) lines.push(`关键决策：${decisions}`);
    const openQuestions = joinList(digest.openQuestions, 6);
    if (openQuestions) lines.push(`未决问题：${openQuestions}`);
    return lines.join("\n");
  }
  if (conversation.summary?.trim()) {
    lines.push(`摘要：${truncateText(conversation.summary, SUMMARY_FALLBACK_MAX_CHARS)}`);
    return lines.join("\n");
  }
  const snippet = conversation.snippet?.trim()
    ? ` — ${truncateText(conversation.snippet, SNIPPET_FALLBACK_MAX_CHARS)}`
    : "";
  lines.push(`摘要：${truncateText(conversation.title || "未命名会话", 80)}${snippet}`);
  return lines.join("\n");
}

/**
 * Cross-conversation key-file aggregate (P4a v2): dedupe digest.keyFiles in
 * first-seen order so the relay model grounds its key_files output on the
 * union instead of per-conversation fragments. Returns null when no digest
 * carries files (the block is then omitted entirely).
 */
function buildKeyFilesAggregate(
  conversations: RelayContextConversation[],
  maxItems = 12
): string | null {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const conversation of conversations) {
    for (const file of conversation.digest?.keyFiles ?? []) {
      const normalized = collapseWhitespace(file);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(normalized);
      if (files.length >= maxItems) break;
    }
    if (files.length >= maxItems) break;
  }
  if (files.length === 0) return null;
  return `## 关键文件汇总（跨会话去重）\n${files.join("、")}`;
}

/**
 * Most-recent message excerpts fitting `budgetChars`. Walks the tail of the
 * chronological list newest-first, then re-orders chronologically; when the
 * budget can't fit even one excerpt, the last message is included truncated
 * so no conversation is left voiceless.
 */
function collectMessageExcerpts(
  messages: RelayContextMessage[],
  budgetChars: number
): string[] {
  const usable = messages.filter((message) => message.content.trim());
  const picked: string[] = [];
  let remaining = budgetChars;
  for (let index = usable.length - 1; index >= 0 && picked.length < RECENT_MESSAGE_LIMIT; index -= 1) {
    const message = usable[index];
    const role = message.role === "user" ? "用户" : "AI";
    const excerpt = truncateText(message.content, MESSAGE_EXCERPT_MAX_CHARS);
    const line = `[${role}] ${excerpt}`;
    if (line.length > remaining) {
      if (picked.length === 0) {
        picked.push(`[${role}] ${truncateText(message.content, Math.max(0, remaining - role.length - 4))}`);
      }
      break;
    }
    picked.push(line);
    remaining -= line.length + 1;
  }
  return picked.reverse();
}

/**
 * Assemble the relay transcript. Head blocks (digest/summary/fallback) are
 * always kept; the remaining budget is split evenly across conversations for
 * recent-message excerpts. The result never exceeds `budgetChars` (beyond a
 * possible few chars of truncation marker).
 *
 * `options.fileAnchors` (P4a quality): deterministically extracted key-file
 * anchors — when present, a "关键文件（程序提取，带锚点）" block rides at the
 * very top of the transcript (counted against the budget) and the relay
 * prompt pins the model's key_files output to that list.
 */
export function buildRelayTranscript(
  conversations: RelayContextConversation[],
  budgetChars: number = RELAY_CONTEXT_BUDGET_CHARS,
  options: { fileAnchors?: RelayFileAnchor[] } = {}
): string {
  if (conversations.length === 0) return "";

  const anchorBlock = formatRelayFileAnchorBlock(
    options.fileAnchors ?? [],
    (conversationId) => {
      const index = conversations.findIndex(
        (conversation) => conversation.id === conversationId
      );
      return index >= 0 ? `会话 ${index + 1}` : null;
    }
  );
  const aggregate = buildKeyFilesAggregate(conversations);
  const heads = conversations.map((conversation, index) =>
    buildConversationHead(conversation, index)
  );
  const separator = "\n\n";
  // Fixed head blocks, top first: file anchors, digest aggregate, per-
  // conversation heads — all always kept, all counted against the budget.
  const fixedBlocks = [anchorBlock, aggregate, ...heads].filter(
    (block): block is string => Boolean(block)
  );
  const fixedTotal =
    fixedBlocks.reduce((sum, block) => sum + block.length, 0) +
    separator.length * (fixedBlocks.length - 1);
  if (fixedTotal >= budgetChars) {
    return `${fixedBlocks.join(separator).slice(0, Math.max(0, budgetChars - 12))}\n[上下文已截断]`;
  }

  const perConversation = Math.floor((budgetChars - fixedTotal) / conversations.length);
  const headCount = (anchorBlock ? 1 : 0) + (aggregate ? 1 : 0);
  const blocks = conversations.map((conversation, index) => {
    const excerpts = collectMessageExcerpts(conversation.messages, perConversation);
    if (excerpts.length === 0) return heads[index];
    return `${heads[index]}\n最近消息：\n${excerpts.join("\n")}`;
  });

  const assembled = [...fixedBlocks.slice(0, headCount), ...blocks].join(separator);
  if (assembled.length <= budgetChars) return assembled;
  return `${assembled.slice(0, Math.max(0, budgetChars - 12))}\n[上下文已截断]`;
}
