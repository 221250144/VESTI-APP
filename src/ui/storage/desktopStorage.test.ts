// Summary freshness gate: generateSummary serves a persisted non-fallback
// summary whose sourceUpdatedAt still covers the conversation's last update,
// without spending an LLM call; force ("Regenerate") bypasses the gate.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationGet: vi.fn(),
  getSummary: vi.fn(),
  saveSummary: vi.fn(),
  runAgent: vi.fn(),
  dispatchEvent: vi.fn(),
}));

vi.mock("../db/schema", () => ({
  db: {
    conversations: { get: mocks.conversationGet },
  },
}));

vi.mock("../db/repository", () => ({
  getSummary: mocks.getSummary,
  saveSummary: mocks.saveSummary,
  listMessages: vi.fn(async () => []),
}));

// Everything below is imported by desktopStorage but never exercised by the
// summary path; empty modules keep the import graph out of this test.
vi.mock("@vesti/ui", () => ({}));
vi.mock("../companion/companionService", () => ({}));
vi.mock("../db/utils/turnMessageText", () => ({}));
vi.mock("../db/utils/messageContentPackage", () => ({}));
vi.mock("../sync/conversationTree", () => ({}));
vi.mock("../sync/conversationDigests", () => ({}));
vi.mock("../deposits/depositRepository", () => ({}));
vi.mock("../deposits/deposits", () => ({}));
vi.mock("../memory", () => ({}));
vi.mock("../db/promptRepository", () => ({}));
vi.mock("../db/promptlib", () => ({}));
vi.mock("../roundtable/roundtable", () => ({}));
vi.mock("../learn/learnDeepen", () => ({}));
vi.mock("../learn/learnSynthesis", () => ({}));
vi.mock("../upstream/notionExport", () => ({}));
vi.mock("../upstream/obsidianExport", () => ({}));
vi.mock("../upstream/markdownSerializer", () => ({}));
vi.mock("../relay/relayContext", () => ({}));
vi.mock("../relay/relayFiles", () => ({}));
vi.mock("../daily/dailyService", () => ({}));
vi.mock("../daily/dailyScheduler", () => ({}));
vi.mock("../daily/dailyActivity", () => ({}));

import { desktopStorage } from "./desktopStorage";
import type { SummaryRecord } from "../db/types";

function conversationRecord(updatedAt: number) {
  return { id: 7, title: "Tokenizer 选型讨论", updated_at: updatedAt, _cli_id: "session-1" };
}

function summaryRecord(overrides: Partial<SummaryRecord>): SummaryRecord {
  return {
    id: 3,
    conversationId: 7,
    content: "缓存的摘要内容",
    structured: null,
    format: "fallback_plain_text",
    status: "ok",
    modelId: "qwen-plus",
    createdAt: 500,
    sourceUpdatedAt: 1000,
    ...overrides,
  };
}

describe("desktopStorage.generateSummary freshness gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationGet.mockResolvedValue(conversationRecord(1000));
    mocks.getSummary.mockResolvedValue(null);
    mocks.saveSummary.mockImplementation(async (record) => ({ id: 4, ...record }));
    mocks.runAgent.mockResolvedValue({
      content: "新的摘要 prose output",
      modelId: "qwen-plus",
      createdAt: 1234,
    });
    (globalThis as { window?: unknown }).window = {
      vesti: { runAgent: mocks.runAgent },
      dispatchEvent: mocks.dispatchEvent,
    };
  });

  it("serves a still-fresh persisted summary without an LLM call", async () => {
    mocks.getSummary.mockResolvedValue(summaryRecord({ sourceUpdatedAt: 1000 }));

    const result = await desktopStorage.generateSummary!(7);

    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.saveSummary).not.toHaveBeenCalled();
    expect(result.meta.title).toBe("Tokenizer 选型讨论");
    expect(result.plain_text).toBe("缓存的摘要内容");
  });

  it("regenerates when the conversation changed after the summary was written", async () => {
    mocks.getSummary.mockResolvedValue(summaryRecord({ sourceUpdatedAt: 999 }));

    const result = await desktopStorage.generateSummary!(7);

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(mocks.runAgent).toHaveBeenCalledWith({ kind: "summary", sessionId: "session-1" });
    expect(mocks.saveSummary).toHaveBeenCalledTimes(1);
    expect(result.plain_text).toBe("新的摘要 prose output");
  });

  it("regenerates fallback rows even when they look fresh", async () => {
    mocks.getSummary.mockResolvedValue(summaryRecord({ status: "fallback" }));

    await desktopStorage.generateSummary!(7);

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it("force bypasses the freshness gate (Regenerate button)", async () => {
    mocks.getSummary.mockResolvedValue(summaryRecord({ sourceUpdatedAt: 1000 }));

    const result = await desktopStorage.generateSummary!(7, { force: true });

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(result.plain_text).toBe("新的摘要 prose output");
  });
});
