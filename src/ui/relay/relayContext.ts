// P4a AI relay: condensed multi-conversation context assembly for the relay
// agent kind. Pure functions — the caller (desktopStorage) gathers digests,
// summaries and recent messages from Dexie and passes them in; everything
// budget-related is deterministic and unit-tested here.
//
// V2 (2026-07): unified relay pack schema, priority-weighted budget allocation,
// primary conversation support, and cross-session timeline assembly.

import {
  formatRelayFileAnchorBlock,
  type RelayFileAnchor,
} from "./relayFiles";

/** Total transcript budget handed to the relay agent. The main process caps
 * transcriptOverride at 30K, so this always fits.
 * V2: raised from 24K to 28K — modern models comfortably hold >28K of
 * structured context per turn and the extra headroom buys significantly more
 * message excerpts for multi-conversation relays. */
export const RELAY_CONTEXT_BUDGET_CHARS = 28_000;
/** Budget when only a single conversation is selected — most of the handoff
 * value comes from the target session's own details. */
export const RELAY_SINGLE_CONVERSATION_BUDGET_CHARS = 18_000;
const RECENT_MESSAGE_LIMIT = 8;
const MESSAGE_EXCERPT_MAX_CHARS = 600;
const SUMMARY_FALLBACK_MAX_CHARS = 600;
const SNIPPET_FALLBACK_MAX_CHARS = 200;
/** Minimum excerpt budget per conversation so none is voiceless. */
const MIN_PER_CONVERSATION_EXCERPT_CHARS = 800;
/** Fraction of remaining budget reserved for the primary conversation. */
const PRIMARY_CONVERSATION_BUDGET_FRACTION = 0.5;

// ---- V2 Unified Relay Pack Schema -------------------------------------------

/** Environment state captured from tool executions and session metadata. */
export interface RelayPackEnvironment {
  gitBranch?: string;
  gitRemote?: string;
  dirtyFiles?: string[];
  lastCommits?: string[];
  nodeVersion?: string;
  packageManager?: string;
}

/** A structured decision with rationale. */
export interface RelayPackDecision {
  decision: string;
  rationale: string;
}

/** A failed/dead-end path that was tried and abandoned. */
export interface RelayPackFailedPath {
  approach: string;
  whyFailed: string;
  /** Where in the conversation this is evidenced (message index or digest ref). */
  evidence: string;
}

/** Verification state — programmatically extracted when possible. */
export interface RelayPackVerification {
  /** The last verification command that was actually executed. */
  lastCommand: string;
  /** Its most recent output (truncated). */
  lastResult: string;
  /** Whether the last run passed (inferred from exit code or output signal). */
  passed: boolean;
}

/** Confidence assessment for the relay pack. */
export interface RelayPackConfidence {
  overall: number;   // 0-1
  lowAreas: string[];
}

/** V2 unified relay pack schema — the single machine-readable format shared
 * across the relay LLM pack, capsule draft, and VESTI-SKILLS handoff. */
export interface RelayPackV2 {
  meta: {
    version: 2;
    createdAt: string;           // ISO 8601
    conversationCount: number;
    primaryConversationId?: number;
  };
  goal: string;
  state: {
    completed: string[];
    inProgress: string[];
    blocked: string[];           // new: items blocked by unresolved dependencies
  };
  files: RelayFileAnchor[];      // program-extracted, not LLM-invented
  decisions: RelayPackDecision[];
  failedPaths: RelayPackFailedPath[];
  verification: RelayPackVerification;
  nextSteps: string[];
  confidence: RelayPackConfidence;
  /** Environment snapshot gathered from tool executions. */
  environment?: RelayPackEnvironment;
  /** Paste-ready handoff prompt with framing prefix + verify-first suffix. */
  handoffPrompt: string;
}

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

/** A1: compact one-line brief of a subagent run folded under the selected
 * conversation — delegated work must survive into handoff packs. */
export interface RelayContextSubagent {
  role?: string | null;
  title: string;
  oneLiner?: string | null;
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
  /** A1: briefs of subagent runs spawned by this conversation (optional). */
  subagents?: RelayContextSubagent[];
  /** Timestamp for timeline ordering (epoch ms). */
  createdAt?: number;
  /** V2: when true, this conversation is the primary and gets weighted budget. */
  isPrimary?: boolean;
}

/**
 * V2: compute a conversation's information density score for budget weighting.
 * Decision-heavy and file-rich conversations carry more relay value and get
 * proportionally more excerpt budget.
 */
export function computeConversationPriority(
  conversation: RelayContextConversation
): number {
  let score = 1.0;
  if (conversation.isPrimary) score += 0.5;
  if ((conversation.digest?.decisions?.length ?? 0) > 0) score += 0.3;
  if ((conversation.digest?.keyFiles?.length ?? 0) > 0) score += 0.2;
  if ((conversation.digest?.openQuestions?.length ?? 0) > 0) score += 0.2;
  if (conversation.git?.branch) score += 0.1;
  // Platforms that carry structured agent work (tool calls, file edits)
  // typically have richer handoff content than casual chat platforms.
  const structuredPlatforms = new Set([
    'claude-code', 'kimi-code', 'codex', 'cursor', 'aider',
    'Claude Code', 'Kimi Code', 'Codex', 'Cursor', 'Aider',
  ]);
  if (structuredPlatforms.has(conversation.platform)) score += 0.1;
  return score;
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
    appendSubagentLines(lines, conversation.subagents);
    return lines.join("\n");
  }
  if (conversation.summary?.trim()) {
    lines.push(`摘要：${truncateText(conversation.summary, SUMMARY_FALLBACK_MAX_CHARS)}`);
    appendSubagentLines(lines, conversation.subagents);
    return lines.join("\n");
  }
  const snippet = conversation.snippet?.trim()
    ? ` — ${truncateText(conversation.snippet, SNIPPET_FALLBACK_MAX_CHARS)}`
    : "";
  lines.push(`摘要：${truncateText(conversation.title || "未命名会话", 80)}${snippet}`);
  appendSubagentLines(lines, conversation.subagents);
  return lines.join("\n");
}

/** A1: bounded subagent rollup under the conversation head — delegated work
 * (review runs, parallel explorations) stays visible in every reuse surface
 * that consumes this head, without ever inlining child transcripts. */
const SUBAGENT_LINE_LIMIT = 4;
function appendSubagentLines(
  lines: string[],
  subagents: RelayContextSubagent[] | undefined
): void {
  const usable = (subagents ?? []).filter((entry) => entry.title || entry.oneLiner);
  if (usable.length === 0) return;
  lines.push(`子代理（${usable.length}）：`);
  for (const entry of usable.slice(0, SUBAGENT_LINE_LIMIT)) {
    const role = entry.role ? `[${collapseWhitespace(entry.role)}] ` : "";
    const title = truncateText(entry.title || "未命名子任务", 60);
    const oneLiner = entry.oneLiner ? ` — ${truncateText(entry.oneLiner, 120)}` : "";
    lines.push(`  - ${role}${title}${oneLiner}`);
  }
  if (usable.length > SUBAGENT_LINE_LIMIT) {
    lines.push(`  - …另有 ${usable.length - SUBAGENT_LINE_LIMIT} 个子代理运行`);
  }
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
 * always kept; the remaining budget is split across conversations with
 * priority-weighted allocation (V2). When a primary conversation is marked
 * (isPrimary), it receives 50% of the excerpt budget.
 *
 * `options.fileAnchors` (P4a quality): deterministically extracted key-file
 * anchors — when present, a "关键文件（程序提取，带锚点）" block rides at the
 * very top of the transcript (counted against the budget) and the relay
 * prompt pins the model's key_files output to that list.
 *
 * `options.primaryConversationId` (V2): when set, the matching conversation
 * is treated as the weighted primary for budget allocation regardless of
 * its `isPrimary` flag.
 */
export function buildRelayTranscript(
  conversations: RelayContextConversation[],
  budgetChars: number = RELAY_CONTEXT_BUDGET_CHARS,
  options: {
    fileAnchors?: RelayFileAnchor[];
    primaryConversationId?: number;
  } = {}
): string {
  if (conversations.length === 0) return "";

  // V2: single-conversation relay gets the higher budget.
  const effectiveBudget =
    conversations.length === 1
      ? Math.min(budgetChars, RELAY_SINGLE_CONVERSATION_BUDGET_CHARS)
      : budgetChars;

  // V2: mark the primary conversation.
  if (options.primaryConversationId !== undefined) {
    for (const conversation of conversations) {
      if (conversation.id === options.primaryConversationId) {
        conversation.isPrimary = true;
        break;
      }
    }
  }

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
  if (fixedTotal >= effectiveBudget) {
    return `${fixedBlocks.join(separator).slice(0, Math.max(0, effectiveBudget - 12))}\n[上下文已截断]`;
  }

  const excerptBudget = effectiveBudget - fixedTotal;

  // V2: priority-weighted budget allocation.
  const hasPrimary = conversations.some((c) => c.isPrimary);
  const priorities = conversations.map((c) => computeConversationPriority(c));
  const totalPriority = priorities.reduce((a, b) => a + b, 0);

  let perConversationBudgets: number[];
  if (hasPrimary && conversations.length > 1) {
    // Primary conversation gets a guaranteed fraction; the rest is
    // priority-weighted.
    const primaryReserve = Math.floor(
      excerptBudget * PRIMARY_CONVERSATION_BUDGET_FRACTION
    );
    const remainder = excerptBudget - primaryReserve;
    perConversationBudgets = conversations.map((c, i) => {
      if (c.isPrimary) {
        // Primary gets its reserve + its share of remainder.
        const shareOfRemainder =
          totalPriority > 0
            ? Math.floor(remainder * (priorities[i] / totalPriority))
            : 0;
        return primaryReserve + shareOfRemainder;
      }
      const nonPrimaryTotal = totalPriority - (conversations.find(c => c.isPrimary) ? priorities[conversations.findIndex(c => c.isPrimary)] : 0);
      return nonPrimaryTotal > 0
        ? Math.floor(remainder * (priorities[i] / nonPrimaryTotal))
        : Math.floor(remainder / (conversations.length - 1));
    });
  } else {
    // No primary: pure priority-weighted split, with a floor per conversation.
    perConversationBudgets = conversations.map((c, i) =>
      totalPriority > 0
        ? Math.max(
            MIN_PER_CONVERSATION_EXCERPT_CHARS,
            Math.floor(excerptBudget * (priorities[i] / totalPriority))
          )
        : Math.floor(excerptBudget / conversations.length)
    );
  }

  // Ensure budgets sum to ≤ excerptBudget (floating point guard).
  let budgetSum = perConversationBudgets.reduce((a, b) => a + b, 0);
  if (budgetSum > excerptBudget && perConversationBudgets.length > 0) {
    // Proportionally scale all budgets down to fit.
    const scale = excerptBudget / budgetSum;
    perConversationBudgets = perConversationBudgets.map((b) =>
      Math.max(MIN_PER_CONVERSATION_EXCERPT_CHARS, Math.floor(b * scale))
    );
    // If the proportional scale still overflows (floor keeps values high),
    // drop the floor and evenly distribute — budget is genuinely too tight.
    budgetSum = perConversationBudgets.reduce((a, b) => a + b, 0);
    if (budgetSum > excerptBudget) {
      const equal = Math.floor(excerptBudget / perConversationBudgets.length);
      perConversationBudgets = perConversationBudgets.map(() => equal);
    }
  }

  const headCount = (anchorBlock ? 1 : 0) + (aggregate ? 1 : 0);
  const blocks = conversations.map((conversation, index) => {
    const budgetForThis = perConversationBudgets[index] ?? Math.floor(excerptBudget / conversations.length);
    const excerpts = collectMessageExcerpts(conversation.messages, budgetForThis);
    if (excerpts.length === 0) return heads[index];
    return `${heads[index]}\n最近消息：\n${excerpts.join("\n")}`;
  });

  const assembled = [...fixedBlocks.slice(0, headCount), ...blocks].join(separator);
  if (assembled.length <= effectiveBudget) return assembled;
  return `${assembled.slice(0, Math.max(0, effectiveBudget - 12))}\n[上下文已截断]`;
}
