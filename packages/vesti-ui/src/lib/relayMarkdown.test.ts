import { describe, expect, it } from "vitest";
import { serializeRelayPackMarkdown } from "./relayMarkdown";
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
      key_decisions: ["采用插件化解码", "状态机管理播放状态"],
      key_files: [
        { path: "src/player/decoder.ts", why: "解码入口", last_state: "已拆分" },
        { path: "src/player/render.ts", why: "渲染层", last_state: "待接入 | 阻塞" },
      ],
      open_issues: ["字幕同步偶发漂移"],
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
          key_decisions: [],
          key_files: [],
          open_issues: [],
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
});
