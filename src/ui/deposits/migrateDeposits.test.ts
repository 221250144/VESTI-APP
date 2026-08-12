// One-shot Dexie→memory_entries migration: head filtering, field mapping,
// batching, idempotency and failure semantics — all with injected seams
// (no Dexie, no window).

import { describe, expect, it } from "vitest";
import type { MemoryEntryView } from "../../shared/contracts";
import type { Deposit } from "../db/types";
import {
  DEPOSITS_MIGRATED_META_KEY,
  migrateDepositsToMemory,
} from "./migrateDeposits";

function makeDeposit(overrides: Partial<Deposit> & { id: number }): Deposit {
  return {
    createdAt: 1_000 + overrides.id,
    updatedAt: 2_000 + overrides.id,
    template: "custom",
    title: `deposit ${overrides.id}`,
    scope: { kind: "selection", conversationIds: [] },
    contentMarkdown: `body ${overrides.id}`,
    version: 1,
    prevId: null,
    customInstruction: null,
    ...overrides,
  };
}

/** Meta map + id-keyed store, mirroring importMemoryEntries' same-id upsert. */
function mockMigrationBridge(options?: { failOnBatch?: number }) {
  const meta = new Map<string, string>();
  const store = new Map<string, MemoryEntryView>();
  const batches: MemoryEntryView[][] = [];
  let call = 0;
  const bridge = {
    getMemoryMeta: async (key: string): Promise<string | null> => meta.get(key) ?? null,
    setMemoryMeta: async (key: string, value: string): Promise<void> => {
      meta.set(key, value);
    },
    importMemoryEntries: async (entries: MemoryEntryView[]): Promise<number> => {
      call += 1;
      if (options?.failOnBatch === call) throw new Error("import failed");
      batches.push(entries);
      for (const entry of entries) store.set(entry.id, entry);
      return entries.length;
    },
  };
  return { bridge, meta, store, batches };
}

describe("migrateDepositsToMemory", () => {
  it("migrates only chain heads (latest version of each chain)", async () => {
    const legacy = [
      makeDeposit({ id: 1, version: 1, prevId: null }),
      makeDeposit({ id: 2, version: 2, prevId: 1 }),
      makeDeposit({ id: 3, version: 3, prevId: 2 }),
      makeDeposit({ id: 4 }),
      // Dangling predecessor (row 99 is gone): still a head of its own chain.
      makeDeposit({ id: 5, version: 2, prevId: 99 }),
    ];
    const { bridge, store } = mockMigrationBridge();

    const result = await migrateDepositsToMemory({
      bridge,
      listLegacyDeposits: async () => legacy,
    });

    expect(result).toEqual({ alreadyMigrated: false, heads: 3, imported: 3 });
    expect([...store.keys()].sort()).toEqual(["deposit:3", "deposit:4", "deposit:5"]);
  });

  it("maps every field, preserving ids, versions and timestamps", async () => {
    const head = makeDeposit({
      id: 3,
      version: 3,
      prevId: 2,
      template: "project_state",
      title: "项目开发状态 · 项目 vesti",
      scope: { kind: "project", projectKey: "cli:/work/vesti", label: "cli · vesti" },
      contentMarkdown: "# 合并后的文档",
      customInstruction: null,
      lastOps: [
        { op: "UPDATE", section: "架构", old_text: "旧", new_text: "新", reason: "调整" },
      ],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_100_000_000,
    });
    const referenced = makeDeposit({ id: 2, version: 2, prevId: 1 });
    const { bridge, store } = mockMigrationBridge();

    await migrateDepositsToMemory({
      bridge,
      listLegacyDeposits: async () => [makeDeposit({ id: 1 }), referenced, head],
    });

    const entry = store.get("deposit:3");
    expect(entry).toMatchObject({
      id: "deposit:3",
      kind: "deposit",
      title: "项目开发状态 · 项目 vesti",
      contentMarkdown: "# 合并后的文档",
      summary: null,
      template: "project_state",
      sourceSessionIds: [],
      tags: [],
      version: 3,
      prevId: "deposit:2",
      status: "active",
      entryDate: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_100_000_000,
    });
    expect(JSON.parse(entry?.scope ?? "")).toEqual({
      kind: "project",
      projectKey: "cli:/work/vesti",
      label: "cli · vesti",
    });
    expect(JSON.parse(entry?.lastOps ?? "")).toEqual([
      { op: "UPDATE", section: "架构", old_text: "旧", new_text: "新", reason: "调整" },
    ]);
  });

  it("stamps the watermark after a successful import and skips repeat runs", async () => {
    const { bridge, meta, batches } = mockMigrationBridge();
    const deps = {
      bridge,
      listLegacyDeposits: async () => [makeDeposit({ id: 1 })],
    };

    const first = await migrateDepositsToMemory(deps);
    expect(first.alreadyMigrated).toBe(false);
    expect(meta.get(DEPOSITS_MIGRATED_META_KEY)).toBe("1");

    const second = await migrateDepositsToMemory(deps);
    expect(second).toEqual({ alreadyMigrated: true, heads: 0, imported: 0 });
    expect(batches).toHaveLength(1);
  });

  it("stays idempotent without the watermark: same ids upsert, no duplicates", async () => {
    const { bridge, meta, store } = mockMigrationBridge();
    const deps = {
      bridge,
      listLegacyDeposits: async () => [makeDeposit({ id: 1 }), makeDeposit({ id: 2, prevId: 1 })],
    };

    await migrateDepositsToMemory(deps);
    meta.clear(); // simulate a lost watermark (e.g. partial restore)
    const rerun = await migrateDepositsToMemory(deps);

    expect(rerun.imported).toBe(1);
    expect(store.size).toBe(1);
    expect(store.has("deposit:2")).toBe(true);
  });

  it("imports in batches of at most 200 entries", async () => {
    const legacy = Array.from({ length: 450 }, (_, index) => makeDeposit({ id: index + 1 }));
    const { bridge, batches } = mockMigrationBridge();

    const result = await migrateDepositsToMemory({
      bridge,
      listLegacyDeposits: async () => legacy,
    });

    expect(result.imported).toBe(450);
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50]);
  });

  it("leaves the watermark unset when a batch fails, so the next run retries", async () => {
    const legacy = Array.from({ length: 250 }, (_, index) => makeDeposit({ id: index + 1 }));
    const failing = mockMigrationBridge({ failOnBatch: 2 });
    const deps = {
      bridge: failing.bridge,
      listLegacyDeposits: async () => legacy,
    };

    await expect(migrateDepositsToMemory(deps)).rejects.toThrow("import failed");
    expect(failing.meta.has(DEPOSITS_MIGRATED_META_KEY)).toBe(false);

    // Retry against a healthy bridge: completes and stamps the watermark.
    const healthy = mockMigrationBridge();
    const retry = await migrateDepositsToMemory({
      bridge: healthy.bridge,
      listLegacyDeposits: deps.listLegacyDeposits,
    });
    expect(retry.imported).toBe(250);
    expect(healthy.meta.get(DEPOSITS_MIGRATED_META_KEY)).toBe("1");
  });

  it("migrates an empty table once and stamps the watermark", async () => {
    const { bridge, meta, batches } = mockMigrationBridge();
    const result = await migrateDepositsToMemory({
      bridge,
      listLegacyDeposits: async () => [],
    });
    expect(result).toEqual({ alreadyMigrated: false, heads: 0, imported: 0 });
    expect(batches).toHaveLength(0);
    expect(meta.get(DEPOSITS_MIGRATED_META_KEY)).toBe("1");
  });

  it("does nothing without the desktop bridge", async () => {
    let legacyReads = 0;
    const result = await migrateDepositsToMemory({
      bridge: null,
      listLegacyDeposits: async () => {
        legacyReads += 1;
        return [];
      },
    });
    expect(result).toEqual({ alreadyMigrated: false, heads: 0, imported: 0 });
    expect(legacyReads).toBe(0);
  });
});
