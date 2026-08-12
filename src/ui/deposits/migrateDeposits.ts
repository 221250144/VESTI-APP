// One-shot migration: copy the legacy Dexie deposits (IndexedDB, schema v20)
// into the main-process memory_entries SQLite store as kind:'deposit' entries.
//
// Only chain heads migrate — the latest version of each logical chain (rows no
// other row points at via prev_id; the same rule findDepositHeads applies in
// the UI). Older versions stay behind in the Dexie table, which is kept
// untouched as a backup. Ids/versions/timestamps are preserved verbatim (the
// numeric Dexie id rides in the `deposit:<n>` entry id), so the deposits area
// reads exactly what it showed before the switch.
//
// Idempotent: importMemoryEntries is a same-id upsert, and the
// 'memory.depositsMigrated' watermark (memory_meta) short-circuits repeat runs.
// The watermark is only stamped after every batch landed, so a mid-import
// failure is retried wholesale on the next launch — upserts keep that safe.

import type { MemoryEntryView, VestiDesktopApi } from "../../shared/contracts";
import type { Deposit } from "../db/types";
import { findDepositHeads } from "./deposits";
import { depositToMemoryEntry } from "./depositRepository";

export const DEPOSITS_MIGRATED_META_KEY = "memory.depositsMigrated";

/** Main process caps memory-import batches at 200 entries. */
const IMPORT_BATCH_SIZE = 200;

export interface DepositsMigrationResult {
  /** true when the watermark was already set — nothing was done. */
  alreadyMigrated: boolean;
  /** Chain heads found in the legacy Dexie table. */
  heads: number;
  /** Entries handed to importMemoryEntries (0 when there was nothing to do). */
  imported: number;
}

type MigrationBridge = Pick<
  VestiDesktopApi,
  "getMemoryMeta" | "setMemoryMeta" | "importMemoryEntries"
>;

/** Injectable seams so the migration is testable without Dexie/window. */
export interface MigrateDepositsDeps {
  bridge?: MigrationBridge | null;
  /** Legacy reader; defaults to the Dexie repository's listDeposits (imported
   * lazily so this module stays loadable in node tests). */
  listLegacyDeposits?: () => Promise<Deposit[]>;
}

function defaultBridge(): MigrationBridge | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

async function defaultListLegacyDeposits(): Promise<Deposit[]> {
  const { listDeposits } = await import("../db/repository");
  return listDeposits();
}

export async function migrateDepositsToMemory(
  deps: MigrateDepositsDeps = {},
): Promise<DepositsMigrationResult> {
  const bridge = deps.bridge !== undefined ? deps.bridge : defaultBridge();
  if (!bridge) {
    // Non-desktop environment: nothing to migrate into.
    return { alreadyMigrated: false, heads: 0, imported: 0 };
  }
  const listLegacyDeposits = deps.listLegacyDeposits ?? defaultListLegacyDeposits;

  const migrated = await bridge.getMemoryMeta(DEPOSITS_MIGRATED_META_KEY).catch(() => null);
  if (migrated === "1") {
    return { alreadyMigrated: true, heads: 0, imported: 0 };
  }

  const heads = findDepositHeads(await listLegacyDeposits());
  const entries: MemoryEntryView[] = heads.map(depositToMemoryEntry);

  let imported = 0;
  for (let offset = 0; offset < entries.length; offset += IMPORT_BATCH_SIZE) {
    imported += await bridge.importMemoryEntries(
      entries.slice(offset, offset + IMPORT_BATCH_SIZE),
    );
  }
  await bridge.setMemoryMeta(DEPOSITS_MIGRATED_META_KEY, "1");
  return { alreadyMigrated: false, heads: heads.length, imported };
}
