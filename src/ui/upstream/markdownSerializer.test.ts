import { describe, expect, it } from "vitest";
import type { AstRoot } from "../db/ast";
import type { Conversation, Message } from "../db/types";
import {
  astRootToMarkdown,
  buildConversationRelativePath,
  buildFrontmatter,
  resolveConflictRelativePath,
  resolveExportPlacement,
  sanitizeFileBaseName,
  sanitizePathSegment,
  serializeConversationMarkdown,
  type UpstreamConversation,
  type UpstreamMessage,
} from "./markdownSerializer";

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
    tags: ["导出", "obsidian"],
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

describe("sanitizePathSegment", () => {
  it("strips Windows-illegal and Obsidian-meaningful characters", () => {
    expect(sanitizePathSegment('a<b>:"/\\|?*^#[ ]c')).toBe("ab c");
  });

  it("collapses whitespace and strips trailing dots and spaces", () => {
    expect(sanitizePathSegment("  hello   world... ")).toBe("hello world");
  });

  it("caps the length at 60 characters", () => {
    expect(sanitizePathSegment("x".repeat(100))).toHaveLength(60);
  });

  it("falls back when nothing usable remains", () => {
    expect(sanitizePathSegment("???")).toBe("untitled");
    expect(sanitizePathSegment("")).toBe("untitled");
  });

  it("keeps CJK titles and hyphens intact", () => {
    expect(sanitizeFileBaseName("2024-总结-导出")).toBe("2024-总结-导出");
  });
});

describe("resolveConflictRelativePath", () => {
  it("returns the original path when free", () => {
    expect(resolveConflictRelativePath("a/b.md", new Set())).toBe("a/b.md");
  });

  it("inserts an incrementing suffix before the extension", () => {
    const taken = new Set(["a/b.md", "a/b (2).md"]);
    expect(resolveConflictRelativePath("a/b.md", taken)).toBe("a/b (3).md");
  });
});

describe("buildConversationRelativePath", () => {
  it("builds the VestiExport/<来源>/<项目>/YYYY-MM-DD-<标题>.md layout", () => {
    const path = buildConversationRelativePath({
      sourceLabel: "Claude Code",
      projectLabel: "vesti-app",
      originAt: 1_700_000_000_000,
      title: "重构导出管线",
    });
    expect(path).toMatch(
      /^VestiExport\/Claude Code\/vesti-app\/\d{4}-\d{2}-\d{2}-重构导出管线\.md$/,
    );
  });

  it("sanitizes every segment", () => {
    const path = buildConversationRelativePath({
      sourceLabel: 'Bad"name"',
      projectLabel: "a/b",
      originAt: 1_700_000_000_000,
      title: "x:y",
    });
    expect(path).toMatch(/^VestiExport\/Badname\/ab\/\d{4}-\d{2}-\d{2}-xy\.md$/);
  });
});

describe("resolveExportPlacement", () => {
  it("groups browser captures under Browser/<domain>", () => {
    expect(
      resolveExportPlacement({
        platform: "ChatGPT",
        url: "https://chatgpt.com/c/123",
        _source: "browser_extension",
      }),
    ).toEqual({ sourceLabel: "Browser", projectLabel: "chatgpt.com" });
  });

  it("groups CLI captures under <平台>/<项目目录名>", () => {
    expect(
      resolveExportPlacement({
        platform: "Claude Code",
        _source: "local_terminal",
        _project_path: "c:/dev/vesti-app/",
      }),
    ).toEqual({ sourceLabel: "Claude Code", projectLabel: "vesti-app" });
  });

  it("falls back to the platform label when no project is known", () => {
    expect(
      resolveExportPlacement({ platform: "Kimi Code", _source: "local_terminal" }),
    ).toEqual({ sourceLabel: "Kimi Code", projectLabel: "Kimi Code" });
  });
});

describe("buildFrontmatter", () => {
  it("emits all required keys, quoting unsafe scalars", () => {
    const frontmatter = buildFrontmatter({
      conversation: conversation({ tags: ["a:b", "plain"] }),
      messages: [message(), message({ id: 2 })],
      sourceLabel: "Claude Code",
      projectLabel: "vesti-app",
      topicPath: "工程 / 导出",
    });
    expect(frontmatter).toContain("platform: Claude Code");
    expect(frontmatter).toContain("source: unknown");
    expect(frontmatter).toContain("project: vesti-app");
    expect(frontmatter).toContain('topic: "工程 / 导出"');
    expect(frontmatter).toContain('tags: ["a:b", "plain"]');
    expect(frontmatter).toContain("uuid: 550e8400-e29b-41d4-a716-446655440000");
    expect(frontmatter).toMatch(/^created: "\d{4}-\d{2}-\d{2}T/m);
    expect(frontmatter).toContain("message_count: 2");
    expect(frontmatter.startsWith("---\n")).toBe(true);
    expect(frontmatter.endsWith("\n---")).toBe(true);
  });

  it("omits the topic line when unclassified", () => {
    const frontmatter = buildFrontmatter({
      conversation: conversation(),
      messages: [],
      sourceLabel: "Browser",
      projectLabel: "chatgpt.com",
    });
    expect(frontmatter).not.toContain("topic:");
  });
});

describe("astRootToMarkdown", () => {
  it("maps the simplified node set: headings/code/lists/math/table/quote", () => {
    const root: AstRoot = {
      type: "root",
      children: [
        { type: "h1", children: [{ type: "text", text: "标题" }] },
        {
          type: "p",
          children: [
            { type: "text", text: "普通 " },
            { type: "strong", children: [{ type: "text", text: "加粗" }] },
            { type: "text", text: " " },
            { type: "em", children: [{ type: "text", text: "斜体" }] },
            { type: "text", text: " " },
            { type: "code_inline", text: "x = 1" },
          ],
        },
        { type: "code_block", code: "const a = 1;", language: "ts" },
        {
          type: "ul",
          children: [
            {
              type: "li",
              children: [
                { type: "text", text: "一级" },
                {
                  type: "ul",
                  children: [{ type: "li", children: [{ type: "text", text: "二级" }] }],
                },
              ],
            },
          ],
        },
        { type: "ol", children: [{ type: "li", children: [{ type: "text", text: "第一步" }] }] },
        { type: "math", tex: "E = mc^2", display: true },
        { type: "math", tex: "a^2", display: false },
        {
          type: "table",
          kind: "legacy",
          headers: ["名称", "值"],
          rows: [["a", "1"]],
        },
        {
          type: "blockquote",
          children: [{ type: "p", children: [{ type: "text", text: "引用" }] }],
        },
        { type: "attachment", name: "报告.pdf", mime: "application/pdf" },
      ],
    };
    const markdown = astRootToMarkdown(root);
    expect(markdown).toContain("# 标题");
    expect(markdown).toContain("普通 **加粗** *斜体* `x = 1`");
    expect(markdown).toContain("```ts\nconst a = 1;\n```");
    expect(markdown).toContain("- 一级\n  - 二级");
    expect(markdown).toContain("1. 第一步");
    expect(markdown).toContain("$$\nE = mc^2\n$$");
    expect(markdown).toContain("$a^2$");
    expect(markdown).toContain("| 名称 | 值 |\n| --- | --- |\n| a | 1 |");
    expect(markdown).toContain("> 引用");
    expect(markdown).toContain("**附件：**报告.pdf (application/pdf)");
  });

  it("shifts message-internal headings so they nest under the role heading", () => {
    const root: AstRoot = {
      type: "root",
      children: [{ type: "h1", children: [{ type: "text", text: "内嵌标题" }] }],
    };
    expect(astRootToMarkdown(root, 3)).toBe("#### 内嵌标题");
  });
});

describe("serializeConversationMarkdown", () => {
  it("assembles frontmatter + title + meta + digest + role-sectioned messages", () => {
    const doc = serializeConversationMarkdown({
      conversation: conversation(),
      messages: [
        message({ role: "user", content_text: "请实现导出", created_at: 1_700_000_000_000 }),
        message({
          id: 2,
          role: "ai",
          content_text: "好的",
          created_at: 1_700_000_060_000,
          _tool_name: "read_file",
          _tool_input: "src/a.ts",
          citations: [{ label: "文档", href: "https://example.com", host: "example.com", sourceType: "inline_pill" }],
        }),
      ],
      sourceLabel: "Claude Code",
      projectLabel: "vesti-app",
      topicPath: "工程 / 导出",
      digest: { oneLiner: "讨论导出实现", keyTopics: ["导出"], decisions: ["用 Markdown"] },
      summary: null,
    });

    expect(doc.startsWith("---\n")).toBe(true);
    expect(doc).toContain("# 重构导出管线");
    expect(doc).toContain("> **来源：**Claude Code · **项目：**vesti-app");
    expect(doc).toContain("## 摘要");
    expect(doc).toContain("> 讨论导出实现");
    expect(doc).toContain("- **关键主题：**导出");
    expect(doc).toContain("- **关键决策：**用 Markdown");
    expect(doc).toContain("### 用户 · ");
    expect(doc).toContain("请实现导出");
    expect(doc).toContain("### AI · ");
    expect(doc).toContain("> **工具：**read_file");
    expect(doc).toContain("> **输入：**`src/a.ts`");
    expect(doc).toContain("**Sources**");
    expect(doc).toContain("- [文档](https://example.com) (example.com)");
    expect(doc.endsWith("\n")).toBe(true);
  });

  it("prefers content_ast over content_text for the message body", () => {
    const doc = serializeConversationMarkdown({
      conversation: conversation(),
      messages: [
        message({
          content_text: "plain fallback",
          content_ast: {
            type: "root",
            children: [
              { type: "code_block", code: "echo hi", language: "bash" },
            ],
          },
        }),
      ],
      sourceLabel: "Claude Code",
      projectLabel: "vesti-app",
    });
    expect(doc).toContain("```bash\necho hi\n```");
    expect(doc).not.toContain("plain fallback");
  });
});
