/**
 * Deposit maintain (mem0-style ops): shared contract + strict-JSON parser for
 * the 'deposit-maintain' agent kind. The kind compares the previous deposit
 * document with freshly distilled content and answers with a set of
 * ADD/UPDATE/DELETE/NOOP operations plus the merged document.
 *
 * Lives in src/shared (not src/main) so both the main-process prompt registry
 * (agentPrompts.ts) and the renderer-side merge pipeline
 * (src/ui/deposits/deposits.ts) can validate/normalize the same payload
 * without pulling main-process dependencies.
 */

export type DepositMaintainOpName = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export const DEPOSIT_MAINTAIN_OPS: readonly DepositMaintainOpName[] = [
  'ADD',
  'UPDATE',
  'DELETE',
  'NOOP',
];

export interface DepositMaintainOp {
  op: DepositMaintainOpName;
  /** Section (heading / topic) of the document the op applies to. */
  section: string;
  /** Previous text being replaced/removed; omitted for ADD. */
  old_text?: string;
  /** New text to write; omitted for DELETE/NOOP. */
  new_text?: string;
  /** Why this op is needed. */
  reason: string;
}

export interface DepositMaintainPayload {
  ops: DepositMaintainOp[];
  merged_markdown: string;
}

const MAX_OPS = 30;
const MAX_OP_TEXT_CHARS = 4_000;
const MAX_SECTION_CHARS = 200;
const MAX_REASON_CHARS = 400;
const MAX_MERGED_CHARS = 50_000;

function asTrimmed(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function asOptionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

export function parseDepositMaintainPayload(raw: string): DepositMaintainPayload {
  // Tolerate Markdown code fences around the JSON object.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('deposit-maintain 输出不是 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('deposit-maintain 输出不是 JSON 对象');
  }

  const rawOps = Array.isArray(parsed.ops) ? parsed.ops : [];
  const ops: DepositMaintainOp[] = [];
  for (const item of rawOps) {
    if (!item || typeof item !== 'object') throw new Error('deposit-maintain 输出包含非法 op 条目');
    const entry = item as Record<string, unknown>;
    if (!DEPOSIT_MAINTAIN_OPS.includes(entry.op as DepositMaintainOpName)) {
      throw new Error(`deposit-maintain 输出包含未知 op：${String(entry.op)}`);
    }
    const section = asTrimmed(entry.section, MAX_SECTION_CHARS);
    if (!section) throw new Error('deposit-maintain 输出 op 缺少 section');
    ops.push({
      op: entry.op as DepositMaintainOpName,
      section,
      old_text: asOptionalText(entry.old_text, MAX_OP_TEXT_CHARS),
      new_text: asOptionalText(entry.new_text, MAX_OP_TEXT_CHARS),
      reason: asTrimmed(entry.reason, MAX_REASON_CHARS),
    });
    if (ops.length >= MAX_OPS) break;
  }

  const merged = asTrimmed(parsed.merged_markdown, MAX_MERGED_CHARS);
  if (!merged) throw new Error('deposit-maintain 输出缺少 merged_markdown');
  return { ops, merged_markdown: merged };
}

/**
 * Compose the maintain transcript handed to the 'deposit-maintain' agent via
 * transcriptOverride: both documents under fixed markers so the prompt can
 * reference them unambiguously. Shared by desktopStorage and tests.
 */
export function buildDepositMaintainTranscript(
  previousMarkdown: string,
  distilledMarkdown: string,
): string {
  return [
    '【旧版本沉淀内容】',
    previousMarkdown.trim(),
    '',
    '【新提炼内容】',
    distilledMarkdown.trim(),
  ].join('\n');
}
