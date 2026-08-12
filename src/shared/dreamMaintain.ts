/**
 * Dream memory (记忆空间「梦境」): shared contracts + strict-JSON parsers for
 * the 'dream-extract' / 'dream-maintain' agent kinds. dream-extract distills
 * long-term facts about the user from compressed conversation batches;
 * dream-maintain merges those candidates into the memory library as
 * ADD/UPDATE/DELETE/NOOP operations.
 *
 * Lives in src/shared (not src/main) so both the main-process prompt registry
 * (agentPrompts.ts) and the dream orchestration pipeline can validate/normalize
 * the same payload without pulling main-process dependencies.
 */

export type DreamMemoryTag = 'profile' | 'preference' | 'goal' | 'emotion' | 'relationship' | 'event';

export const DREAM_MEMORY_TAGS: readonly DreamMemoryTag[] = [
  'profile',
  'preference',
  'goal',
  'emotion',
  'relationship',
  'event',
];

export interface DreamMemoryCandidate {
  tag: DreamMemoryTag;
  fact: string;
  evidence: string;
  session_ids: string[];
}

export type DreamMaintainOpName = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export const DREAM_MAINTAIN_OPS: readonly DreamMaintainOpName[] = [
  'ADD',
  'UPDATE',
  'DELETE',
  'NOOP',
];

export interface DreamMaintainOp {
  op: DreamMaintainOpName;
  /** Target memory-entry id. Required for UPDATE/DELETE; must be null for ADD. */
  target_id: string | null;
  tag: DreamMemoryTag | null;
  title: string;
  content: string;
  reason: string;
}

const MAX_MEMORIES = 30;
const MAX_FACT_CHARS = 500;
const MAX_EVIDENCE_CHARS = 500;
const MAX_SESSION_IDS = 20;
const MAX_OPS = 50;
const MAX_TARGET_ID_CHARS = 240;
const MAX_OP_TITLE_CHARS = 60;
const MAX_OP_CONTENT_CHARS = 1_000;
const MAX_REASON_CHARS = 400;

function asTrimmed(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function asTag(value: unknown): DreamMemoryTag | null {
  return DREAM_MEMORY_TAGS.includes(value as DreamMemoryTag) ? (value as DreamMemoryTag) : null;
}

/** Extract the outermost JSON object, tolerating Markdown fences and prose. */
function parsePayloadObject(raw: string, label: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`${label} 输出不是 JSON`);
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 输出不是 JSON 对象`);
  }
  return parsed;
}

/**
 * dream-extract output: {"memories": [{tag, fact, evidence, session_ids}]}.
 * Malformed entries (non-object, unknown tag, empty fact) are dropped rather
 * than failing the whole batch — extraction is a best-effort nightly pass.
 */
export function parseDreamExtractPayload(raw: string): DreamMemoryCandidate[] {
  const parsed = parsePayloadObject(raw, 'dream-extract');
  const rawMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
  const memories: DreamMemoryCandidate[] = [];
  for (const item of rawMemories) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const tag = asTag(entry.tag);
    const fact = asTrimmed(entry.fact, MAX_FACT_CHARS);
    if (!tag || !fact) continue;
    const sessionIds = Array.isArray(entry.session_ids)
      ? entry.session_ids
          .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
          .slice(0, MAX_SESSION_IDS)
      : [];
    memories.push({
      tag,
      fact,
      evidence: asTrimmed(entry.evidence, MAX_EVIDENCE_CHARS),
      session_ids: sessionIds,
    });
    if (memories.length >= MAX_MEMORIES) break;
  }
  return memories;
}

/**
 * dream-maintain output: {"ops": [{op, target_id, tag, title, content,
 * reason}]}. Op-level invariants are enforced by dropping the offending op:
 * UPDATE/DELETE must name an existing target_id, and an ADD that carries one
 * is a contradiction the model sometimes emits under retry.
 */
export function parseDreamMaintainPayload(raw: string): DreamMaintainOp[] {
  const parsed = parsePayloadObject(raw, 'dream-maintain');
  const rawOps = Array.isArray(parsed.ops) ? parsed.ops : [];
  const ops: DreamMaintainOp[] = [];
  for (const item of rawOps) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (!DREAM_MAINTAIN_OPS.includes(entry.op as DreamMaintainOpName)) continue;
    const op = entry.op as DreamMaintainOpName;
    const targetId = asTrimmed(entry.target_id, MAX_TARGET_ID_CHARS) || null;
    if ((op === 'UPDATE' || op === 'DELETE') && !targetId) continue;
    if (op === 'ADD' && targetId) continue;
    ops.push({
      op,
      target_id: targetId,
      tag: asTag(entry.tag),
      title: asTrimmed(entry.title, MAX_OP_TITLE_CHARS),
      content: asTrimmed(entry.content, MAX_OP_CONTENT_CHARS),
      reason: asTrimmed(entry.reason, MAX_REASON_CHARS),
    });
    if (ops.length >= MAX_OPS) break;
  }
  return ops;
}
