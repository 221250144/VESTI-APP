// P4a relay quality: deterministic key-file extraction. The handoff pack's
// file list must not rely on the model's recollection — it is aggregated from
// the captured tool_executions (read/write/edit touches) of the selected
// sessions. Pure functions: the caller (desktopStorage) fetches raw touch
// rows over IPC and resolves capture session ids to conversation ids.
//
// V2 (2026-07): structured extraction from parsed JSON tool inputs (not regex
// on stringified JSON), and verification command extraction from tool calls.

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

// ---- V2: Structured File Extraction ----------------------------------------

/** File-path keys in priority order — checked against a parsed JSON object
 * so the exact key name does not matter. This covers tools that use
 * non-standard schemas (str_replace_editor, apply_patch, etc.). */
const STRUCTURED_PATH_KEYS = [
  'file_path', 'filePath', 'path',
  'notebook_path', 'notebookPath',
  'target_file', 'targetFile',
  'old_path', 'new_path',  // rename/move tools
  'output_file', 'outputFile',
];

/**
 * V2: extract a file path from a properly parsed JSON tool input object.
 * Checks known path keys in priority order, returns the first non-URL,
 * non-empty file path found. Returns null when the input carries no path.
 */
export function extractTouchPathStructured(
  toolInput: Record<string, unknown> | null | undefined,
): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  for (const key of STRUCTURED_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 500) continue;
    if (/^https?:\/\//i.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/**
 * V2: dual-tier file path extraction. Attempts structured extraction first
 * (from a parsed JSON object), falls back to the legacy regex-based extraction
 * (for rows where the tool input is only available as a string).
 */
export function extractTouchPathV2(
  toolInput: Record<string, unknown> | null | undefined,
  inputSummary: string | null | undefined,
): string | null {
  // Tier 1: structured extraction from parsed JSON.
  const structured = extractTouchPathStructured(toolInput);
  if (structured) return structured;
  // Tier 2: regex fallback on stringified input.
  return extractTouchPath(inputSummary);
}

// ---- V2: Verification Command Extraction -----------------------------------

/** Tool names that represent verification/check commands. */
const VERIFICATION_TOOL_NAMES = new Set([
  'bash', 'shell', 'execute_command', 'run',
  'terminal', 'exec', 'command',
]);

/** Patterns identifying verification-intent commands. */
const VERIFICATION_COMMAND_PATTERNS = [
  /\b(npm\s+(test|run\s+build|lint|typecheck|tsc))\b/i,
  /\b(pnpm\s+(test|build|lint|typecheck))\b/i,
  /\b(yarn\s+(test|build|lint))\b/i,
  /\b(npx\s+(vitest|jest|tsc|eslint|prettier)\b[^|&;]*)/i,
  /\b(python\s+-m\s+pytest)\b/i,
  /\b(cargo\s+(test|build|clippy))\b/i,
  /\b(go\s+(test|build|vet))\b/i,
  /\b(make\s+(test|check|build))\b/i,
  /\b(npm\s+run\b[^|&;]*)/i,
];

export interface VerificationCommand {
  /** The full command string. */
  command: string;
  /** The tool output (truncated). */
  output: string;
  /** Whether the command appears to have passed. */
  passed: boolean;
  /** Epoch ms timestamp. */
  timestamp: number;
}

/** Failure-indicating output patterns. */
const FAILURE_PATTERNS = [
  /\b(FAIL|FAILED|FAILURE)\b/,
  /\b(error|Error|ERROR)[:\s]/,
  /\b\d+\s+failing\b/i,
  /\btest(s)?\s+failed\b/i,
  /\bexit\s*(code)?\s*[1-9]\d*\b/i,
  /\bcommand\s+not\s+found\b/i,
  /\bmodule\s+not\s+found\b/i,
  /\bcannot\s+find\s+module\b/i,
  /\b(npm\s+ERR!|pnpm\s+ERR|yarn\s+error)\b/i,
];

/**
 * V2: extract verification commands from tool execution rows. Scans for
 * tool calls that match known verification patterns (npm test, pnpm build,
 * tsc, etc.) and returns their trimmed command + output + pass/fail judgment.
 */
export function extractVerificationCommands(
  rows: Array<{
    toolName?: string | null;
    toolInput?: string | null;
    toolOutput?: string | null;
    toolError?: string | null;
    timestamp: number;
  }>,
): VerificationCommand[] {
  const commands: VerificationCommand[] = [];

  for (const row of rows) {
    const toolName = (row.toolName || '').toLowerCase().trim();
    // Only look at shell/execution tools.
    if (!VERIFICATION_TOOL_NAMES.has(toolName)) continue;

    const input = row.toolInput || '';
    // Check if this command matches a verification pattern.
    let matchedCommand = '';
    for (const pattern of VERIFICATION_COMMAND_PATTERNS) {
      const match = pattern.exec(input);
      if (match) {
        matchedCommand = match[0].trim();
        break;
      }
    }
    if (!matchedCommand) continue;

    const output = (row.toolOutput || row.toolError || '').slice(0, 2000);
    // Judge pass/fail from output patterns.
    const passed = !FAILURE_PATTERNS.some(p => p.test(output));

    commands.push({
      command: matchedCommand,
      output: output.slice(0, 500),
      passed,
      timestamp: row.timestamp ?? 0,
    });
  }

  // Most recent first.
  commands.sort((a, b) => b.timestamp - a.timestamp);
  return commands;
}

/**
 * Format extracted verification commands into a transcript block.
 * Returns null when none were found.
 */
export function formatVerificationBlock(
  commands: VerificationCommand[],
): string | null {
  if (commands.length === 0) return null;
  const latest = commands[0];
  const status = latest.passed ? '✓ 通过' : '✗ 失败';
  const lines = [
    `## 程序提取的验证命令（最新一次）`,
    `- 命令：\`${latest.command}\``,
    `- 状态：${status}`,
    `- 输出：${latest.output.slice(0, 300)}`,
  ];
  return lines.join('\n');
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
