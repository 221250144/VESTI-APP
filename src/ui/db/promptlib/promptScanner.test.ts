import { describe, expect, it } from "vitest";
import {
  deriveTemplateKey,
  scanUserPromptInputs,
  type PromptScanUserInput,
} from "./promptScanner";

function input(overrides: Partial<PromptScanUserInput> = {}): PromptScanUserInput {
  return {
    origin: "agent",
    conversationId: "session-1",
    conversationTitle: "重构会话",
    text: "请帮我重构下面的 TypeScript 函数，要求保持行为不变、补充类型标注，并解释每一处改动的原因。",
    ...overrides,
  };
}

describe("deriveTemplateKey", () => {
  it("normalizes {{variable}} fills to one shared key", () => {
    const a = deriveTemplateKey("请总结下面的会议记录：{{主题}}\n要求分点输出。");
    const b = deriveTemplateKey("请总结下面的会议记录：{{项目名}}\n要求分点输出。");
    expect(a).toBe(b);
  });

  it("normalizes [NAME] fills and casing/whitespace", () => {
    const a = deriveTemplateKey("Translate  the following text into English: [TEXT]");
    const b = deriveTemplateKey("translate the following text into english: [INPUT]");
    expect(a).toBe(b);
  });

  it("keeps unrelated prompts on distinct keys", () => {
    const a = deriveTemplateKey("请帮我重构下面的 TypeScript 函数，要求保持行为不变。");
    const b = deriveTemplateKey("把下面这篇文章润色成更正式的商务邮件风格。");
    expect(a).not.toBe(b);
  });

  it("truncates to the shared opening prefix", () => {
    const key = deriveTemplateKey("a".repeat(200), 40);
    expect(key.length).toBeLessThanOrEqual(40);
  });
});

describe("scanUserPromptInputs", () => {
  it("drops trivial, short and non-instruction turns", () => {
    const clusters = scanUserPromptInputs([
      input({ text: "好的" }),
      input({ text: "ok" }),
      input({ text: "短" }),
      input({ text: "这个函数为什么会报错呢？" }),
    ]);
    expect(clusters).toEqual([]);
  });

  it("counts exact repeats and tracks distinct conversations", () => {
    const text = input().text;
    const clusters = scanUserPromptInputs([
      input({ conversationId: "s1", text }),
      input({ conversationId: "s2", text }),
      input({ conversationId: "s2", text }), // repeat inside one conversation
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(3);
    expect(clusters[0].sourceCount).toBe(2);
    expect(clusters[0].sources.map((source) => source.conversationId).sort()).toEqual(["s1", "s2"]);
  });

  it("ignores casing/whitespace-only differences when counting repeats", () => {
    const base = input().text;
    const clusters = scanUserPromptInputs([
      input({ conversationId: "s1", text: base }),
      input({ conversationId: "s2", text: `${base.toUpperCase()}   ` }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].sourceCount).toBe(2);
  });

  it("merges template variants that only differ in {{variable}} fills", () => {
    const clusters = scanUserPromptInputs([
      input({ conversationId: "s1", text: "请总结下面的会议记录：{{主题}}\n要求：分点输出，控制在 200 字以内。" }),
      input({ conversationId: "s2", text: "请总结下面的会议记录：{{项目名}}\n要求：分点输出，控制在 200 字以内。" }),
      input({ conversationId: "s3", text: "请总结下面的会议记录：{{客户}}\n要求：分点输出，控制在 200 字以内。" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(3);
    expect(clusters[0].sourceCount).toBe(3);
  });

  it("merges prompts sharing the same opening across conversations", () => {
    // The shared opening must cover the whole template prefix (40 chars).
    const opening = "你是一名资深前端工程师，请审查下面给你的 React 组件代码，逐条指出问题并给出修改建议";
    const clusters = scanUserPromptInputs([
      input({ conversationId: "s1", text: `${opening}，重点关注性能问题与重复渲染。` }),
      input({ conversationId: "s2", text: `${opening}，重点关注可访问性与键盘交互。` }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceCount).toBe(2);
  });

  it("picks the highest-scoring variant as the representative body", () => {
    const opening = "你是一名资深技术编辑，请把下面给你的文章草稿润色成可以直接发布的正式文章，保持客观专业的语气";
    const rich = `${opening}。\n要求：\n1. 保持原意\n2. 删除口语表达\n3. 输出为 Markdown 格式`;
    const plain = `${opening}，让它读起来更顺一些。`;
    const clusters = scanUserPromptInputs([
      input({ conversationId: "s1", text: plain }),
      input({ conversationId: "s2", text: rich }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].body).toBe(rich);
    expect(clusters[0].title.length).toBeLessThanOrEqual(48);
  });

  it("ranks cross-conversation patterns above single-conversation ones", () => {
    const recurring = "请帮我分析下面这段日志的报错原因，按可能性列出三条并给出排查步骤。";
    const oneOff = "请帮我设计一个支持水平扩展的消息队列架构，要求给出组件图和选型理由。";
    const clusters = scanUserPromptInputs([
      input({ conversationId: "s1", text: recurring }),
      input({ conversationId: "s2", text: recurring }),
      input({ conversationId: "s3", text: oneOff }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].body).toBe(recurring);
    expect(clusters[0].sourceCount).toBe(2);
    expect(clusters[1].sourceCount).toBe(1);
  });

  it("keeps browser and agent origins in the source refs", () => {
    const text = input().text;
    const clusters = scanUserPromptInputs([
      input({ origin: "agent", conversationId: "cli-1", text }),
      input({ origin: "browser", conversationId: "42", conversationTitle: "网页会话", text }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceCount).toBe(2);
    expect(clusters[0].sources.map((source) => source.origin).sort()).toEqual(["agent", "browser"]);
  });

  it("caps sources per cluster and results overall", () => {
    const text = input().text;
    const many = Array.from({ length: 12 }, (_, index) =>
      input({ conversationId: `s${index}`, text }));
    const clusters = scanUserPromptInputs(many, { maxSourcesPerCluster: 5 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sources).toHaveLength(5);
    expect(clusters[0].sourceCount).toBe(12);

    const distinct = Array.from({ length: 8 }, (_, index) =>
      input({ conversationId: `s${index}`, text: `请帮我完成第 ${index + 1} 项完全不同的重构任务，要求附上完整的测试用例与说明。` }));
    const capped = scanUserPromptInputs(distinct, { maxResults: 3 });
    expect(capped).toHaveLength(3);
  });

  it("honors custom minScore/minLength thresholds", () => {
    const text = input().text;
    expect(scanUserPromptInputs([input({ text })], { minScore: 1 })).toEqual([]);
    expect(scanUserPromptInputs([input({ text })], { minLength: 10_000 })).toEqual([]);
  });
});
