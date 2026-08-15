import { describe, expect, it } from "vitest";
import type { ExploreMessage } from "../../types";
import {
  COMPANION_MEMORY_SCOPE_PREF_KEY,
  COMPANION_PERSONA_PREF_KEY,
  companionErrorFrom,
  loadCompanionPreferences,
  normalizeCompanionMemoryScope,
  normalizeCompanionMood,
  normalizeCompanionPersona,
  saveCompanionPreference,
  streamDisplayBody,
  stripCompanionMoodLine,
  toCompanionMessageView,
  toCompanionSessionPreview,
} from "./companionView";

function assistantMessage(overrides: Partial<ExploreMessage> = {}): ExploreMessage {
  return {
    id: "msg_1",
    sessionId: "sess_1",
    role: "assistant",
    content: "warm\n今晚的风很温柔。",
    timestamp: 1000,
    ...overrides,
  };
}

describe("stripCompanionMoodLine", () => {
  it("strips a leading mood id line", () => {
    expect(stripCompanionMoodLine("calm\n你好呀。")).toBe("你好呀。");
    expect(stripCompanionMoodLine("delighted\n第一行\n第二行")).toBe("第一行\n第二行");
  });

  it("returns content unchanged when there is no mood line", () => {
    expect(stripCompanionMoodLine("普通 Markdown **回答**")).toBe("普通 Markdown **回答**");
    expect(stripCompanionMoodLine("第一行\ncalm 不在句首不算")).toBe("第一行\ncalm 不在句首不算");
  });

  it("treats mood-only content as an empty body", () => {
    expect(stripCompanionMoodLine("sleepy")).toBe("");
  });

  it("handles empty and whitespace input", () => {
    expect(stripCompanionMoodLine("")).toBe("");
    expect(stripCompanionMoodLine("calm\n\n正文")).toBe("正文");
  });
});

describe("normalizers", () => {
  it("normalizeCompanionMood accepts the six moods, else calm", () => {
    for (const mood of ["calm", "thinking", "delighted", "spark", "sleepy", "warm"] as const) {
      expect(normalizeCompanionMood(mood)).toBe(mood);
    }
    expect(normalizeCompanionMood("angry")).toBe("calm");
    expect(normalizeCompanionMood(undefined)).toBe("calm");
    expect(normalizeCompanionMood(42)).toBe("calm");
  });

  it("normalizeCompanionPersona falls back to listener", () => {
    expect(normalizeCompanionPersona("creator")).toBe("creator");
    expect(normalizeCompanionPersona("listener")).toBe("listener");
    expect(normalizeCompanionPersona("poet")).toBe("listener");
    expect(normalizeCompanionPersona(null)).toBe("listener");
  });

  it("normalizeCompanionMemoryScope falls back to full", () => {
    expect(normalizeCompanionMemoryScope("memory")).toBe("memory");
    expect(normalizeCompanionMemoryScope("chat")).toBe("chat");
    expect(normalizeCompanionMemoryScope("everything")).toBe("full");
    expect(normalizeCompanionMemoryScope(undefined)).toBe("full");
  });
});

describe("toCompanionMessageView", () => {
  it("passes user messages through untouched", () => {
    const view = toCompanionMessageView({
      id: "u1",
      sessionId: "s1",
      role: "user",
      content: "calm\n这是用户原话，不剥",
      timestamp: 5,
    });
    expect(view.role).toBe("user");
    expect(view.body).toBe("calm\n这是用户原话，不剥");
    expect(view.mood).toBe("calm");
  });

  it("assistant: mood comes from agentMeta and the tag line is stripped", () => {
    const view = toCompanionMessageView(
      assistantMessage({
        agentMeta: { mode: "agent", toolCalls: [], mood: "spark", persona: "creator" },
      }),
    );
    expect(view.body).toBe("今晚的风很温柔。");
    expect(view.mood).toBe("spark");
    expect(view.persona).toBe("creator");
  });

  it("assistant: an invalid agentMeta mood degrades to calm", () => {
    const view = toCompanionMessageView(
      assistantMessage({
        agentMeta: { mode: "agent", toolCalls: [], mood: "furious" as never },
      }),
    );
    expect(view.mood).toBe("calm");
  });

  it("assistant: without agentMeta the mood is sniffed from the first line", () => {
    const view = toCompanionMessageView(assistantMessage());
    expect(view.body).toBe("今晚的风很温柔。");
    expect(view.mood).toBe("warm");
  });

  it("assistant: legacy messages without a mood line render whole with calm", () => {
    const view = toCompanionMessageView(
      assistantMessage({ content: "旧的 agent 回答，没有 mood 行。" }),
    );
    expect(view.body).toBe("旧的 agent 回答，没有 mood 行。");
    expect(view.mood).toBe("calm");
  });

  it("carries recall sources through", () => {
    const sources = [{ id: 1, title: "旧会话", platform: "Kimi" as const, similarity: 0.8 }];
    const view = toCompanionMessageView(assistantMessage({ sources }));
    expect(view.sources).toEqual(sources);
  });
});

describe("toCompanionSessionPreview", () => {
  it("strips the mood line leaking into stored previews", () => {
    expect(toCompanionSessionPreview("warm\n今晚的风很温柔。")).toBe("今晚的风很温柔。");
  });

  it("leaves ordinary previews alone", () => {
    expect(toCompanionSessionPreview("普通的会话预览")).toBe("普通的会话预览");
  });
});

describe("companion ui-preferences", () => {
  it("loads defaults when the host has no pref bridge", async () => {
    await expect(loadCompanionPreferences({})).resolves.toEqual({
      persona: "listener",
      memoryScope: "full",
    });
  });

  it("loads and normalizes stored values", async () => {
    const stored: Record<string, unknown> = {
      [COMPANION_PERSONA_PREF_KEY]: "creator",
      [COMPANION_MEMORY_SCOPE_PREF_KEY]: "memory",
    };
    const prefs = await loadCompanionPreferences({
      getUiPreference: async (key) => stored[key] ?? null,
    });
    expect(prefs).toEqual({ persona: "creator", memoryScope: "memory" });
  });

  it("invalid stored values fall back to defaults", async () => {
    const prefs = await loadCompanionPreferences({
      getUiPreference: async () => "nonsense",
    });
    expect(prefs).toEqual({ persona: "listener", memoryScope: "full" });
  });

  it("a failing read falls back to defaults instead of throwing", async () => {
    const prefs = await loadCompanionPreferences({
      getUiPreference: async () => {
        throw new Error("bridge down");
      },
    });
    expect(prefs).toEqual({ persona: "listener", memoryScope: "full" });
  });

  it("persists a switch under its pref key", async () => {
    const writes: Array<[string, unknown]> = [];
    await saveCompanionPreference(
      {
        setUiPreference: async (key, value) => {
          writes.push([key, value]);
        },
      },
      COMPANION_PERSONA_PREF_KEY,
      "creator",
    );
    expect(writes).toEqual([[COMPANION_PERSONA_PREF_KEY, "creator"]]);
  });

  it("persist tolerates a missing bridge and write failures", async () => {
    await expect(saveCompanionPreference({}, COMPANION_MEMORY_SCOPE_PREF_KEY, "chat")).resolves.toBeUndefined();
    await expect(
      saveCompanionPreference(
        {
          setUiPreference: async () => {
            throw new Error("disk full");
          },
        },
        COMPANION_MEMORY_SCOPE_PREF_KEY,
        "chat",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("streamDisplayBody", () => {
  it("hides a completed [mood:xxx] tag line and keeps the body", () => {
    expect(streamDisplayBody("[mood:calm]\n你好呀。")).toBe("你好呀。");
    expect(streamDisplayBody("【mood: warm】\n第一行\n第二行")).toBe("第一行\n第二行");
  });

  it("hides a bare mood id line too (contract-shaped streams)", () => {
    expect(streamDisplayBody("calm\n正文")).toBe("正文");
  });

  it("shows nothing while only a partial tag line has arrived", () => {
    expect(streamDisplayBody("")).toBe("");
    expect(streamDisplayBody("[")).toBe("");
    expect(streamDisplayBody("[mood:ca")).toBe("");
    expect(streamDisplayBody("cal")).toBe("");
  });

  it("shows ordinary first lines immediately (no false positives)", () => {
    expect(streamDisplayBody("这")).toBe("这");
    expect(streamDisplayBody("好的，我们来")).toBe("好的，我们来");
    expect(streamDisplayBody("mood 不是标签的时候")).toBe("mood 不是标签的时候");
  });

  it("keeps content unchanged when the first line is not a tag", () => {
    expect(streamDisplayBody("先回答问题\ncalm 在第二行不算")).toBe("先回答问题\ncalm 在第二行不算");
  });
});

describe("companionErrorFrom", () => {
  it("prefers the structured category the host stamps on the error", () => {
    expect(
      companionErrorFrom(Object.assign(new Error("HTTP 401"), { category: "auth" })),
    ).toEqual({ category: "auth", message: "HTTP 401" });
    expect(
      companionErrorFrom(Object.assign(new Error("积分用完"), { category: "credits" })).category,
    ).toBe("credits");
  });

  it("recognizes the lost-session error by name", () => {
    const err = Object.assign(new Error("这场夜话已经不在了"), { name: "CompanionSessionLostError" });
    expect(companionErrorFrom(err).category).toBe("session-lost");
  });

  it("ignores a bogus category and falls back to message markers", () => {
    expect(
      companionErrorFrom(Object.assign(new Error("[CREDITS_EXHAUSTED] 用完"), { category: "bogus" })).category,
    ).toBe("credits");
    expect(companionErrorFrom(new Error("无法连接模型服务：fetch failed")).category).toBe("network");
    expect(companionErrorFrom(new Error("The operation timed out.")).category).toBe("network");
    expect(companionErrorFrom(new Error("请先在设置中填写 API Key")).category).toBe("auth");
  });

  it("degrades anything else to unknown without throwing", () => {
    expect(companionErrorFrom(new Error("dexie exploded")).category).toBe("unknown");
    expect(companionErrorFrom(undefined)).toEqual({ category: "unknown", message: "" });
    expect(companionErrorFrom(null).category).toBe("unknown");
  });
});
