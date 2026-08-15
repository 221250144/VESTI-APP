// AITI local lightweight signals (本地轻量信号) — a deterministic, LLM-free
// complement to the structured-summary path in computeAiti.ts. It reads raw
// conversation messages (the rows VESTI already captures) and derives the
// same per-conversation feature shape computeAiti aggregates: active-hour
// distribution, question/statement ratio, maker/theorist cue counts, average
// question length & follow-up depth, spirited/cool cues, and recurring topic
// terms. Everything is keyword/punctuation/length based — no model, no
// network, no new extraction pipeline.
//
// When structured summaries are still below the full-profile threshold,
// computeAiti merges these feats in and marks the result `preliminary`
// (初步画像); once enough structured summaries exist the summary path takes
// over unchanged.
//
// Host contract: pass the conversations to count (filter archived/trash
// upstream), each with its messages oldest-first. Only `role: "user"`
// messages carry signal — the AI's style is not the user's fingerprint.
// Pure + DOM-free.

import type { AitiObsession } from "@vesti/ui";

/** Below these gates the local signals are too thin even for a 初步画像. */
export const AITI_LOCAL_MIN_CONVERSATIONS = 3;
export const AITI_LOCAL_MIN_USER_MESSAGES = 6;

/** Scan caps — cue/term extraction only reads the head of each message and
 * the first N user messages per conversation, so huge histories stay cheap. */
const MAX_USER_MESSAGES_PER_CONV = 100;
const SCAN_CHARS = 1500;
const MAX_TERMS_PER_CONV = 8;
const MAX_TOP_TERMS = 10;

export interface AitiLocalMessageInput {
  /** only "user" messages are analyzed; everything else is skipped */
  role: string;
  content: string;
  /** ms epoch; feeds the active-hour histogram */
  createdAt?: number;
}

export interface AitiLocalConversationInput {
  conversationId: number;
  /** ms epoch; used as the feat's createdAt for recency ordering */
  updatedAt?: number;
  messages: AitiLocalMessageInput[];
}

/** Structurally identical to the internal Feat in computeAiti.ts — keep the
 * fields in sync; computeAiti consumes these directly. */
export interface AitiLocalFeat {
  conversationId: number;
  createdAt: number;
  /** 0..100 toward the depth pole; null when there is nothing to judge */
  depth: number | null;
  maker: boolean;
  theorist: boolean;
  /** unresolved-thread proxy: open-ended question tail + single-shot asking */
  unresolved: number;
  /** 1 = spirited, -1 = cool, null = not enough text to tell */
  affect: 1 | -1 | null;
  terms: string[];
}

export interface AitiLocalSignals {
  /** conversations that carried at least one user message */
  conversationCount: number;
  userMessageCount: number;
  /** user messages that look like questions / all user messages */
  questionRatio: number;
  /** average characters per user message (follow-up length proxy) */
  avgUserChars: number;
  /** average user turns per conversation (追问深度 proxy) */
  avgUserTurns: number;
  /** 24-bucket histogram of user-message hours (local timezone) */
  activeHours: number[];
  /** recurring topic terms across ≥2 conversations */
  topTerms: AitiObsession[];
  feats: AitiLocalFeat[];
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
/** linear 0..100 scaling: v<=lo → 0, v>=hi → 100 */
const norm = (v: number, lo: number, hi: number) => clamp(((v - lo) / (hi - lo)) * 100);

// ---- cue tables (bilingual, lowercase-compared) -----------------------------

const QUESTION_CUES = [
  "为什么", "为何", "如何", "怎么", "怎样", "什么", "请问", "能否", "能不能", "是不是", "有没有",
];
const QUESTION_STARTERS_EN = /^(why|how|what|when|where|which|who|is|are|do|does|did|can|could|should|would)\b/;

const MAKER_CUES = [
  "```",
  "报错", "错误", "异常", "崩溃", "运行不了", "编译", "打包", "代码",
  "帮我写", "帮我改", "帮我做", "实现", "修复", "部署", "优化",
];
const MAKER_COMMAND_RE = /\b(npm|pnpm|yarn|git|pip|docker|kubectl|cargo|brew|curl|node)\s/i;
const MAKER_FILE_RE = /\b\w+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|sql|css|scss|html|json|ya?ml|toml|sh|vue|svelte)\b/i;
const MAKER_ERROR_RE = /\b(error|exception|traceback|failed|failure|bug|stack ?trace)\b/i;
const MAKER_VERB_RE = /\b(fix|implement|refactor|debug|deploy|build|optimize|rewrite|migrate|install)\b/i;

const THEORIST_CUES = [
  "为什么", "为何", "原理", "概念", "区别", "对比", "意义", "本质", "怎么看", "理解", "优缺点",
];
const THEORIST_EN_RE = /\b(why|principle|concept|theory|tradeoff|compare|comparison|meaning|understand|philosophy)\b/i;

const SPIRITED_CUES = [
  "太", "真的", "棒", "赞", "烦", "开心", "激动", "感谢", "谢谢", "离谱",
];
const SPIRITED_EN_RE = /\b(awesome|amazing|love|hate|fantastic|terrible|annoying|frustrated|exciting|excited|thanks|wow)\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

// ---- term extraction ---------------------------------------------------------

const LATIN_WORD_RE = /[a-zA-Z][a-zA-Z0-9+#._-]{2,29}/g;
const CJK_RUN_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]+/g;
/** CJK function/Question chars whose bigrams never name a topic. */
const CJK_STOP_CHARS = new Set([
  ..."的了着吗呢吧啊哦呀嘛哪这那你我他她它们是在就有都也而不没与及或且因为如果所以但是然后现在一个可以什为怎样请帮谢谢感谢",
]);
const LATIN_STOP_WORDS = new Set([
  "the", "and", "for", "you", "your", "this", "that", "these", "those", "with", "from",
  "have", "has", "what", "how", "why", "when", "where", "which", "who", "can", "could",
  "should", "would", "will", "are", "was", "were", "not", "but", "all", "any", "some",
  "please", "thanks", "thank", "yes", "okay", "use", "using", "get", "got", "make",
  "want", "need", "like", "just", "also", "too", "very", "much", "more", "now", "here",
  "there", "then", "than", "about", "into", "out", "off", "because", "while", "without",
  "does", "did", "its", "our", "they", "them", "their", "say", "says", "tell", "told",
]);

function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("?") || t.endsWith("？") || t.endsWith("吗") || t.endsWith("呢")) return true;
  if (QUESTION_STARTERS_EN.test(t)) return true;
  return QUESTION_CUES.some((cue) => t.includes(cue));
}

function countHits(text: string, re: RegExp, cues: string[]): number {
  let hits = re.test(text) ? 1 : 0;
  for (const cue of cues) if (text.includes(cue)) hits += 1;
  return hits;
}

/** Topic terms of one message: latin words (first-seen casing kept) plus CJK
 * runs ≤4 chars / char bigrams for longer runs, stop-filtered. Heuristic by
 * design — the preliminary badge covers the noise. */
function messageTerms(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LATIN_WORD_RE)) {
    const word = match[0];
    if (LATIN_STOP_WORDS.has(word.toLowerCase())) continue;
    out.push(word);
  }
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    if (run.length <= 4) {
      if (![...run].some((c) => CJK_STOP_CHARS.has(c))) out.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i += 1) {
        const bigram = run.slice(i, i + 2);
        if (![...bigram].some((c) => CJK_STOP_CHARS.has(c))) out.push(bigram);
      }
    }
  }
  return out;
}

function analyzeConversation(conv: AitiLocalConversationInput): AitiLocalFeat | null {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const userMessages = messages
    .filter((m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim())
    .slice(0, MAX_USER_MESSAGES_PER_CONV);
  if (userMessages.length === 0) return null;

  let totalChars = 0;
  let questions = 0;
  let makerHits = 0;
  let theoristHits = 0;
  let spiritedHits = 0;
  const termCounts = new Map<string, number>();

  for (const message of userMessages) {
    const text = message.content.trim();
    totalChars += Math.min(text.length, 8000);
    const head = text.slice(0, SCAN_CHARS);
    const lower = head.toLowerCase();
    if (isQuestion(head)) questions += 1;
    makerHits += countHits(lower, MAKER_COMMAND_RE, MAKER_CUES);
    makerHits += MAKER_FILE_RE.test(lower) || MAKER_ERROR_RE.test(lower) || MAKER_VERB_RE.test(lower) ? 1 : 0;
    theoristHits += countHits(lower, THEORIST_EN_RE, THEORIST_CUES);
    const exclamations = (head.match(/[!！]/g) ?? []).length;
    let spirited = exclamations + (EMOJI_RE.test(head) ? 1 : 0) + (SPIRITED_EN_RE.test(lower) ? 1 : 0);
    if (spirited === 0 && SPIRITED_CUES.some((cue) => head.includes(cue))) spirited = 1;
    spiritedHits += spirited;
    for (const term of messageTerms(head)) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }

  const userTurns = userMessages.length;
  const avgChars = totalChars / userTurns;
  const last = messages[messages.length - 1];
  const lastUser = userMessages[userMessages.length - 1];
  const openEndOnQuestion =
    Boolean(last && last.role === "user") && lastUser !== undefined && isQuestion(lastUser.content);

  const terms = Array.from(termCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TERMS_PER_CONV)
    .map(([term]) => term);

  return {
    conversationId: conv.conversationId,
    createdAt: typeof conv.updatedAt === "number" ? conv.updatedAt : 0,
    depth: Math.round(clamp(0.55 * norm(avgChars, 15, 320) + 0.45 * norm(userTurns, 1, 9))),
    maker: makerHits >= 1,
    theorist: theoristHits >= 1,
    unresolved:
      (openEndOnQuestion ? 2 : 0) + (userTurns <= 2 && questions / userTurns >= 0.5 ? 1 : 0),
    affect: spiritedHits >= 2 ? 1 : totalChars >= 80 ? -1 : null,
    terms,
  };
}

export function computeLocalSignals(
  conversations: readonly AitiLocalConversationInput[],
): AitiLocalSignals {
  const feats: AitiLocalFeat[] = [];
  const activeHours = new Array<number>(24).fill(0);
  let userMessageCount = 0;
  let questionCount = 0;
  let totalChars = 0;

  for (const conv of conversations) {
    if (!conv || typeof conv.conversationId !== "number") continue;
    const feat = analyzeConversation(conv);
    if (!feat) continue;
    feats.push(feat);

    const userMessages = conv.messages
      .filter((m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim())
      .slice(0, MAX_USER_MESSAGES_PER_CONV);
    userMessageCount += userMessages.length;
    for (const message of userMessages) {
      const text = message.content.trim();
      totalChars += Math.min(text.length, 8000);
      if (isQuestion(text.slice(0, SCAN_CHARS))) questionCount += 1;
      if (typeof message.createdAt === "number" && message.createdAt > 0) {
        activeHours[new Date(message.createdAt).getHours()] += 1;
      }
    }
  }

  // recurring terms across ≥2 conversations (same per-conversation dedupe the
  // summary-path obsessions use)
  const counts = new Map<string, { display: string; count: number }>();
  for (const feat of feats) {
    const seen = new Set<string>();
    for (const term of feat.terms) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { display: term, count: 1 });
    }
  }
  const topTerms = Array.from(counts.values())
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TOP_TERMS)
    .map((e) => ({ term: e.display, count: e.count }));

  const conversationCount = feats.length;
  return {
    conversationCount,
    userMessageCount,
    questionRatio: userMessageCount ? questionCount / userMessageCount : 0,
    avgUserChars: userMessageCount ? totalChars / userMessageCount : 0,
    avgUserTurns: conversationCount ? userMessageCount / conversationCount : 0,
    activeHours,
    topTerms,
    feats,
  };
}

/** True when the local signals are thick enough to back a preliminary profile. */
export function hasEnoughLocalSignals(signals: AitiLocalSignals | null | undefined): boolean {
  return Boolean(
    signals &&
      signals.conversationCount >= AITI_LOCAL_MIN_CONVERSATIONS &&
      signals.userMessageCount >= AITI_LOCAL_MIN_USER_MESSAGES,
  );
}
