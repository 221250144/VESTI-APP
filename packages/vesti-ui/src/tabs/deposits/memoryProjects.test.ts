import { describe, expect, it } from "vitest";
import type {
  ConversationTree,
  ConversationTreeSession,
  MemoryEntryView,
} from "../../types";
import {
  EMPTY_SESSION_PROJECT_MAP,
  buildSessionProjectMap,
  earliestSessionActivity,
  entryDateLabel,
  entryEventTime,
  groupEntriesByProject,
  resolveEntryProject,
  toggleExpandedKey,
} from "./memoryProjects";

function session(
  id: string,
  lastActivityAt: number,
  children?: ConversationTreeSession[],
): ConversationTreeSession {
  return {
    id,
    title: id,
    messageCount: 1,
    lastActivityAt,
    oneLiner: null,
    keyTopics: [],
    keyFiles: [],
    decisions: [],
    ...(children ? { children } : {}),
  };
}

// Two CLI projects plus a browser-source project; proj-a's second session
// carries a nested subagent child to exercise the recursive walk.
const TREE: ConversationTree = {
  generatedAt: "2026-08-15T00:00:00.000Z",
  sources: [
    {
      platform: "kimi-code",
      host: "native",
      projects: [
        {
          projectKey: "proj-a",
          label: "VESTI",
          pathOrDomain: "/dev/vesti",
          sessions: [session("sa1", 1000), session("sa2", 3000, [session("sa2-sub", 2000)])],
        },
        {
          projectKey: "proj-b",
          label: "Other",
          pathOrDomain: "/dev/other",
          sessions: [session("sb1", 5000)],
        },
      ],
    },
    {
      platform: "browser",
      host: "web",
      projects: [
        {
          projectKey: "dom-c",
          label: "chat.example",
          pathOrDomain: "chat.example",
          sessions: [session("browser:1", 9000)],
        },
      ],
    },
  ],
};

const MAP = buildSessionProjectMap(TREE);

function entry(id: string, overrides: Partial<MemoryEntryView> = {}): MemoryEntryView {
  return {
    id,
    kind: "dream",
    title: id,
    contentMarkdown: "",
    sourceSessionIds: [],
    tags: [],
    version: 1,
    status: "active",
    createdAt: 0,
    updatedAt: 100,
    ...overrides,
  };
}

describe("buildSessionProjectMap", () => {
  it("maps every session to its project, recursing into subagent children", () => {
    expect(MAP.get("sa1")).toMatchObject({ projectKey: "proj-a", projectLabel: "VESTI" });
    expect(MAP.get("sa2-sub")).toMatchObject({ projectKey: "proj-a", lastActivityAt: 2000 });
    expect(MAP.get("sb1")).toMatchObject({ projectKey: "proj-b" });
    expect(MAP.get("browser:1")).toMatchObject({ projectKey: "dom-c" });
    expect(MAP.size).toBe(5);
  });

  it("returns an empty map for a null/absent tree", () => {
    expect(buildSessionProjectMap(null).size).toBe(0);
  });
});

describe("resolveEntryProject", () => {
  it("lets the majority project win", () => {
    const target = entry("m1", { sourceSessionIds: ["sa1", "sa2", "sb1"] });
    expect(resolveEntryProject(target, MAP)).toMatchObject({ projectKey: "proj-a" });
  });

  it("breaks a hit-count tie by the newest matched session activity", () => {
    // proj-a's match was active at 3000, proj-b's at 5000 — proj-b wins.
    const target = entry("m2", { sourceSessionIds: ["sa2", "sb1"] });
    expect(resolveEntryProject(target, MAP)).toMatchObject({ projectKey: "proj-b" });
    // Same tie the other way around: sa1 (1000) vs browser:1 (9000).
    const flipped = entry("m3", { sourceSessionIds: ["sa1", "browser:1"] });
    expect(resolveEntryProject(flipped, MAP)).toMatchObject({ projectKey: "dom-c" });
  });

  it("returns null when no source session resolves", () => {
    expect(resolveEntryProject(entry("m4", { sourceSessionIds: ["ghost"] }), MAP)).toBeNull();
    expect(resolveEntryProject(entry("m5"), MAP)).toBeNull();
  });
});

describe("groupEntriesByProject", () => {
  it("orders groups by their newest entry event time, unlinked last even when newest", () => {
    const oldA = entry("a", { sourceSessionIds: ["sa1"] }); // event time 1000
    const newB = entry("b", { sourceSessionIds: ["sb1"] }); // event time 5000
    const stray = entry("u", { updatedAt: 999_999 }); // unlinked, newest write time
    const groups = groupEntriesByProject([oldA, stray, newB], MAP);
    expect(groups.map((group) => group.projectKey)).toEqual(["proj-b", "proj-a", null]);
    expect(groups[2].entries.map((item) => item.id)).toEqual(["u"]);
  });

  it("merges entries of the same project into one group", () => {
    const groups = groupEntriesByProject(
      [entry("a", { sourceSessionIds: ["sa1"] }), entry("b", { sourceSessionIds: ["sa2"] })],
      MAP,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("entryDateLabel", () => {
  it("prefers the stored entryDate verbatim", () => {
    const target = entry("d1", {
      entryDate: "2026-08-01",
      sourceSessionIds: ["sa1"],
      updatedAt: 123456789,
    });
    expect(entryDateLabel(target, MAP)).toBe("2026-08-01");
  });

  it("falls back to the earliest source-session activity date", () => {
    const target = entry("d2", { sourceSessionIds: ["sa2", "sa1"] }); // earliest = 1000
    expect(entryDateLabel(target, MAP)).toBe(new Date(1000).toLocaleDateString());
  });

  it("falls back to updatedAt when nothing resolves", () => {
    const target = entry("d3", { sourceSessionIds: ["ghost"], updatedAt: 424242 });
    expect(entryDateLabel(target, MAP)).toBe(new Date(424242).toLocaleDateString());
    expect(entryDateLabel(target)).toBe(new Date(424242).toLocaleDateString());
  });
});

describe("earliestSessionActivity / entryEventTime", () => {
  it("ignores unresolvable session ids", () => {
    const target = entry("e1", { sourceSessionIds: ["ghost", "browser:1"] });
    expect(earliestSessionActivity(target, MAP)).toBe(9000);
  });

  it("parses entryDate for sorting and falls back cleanly", () => {
    expect(entryEventTime(entry("e2", { entryDate: "2026-08-01" }), MAP)).toBe(
      Date.parse("2026-08-01"),
    );
    expect(entryEventTime(entry("e3", { entryDate: "not-a-date", updatedAt: 77 }), MAP)).toBe(77);
  });
});

describe("toggleExpandedKey (default-collapsed interaction)", () => {
  it("starts collapsed: an empty set expands on the first toggle and collapses on the second", () => {
    const expanded0 = new Set<string>(); // initial component state = everything collapsed
    const expanded1 = toggleExpandedKey(expanded0, "proj-a");
    expect(expanded0.has("proj-a")).toBe(false); // original set untouched
    expect(expanded1.has("proj-a")).toBe(true);
    const expanded2 = toggleExpandedKey(expanded1, "proj-a");
    expect(expanded2.has("proj-a")).toBe(false);
  });

  it("toggles keys independently", () => {
    const expanded = toggleExpandedKey(new Set(["proj-a"]), "unlinked");
    expect([...expanded].sort()).toEqual(["proj-a", "unlinked"]);
  });
});

describe("EMPTY_SESSION_PROJECT_MAP", () => {
  it("degrades every lookup to unlinked / updatedAt", () => {
    const target = entry("z", { updatedAt: 55 });
    expect(resolveEntryProject(target, EMPTY_SESSION_PROJECT_MAP)).toBeNull();
    expect(entryDateLabel(target, EMPTY_SESSION_PROJECT_MAP)).toBe(
      new Date(55).toLocaleDateString(),
    );
    expect(groupEntriesByProject([target], EMPTY_SESSION_PROJECT_MAP)[0].projectKey).toBeNull();
  });
});
