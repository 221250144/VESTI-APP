import type { UiThemeMode } from "../../types";

/**
 * 情绪颜色分桶（Conversation Sphere, docs/conversation-sphere-design.md §4.3）。
 *
 * `emotional_tone` 是 ChatSummaryData.meta_observations 里的自由文本（中英
 * 皆有可能；2026-08 起定义为"用户在对话中的情绪状态"，见 §4.3 语义变更
 * 说明），这里用显式关键词表把它分桶到 7 个情绪家族。前 5 个与夜话猫头鹰
 * mood 同族同色系；grief（悲伤）与 strained（紧绷：焦虑/疲惫/挫败）是
 * 为用户情绪足迹新增的两个负面情绪家族——负面情绪是 AI 对话的高频基调，
 * 不应共用一个垃圾桶。匹配不到、空文本或无摘要（undefined）→ null，由
 * `getEmotionColor` 落成中性灰白"背景星"。
 *
 * 纯函数、确定性：同一文本必同家族。表顺序即优先级——一段文本命中多个
 * 家族时排在前面的家族胜出（具体、强信号的词在前；grief 先于 strained，
 * 明确的悲伤优先于泛化的紧绷；最泛化的 thinking 兜底）。拉丁词用单词边
 * 界匹配（避免 "follow" 误中 "low"），中文词用普通子串匹配。
 */

export type EmotionFamily =
  | "calm"
  | "thinking"
  | "delighted"
  | "spark"
  | "grief"
  | "strained"
  | "warm";

interface EmotionKeywordSet {
  family: EmotionFamily;
  /** Latin-script keywords matched with \b word boundaries, case-insensitive. */
  latin: RegExp;
  /** CJK keywords matched as plain substrings. */
  cjk: string[];
}

const EMOTION_KEYWORD_TABLE: ReadonlyArray<EmotionKeywordSet> = [
  {
    // 顿悟时刻：信号最强，最先匹配
    family: "spark",
    latin: /\b(inspired?|inspiration|spark|breakthrough|eureka|aha|insight(?:ful)?|surprised?|amazed?|amazing|wow)\b/i,
    cjk: ["灵感", "惊喜", "突破", "顿悟", "启发", "灵光", "惊叹", "恍然大悟", "开窍"],
  },
  {
    // 被接住的感觉：感激、治愈、释然、被理解
    family: "warm",
    latin: /\b(warm|grateful|thankful|healing|comfort(?:ed|ing)?|touched|moved|appreciat\w*|supported?|reassured?|relieved)\b/i,
    cjk: ["温暖", "感激", "感恩", "治愈", "温馨", "感动", "释然", "安慰", "被理解", "被支持", "踏实"],
  },
  {
    // 正向高唤醒：开心、满足、成就感
    family: "delighted",
    latin: /\b(happy|happiness|excited?|delighted?|joy(?:ful)?|cheerful|glad|thrilled|satisfied|proud|accomplish\w*)\b/i,
    cjk: ["开心", "兴奋", "愉悦", "快乐", "高兴", "欢乐", "欣喜", "满足", "成就感", "自豪", "爽快", "畅快"],
  },
  {
    // 悲伤与丧失：先于 strained，明确的悲伤优先于泛化的紧绷
    family: "grief",
    latin: /\b(sad|sadness|sorrow\w*|heartbrok\w*|heartache|grie\w+|mourn\w*|melanchol\w*|dejected|downcast|tear\w*|crying|lonel\w+|homesick|depressed?|despair|hopeless)\b/i,
    cjk: ["悲伤", "伤心", "难过", "伤感", "哀伤", "心碎", "心酸", "忧郁", "忧伤", "抑郁", "孤独", "寂寞", "失落", "空虚", "想哭", "落泪", "绝望", "压抑", "沉重", "好丧", "很丧", "emo"],
  },
  {
    // 紧绷：焦虑、挫败、疲惫——AI 对话最高频的负向基调
    family: "strained",
    latin: /\b(anxi\w+|worried?|nervous|tense|stress\w*|pressure|overwhelm\w*|frustrat\w*|annoy\w+|irritat\w*|angry|anger|stuck|confus\w+|panic|restless|helpless|tired|exhausted?|sleepy|weary|drained?|burnout|burned\s?out|bored?|down|low|upset)\b/i,
    cjk: ["焦虑", "紧张", "担心", "担忧", "不安", "压力", "紧绷", "烦躁", "挫败", "沮丧", "泄气", "崩溃", "疲惫", "疲倦", "倦怠", "困倦", "无力", "无助", "累", "迷茫", "困惑", "卡住", "卡壳", "无从下手", "生气", "愤怒", "无聊", "厌烦"],
  },
  {
    family: "calm",
    latin: /\b(calm|relax\w*|peaceful|serene|tranquil|content|soothed?|steady|at\s?ease)\b/i,
    cjk: ["平静", "放松", "冷静", "安宁", "平和", "舒缓", "宁静", "松弛", "安心", "淡定"],
  },
  {
    // 认知基调兜底：沉思、专注、好奇
    family: "thinking",
    latin: /\b(thoughtful|focus(?:ed)?|analytical?|contemplative|reflective|curious|pensive|ponder\w*)\b/i,
    cjk: ["沉思", "专注", "分析", "思考", "深入", "理性", "好奇", "探索", "琢磨", "复盘"],
  },
];

/**
 * Bucket a free-text emotional tone into one of the 6 families.
 * Returns null for no-match / empty / missing tones (neutral background star).
 */
export function getEmotionFamily(tone: string | null | undefined): EmotionFamily | null {
  if (!tone) return null;
  const text = tone.trim().toLowerCase();
  if (!text) return null;
  for (const set of EMOTION_KEYWORD_TABLE) {
    if (set.latin.test(text)) return set.family;
    if (set.cjk.some((word) => text.includes(word))) return set.family;
  }
  return null;
}

/** Ordered family list (legend order). Matching priority is the keyword-table
 * order above, NOT this list. */
export const EMOTION_FAMILIES: ReadonlyArray<EmotionFamily> = [
  "calm",
  "thinking",
  "delighted",
  "spark",
  "grief",
  "strained",
  "warm",
];

/** English display names — legend default labels (hosts can override later). */
export const EMOTION_FAMILY_LABELS: Record<EmotionFamily, string> = {
  calm: "Calm",
  thinking: "Thinking",
  delighted: "Delighted",
  spark: "Spark",
  grief: "Grief",
  strained: "Strained",
  warm: "Warm",
};

/** 双主题色值：暗色主题星点用明亮色（深空上发光），亮色主题用饱和度适
 * 中的深色（纸面上可读），与 GROUP_PALETTE / getGraphLabelFill 的双主题
 * 写法一致。2026-08：整体饱和度提高 ~28%（HSL S×1.28，grief 仅 ×1.12）——
 * 高饱和"有故事的星"与低饱和恒星光谱色（stellarColors）拉开层级。 */
const EMOTION_COLORS: Record<EmotionFamily, Record<UiThemeMode, string>> = {
  calm: { light: "#2E7DB7", dark: "#70B9F7" },
  thinking: { light: "#6552AF", dark: "#9F90F7" },
  delighted: { light: "#CD930A", dark: "#FFCF4B" },
  spark: { light: "#0099B1", dark: "#4AECFB" },
  // grief：冷调灰蓝，刻意维持相对低饱和（悲伤的距离感）；2026-08 整体提
  // 饱和时仅小幅提升，与 calm 的亮蓝保持区分
  grief: { light: "#576A88", dark: "#89A2C6" },
  // strained：赭红，暗色主题下偏粉（与 warm 的橙用明度区分）
  strained: { light: "#B23D30", dark: "#ED8167" },
  warm: { light: "#D4521A", dark: "#FF925B" },
};

/** 中性灰白兜底：无摘要 / 匹配失败时的保底色。2026-08 起 renderer 的未摘要
 * 节点走 stellarColors 恒星光谱色（最近活跃时间 → 温度），此色仅为防御性
 * 兜底（如数据缺 lastCapturedAt 的极端情况）。 */
const NEUTRAL_STAR_COLORS: Record<UiThemeMode, string> = {
  light: "#9A9890",
  dark: "#B8B6AE",
};

/** Color for one star; `null` family = neutral grey-white background star. */
export function getEmotionColor(
  family: EmotionFamily | null,
  themeMode: UiThemeMode
): string {
  return (family ? EMOTION_COLORS[family] : NEUTRAL_STAR_COLORS)[themeMode];
}
