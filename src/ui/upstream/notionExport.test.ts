import { describe, expect, it } from "vitest";
import type { ConversationMarkdownInput, UpstreamConversation, UpstreamMessage } from "./markdownSerializer";
import {
  chunkNotionBlocks,
  conversationToNotionBlocks,
  mapNotionCodeLanguage,
  markdownToNotionBlocks,
  plainTextToNotionBlocks,
  richTextFromText,
  splitNotionText,
  type NotionBlock,
} from "./notionExport";

function conversation(overrides: Partial<UpstreamConversation> = {}): UpstreamConversation {
  return {
    id: 1,
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    platform: "Claude Code",
    title: "重构导出管线",
    snippet: "",
    url: "",
    source_created_at: 1_700_000_000_000,
    first_captured_at: 1_700_000_000_000,
    last_captured_at: 1_700_000_100_000,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
    message_count: 2,
    turn_count: 1,
    is_archived: false,
    is_trash: false,
    tags: [],
    topic_id: null,
    is_starred: false,
    ...overrides,
  };
}

function message(overrides: Partial<UpstreamMessage> = {}): UpstreamMessage {
  return {
    id: 1,
    conversation_id: 1,
    role: "user",
    content_text: "你好",
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function input(overrides: Partial<ConversationMarkdownInput> = {}): ConversationMarkdownInput {
  return {
    conversation: conversation(),
    messages: [message()],
    sourceLabel: "Claude Code",
    projectLabel: "vesti-app",
    ...overrides,
  };
}

function blockText(block: NotionBlock): string {
  const payload = block[block.type] as { rich_text?: Array<{ text: { content: string } }> } | undefined;
  return (payload?.rich_text ?? []).map((run) => run.text.content).join("");
}

describe("splitNotionText", () => {
  it("keeps short text in one chunk", () => {
    expect(splitNotionText("hello")).toEqual(["hello"]);
  });

  it("splits text over 2000 chars into ≤2000-char chunks", () => {
    const text = "字".repeat(4_500);
    const chunks = splitNotionText(text);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2_000);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers newline boundaries when available", () => {
    const text = `${"a".repeat(1_500)}\n${"b".repeat(1_500)}`;
    const chunks = splitNotionText(text);
    expect(chunks[0]).toBe("a".repeat(1_500));
    expect(chunks[1]).toBe("b".repeat(1_500));
  });

  it("handles text exactly at the limit", () => {
    expect(splitNotionText("x".repeat(2_000))).toEqual(["x".repeat(2_000)]);
  });
});

describe("richTextFromText", () => {
  it("produces multiple rich_text items for long content", () => {
    const runs = richTextFromText("字".repeat(4_100));
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const run of runs) expect(run.text.content.length).toBeLessThanOrEqual(2_000);
  });

  it("carries link and annotations", () => {
    const [run] = richTextFromText("文档", { link: "https://example.com", annotations: { bold: true } });
    expect(run.text.link).toEqual({ url: "https://example.com" });
    expect(run.annotations).toEqual({ bold: true });
  });
});

describe("chunkNotionBlocks", () => {
  it("splits >100 blocks into ≤100-block batches", () => {
    const blocks = Array.from({ length: 250 }, (_, index) => index);
    const batches = chunkNotionBlocks(blocks);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(blocks);
  });

  it("returns a single batch at exactly 100", () => {
    expect(chunkNotionBlocks(Array.from({ length: 100 }))).toHaveLength(1);
  });
});

describe("mapNotionCodeLanguage", () => {
  it("maps common aliases and falls back to plain text", () => {
    expect(mapNotionCodeLanguage("ts")).toBe("typescript");
    expect(mapNotionCodeLanguage("Python")).toBe("python");
    expect(mapNotionCodeLanguage("brainfuck")).toBe("plain text");
    expect(mapNotionCodeLanguage(null)).toBe("plain text");
  });
});

describe("conversationToNotionBlocks", () => {
  it("emits digest callout, meta quote, divider, then role sections", () => {
    const blocks = conversationToNotionBlocks(input({
      digest: { oneLiner: "讨论导出实现", keyTopics: ["导出"], decisions: ["用 Markdown"] },
      messages: [
        message({ role: "user", content_text: "请实现导出" }),
        message({ id: 2, role: "ai", content_text: "好的", created_at: 1_700_000_060_000 }),
      ],
    }));
    expect(blocks[0].type).toBe("callout");
    expect(blockText(blocks[0])).toContain("讨论导出实现");
    expect(blockText(blocks[0])).toContain("关键主题：导出");
    expect(blocks[1].type).toBe("quote");
    expect(blockText(blocks[1])).toContain("uuid：550e8400");
    expect(blocks[2].type).toBe("divider");
    const headings = blocks.filter((block) => block.type === "heading_2");
    expect(headings).toHaveLength(2);
    expect(blockText(headings[0])).toMatch(/^用户 · /);
    expect(blockText(headings[1])).toMatch(/^AI · /);
  });

  it("omits the callout when there is no digest or summary", () => {
    const blocks = conversationToNotionBlocks(input());
    expect(blocks[0].type).toBe("quote");
  });

  it("maps AST bodies: code/math/list stay structured", () => {
    const blocks = conversationToNotionBlocks(input({
      messages: [
        message({
          content_ast: {
            type: "root",
            children: [
              { type: "code_block", code: "const a = 1;", language: "ts" },
              { type: "math", tex: "E = mc^2", display: true },
              { type: "ul", children: [{ type: "li", children: [{ type: "text", text: "条目" }] }] },
            ],
          },
        }),
      ],
    }));
    const code = blocks.find((block) => block.type === "code");
    expect(code).toBeDefined();
    expect((code!.code as { language: string }).language).toBe("typescript");
    expect(blocks.some((block) => block.type === "equation")).toBe(true);
    expect(blocks.some((block) => block.type === "bulleted_list_item")).toBe(true);
  });

  it("renders tool calls as callouts and citations as linked bullets", () => {
    const blocks = conversationToNotionBlocks(input({
      messages: [
        message({
          role: "ai",
          content_text: "查一下",
          _tool_name: "read_file",
          _tool_input: "src/a.ts",
          citations: [{ label: "文档", href: "https://example.com", host: "example.com", sourceType: "inline_pill" }],
        }),
      ],
    }));
    const toolCallout = blocks.find(
      (block) => block.type === "callout" && blockText(block).includes("工具：read_file"),
    );
    expect(toolCallout).toBeDefined();
    const citation = blocks.find((block) => block.type === "bulleted_list_item");
    expect(citation).toBeDefined();
    const runs = (citation!.bulleted_list_item as { rich_text: Array<{ text: { content: string; link?: { url: string } } }> }).rich_text;
    expect(runs[0].text.link).toEqual({ url: "https://example.com" });
  });

  it("splits long message bodies across ≤2000-char rich_text items", () => {
    const blocks = conversationToNotionBlocks(input({
      messages: [message({ content_text: "字".repeat(4_500) })],
    }));
    const paragraph = blocks.find((block) => block.type === "paragraph");
    const runs = (paragraph!.paragraph as { rich_text: Array<{ text: { content: string } }> }).rich_text;
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const run of runs) expect(run.text.content.length).toBeLessThanOrEqual(2_000);
  });
});

describe("plainTextToNotionBlocks", () => {
  it("splits fenced code from paragraphs", () => {
    const blocks = plainTextToNotionBlocks("前文\n\n```bash\necho hi\n```\n\n后文");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blockText(blocks[0])).toBe("前文");
    expect((blocks[1].code as { language: string }).language).toBe("bash");
  });
});

describe("markdownToNotionBlocks", () => {
  it("maps headings/lists/quotes/dividers/code", () => {
    const blocks = markdownToNotionBlocks(
      "# 标题\n\n- 甲\n- 乙\n\n1. 一\n\n> 引用\n\n---\n\n```ts\nlet x = 1;\n```",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1",
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "quote",
      "divider",
      "code",
    ]);
  });

  it("merges consecutive plain lines into one paragraph", () => {
    const blocks = markdownToNotionBlocks("第一行\n第二行");
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0])).toBe("第一行\n第二行");
  });
});
