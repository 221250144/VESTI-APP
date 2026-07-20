import type { SessionMessage } from '../shared/contracts';

/**
 * Digest transcript window assembly (pure functions, unit-testable).
 *
 * v2 (bench C 2026-07-19 follow-up): the old window (last ≤60 messages,
 * 6000-char tail budget, no per-message cap) let one giant message eat the
 * whole budget — the worst real session fit 44 messages into 1 — and 48% of
 * extracted facts never reached the digest prompt. The v2 assembly keeps the
 * mandated mechanics but with parameters fixed from a policy sweep on the
 * real snapshot (scripts/bench/window-sweep.mjs):
 *  - blind-spot decomposition showed 81.6% of invisible facts sit in messages
 *    OLDER than the 60-message cutoff (only 8.3% are budget victims), so the
 *    recency limit is raised to a non-binding safety valve and the budget
 *    doubled to 12000;
 *  - a uniform per-message cap (e.g. 800) was measured WORSE than v1 (20.8%
 *    vs 51.8% visible) because facts concentrate deep inside long messages
 *    (fact offset p50 ≈ 1265 chars) — so normal messages are always kept
 *    whole and only OVERSIZED ones (>10k) are truncated, head+tail with an
 *    explicit elision mark, to min(OVERSIZED_MESSAGE_CAP, remaining budget);
 *  - the first user message (task framing) gets its own capped section;
 *  - the most recent file-write tool messages outside the recency valve are
 *    back-filled (file-state facts cluster there);
 *  - filling is newest-first, so budget pressure always drops the oldest
 *    context first; the newest message is always included (v1 guarantee).
 */

export const RECENT_MESSAGE_LIMIT = 500;
export const TRANSCRIPT_BUDGET_CHARS = 12_000;
export const FIRST_USER_MESSAGE_CHARS = 400;
export const OVERSIZED_MESSAGE_CAP_CHARS = 4_000;
export const FILE_WRITE_EXTRA_LIMIT = 10;
export const OVERSIZED_MESSAGE_CHARS = 10_000;
export const TOOL_OUTPUT_CHARS = 200;

/** Below this a window slot carries no usable content; skip and pass the
 * remaining budget on to newer messages. */
const MIN_SLOT_CHARS = 40;
const TRUNCATED_MARK = '……[截断]';
const elisionMark = (omitted: number) => `……[中间省略 ${omitted} 字符]……`;

/** Tool names that write files (real names from the bench snapshot:
 * Edit/Write dominate; _v2 variants come from kimi-code). Matched lowercase. */
const FILE_WRITE_TOOL_NAMES = new Set([
  'edit', 'multiedit', 'write', 'notebookedit',
  'edit_file', 'edit_file_v2', 'write_file', 'create_file', 'delete_file',
  'apply_patch', 'str_replace_editor', 'fswrite',
]);

export function isFileWriteTool(toolName?: string): boolean {
  return Boolean(toolName && FILE_WRITE_TOOL_NAMES.has(toolName.trim().toLowerCase()));
}

export function formatDigestMessage(message: SessionMessage): string {
  const values = [
    message.contentText,
    message.contentToolName ? `工具：${message.contentToolName}` : undefined,
    message.contentToolOutput ? `工具结果：${message.contentToolOutput.slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
    message.contentToolError ? `工具错误：${message.contentToolError.slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  if (!values.length) return '';
  const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'AI' : '系统';
  return `${role}：${values.join('；')}`;
}

/**
 * Fit `text` into `cap` chars. Normal overflow keeps the head and appends a
 * truncation mark; oversized originals (> OVERSIZED_MESSAGE_CHARS) keep head
 * AND tail with an elision mark — tails of long messages (command output,
 * pasted logs) often carry the final state.
 */
export function truncateForDigest(text: string, cap: number, oversized: boolean): string {
  if (text.length <= cap) return text;
  if (cap < MIN_SLOT_CHARS) return text.slice(0, cap);
  if (oversized && cap >= 120) {
    // Reserve ~20 chars for the elision mark (adjust once if the omitted
    // count needs more digits than estimated).
    const estimate = 20;
    let head = Math.ceil((cap - estimate) * 0.6);
    let tail = cap - estimate - head;
    const mark = elisionMark(text.length - head - tail);
    if (mark.length > estimate) head = Math.max(0, head - (mark.length - estimate));
    return text.slice(0, head) + mark + (tail > 0 ? text.slice(text.length - tail) : '');
  }
  return text.slice(0, cap - TRUNCATED_MARK.length) + TRUNCATED_MARK;
}

export interface DigestTranscriptOptions {
  budgetChars?: number;
  recentLimit?: number;
  oversizedCapChars?: number;
  fileWriteExtraLimit?: number;
  oversizedChars?: number;
}

interface FormattedEntry {
  message: SessionMessage;
  formatted: string;
  oversized: boolean;
}

export function buildDigestTranscript(
  messages: SessionMessage[],
  options: DigestTranscriptOptions = {},
): string {
  const budget = options.budgetChars ?? TRANSCRIPT_BUDGET_CHARS;
  const recentLimit = options.recentLimit ?? RECENT_MESSAGE_LIMIT;
  const oversizedCap = options.oversizedCapChars ?? OVERSIZED_MESSAGE_CAP_CHARS;
  const fileWriteExtraLimit = options.fileWriteExtraLimit ?? FILE_WRITE_EXTRA_LIMIT;
  const oversizedChars = options.oversizedChars ?? OVERSIZED_MESSAGE_CHARS;

  const entries: FormattedEntry[] = [];
  for (const message of messages) {
    const formatted = formatDigestMessage(message);
    if (formatted) entries.push({ message, formatted, oversized: formatted.length > oversizedChars });
  }
  if (!entries.length) return '';

  // Selection (positions into `entries`): the recent window, plus the most
  // recent file-write messages that fell outside it.
  const recentStart = Math.max(0, entries.length - recentLimit);
  const selected = new Set<number>();
  for (let i = recentStart; i < entries.length; i += 1) selected.add(i);
  let extras = 0;
  for (let i = recentStart - 1; i >= 0 && extras < fileWriteExtraLimit; i -= 1) {
    if (isFileWriteTool(entries[i].message.contentToolName)) {
      selected.add(i);
      extras += 1;
    }
  }

  // The first user message (task framing) gets its own capped section so it
  // survives even when the recent window is crowded out.
  let remaining = budget;
  const sections: string[] = [];
  const firstUserPos = entries.findIndex(
    entry => entry.message.role === 'user' && entry.message.contentText?.trim(),
  );
  if (firstUserPos !== -1) {
    const entry = entries[firstUserPos];
    const cap = Math.max(
      MIN_SLOT_CHARS,
      Math.min(FIRST_USER_MESSAGE_CHARS, Math.floor(budget / 4), entry.formatted.length),
    );
    const text = truncateForDigest(entry.formatted, cap, entry.oversized);
    const section = `【会话开场】${text}`;
    sections.push(section);
    remaining -= section.length + 1; // + the '\n' separator it will be joined with
    selected.delete(firstUserPos);
  }

  // Newest-first fill. Normal messages are kept whole (they carry the facts);
  // oversized ones are capped at min(oversizedCap, remainingBudget) with a
  // head+tail cut, so a single giant message can no longer starve the window.
  // Entries that no longer fit a useful slot are skipped oldest-first.
  const windowed = [...selected].sort((a, b) => b - a).map(i => entries[i]);
  const parts: string[] = [];
  windowed.forEach((entry, i) => {
    const isNewest = i === 0;
    let cap = entry.oversized ? Math.min(oversizedCap, remaining) : remaining;
    // The newest message is always included (mirrors the v1 guarantee).
    if (isNewest) cap = Math.max(cap, MIN_SLOT_CHARS);
    if (cap < MIN_SLOT_CHARS) return;
    const text = truncateForDigest(entry.formatted, cap, entry.oversized);
    parts.unshift(text);
    remaining -= text.length + 1; // + the '\n' separator
  });

  return [...sections, ...parts].join('\n');
}
