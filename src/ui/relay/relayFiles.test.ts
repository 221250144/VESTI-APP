import { describe, expect, it } from "vitest";
import type { RelayFileTouchRow } from "../../shared/contracts";
import {
  extractRelayFileAnchors,
  extractTouchPath,
  extractTouchPathStructured,
  extractTouchPathV2,
  extractVerificationCommands,
  formatRelayFileAnchorBlock,
  formatVerificationBlock,
  RELAY_FILE_ANCHOR_LIMIT,
  sameAnchorPath,
} from "./relayFiles";

function row(
  sessionId: string,
  inputSummary: string | null,
  timestamp: number,
  toolName = "Read"
): RelayFileTouchRow {
  return { sessionId, toolName, toolCategory: "file_read", inputSummary, timestamp };
}

// Mid-day UTC so the local calendar date is 2023-11-14 in any runner
// timezone up to UTC+11 (the block formats dates in local time).
const FIRST_SEEN = Date.UTC(2023, 10, 14, 12, 0, 0);

describe("extractTouchPath", () => {
  it("extracts file_path / path / filePath keys from tool input JSON", () => {
    expect(extractTouchPath('{"file_path": "src/a.ts"}')).toBe("src/a.ts");
    expect(extractTouchPath('{"path": "C:\\\\proj\\\\b.ts", "old": "x"}')).toBe("C:\\proj\\b.ts");
    expect(extractTouchPath('{"filePath": "/home/u/c.ts"}')).toBe("/home/u/c.ts");
    expect(extractTouchPath('{"target_file": "d.ts"}')).toBe("d.ts");
  });

  it("survives truncation mid-string (regex fallback without JSON.parse)", () => {
    // input_summary is capped at 500 chars upstream — the JSON may be cut off.
    expect(extractTouchPath('{"file_path": "src/very/long/path/that/keeps/g')).toBe(
      "src/very/long/path/that/keeps/g"
    );
  });

  it("rejects non-file input, URLs and empty values", () => {
    expect(extractTouchPath(null)).toBeNull();
    expect(extractTouchPath("")).toBeNull();
    expect(extractTouchPath('{"command": "pnpm test"}')).toBeNull();
    expect(extractTouchPath('{"path": "https://example.com/x"}')).toBeNull();
    expect(extractTouchPath('{"path": "   "}')).toBeNull();
  });
});

describe("extractRelayFileAnchors", () => {
  it("returns an empty list for empty / pathless input", () => {
    expect(extractRelayFileAnchors([], () => 1)).toEqual([]);
    expect(
      extractRelayFileAnchors(
        [row("s1", '{"command": "ls"}', FIRST_SEEN), row("s1", null, FIRST_SEEN)],
        () => 1
      )
    ).toEqual([]);
  });

  it("aggregates touches, latest timestamp and source conversations per path", () => {
    const anchors = extractRelayFileAnchors(
      [
        row("s1", '{"file_path": "src/a.ts"}', FIRST_SEEN),
        row("s1", '{"file_path": "src/a.ts"}', FIRST_SEEN + 1_000, "Edit"),
        row("s2", '{"file_path": "src/a.ts"}', FIRST_SEEN + 2_000),
        row("s2", '{"file_path": "src/b.ts"}', FIRST_SEEN + 500),
      ],
      (sessionId) => (sessionId === "s1" ? 1 : 2)
    );
    expect(anchors).toHaveLength(2);
    const a = anchors.find((anchor) => anchor.path === "src/a.ts");
    expect(a).toMatchObject({
      touches: 3,
      lastTouchedAt: FIRST_SEEN + 2_000,
      conversationIds: [1, 2],
    });
    const b = anchors.find((anchor) => anchor.path === "src/b.ts");
    expect(b).toMatchObject({ touches: 1, conversationIds: [2] });
  });

  it("dedupes case- and separator-insensitively, keeping the first-seen spelling", () => {
    const anchors = extractRelayFileAnchors(
      [
        row("s1", '{"file_path": "Src\\\\A.ts"}', FIRST_SEEN),
        row("s1", '{"file_path": "src/A.ts/"}', FIRST_SEEN + 1_000),
      ],
      () => 1
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0].path).toBe("Src\\A.ts");
    expect(anchors[0].touches).toBe(2);
  });

  it("sorts by touches desc, then recency desc, then path", () => {
    const anchors = extractRelayFileAnchors(
      [
        row("s1", '{"file_path": "z-last.ts"}', FIRST_SEEN + 100),
        row("s1", '{"file_path": "b-hot.ts"}', FIRST_SEEN),
        row("s1", '{"file_path": "b-hot.ts"}', FIRST_SEEN + 50),
        row("s1", '{"file_path": "a-same-count.ts"}', FIRST_SEEN + 100),
      ],
      () => 1
    );
    expect(anchors.map((anchor) => anchor.path)).toEqual([
      "b-hot.ts",
      "a-same-count.ts",
      "z-last.ts",
    ]);
  });

  it("caps the result at the anchor limit", () => {
    const rows = Array.from({ length: RELAY_FILE_ANCHOR_LIMIT + 5 }, (_, index) =>
      row("s1", `{"file_path": "f${String(index).padStart(2, "0")}.ts"}`, FIRST_SEEN + index)
    );
    const anchors = extractRelayFileAnchors(rows, () => 1);
    expect(anchors).toHaveLength(RELAY_FILE_ANCHOR_LIMIT);
  });

  it("drops source sessions the resolver does not know", () => {
    const anchors = extractRelayFileAnchors(
      [
        row("unknown", '{"file_path": "a.ts"}', FIRST_SEEN),
        row("s1", '{"file_path": "a.ts"}', FIRST_SEEN + 1),
      ],
      (sessionId) => (sessionId === "s1" ? 7 : null)
    );
    expect(anchors[0].touches).toBe(2);
    expect(anchors[0].conversationIds).toEqual([7]);
  });
});

describe("formatRelayFileAnchorBlock", () => {
  it("returns null for no anchors (the block is omitted)", () => {
    expect(formatRelayFileAnchorBlock([], () => "会话 1")).toBeNull();
  });

  it("renders one line per anchor with touches, recency and source labels", () => {
    const block = formatRelayFileAnchorBlock(
      [
        { path: "src/a.ts", touches: 3, lastTouchedAt: FIRST_SEEN, conversationIds: [1, 2] },
        { path: "src/b.ts", touches: 1, lastTouchedAt: 0, conversationIds: [99] },
      ],
      (id) => (id <= 2 ? `会话 ${id}` : null)
    );
    expect(block).not.toBeNull();
    expect(block).toContain("## 关键文件（程序提取，带锚点）");
    expect(block).toContain("- src/a.ts（触碰 3 次，最近 2023-11-14，来源：会话 1、会话 2）");
    // Unresolvable conversations simply carry no source suffix.
    expect(block).toContain("- src/b.ts（触碰 1 次，最近 时间未知）");
  });
});

describe("sameAnchorPath", () => {
  it("matches case- and separator-folded paths", () => {
    expect(sameAnchorPath("Src\\A.ts", "src/a.ts/")).toBe(true);
    expect(sameAnchorPath("src/a.ts", "src/b.ts")).toBe(false);
  });
});

// ---- V2: Structured Extraction & Verification Tests -------------------------

describe("extractTouchPathStructured", () => {
  it("extracts from standard keys", () => {
    expect(extractTouchPathStructured({ file_path: "src/main.ts" })).toBe("src/main.ts");
    expect(extractTouchPathStructured({ filePath: "src/lib.ts" })).toBe("src/lib.ts");
    expect(extractTouchPathStructured({ path: "config.json" })).toBe("config.json");
  });

  it("extracts from non-standard keys (notebook, target_file, etc.)", () => {
    expect(extractTouchPathStructured({ notebook_path: "notes.ipynb" })).toBe("notes.ipynb");
    expect(extractTouchPathStructured({ target_file: "out/bundle.js" })).toBe("out/bundle.js");
    expect(extractTouchPathStructured({ old_path: "src/old.ts", new_path: "src/new.ts" }))
      .toBe("src/old.ts"); // first matching key wins
  });

  it("returns null for non-file objects", () => {
    expect(extractTouchPathStructured(null)).toBeNull();
    expect(extractTouchPathStructured(undefined)).toBeNull();
    expect(extractTouchPathStructured({ query: "search something" })).toBeNull();
  });

  it("skips URLs", () => {
    expect(extractTouchPathStructured({ file_path: "https://example.com/file.ts" })).toBeNull();
  });
});

describe("extractTouchPathV2", () => {
  it("prefers structured over regex", () => {
    const result = extractTouchPathV2(
      { file_path: "src/structured.ts" },
      '{"file_path": "src/legacy.ts"}',
    );
    expect(result).toBe("src/structured.ts");
  });

  it("falls back to regex when structured is null", () => {
    const result = extractTouchPathV2(
      { query: "no path" },
      '{"file_path": "src/legacy.ts"}',
    );
    expect(result).toBe("src/legacy.ts");
  });
});

describe("extractVerificationCommands", () => {
  const makeRow = (overrides: {
    toolName?: string;
    toolInput?: string;
    toolOutput?: string;
    toolError?: string;
    timestamp?: number;
  }) => ({
    toolName: overrides.toolName ?? "bash",
    toolInput: overrides.toolInput ?? "",
    toolOutput: overrides.toolOutput ?? "",
    toolError: overrides.toolError ?? null,
    timestamp: overrides.timestamp ?? 1000,
  });

  it("extracts npm test commands", () => {
    const cmds = extractVerificationCommands([
      makeRow({ toolName: "bash", toolInput: "npm test -- --run", toolOutput: "42 passed" }),
    ]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toContain("npm test");
    expect(cmds[0].passed).toBe(true);
  });

  it("detects failed verification", () => {
    const cmds = extractVerificationCommands([
      makeRow({
        toolName: "bash",
        toolInput: "pnpm test",
        toolOutput: "3 tests failed. exit code 1",
      }),
    ]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].passed).toBe(false);
  });

  it("detects tsc typecheck", () => {
    const cmds = extractVerificationCommands([
      makeRow({ toolName: "bash", toolInput: "npx tsc --noEmit", toolOutput: "" }),
    ]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toContain("tsc");
  });

  it("ignores non-verification shell tools", () => {
    const cmds = extractVerificationCommands([
      makeRow({ toolName: "bash", toolInput: "echo hello world" }),
    ]);
    expect(cmds).toHaveLength(0);
  });

  it("ignores non-shell tools", () => {
    const cmds = extractVerificationCommands([
      makeRow({ toolName: "read", toolInput: "pnpm test src/test.ts" }),
    ]);
    expect(cmds).toHaveLength(0);
  });

  it("sorts most recent first", () => {
    const cmds = extractVerificationCommands([
      makeRow({ toolName: "bash", toolInput: "npm test", timestamp: 100 }),
      makeRow({ toolName: "bash", toolInput: "npm run build", timestamp: 300 }),
    ]);
    expect(cmds[0].command).toContain("build");
  });
});

describe("formatVerificationBlock", () => {
  it("renders a block with the latest verification result", () => {
    const block = formatVerificationBlock([
      { command: "npm test", output: "42 passed", passed: true, timestamp: 200 },
    ]);
    expect(block).toContain("程序提取的验证命令");
    expect(block).toContain("npm test");
    expect(block).toContain("✓ 通过");
  });

  it("returns null for empty list", () => {
    expect(formatVerificationBlock([])).toBeNull();
  });
});
