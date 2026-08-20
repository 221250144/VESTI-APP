import { describe, expect, it } from "vitest";
import type { Conversation, Message } from "./types";
import { buildExportMdV1, buildExportTxtV1, type ExportDataset } from "./exportSerializers";

function dataset(): ExportDataset {
  const conversation = {
    id: 1,
    uuid: "turn-export",
    platform: "Codex",
    title: "聚合轮次",
    snippet: "",
    url: "",
    source_created_at: 1_700_000_000_000,
    first_captured_at: 1_700_000_000_000,
    last_captured_at: 1_700_000_010_000,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_010_000,
    message_count: 2,
    turn_count: 1,
    is_archived: false,
    is_trash: false,
    tags: [],
    topic_id: null,
    is_starred: false,
  } as Conversation;
  const messages: Message[] = [
    {
      id: 1,
      conversation_id: 1,
      role: "user",
      content_text: "主提示",
      created_at: 1_700_000_000_000,
      _turn_id: "turn-1",
      _followups: [{ id: 11, content_text: "修正范围", created_at: 1_700_000_001_000 }],
    },
    {
      id: 2,
      conversation_id: 1,
      role: "ai",
      content_text: "最终答案",
      created_at: 1_700_000_010_000,
      _turn_id: "turn-1",
      _progress_segments: [{ id: 21, content_text: "正在检查", created_at: 1_700_000_002_000 }],
      _thinking_segments: [{ id: 22, content_text: "内部推理", created_at: 1_700_000_003_000 }],
    },
  ];
  return {
    conversations: [conversation],
    messages,
    summaries: [],
    weeklyReports: [],
    annotations: [],
  };
}

describe("turn-aware text exports", () => {
  it.each([
    ["TXT", buildExportTxtV1],
    ["Markdown", buildExportMdV1],
  ])("preserves follow-ups and folded process in %s", (_label, build) => {
    const output = build(dataset()).content;

    expect(output).toContain("主提示");
    expect(output).toContain("跟进 1");
    expect(output).toContain("修正范围");
    expect(output).toContain("最终答案");
    expect(output).toContain("进度");
    expect(output).toContain("正在检查");
    expect(output).toContain("思考");
    expect(output).toContain("内部推理");
  });
});
