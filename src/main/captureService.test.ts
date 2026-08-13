// captureService: incremental conversation export + watch-tick notify gating.
// exportConversations rebuilds every session but only re-sends bundles whose
// content fingerprint moved against a process-lifetime cache, alongside the
// full session id list for renderer-side stale reconciliation. The watch path
// must notify only when a tick actually stored content — digest-only ticks
// used to trigger the renderer's full reload chain on every file event.

import { describe, expect, it, vi } from "vitest";
import { CaptureService } from "./captureService";

type FakeSession = {
  id: string;
  sessionId: string;
  platform: string;
  title: string;
  projectPath: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  turnCount: number;
  status: string;
  tags: string[];
  model: string;
  toolCallCount: number;
};

type FakeMessage = {
  id: string;
  sessionId: string;
  source: string;
  role: string;
  timestamp: number;
  contentText: string;
};

type Internals = {
  db: unknown;
  notify: (() => void) | undefined;
  adapters: unknown;
  syncEngine: unknown;
  enabledPlatforms: Set<string>;
  fileQueue: Map<string, Promise<void>>;
};

const internals = (service: CaptureService): Internals =>
  service as unknown as Internals;

function makeSession(id: string, overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id,
    sessionId: `sess-${id}`,
    platform: "kimi-code",
    title: `Session ${id}`,
    projectPath: "/tmp/project",
    startedAt: 1_000,
    endedAt: 2_000,
    messageCount: 1,
    turnCount: 1,
    status: "completed",
    tags: [],
    model: "kimi",
    toolCallCount: 0,
    ...overrides,
  };
}

function makeMessage(
  id: string,
  sessionId: string,
  text: string,
  overrides: Partial<FakeMessage> = {}
): FakeMessage {
  return {
    id: `msg-${sessionId}-${id}`,
    sessionId,
    source: "user_input",
    role: "user",
    timestamp: 1_500,
    contentText: text,
    ...overrides,
  };
}

function makeExportService(
  sessions: FakeSession[],
  messagesBySessionId: Map<string, FakeMessage[]>
): CaptureService {
  const service = new CaptureService({ wslPollIntervalMs: 0 });
  internals(service).db = {
    listWorkSessions: vi.fn(() => sessions),
    getSessionMessages: vi.fn(
      (id: string) => messagesBySessionId.get(id) ?? []
    ),
    getSubagentLineageByChild: vi.fn(() => new Map()),
  };
  return service;
}

describe("exportConversations (incremental)", () => {
  it("returns a full snapshot plus all session ids on the first export", () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const messages = new Map([
      ["s1", [makeMessage("1", "s1", "hello")]],
      ["s2", [makeMessage("1", "s2", "world")]],
    ]);
    const service = makeExportService(sessions, messages);

    const result = service.exportConversations();

    expect(result.sessionIds).toEqual(["s1", "s2"]);
    expect(result.bundles).toHaveLength(2);
    expect(
      result.bundles.map((bundle) => bundle.conversation._cli_id).sort()
    ).toEqual(["s1", "s2"]);
    expect(result.bundles[0].messages).toHaveLength(1);
  });

  it("returns empty bundles but the full id list when nothing changed", () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const messages = new Map([
      ["s1", [makeMessage("1", "s1", "hello")]],
      ["s2", [makeMessage("1", "s2", "world")]],
    ]);
    const service = makeExportService(sessions, messages);
    service.exportConversations();

    const second = service.exportConversations();

    expect(second.bundles).toEqual([]);
    expect(second.sessionIds).toEqual(["s1", "s2"]);
  });

  it("re-exports only the session whose content changed", () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const messages = new Map([
      ["s1", [makeMessage("1", "s1", "hello")]],
      ["s2", [makeMessage("1", "s2", "world")]],
    ]);
    const service = makeExportService(sessions, messages);
    service.exportConversations();

    // Streaming growth on s2: a new tail message plus the session-level
    // counters the sync engine would have updated alongside it.
    messages.set("s2", [
      makeMessage("1", "s2", "world"),
      makeMessage("2", "s2", "new tail", {
        source: "assistant_text",
        role: "assistant",
        timestamp: 1_600,
      }),
    ]);
    sessions[1] = makeSession("s2", { endedAt: 3_000, messageCount: 2 });

    const second = service.exportConversations();

    expect(second.sessionIds).toEqual(["s1", "s2"]);
    expect(second.bundles).toHaveLength(1);
    expect(second.bundles[0].conversation._cli_id).toBe("s2");
    expect(second.bundles[0].messages).toHaveLength(2);
  });

  it("drops deleted sessions from the id list and re-exports them fully if they reappear", () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const messages = new Map([
      ["s1", [makeMessage("1", "s1", "hello")]],
      ["s2", [makeMessage("1", "s2", "world")]],
    ]);
    const service = makeExportService(sessions, messages);
    service.exportConversations();

    // s2 deleted upstream: gone from the id list, nothing re-sent.
    sessions.splice(1, 1);
    const afterDelete = service.exportConversations();
    expect(afterDelete.sessionIds).toEqual(["s1"]);
    expect(afterDelete.bundles).toEqual([]);

    // A session reappearing under the same id must export in full again —
    // its cache entry was pruned with the deletion.
    sessions.push(makeSession("s2"));
    const afterReappear = service.exportConversations();
    expect(afterReappear.sessionIds).toEqual(["s1", "s2"]);
    expect(afterReappear.bundles).toHaveLength(1);
    expect(afterReappear.bundles[0].conversation._cli_id).toBe("s2");
  });
});

describe("watch-tick notify gating", () => {
  async function drainFileQueue(service: CaptureService): Promise<void> {
    await Promise.allSettled([...internals(service).fileQueue.values()]);
  }

  it("notifies only when a watch tick actually stored content", async () => {
    const service = new CaptureService({ wslPollIntervalMs: 0 });
    const notify = vi.fn();
    internals(service).notify = notify;
    internals(service).enabledPlatforms = new Set(["codex"]);
    const watcher: {
      callback?: (platform: string, filePath: string) => void;
    } = {};
    internals(service).adapters = {
      startWatching: vi.fn(
        async (callback: (platform: string, filePath: string) => void) => {
          watcher.callback = callback;
        }
      ),
      stopWatching: vi.fn(async () => undefined),
    };
    const syncFile = vi.fn();
    internals(service).syncEngine = {
      syncFile,
      resolveSubagentLinks: vi.fn(async () => 0),
    };

    await service.setWatching(true);
    notify.mockClear();

    // Digest-only / no-change tick: nothing stored, no notify.
    syncFile.mockResolvedValue(null);
    watcher.callback?.("codex", "/sessions/a.jsonl");
    await drainFileQueue(service);
    expect(notify).not.toHaveBeenCalled();

    // A tick that stored new content notifies exactly once.
    syncFile.mockResolvedValue({ sessionId: "s1" });
    watcher.callback?.("codex", "/sessions/a.jsonl");
    await drainFileQueue(service);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
