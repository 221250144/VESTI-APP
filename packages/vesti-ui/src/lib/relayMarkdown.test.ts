import { describe, expect, it } from "vitest";
import { normalizeRelayPackPayload, serializeRelayPackMarkdown } from "./relayMarkdown";
import type { RelayPack } from "../types";

function pack(overrides?: Partial<RelayPack>): RelayPack {
  return {
    id: 7,
    createdAt: Date.UTC(2026, 6, 18, 12, 30, 0),
    title: "播放器重构交接",
    conversationIds: [11, 12],
    suggestedPrompt: "背景：正在重构播放器……",
    source: "manual",
    pack: {
      title: "播放器重构交接",
      goal: "把播放器迁移到新架构",
      current_state: "解码层已拆分，渲染层待接入",
      completed: [],
      in_progress: [],
      git_state: { dirty_files: [], last_commits: [] },
      key_decisions: ["采用插件化解码", "状态机管理播放状态"],
      key_files: [
        { path: "src/player/decoder.ts", why: "解码入口", last_state: "已拆分" },
        { path: "src/player/render.ts", why: "渲染层", last_state: "待接入 | 阻塞" },
      ],
      failed_paths: [],
      open_issues: ["字幕同步偶发漂移"],
      verification: { commands: [], last_results: [] },
      next_steps: ["接入新渲染层", "回归测试"],
      suggested_prompt: "背景：正在重构播放器……",
    },
    ...overrides,
  };
}

describe("serializeRelayPackMarkdown", () => {
  it("renders every section with the pack content", () => {
    const markdown = serializeRelayPackMarkdown(pack());
    expect(markdown).toContain("relay_id: 7");
    expect(markdown).toContain("conversations: 2");
    expect(markdown).toContain("# 交接包：播放器重构交接");
    expect(markdown).toContain("## 目标\n\n把播放器迁移到新架构");
    expect(markdown).toContain("## 当前状态\n\n解码层已拆分，渲染层待接入");
    expect(markdown).toContain("- 采用插件化解码");
    expect(markdown).toContain("| src/player/decoder.ts | 解码入口 | 已拆分 |");
    expect(markdown).toContain("- 字幕同步偶发漂移");
    expect(markdown).toContain("1. 接入新渲染层");
    expect(markdown).toContain("2. 回归测试");
    expect(markdown).toContain("```text\n背景：正在重构播放器……\n```");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("escapes pipes inside key-file table cells", () => {
    const markdown = serializeRelayPackMarkdown(pack());
    expect(markdown).toContain("待接入 \\| 阻塞");
  });

  it("renders 无 for empty sections", () => {
    const markdown = serializeRelayPackMarkdown(
      pack({
        pack: {
          title: "空交接",
          goal: "g",
          current_state: "c",
          completed: [],
          in_progress: [],
          git_state: { dirty_files: [], last_commits: [] },
          key_decisions: [],
          key_files: [],
          failed_paths: [],
          open_issues: [],
          verification: { commands: [], last_results: [] },
          next_steps: [],
          suggested_prompt: "p",
        },
      })
    );
    const decisions = markdown.split("## 关键决策")[1].split("##")[0];
    expect(decisions).toContain("无");
    const files = markdown.split("## 关键文件")[1].split("##")[0];
    expect(files).toContain("无");
    expect(files).not.toContain("| --- |");
  });

  it("renders the schema-v2 sections when they carry content", () => {
    const markdown = serializeRelayPackMarkdown(
      pack({
        pack: {
          title: "v2 交接",
          goal: "迁移播放器",
          current_state: "",
          completed: ["解码层拆分"],
          in_progress: ["渲染层接入"],
          git_state: {
            branch: "feature/player",
            dirty_files: ["src/player/render.ts"],
            last_commits: ["拆分解码层"],
          },
          key_decisions: [],
          key_files: [],
          failed_paths: [{ approach: "重写渲染线程", why_failed: "丢帧严重" }],
          open_issues: [],
          verification: { commands: ["pnpm test"], last_results: ["42 项通过"] },
          next_steps: [],
          confidence: { overall: 0.65, low_areas: ["字幕同步"] },
          suggested_prompt: "p",
        },
      })
    );
    expect(markdown).toContain("## 已完成\n\n- 解码层拆分");
    expect(markdown).toContain("## 进行中\n\n- 渲染层接入");
    expect(markdown).toContain("## Git 状态");
    expect(markdown).toContain("- 分支：feature/player");
    expect(markdown).toContain("- 未提交改动：src/player/render.ts");
    expect(markdown).toContain("  - 拆分解码层");
    expect(markdown).toContain("## 失败死路\n\n- 重写渲染线程 — 失败原因：丢帧严重");
    expect(markdown).toContain("## 验证");
    expect(markdown).toContain("- `pnpm test`");
    expect(markdown).toContain("- 42 项通过");
    expect(markdown).toContain("## 置信度\n\n整体置信度：65%");
    expect(markdown).toContain("低置信区域：字幕同步");
    // current_state is empty on v2 packs — the section disappears entirely.
    expect(markdown).not.toContain("## 当前状态");
  });
});

describe("normalizeRelayPackPayload", () => {
  it("upgrades a stored v1 payload with empty v2 defaults", () => {
    // Shape of a pack row written before schema v2 (no v2 keys at all).
    const v1 = {
      title: "旧交接",
      goal: "g",
      current_state: "旧状态",
      key_decisions: ["决定"],
      key_files: [{ path: "a.ts", why: "w", last_state: "s" }],
      open_issues: [],
      next_steps: ["下一步"],
      suggested_prompt: "p",
    };
    const normalized = normalizeRelayPackPayload(v1);
    expect(normalized).toEqual({
      title: "旧交接",
      goal: "g",
      current_state: "旧状态",
      completed: [],
      in_progress: [],
      git_state: { dirty_files: [], last_commits: [] },
      key_decisions: ["决定"],
      key_files: [{ path: "a.ts", why: "w", last_state: "s" }],
      failed_paths: [],
      open_issues: [],
      verification: { commands: [], last_results: [] },
      next_steps: ["下一步"],
      suggested_prompt: "p",
    });
    expect(normalized.confidence).toBeUndefined();
  });

  it("passes through a full v2 payload and clamps confidence", () => {
    const v2 = normalizeRelayPackPayload({
      title: "t",
      goal: "g",
      completed: ["a"],
      confidence: { overall: 1.4, low_areas: ["x"] },
      suggested_prompt: "p",
    });
    expect(v2.completed).toEqual(["a"]);
    expect(v2.confidence).toEqual({ overall: 1, low_areas: ["x"] });
  });

  it("degrades garbage input to a safe empty pack", () => {
    const normalized = normalizeRelayPackPayload("not-an-object");
    expect(normalized.title).toBe("");
    expect(normalized.completed).toEqual([]);
    expect(normalized.git_state).toEqual({ dirty_files: [], last_commits: [] });
    expect(normalized.verification).toEqual({ commands: [], last_results: [] });
    expect(normalized.confidence).toBeUndefined();
    // …and serializing a v1-shaped stored pack must not crash.
    const markdown = serializeRelayPackMarkdown(
      pack({
        pack: {
          title: "旧交接",
          goal: "g",
          current_state: "旧状态",
          key_decisions: [],
          key_files: [],
          open_issues: [],
          next_steps: [],
          suggested_prompt: "p",
        } as unknown as RelayPack["pack"],
      })
    );
    expect(markdown).toContain("## 当前状态\n\n旧状态");
    expect(markdown).not.toContain("## 已完成");
    expect(markdown).not.toContain("## 置信度");
  });
});
