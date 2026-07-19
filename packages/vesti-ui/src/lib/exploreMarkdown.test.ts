import { describe, expect, it } from "vitest";
import type { AitiProfile, DashboardLabels } from "../types";
import { buildAitiMarkdown } from "./exploreMarkdown";

const labels = {
  title: "你的 AITI",
  strengthsTitle: "你的思维优势",
  empoweringIntro: "这些思维力量格外闪光：",
  obsessionsTitle: "你长期深耕的领域",
  sample: "来自你的 {n} 段对话",
  personaNoteLabel: "近期注脚",
  axisDepthLeftStrength: "广",
  axisDepthRightStrength: "深",
  axisMakerLeftStrength: "理论",
  axisMakerRightStrength: "实践",
  axisFocusLeftStrength: "收敛",
  axisFocusRightStrength: "发散",
  axisAffectLeftStrength: "沉静",
  axisAffectRightStrength: "热忱",
} as DashboardLabels["aiti"];

const profile: AitiProfile = {
  available: true,
  sampleSize: 12,
  axes: [
    { key: "depth", score: 90, evidenceConversationIds: [1], hasSignal: true },
    { key: "maker", score: 80, evidenceConversationIds: [2], hasSignal: true },
    { key: "focus", score: 85, evidenceConversationIds: [3], hasSignal: true },
    { key: "affect", score: 75, evidenceConversationIds: [4], hasSignal: true },
  ],
  obsessions: [
    { term: "向量检索", count: 4 },
    { term: "本地优先", count: 3 },
  ],
};

describe("buildAitiMarkdown (P5 思维意象)", () => {
  it("keeps the pre-P5 shape when no extras are passed", () => {
    const md = buildAitiMarkdown(profile, labels);
    expect(md).toContain("# 你的 AITI");
    expect(md).toContain("## 你的思维优势");
    expect(md).toContain("- 向量检索 (×4)");
    expect(md).toContain("来自你的 12 段对话");
    expect(md).not.toContain("近期注脚");
  });

  it("adds the imagery name/code, verdict quote, origin and persona footnote", () => {
    const md = buildAitiMarkdown(profile, labels, {
      imagery: {
        name: "马孔多的蝴蝶",
        code: "qTWS",
        origin: "《百年孤独》",
        verdict: "黄色的蝴蝶成群而至——被纷飞的灵感环绕，所到之处皆绚烂",
      },
      personaNote: "蝴蝶最近总绕着向量检索飞。",
    });
    expect(md).toContain("## 马孔多的蝴蝶 · qTWS");
    expect(md).toContain("> 黄色的蝴蝶成群而至");
    expect(md).toContain("_《百年孤独》_");
    expect(md).toContain("**近期注脚**：蝴蝶最近总绕着向量检索飞。");
    // The classic sections survive below the imagery block.
    expect(md).toContain("## 你的思维优势");
    expect(md.indexOf("马孔多的蝴蝶")).toBeLessThan(md.indexOf("你的思维优势"));
  });

  it("omits the footnote line when the persona note is blank", () => {
    const md = buildAitiMarkdown(profile, labels, {
      imagery: { name: "N", code: "DMWS", origin: "O", verdict: "V" },
      personaNote: "   ",
    });
    expect(md).not.toContain("近期注脚");
  });
});
