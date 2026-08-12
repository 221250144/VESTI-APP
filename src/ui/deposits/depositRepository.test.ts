// Memory-backed deposit repository: CRUD mapping tests with a stubbed
// window.vesti bridge (node environment, no IndexedDB/SQLite involved).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntryView } from "../../shared/contracts";
import {
  createDeposit,
  deleteDeposit,
  depositMemoryId,
  DEPOSIT_MEMORY_ID_PREFIX,
  getDeposit,
  listDeposits,
  memoryEntryToDeposit,
  parseDepositMemoryId,
  renameDeposit,
  serializeDepositScope,
} from "./depositRepository";

/** In-memory mirror of the main-process memory bridge semantics (kind/status
 * filters, updated_at DESC ordering, limit/offset, upsert by id). */
function mockMemoryBridge(seed: MemoryEntryView[] = []) {
  const store = new Map<string, MemoryEntryView>();
  for (const entry of seed) store.set(entry.id, { ...entry });
  const bridge = {
    listMemoryEntries: async (options?: {
      kind?: string;
      status?: string;
      limit?: number;
      offset?: number;
    }): Promise<MemoryEntryView[]> => {
      let entries = [...store.values()];
      if (options?.kind) entries = entries.filter((entry) => entry.kind === options.kind);
      if (options?.status) entries = entries.filter((entry) => entry.status === options.status);
      entries.sort((a, b) => b.updatedAt - a.updatedAt);
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? entries.length;
      return entries.slice(offset, offset + limit).map((entry) => ({ ...entry }));
    },
    getMemoryEntries: async (ids: string[]): Promise<MemoryEntryView[]> =>
      ids.flatMap((id) => {
        const entry = store.get(id);
        return entry ? [{ ...entry }] : [];
      }),
    upsertMemoryEntry: async (entry: MemoryEntryView): Promise<void> => {
      store.set(entry.id, { ...entry });
    },
    deleteMemoryEntry: async (id: string): Promise<void> => {
      store.delete(id);
    },
  };
  return { bridge, store };
}

function stubWindow(bridge: unknown): void {
  vi.stubGlobal("window", { vesti: bridge });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function seedEntry(overrides: Partial<MemoryEntryView> & { id: string }): MemoryEntryView {
  return {
    kind: "deposit",
    title: overrides.id,
    contentMarkdown: "body",
    summary: null,
    scope: JSON.stringify({ kind: "selection", conversationIds: [] }),
    template: "custom",
    sourceSessionIds: [],
    tags: [],
    version: 1,
    prevId: null,
    lastOps: null,
    status: "active",
    entryDate: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("deposit id codec", () => {
  it("round-trips numeric ids through the deposit:<n> scheme", () => {
    expect(depositMemoryId(42)).toBe(`${DEPOSIT_MEMORY_ID_PREFIX}42`);
    expect(parseDepositMemoryId("deposit:42")).toBe(42);
  });

  it("rejects foreign ids", () => {
    expect(parseDepositMemoryId("dream:abc:123")).toBeNull();
    expect(parseDepositMemoryId("deposit:")).toBeNull();
    expect(parseDepositMemoryId("deposit:0")).toBeNull();
    expect(parseDepositMemoryId("deposit:-3")).toBeNull();
    expect(parseDepositMemoryId("42")).toBeNull();
  });
});

describe("serializeDepositScope", () => {
  it("keeps ordinary scopes verbatim", () => {
    const scope = { kind: "project" as const, projectKey: "cli:/work/app", label: "cli · app" };
    expect(serializeDepositScope(scope)).toBe(JSON.stringify(scope));
  });

  it("trims pathological selections under the 500-char IPC cap", () => {
    const scope = {
      kind: "selection" as const,
      conversationIds: Array.from({ length: 400 }, (_, index) => index + 1),
    };
    const serialized = serializeDepositScope(scope);
    expect(serialized.length).toBeLessThanOrEqual(500);
    expect(JSON.parse(serialized).kind).toBe("selection");
  });
});

describe("createDeposit", () => {
  it("allocates sequential numeric ids and maps every field", async () => {
    const { bridge, store } = mockMemoryBridge();
    stubWindow(bridge);

    const first = await createDeposit({
      template: "custom",
      title: "自定义提炼 · 手动选择 2 个会话",
      scope: { kind: "selection", conversationIds: [1, 2] },
      contentMarkdown: "# 文档",
      customInstruction: "  提炼理财观点  ",
    });
    expect(first.id).toBe(1);
    expect(first.version).toBe(1);
    expect(first.prevId).toBeNull();
    expect(first.customInstruction).toBe("提炼理财观点");

    const second = await createDeposit({
      template: "project_state",
      title: "项目开发状态 · 项目 app",
      scope: { kind: "project", projectKey: "cli:/work/app", label: "cli · app" },
      contentMarkdown: "# v2",
      version: 2,
      prevId: first.id,
      lastOps: [{ op: "ADD", section: "风险", new_text: "新风险", reason: "新会话提到" }],
    });
    expect(second.id).toBe(2);

    const entry = store.get("deposit:2");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("deposit");
    expect(entry?.version).toBe(2);
    expect(entry?.prevId).toBe("deposit:1");
    expect(entry?.template).toBe("project_state");
    expect(JSON.parse(entry?.scope ?? "")).toEqual({
      kind: "project",
      projectKey: "cli:/work/app",
      label: "cli · app",
    });
    expect(JSON.parse(entry?.lastOps ?? "")).toEqual([
      { op: "ADD", section: "风险", new_text: "新风险", reason: "新会话提到" },
    ]);
    expect(entry?.status).toBe("active");
    expect(entry?.createdAt).toBe(second.createdAt);
  });

  it("continues numbering above migrated legacy rows", async () => {
    const { bridge } = mockMemoryBridge([
      seedEntry({ id: "deposit:7" }),
      seedEntry({ id: "deposit:12" }),
      // Foreign ids sharing the kind must not disturb numbering.
      seedEntry({ id: "note:external" }),
    ]);
    stubWindow(bridge);
    const created = await createDeposit({
      template: "extract",
      title: "知识提取 · s1",
      scope: { kind: "selection", conversationIds: [9] },
      contentMarkdown: "body",
    });
    expect(created.id).toBe(13);
  });

  it("truncates over-long titles to the IPC cap instead of being rejected", async () => {
    const { bridge, store } = mockMemoryBridge();
    stubWindow(bridge);
    const created = await createDeposit({
      template: "custom",
      title: "题".repeat(500),
      scope: { kind: "selection", conversationIds: [] },
      contentMarkdown: "body",
    });
    expect(created.title).toHaveLength(200);
    expect(store.get("deposit:1")?.title).toHaveLength(200);
  });

  it("throws without the desktop bridge", async () => {
    stubWindow(undefined);
    await expect(
      createDeposit({
        template: "custom",
        title: "x",
        scope: { kind: "selection", conversationIds: [] },
        contentMarkdown: "y",
      }),
    ).rejects.toThrow("桌面环境不可用");
  });
});

describe("listDeposits", () => {
  it("returns parsed deposits newest-created first, skipping foreign ids", async () => {
    const { bridge } = mockMemoryBridge([
      seedEntry({ id: "deposit:1", createdAt: 1_000 }),
      seedEntry({
        id: "deposit:2",
        createdAt: 3_000,
        version: 2,
        prevId: "deposit:1",
        summary: "指令",
        lastOps: JSON.stringify([{ op: "NOOP", section: "全部", reason: "" }]),
      }),
      seedEntry({ id: "deposit:3", createdAt: 2_000 }),
      seedEntry({ id: "dream:other", kind: "dream" }),
    ]);
    stubWindow(bridge);

    const deposits = await listDeposits();
    expect(deposits.map((deposit) => deposit.id)).toEqual([2, 3, 1]);
    expect(deposits[0].prevId).toBe(1);
    expect(deposits[0].customInstruction).toBe("指令");
    expect(deposits[0].lastOps).toEqual([{ op: "NOOP", section: "全部", reason: "" }]);
    expect(deposits[0].scope).toEqual({ kind: "selection", conversationIds: [] });
  });

  it("pages past the 500-per-call bridge cap", async () => {
    const seed = Array.from({ length: 1_200 }, (_, index) =>
      seedEntry({ id: `deposit:${index + 1}`, createdAt: index + 1 }),
    );
    const { bridge } = mockMemoryBridge(seed);
    stubWindow(bridge);
    const deposits = await listDeposits();
    expect(deposits).toHaveLength(1_200);
    expect(deposits[0].id).toBe(1_200);
  });
});

describe("getDeposit / renameDeposit / deleteDeposit", () => {
  it("reads one entry by its numeric id", async () => {
    const { bridge } = mockMemoryBridge([seedEntry({ id: "deposit:5", title: "五" })]);
    stubWindow(bridge);
    expect((await getDeposit(5))?.title).toBe("五");
    expect(await getDeposit(6)).toBeNull();
  });

  it("renames in place, preserving the rest of the entry", async () => {
    const { bridge, store } = mockMemoryBridge([
      seedEntry({ id: "deposit:5", title: "旧", version: 3, prevId: "deposit:2" }),
    ]);
    stubWindow(bridge);
    const renamed = await renameDeposit(5, "  新标题  ");
    expect(renamed.title).toBe("新标题");
    expect(renamed.version).toBe(3);
    expect(renamed.prevId).toBe(2);
    expect(store.get("deposit:5")?.title).toBe("新标题");
  });

  it("rejects empty titles and unknown ids", async () => {
    const { bridge } = mockMemoryBridge([seedEntry({ id: "deposit:5" })]);
    stubWindow(bridge);
    await expect(renameDeposit(5, "   ")).rejects.toThrow("empty");
    await expect(renameDeposit(99, "x")).rejects.toThrow("not found");
  });

  it("deletes via the encoded memory id", async () => {
    const { bridge, store } = mockMemoryBridge([seedEntry({ id: "deposit:5" })]);
    stubWindow(bridge);
    await deleteDeposit(5);
    expect(store.has("deposit:5")).toBe(false);
    expect(await getDeposit(5)).toBeNull();
  });
});

describe("memoryEntryToDeposit", () => {
  it("degrades malformed scope/lastOps JSON like the old Dexie normalizers", () => {
    const deposit = memoryEntryToDeposit(
      seedEntry({ id: "deposit:9", scope: "not json", lastOps: "[1,2]", template: "weird" }),
    );
    expect(deposit?.scope).toEqual({ kind: "selection", conversationIds: [] });
    expect(deposit?.lastOps).toBeNull();
    expect(deposit?.template).toBe("custom");
  });

  it("returns null for non-deposit kinds and foreign ids", () => {
    expect(memoryEntryToDeposit(seedEntry({ id: "deposit:1", kind: "dream" }))).toBeNull();
    expect(memoryEntryToDeposit(seedEntry({ id: "note:1" }))).toBeNull();
  });
});
