// P4a relay quality: deterministic key-file extraction. The handoff pack's
// file list must not rely on the model's recollection — it is aggregated from
// the captured tool_executions (read/write/edit touches) of the selected
// sessions. Pure functions: the caller (desktopStorage) fetches raw touch
// rows over IPC and resolves capture session ids to conversation ids.

import type { RelayFileTouchRow } from "../../shared/contracts";

/** Max anchors injected into the relay transcript / stored on the pack. */
export const RELAY_FILE_ANCHOR_LIMIT = 15;

/**
 * One aggregated file anchor: how often the selected sessions touched the
 * file, when most recently, and which conversations the touches came from.
 */
export interface RelayFileAnchor {
  /** Display path (first-seen spelling; dedupe is separator/case-insensitive). */
  path: string;
  touches: number;
  /** Epoch ms of the most recent touch. */
  lastTouchedAt: number;
  /** Renderer conversation ids that touched this file, first-seen order. */
  conversationIds: number[];
}

// Tool-input keys that carry a file path across the captured platforms
// (Claude Code file_path, Kimi Code path, Cursor filePath/target_file). The
// closing quote is optional: input summaries are capped upstream and may be
// truncated mid-string.
const PATH_KEY_PATTERN =
  /"(?:file_path|filePath|path|notebook_path|target_file)"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/;

/**
 * Best-effort file-path extraction from a tool-execution input summary (the
 * first ~500 chars of the stringified tool input). Returns null when the
 * input carries no usable path (non-file tools, URLs, truncated garbage).
 */
export function extractTouchPath(inputSummary: string | null | undefined): string | null {
  if (!inputSummary) return null;
  const match = PATH_KEY_PATTERN.exec(inputSummary);
  if (!match) return null;
  let value = match[1];
  try {
    value = JSON.parse(`"${match[1]}"`) as string;
  } catch {
    // Truncated escape sequence — fall back to the raw capture.
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/** Dedupe key: separators and case folded, trailing slashes stripped. */
function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Aggregate raw file-tool touch rows into anchors: dedupe by normalized path,
 * count touches, track the latest touch and the source conversations, then
 * sort by touch count (ties: most recent, then path) and cap at `limit`.
 */
export function extractRelayFileAnchors(
  rows: RelayFileTouchRow[],
  resolveConversationId: (sessionId: string) => number | null,
  limit: number = RELAY_FILE_ANCHOR_LIMIT
): RelayFileAnchor[] {
  type MutableAnchor = RelayFileAnchor & { key: string };
  const byKey = new Map<string, MutableAnchor>();
  for (const row of rows) {
    const path = extractTouchPath(row.inputSummary);
    if (!path) continue;
    const key = normalizePathKey(path);
    if (!key) continue;
    let anchor = byKey.get(key);
    if (!anchor) {
      anchor = { key, path, touches: 0, lastTouchedAt: 0, conversationIds: [] };
      byKey.set(key, anchor);
    }
    anchor.touches += 1;
    if (row.timestamp > anchor.lastTouchedAt) {
      anchor.lastTouchedAt = row.timestamp;
    }
    const conversationId = resolveConversationId(row.sessionId);
    if (conversationId !== null && !anchor.conversationIds.includes(conversationId)) {
      anchor.conversationIds.push(conversationId);
    }
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.touches - a.touches ||
        b.lastTouchedAt - a.lastTouchedAt ||
        a.path.localeCompare(b.path)
    )
    .slice(0, Math.max(0, limit))
    .map(({ key: _key, ...anchor }) => anchor);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function anchorDate(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime()) || epochMs <= 0) return "时间未知";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Render the anchor block injected at the top of the relay transcript. Each
 * line carries its source-conversation labels (会话 N, matching the
 * per-conversation head numbering) so both the model and the reader can jump
 * back to the evidence. Returns null when there are no anchors — the block is
 * then omitted entirely.
 */
export function formatRelayFileAnchorBlock(
  anchors: RelayFileAnchor[],
  labelForConversation: (conversationId: number) => string | null
): string | null {
  if (anchors.length === 0) return null;
  const lines = anchors.map((anchor) => {
    const labels = [
      ...new Set(
        anchor.conversationIds
          .map((id) => labelForConversation(id))
          .filter((label): label is string => Boolean(label))
      ),
    ];
    const source = labels.length > 0 ? `，来源：${labels.join("、")}` : "";
    return `- ${anchor.path}（触碰 ${anchor.touches} 次，最近 ${anchorDate(anchor.lastTouchedAt)}${source}）`;
  });
  return `## 关键文件（程序提取，带锚点）\n${lines.join("\n")}`;
}

/** Path comparison for the panel badges (same folding as the dedupe key). */
export function sameAnchorPath(a: string, b: string): boolean {
  return normalizePathKey(a) === normalizePathKey(b);
}
