// 路线级 LLM 合成 (Learn route synthesis) — one LLM pass per learning route,
// turning the deterministic computeLearn V3 label ("Kimi · 综合探索") into a
// real summary: a full-sentence outcome-oriented title, a short
// interpretation and concrete next steps. Mirrors learnDeepen: everything
// here is pure/deterministic and covered by vitest; the agent call itself
// stays in the storage layer (desktopStorage.runLearnSynthesis), injected as
// a `runner`, and persistence is injected as a `store` (ui-prefs in
// production, in-memory in tests).
//
// Caching: the route fingerprint (member conversation id set hash, see
// vesti-ui lib/learnSynthesis) keys the cache. An unchanged fingerprint
// never re-runs; when routes shift, only the changed routes synthesize.
// Synthesis entries are language-tagged — a language switch re-synthesizes,
// switching back reuses the earlier entries.

import type { LearnDomain, LearnRouteSynthesis } from "@vesti/ui";
import { learnRouteFingerprint } from "@vesti/ui";

/** Title quality bar: an empty or overlong (keyword-stuffed) title loses to
 * the deterministic route label — the parse returns null and the route falls
 * back. */
export const LEARN_SYNTHESIS_TITLE_MAX_CHARS = 60;
export const LEARN_SYNTHESIS_SUMMARY_MAX_CHARS = 500;
export const LEARN_SYNTHESIS_MAX_NEXT_STEPS = 3;
export const LEARN_SYNTHESIS_STEP_MAX_CHARS = 140;
/** Cap on grounding session lines in the transcript (representatives first,
 * then further members that have a digest one-liner). */
const MAX_CONTEXT_SESSIONS = 6;

export type LearnSynthesisLang = "zh" | "en";

export interface LearnSynthesisTranscriptInput {
  domain: LearnDomain;
  /** conversationId → digest one-liner (existing digest data — no long
   * transcript pulls). */
  digestByConversationId?: ReadonlyMap<number, string>;
  lang: LearnSynthesisLang;
}

/** Session lines grounding the synthesis: the route's representative
 * conversations (title + digest when available), then extra members that
 * have a digest one-liner, capped. */
function contextSessionLines(
  domain: LearnDomain,
  digestByConversationId: ReadonlyMap<number, string> | undefined,
  lang: LearnSynthesisLang,
): string[] {
  const lines: string[] = [];
  const seen = new Set<number>();
  for (const rep of domain.representatives) {
    if (lines.length >= MAX_CONTEXT_SESSIONS) break;
    seen.add(rep.conversationId);
    const oneLiner = digestByConversationId?.get(rep.conversationId)?.trim();
    lines.push(oneLiner ? `- ${rep.title} — ${oneLiner}` : `- ${rep.title}`);
  }
  for (const id of domain.memberIds ?? []) {
    if (lines.length >= MAX_CONTEXT_SESSIONS) break;
    if (seen.has(id)) continue;
    const oneLiner = digestByConversationId?.get(id)?.trim();
    if (!oneLiner) continue;
    lines.push(lang === "zh" ? `- （其他会话）${oneLiner}` : `- (other session) ${oneLiner}`);
  }
  return lines;
}

/**
 * Compose the transcriptOverride for the 'learn-synthesis' run: the route's
 * deterministic label, its local stats, platform / project context, the
 * grounding session lines, the open question, and a strict-JSON output
 * contract (title / summary / next_steps). The caller validates the JSON
 * (parseLearnSynthesis) and falls back to the deterministic label on null.
 */
export function buildLearnSynthesisTranscript({
  domain,
  digestByConversationId,
  lang,
}: LearnSynthesisTranscriptInput): string {
  const sessions = contextSessionLines(domain, digestByConversationId, lang);
  const platforms = (domain.platforms ?? []).filter(Boolean);
  const projects = (domain.projects ?? []).filter(Boolean);
  const openQuestion = domain.openQuestion?.text.trim();
  if (lang === "zh") {
    return [
      `学习路线：${domain.name}`,
      ...(platforms.length > 0 ? [`来源平台：${platforms.join("、")}`] : []),
      ...(projects.length > 0 ? [`涉及项目：${projects.join("、")}`] : []),
      "",
      `本地统计：该路线共 ${domain.count} 段对话；其中深入 ${domain.deep} 段、适中 ${domain.moderate} 段、浅层 ${domain.superficial} 段；近 30 天活跃 ${domain.recent30 ?? 0} 段。`,
      ...(sessions.length > 0 ? ["", "最能代表这条路线的会话：", ...sessions] : []),
      ...(openQuestion ? ["", `该路线还没收尾的问题：${openQuestion}`] : []),
      "",
      "请为这条学习路线生成一段「路线解读」，输出一个 JSON 对象（不要 Markdown 代码围栏、不要任何额外文字），字段如下：",
      '{"title": "完整句子的路线标题（动词/成果导向，概括这条路线在做什么或做成了什么，例如「用 RAG 重构了桌面端记忆召回」，不要关键词堆砌，不超过 30 字）", "summary": "2-4 句综合解读：这个领域你在做什么、进展到哪一步、知识结构是怎样的", "next_steps": ["具体的下一步建议，1-3 条"]}',
      "要求：只依据上面给出的信息做概括，不编造资料中没有的具体事实；title 必须是一个完整的句子而不是话题名；没有合适内容时 next_steps 给空数组；只输出 JSON 本身。",
    ].join("\n");
  }
  return [
    `Learning route: ${domain.name}`,
    ...(platforms.length > 0 ? [`Source platforms: ${platforms.join(", ")}`] : []),
    ...(projects.length > 0 ? [`Projects involved: ${projects.join(", ")}`] : []),
    "",
    `Local stats: ${domain.count} conversations on this route — ${domain.deep} deep, ${domain.moderate} moderate, ${domain.superficial} superficial; ${domain.recent30 ?? 0} active in the last 30 days.`,
    ...(sessions.length > 0 ? ["", "The sessions that best represent this route:", ...sessions] : []),
    ...(openQuestion ? ["", `The route's still-open question: ${openQuestion}`] : []),
    "",
    "Write a reading of this learning route and output one JSON object (no Markdown fences, no extra text) with these fields:",
    '{"title": "a full-sentence, outcome-oriented route title (what the learner is doing or has achieved, e.g. "Rebuilt desktop memory recall with RAG" — not a keyword pile, <= 60 chars)", "summary": "a 2-4 sentence interpretation: what is being pursued here, how far it has progressed, how the pieces fit together", "next_steps": ["1-3 concrete next steps"]}',
    "Rules: base everything on the information above — invent no concrete facts beyond it; the title must be a complete sentence, not a topic name; use an empty array for next_steps when nothing sensible applies; output JSON only.",
  ].join("\n");
}

export interface LearnSynthesisOutput {
  title: string;
  summary: string;
  nextSteps: string[];
}

/**
 * Lenient parse of the model's JSON with the title quality bar: tolerates
 * code fences and leading/trailing prose; returns null when the title is
 * empty/overlong or the summary is missing — the caller then keeps the
 * deterministic route label (zero-regression fallback).
 */
export function parseLearnSynthesis(raw: string): LearnSynthesisOutput | null {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const title =
      typeof parsed.title === "string" ? parsed.title.replace(/\s+/g, " ").trim() : "";
    if (!title || title.length > LEARN_SYNTHESIS_TITLE_MAX_CHARS) return null;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) return null;
    const nextSteps = Array.isArray(parsed.next_steps)
      ? (parsed.next_steps as unknown[])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, LEARN_SYNTHESIS_MAX_NEXT_STEPS)
          .map((item) => item.slice(0, LEARN_SYNTHESIS_STEP_MAX_CHARS))
      : [];
    return { title, summary: summary.slice(0, LEARN_SYNTHESIS_SUMMARY_MAX_CHARS), nextSteps };
  } catch {
    return null;
  }
}

// ---- Orchestration + cache -------------------------------------------------

/** Cache persistence for synthesis entries, keyed by route fingerprint. */
export interface LearnSynthesisStore {
  read(): Promise<Record<string, LearnRouteSynthesis>>;
  write(cache: Record<string, LearnRouteSynthesis>): Promise<void>;
}

/** The agent call, injected by the storage layer: one route → raw model
 * output. Throws on failure — the route then keeps its deterministic label. */
export type LearnSynthesisRunner = (
  domain: LearnDomain,
  transcript: string,
) => Promise<string>;

export interface SynthesizeLearnRoutesOptions {
  lang: LearnSynthesisLang;
  runner: LearnSynthesisRunner;
  store: LearnSynthesisStore;
  digestByConversationId?: ReadonlyMap<number, string>;
  /** Ignore cached entries for this language and re-synthesize every route
   * ("重新生成"). Entries in other languages survive. */
  force?: boolean;
  /** Routes settled (cache hit or synthesized) of total — drives the UI's
   * progressive "已完成 x/y" state. */
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
}

/**
 * Synthesize every route once: sequential by design (concurrency 1 — the
 * local LLM proxy behind runAgent doesn't queue well, and routes are few),
 * fingerprint-cached, failure-tolerant. Returns the per-route map keyed by
 * fingerprint; routes absent from the map (runner threw / unusable output)
 * render their deterministic labels.
 *
 * The persisted cache is keyed `fingerprint::lang`, so both languages of a
 * route survive a language switch (switching back reuses the earlier entry).
 * Entries whose route no longer exists are pruned; the cache is written once
 * at the end.
 */
export async function synthesizeLearnRoutes(
  domains: LearnDomain[],
  {
    lang,
    runner,
    store,
    digestByConversationId,
    force = false,
    onProgress,
    now = Date.now,
  }: SynthesizeLearnRoutesOptions,
): Promise<Record<string, LearnRouteSynthesis>> {
  const total = domains.length;
  if (total === 0) return {};
  const cache = await store.read();
  const out: Record<string, LearnRouteSynthesis> = {};
  let done = 0;
  for (const domain of domains) {
    const fingerprint = learnRouteFingerprint(domain);
    const cacheKey = `${fingerprint}::${lang}`;
    const cached = cache[cacheKey];
    if (!force && cached) {
      out[fingerprint] = cached;
    } else {
      try {
        const raw = await runner(
          domain,
          buildLearnSynthesisTranscript({ domain, digestByConversationId, lang }),
        );
        const parsed = parseLearnSynthesis(raw);
        if (parsed) {
          out[fingerprint] = { fingerprint, lang, ...parsed, synthesizedAt: now() };
        }
        // Unusable output → the route keeps its deterministic label this
        // round; nothing is cached, so a later run retries it.
      } catch {
        // Runner failure → same silent fallback; the remaining routes run.
      }
    }
    done += 1;
    onProgress?.(done, total);
  }
  const currentFingerprints = new Set(domains.map((domain) => learnRouteFingerprint(domain)));
  const persisted: Record<string, LearnRouteSynthesis> = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (currentFingerprints.has(key.split("::")[0])) persisted[key] = entry;
  }
  for (const entry of Object.values(out)) {
    persisted[`${entry.fingerprint}::${entry.lang}`] = entry;
  }
  await store.write(persisted);
  return out;
}

function isSynthesisEntry(value: unknown): value is LearnRouteSynthesis {
  const entry = value as LearnRouteSynthesis | null;
  return Boolean(
    entry &&
      typeof entry === "object" &&
      typeof entry.fingerprint === "string" &&
      typeof entry.title === "string" &&
      typeof entry.summary === "string" &&
      Array.isArray(entry.nextSteps),
  );
}

/** ui-prefs key holding the whole fingerprint → synthesis map (routes are
 * capped at 8, so one JSON blob stays small). */
export const LEARN_SYNTHESIS_PREF_KEY = "learn.synthesis.v1";

/** Production store: the ui-prefs JSON blob (mirrors autoClassify's pref
 * access — best-effort, never throws into the synthesis run). */
export function createUiPrefsLearnSynthesisStore(): LearnSynthesisStore {
  return {
    async read() {
      try {
        if (typeof window === "undefined" || !window.vestiUi) return {};
        const value = await window.vestiUi.getUiPreference(LEARN_SYNTHESIS_PREF_KEY);
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        const entries: Record<string, LearnRouteSynthesis> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          if (isSynthesisEntry(entry)) entries[key] = entry;
        }
        return entries;
      } catch {
        return {};
      }
    },
    async write(cache) {
      try {
        if (typeof window === "undefined" || !window.vestiUi) return;
        await window.vestiUi.setUiPreference(LEARN_SYNTHESIS_PREF_KEY, cache);
      } catch {
        // Persistence is best-effort — a lost cache entry just re-runs later.
      }
    },
  };
}

/** In-memory store for tests (mirrors autoClassify's memory suggestion
 * store): call counters + a snapshot for assertions. */
export function createMemoryLearnSynthesisStore(
  seed: Record<string, LearnRouteSynthesis> = {},
): LearnSynthesisStore & {
  readCount: number;
  writeCount: number;
  snapshot(): Record<string, LearnRouteSynthesis>;
} {
  let cache = { ...seed };
  const store = {
    readCount: 0,
    writeCount: 0,
    async read() {
      store.readCount += 1;
      return { ...cache };
    },
    async write(next: Record<string, LearnRouteSynthesis>) {
      store.writeCount += 1;
      cache = { ...next };
    },
    snapshot() {
      return { ...cache };
    },
  };
  return store;
}
