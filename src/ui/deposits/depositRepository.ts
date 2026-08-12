// 记忆空间 deposit repository: the deposits-area persistence layer, moved off
// Dexie onto the main-process memory_entries SQLite store (via the window.vesti
// memory bridge). The public API mirrors the old Dexie repository
// (src/ui/db/repository.ts) signature-for-signature — numeric ids included — so
// desktopStorage, the deposits tab and the sweep need no changes beyond the
// import. The Dexie deposits table stays untouched as a backup; the one-shot
// migration lives in ./migrateDeposits.
//
// Mapping (Deposit ↔ MemoryEntryView, kind 'deposit'):
//   id ↔ `deposit:<n>` (memory ids are strings; the numeric Dexie id is kept in
//        the suffix so version-chain pointers stay stable)
//   title/contentMarkdown/version ↔ direct (title truncated to the 200-char IPC
//        cap, content to 100K)
//   scope ↔ JSON string in `scope` (500-char cap — see serializeDepositScope)
//   customInstruction ↔ `summary` (memory_entries has no custom-instruction
//        column; deposits don't otherwise use summaries)
//   prevId ↔ `deposit:<n>` pointer in `prevId`
//   lastOps ↔ the same JSON string Dexie stored (null without a maintain pass)
//   createdAt ↔ createdAt; updatedAt is refreshed by the bridge on upsert
//   template ↔ `template`; sourceSessionIds/tags stay empty, status 'active',
//   entryDate null — the deposits area doesn't use them.

import type { MemoryEntryView, VestiDesktopApi } from "../../shared/contracts";
import type { DepositMaintainOp } from "../../shared/depositMaintain";
import type { Deposit, DepositScope, DepositTemplate } from "../db/types";

export interface CreateDepositInput {
  template: DepositTemplate;
  title: string;
  scope: DepositScope;
  contentMarkdown: string;
  /** Version-chain pointer; defaults to a fresh v1 (no predecessor). */
  version?: number;
  prevId?: number | null;
  customInstruction?: string | null;
  /** mem0-style maintain ops behind this version (null when stored without a
   * maintain pass). Persisted as a JSON string, same as the Dexie row did. */
  lastOps?: DepositMaintainOp[] | null;
}

// ---- id codec ------------------------------------------------------------------

export const DEPOSIT_MEMORY_ID_PREFIX = "deposit:";
const DEPOSIT_MEMORY_ID_PATTERN = /^deposit:(\d+)$/;

/** Memory-entry id for a numeric deposit id (`deposit:42`). */
export function depositMemoryId(id: number): string {
  return `${DEPOSIT_MEMORY_ID_PREFIX}${id}`;
}

/** Numeric deposit id behind a memory-entry id, null for foreign ids. */
export function parseDepositMemoryId(value: string): number | null {
  const match = DEPOSIT_MEMORY_ID_PATTERN.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ---- field mapping ---------------------------------------------------------------

const DEPOSIT_TEMPLATES: readonly DepositTemplate[] = [
  "background_knowledge",
  "project_state",
  "writing_style",
  "extract",
  "custom",
];

// Main-process IPC caps (validMemoryEntry in src/main.ts).
const TITLE_MAX_CHARS = 200;
const CONTENT_MAX_CHARS = 100_000;
const SHORT_TEXT_MAX_CHARS = 500;

function normalizeDepositTemplate(value: unknown): DepositTemplate {
  return DEPOSIT_TEMPLATES.includes(value as DepositTemplate)
    ? (value as DepositTemplate)
    : "custom";
}

/**
 * Serialize a scope for the 500-char `scope` column. Real scopes are far below
 * the cap; the fallbacks only guard against pathological input (a giant manual
 * selection or an over-long label) so the main-process validator never rejects
 * the write — cosmetic labels are trimmed first, then selection ids.
 */
export function serializeDepositScope(scope: DepositScope): string {
  const candidates: DepositScope[] = [scope];
  switch (scope.kind) {
    case "project":
    case "topic":
      candidates.push({ ...scope, label: scope.label.slice(0, 120) });
      candidates.push({ ...scope, label: "" });
      break;
    case "selection":
      candidates.push({ kind: "selection", conversationIds: scope.conversationIds.slice(0, 50) });
      candidates.push({ kind: "selection", conversationIds: scope.conversationIds.slice(0, 20) });
      candidates.push({ kind: "selection", conversationIds: [] });
      break;
    case "timerange":
      break;
  }
  for (const candidate of candidates) {
    const serialized = JSON.stringify(candidate);
    if (serialized.length <= SHORT_TEXT_MAX_CHARS) return serialized;
  }
  return JSON.stringify({ kind: "selection", conversationIds: [] });
}

/** Inverse of serializeDepositScope; unknown payloads degrade to an empty
 * selection scope (the old Dexie normalizeDepositScope fallback). */
export function parseDepositScope(raw: string | null | undefined): DepositScope {
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { kind?: unknown }).kind === "string"
      ) {
        return parsed as DepositScope;
      }
    } catch {
      // fall through to the fallback
    }
  }
  return { kind: "selection", conversationIds: [] };
}

function parseDepositLastOps(value: string | null | undefined): DepositMaintainOp[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const ops: DepositMaintainOp[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Partial<DepositMaintainOp>;
      if (
        (entry.op !== "ADD" && entry.op !== "UPDATE" && entry.op !== "DELETE" && entry.op !== "NOOP") ||
        typeof entry.section !== "string"
      ) {
        return null;
      }
      ops.push({
        op: entry.op,
        section: entry.section,
        old_text: typeof entry.old_text === "string" ? entry.old_text : undefined,
        new_text: typeof entry.new_text === "string" ? entry.new_text : undefined,
        reason: typeof entry.reason === "string" ? entry.reason : "",
      });
    }
    return ops;
  } catch {
    return null;
  }
}

/** Deposit → memory entry (kind 'deposit'), preserving id/version/timestamps.
 * Shared by createDeposit and the Dexie→SQLite migration. */
export function depositToMemoryEntry(deposit: Deposit): MemoryEntryView {
  return {
    id: depositMemoryId(deposit.id),
    kind: "deposit",
    title: deposit.title.slice(0, TITLE_MAX_CHARS),
    contentMarkdown: deposit.contentMarkdown.slice(0, CONTENT_MAX_CHARS),
    summary: deposit.customInstruction?.trim()
      ? deposit.customInstruction.trim().slice(0, SHORT_TEXT_MAX_CHARS)
      : null,
    scope: serializeDepositScope(deposit.scope),
    template: deposit.template,
    sourceSessionIds: [],
    tags: [],
    version: deposit.version,
    prevId: deposit.prevId !== null ? depositMemoryId(deposit.prevId) : null,
    lastOps: deposit.lastOps?.length ? JSON.stringify(deposit.lastOps) : null,
    status: "active",
    entryDate: null,
    createdAt: deposit.createdAt,
    updatedAt: deposit.updatedAt,
  };
}

/** Memory entry → Deposit; null for entries that aren't deposit-coded
 * (foreign id scheme or wrong kind), so listers can filter them out. */
export function memoryEntryToDeposit(entry: MemoryEntryView): Deposit | null {
  if (entry.kind !== "deposit") return null;
  const id = parseDepositMemoryId(entry.id);
  if (id === null) return null;
  return {
    id,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    template: normalizeDepositTemplate(entry.template),
    title: entry.title,
    scope: parseDepositScope(entry.scope),
    contentMarkdown: entry.contentMarkdown,
    version:
      Number.isFinite(entry.version) && entry.version > 0 ? Math.floor(entry.version) : 1,
    prevId: entry.prevId ? parseDepositMemoryId(entry.prevId) : null,
    customInstruction: entry.summary ?? null,
    lastOps: parseDepositLastOps(entry.lastOps),
  };
}

// ---- bridge access -----------------------------------------------------------------

function memoryApi(): VestiDesktopApi {
  const api = typeof window !== "undefined" ? window.vesti : undefined;
  if (!api) {
    throw new Error("桌面环境不可用，无法访问记忆空间");
  }
  return api;
}

/** Every kind:'deposit' entry, paging past the 500-per-call IPC cap. */
async function listAllDepositEntries(api: VestiDesktopApi): Promise<MemoryEntryView[]> {
  const PAGE = 500;
  const entries: MemoryEntryView[] = [];
  for (;;) {
    const page = await api.listMemoryEntries({
      kind: "deposit",
      limit: PAGE,
      offset: entries.length,
    });
    entries.push(...page);
    if (page.length < PAGE) return entries;
  }
}

// ---- CRUD (API-compatible with the old Dexie repository) ----------------------------

export async function createDeposit(input: CreateDepositInput): Promise<Deposit> {
  const api = memoryApi();
  const now = Date.now();
  // Dexie used an auto-increment id; allocate the next numeric suffix here so
  // existing chain pointers (`deposit:<n>`) stay interpretable.
  const existing = await listAllDepositEntries(api);
  const nextId =
    existing.reduce((max, entry) => {
      const id = parseDepositMemoryId(entry.id);
      return id !== null && id > max ? id : max;
    }, 0) + 1;
  const entry = depositToMemoryEntry({
    id: nextId,
    createdAt: now,
    updatedAt: now,
    template: input.template,
    title: input.title,
    scope: input.scope,
    contentMarkdown: input.contentMarkdown,
    version: input.version ?? 1,
    prevId: input.prevId ?? null,
    customInstruction: input.customInstruction ?? null,
    lastOps: input.lastOps ?? null,
  });
  await api.upsertMemoryEntry(entry);
  const created = memoryEntryToDeposit(entry);
  if (!created) throw new Error("Failed to create deposit");
  return created;
}

/** Newest-created first, mirroring the Dexie orderBy(created_at).reverse(). */
export async function listDeposits(): Promise<Deposit[]> {
  const api = memoryApi();
  const entries = await listAllDepositEntries(api);
  return entries
    .map(memoryEntryToDeposit)
    .filter((deposit): deposit is Deposit => deposit !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getDeposit(id: number): Promise<Deposit | null> {
  const api = memoryApi();
  const [entry] = await api.getMemoryEntries([depositMemoryId(id)]);
  return entry ? memoryEntryToDeposit(entry) : null;
}

export async function renameDeposit(id: number, title: string): Promise<Deposit> {
  const api = memoryApi();
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("Deposit title cannot be empty");
  }
  const [entry] = await api.getMemoryEntries([depositMemoryId(id)]);
  if (!entry) {
    throw new Error("Deposit not found");
  }
  // The bridge stamps a fresh updatedAt on upsert.
  await api.upsertMemoryEntry({ ...entry, title: trimmed.slice(0, TITLE_MAX_CHARS) });
  const deposit = await getDeposit(id);
  if (!deposit) {
    throw new Error("Deposit not found");
  }
  return deposit;
}

export async function deleteDeposit(id: number): Promise<void> {
  await memoryApi().deleteMemoryEntry(depositMemoryId(id));
}
