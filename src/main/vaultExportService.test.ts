import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bumpConflictPath,
  fileFrontmatterHasUuid,
  resolveInsideRoot,
  writeUpstreamExportFile,
} from "./vaultExportService";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vesti-vault-test-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveInsideRoot", () => {
  it("resolves ordinary relative paths inside the root", () => {
    const resolved = resolveInsideRoot(root, "VestiExport/a/b.md");
    expect(resolved).toBe(path.resolve(root, "VestiExport/a/b.md"));
  });

  it("rejects .. traversal escaping the root", () => {
    expect(() => resolveInsideRoot(root, "../outside.md")).toThrow("越出");
    expect(() => resolveInsideRoot(root, "a/../../outside.md")).toThrow("越出");
    expect(() => resolveInsideRoot(root, "..")).toThrow("越出");
  });

  it("rejects absolute and UNC re-rooting", () => {
    expect(() => resolveInsideRoot(root, "C:/Windows/evil.md")).toThrow("相对路径");
    expect(() => resolveInsideRoot(root, "\\\\server\\share\\evil.md")).toThrow("相对路径");
  });

  it("rejects a non-absolute root and empty/NUL paths", () => {
    expect(() => resolveInsideRoot("relative/root", "a.md")).toThrow("绝对路径");
    expect(() => resolveInsideRoot(root, "")).toThrow("无效");
    expect(() => resolveInsideRoot(root, "a\0b.md")).toThrow("无效");
  });
});

describe("bumpConflictPath", () => {
  it("inserts the attempt number before the extension", () => {
    expect(bumpConflictPath("VestiExport/a/b.md", 2)).toBe("VestiExport/a/b (2).md");
  });
});

describe("fileFrontmatterHasUuid", () => {
  it("matches the uuid line inside frontmatter only", async () => {
    const file = path.join(root, "probe.md");
    await fs.writeFile(
      file,
      "---\nplatform: Claude Code\nuuid: abc-123\n---\n\n# title\nuuid: other\n",
      "utf8",
    );
    expect(await fileFrontmatterHasUuid(file, "abc-123")).toBe(true);
    expect(await fileFrontmatterHasUuid(file, "other")).toBe(false);
    expect(await fileFrontmatterHasUuid(file, "")).toBe(false);
  });
});

describe("writeUpstreamExportFile", () => {
  it("writes new files, creating directories", async () => {
    const result = await writeUpstreamExportFile({
      rootPath: root,
      relativePath: "VestiExport/Claude Code/app/2024-01-01-t.md",
      content: "---\nuuid: u1\n---\n",
    });
    expect(result.relativePath).toBe("VestiExport/Claude Code/app/2024-01-01-t.md");
    const written = await fs.readFile(path.join(root, result.relativePath), "utf8");
    expect(written).toContain("uuid: u1");
  });

  it("idempotently updates the previous file when its uuid matches", async () => {
    const first = await writeUpstreamExportFile({
      rootPath: root,
      relativePath: "VestiExport/A/2024-01-01-same.md",
      content: "---\nuuid: u2\n---\nv1\n",
      expectedUuid: "u2",
    });
    const second = await writeUpstreamExportFile({
      rootPath: root,
      relativePath: "VestiExport/B/2024-01-02-renamed.md",
      content: "---\nuuid: u2\n---\nv2\n",
      previousRelativePath: first.relativePath,
      expectedUuid: "u2",
    });
    // Same conversation re-exported: updates the original file, no duplicate.
    expect(second.relativePath).toBe(first.relativePath);
    const written = await fs.readFile(path.join(root, first.relativePath), "utf8");
    expect(written).toContain("v2");
  });

  it("adds a numeric suffix when the desired name is taken by another uuid", async () => {
    await writeUpstreamExportFile({
      rootPath: root,
      relativePath: "VestiExport/A/2024-01-01-clash.md",
      content: "---\nuuid: owner\n---\n",
      expectedUuid: "owner",
    });
    const result = await writeUpstreamExportFile({
      rootPath: root,
      relativePath: "VestiExport/A/2024-01-01-clash.md",
      content: "---\nuuid: newcomer\n---\n",
      expectedUuid: "newcomer",
    });
    expect(result.relativePath).toBe("VestiExport/A/2024-01-01-clash (2).md");
  });

  it("refuses to overwrite a previous path whose uuid does not match", async () => {
    const taken = await writeUpstreamExportFile({
      rootPath: root,
      relativePath: "VestiExport/A/2024-01-01-owned.md",
      content: "---\nuuid: real-owner\n---\n",
      expectedUuid: "real-owner",
    });
    const result = await writeUpstreamExportFile({
      rootPath: root,
      relativePath: "VestiExport/A/2024-01-01-owned.md",
      content: "---\nuuid: impostor\n---\n",
      previousRelativePath: taken.relativePath,
      expectedUuid: "impostor",
    });
    expect(result.relativePath).not.toBe(taken.relativePath);
    const original = await fs.readFile(path.join(root, taken.relativePath), "utf8");
    expect(original).toContain("real-owner");
  });

  it("rejects traversal before touching the disk", async () => {
    await expect(
      writeUpstreamExportFile({
        rootPath: root,
        relativePath: "../escape.md",
        content: "x",
      }),
    ).rejects.toThrow("越出");
    await expect(
      writeUpstreamExportFile({
        rootPath: root,
        relativePath: "ok.md",
        content: "x",
        previousRelativePath: "../escape.md",
      }),
    ).rejects.toThrow("越出");
  });
});
