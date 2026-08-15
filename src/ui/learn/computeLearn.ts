// "学习 Learn" — reframes the captured KB as a personal curriculum, computed 100%
// locally (no LLM, no new extraction) from data VESTI already stores: topics
// (domains), per-conversation summary signals (key_insights → glossary;
// unresolved_threads → open loops; depth_level → depth mix). Mirrors computeAiti:
// pure; localized strings the module itself generates (fallback route names)
// follow the `lang` parameter, everything else stays host-labeled.
//
// V2 (2026-07): user corrections parameter allows manual glossary edits, domain
// reassignment hints, and open-loop management that survive recomputation.
//
// V3 (2026-07): route-style aggregation. V2 grouped strictly by topic_id, so
// every conversation the classifier hadn't filed (LLM off, suggestion queue,
// low confidence) collapsed into one giant nameless "uncategorized" bucket.
// Now conversations converge into a handful of representative learning routes:
// classified ones group under their ROOT topic; unclassified ones fall back to
// their captured project (working directory / site) and then to their source
// platform. The long tail merges into a single descriptive fallback route
// whose share of all conversations is hard-capped — a structure-less "未分类"
// blob is never produced, even with no LLM configured.
//
// V4 (2026-08): route-level LLM synthesis support. Each route now also
// exposes its full member conversation id set (the synthesis cache
// fingerprint input) plus the members' platform / project labels — the
// grounding context the synthesis transcript is built from. Still 100%
// local: the LLM pass itself lives in src/ui/learn/learnSynthesis.
//
// V5 (2026-08): topic-family consolidation + heat ordering. Over-specific
// root topics ("nohup 学习") fold up into a parent theme ("Linux 系统") via
// a small deterministic keyword-family table, so the map shows a few
// general themes instead of a pile of micro-topics. Named routes come back
// ordered by conversation count (heat), which drives the card sizes.

import type { Conversation, SummaryRecord, Topic } from "../db/types";
import type {
  LearnProfile,
  LearnDomain,
  LearnGlossaryEntry,
  LearnOpenLoop,
} from "@vesti/ui";

const MIN_LEARN_SAMPLE = 3;
const MAX_GLOSSARY = 24;
const MAX_OPEN_LOOPS = 14;
/** Representative conversations surfaced per route (evidence-chain jumps). */
const MAX_DOMAIN_REPS = 3;
/** V4: platform / project context labels kept per route (synthesis input). */
const MAX_CONTEXT_LABELS = 3;
/** V3: named learning routes converge to a representative handful; the long
 * tail beyond this cap merges into one descriptive fallback route. */
const MAX_LEARN_ROUTES = 7;
/** V3: a captured project needs at least this many conversations to stand
 * alone as a route; smaller ones fold into their platform cluster. */
const MIN_PROJECT_CLUSTER = 2;
/** V3: hard cap on the fallback route's share of all conversations — an
 * oversized tail promotes its largest clusters back into named routes. */
const MAX_MISC_SHARE = 1 / 3;
const DAY_MS = 86_400_000;

type Depth = "superficial" | "moderate" | "deep";

// ---- User Corrections (V2) --------------------------------------------------

export interface LearnCorrection {
  type: 'glossary_add' | 'glossary_edit' | 'glossary_remove' | 'open_loop_dismiss';
  term?: string;
  definition?: string;
  /** Domain name targeted for reassignment. */
  domain?: string;
  /** Text of an open loop to dismiss. */
  loopText?: string;
  timestamp?: number;
}

/** Apply user corrections to the glossary after automatic extraction. */
function applyGlossaryCorrections(
  glossary: LearnGlossaryEntry[],
  corrections: LearnCorrection[],
): LearnGlossaryEntry[] {
  const removeKeys = new Set(
    corrections
      .filter(c => c.type === 'glossary_remove' && c.term)
      .map(c => c.term!.toLowerCase())
  );
  // Start with auto-extracted entries, minus user-removed ones.
  let filtered = glossary.filter(g => !removeKeys.has(g.term.toLowerCase()));

  // Apply edits: user-edited definitions replace auto-extracted ones.
  const edits = new Map(
    corrections
      .filter(c => c.type === 'glossary_edit' && c.term && c.definition)
      .map(c => [c.term!.toLowerCase(), c.definition!])
  );
  filtered = filtered.map(g => {
    const edit = edits.get(g.term.toLowerCase());
    return edit ? { ...g, definition: edit } : g;
  });

  // Prepend user-added entries at the top.
  const adds = corrections
    .filter(c => c.type === 'glossary_add' && c.term)
    .map(c => ({
      term: c.term!,
      definition: c.definition ?? '',
    }));
  return [...adds, ...filtered].slice(0, MAX_GLOSSARY);
}

/** Remove user-dismissed loops from the open-loops list. */
function applyOpenLoopCorrections(
  loops: LearnOpenLoop[],
  corrections: LearnCorrection[],
): LearnOpenLoop[] {
  const dismissKeys = new Set(
    corrections
      .filter(c => c.type === 'open_loop_dismiss' && c.loopText)
      .map(c => c.loopText!.toLowerCase())
  );
  return loops.filter(l => !dismissKeys.has(l.text.toLowerCase()));
}

/** Ranking weight for "how representative is this conversation": a deep dive
 * beats a superficial skim; unsummarized conversations rank last. */
const DEPTH_RANK: Record<Depth, number> = { deep: 3, moderate: 2, superficial: 1 };

// ---- V2: Domain Importance Scoring -----------------------------------------

/** Thresholds for domain compact mode. */
const COMPACT_MAX_COUNT = 2;
const DORMANT_DAYS = 30;
const IMPORTANCE_COUNT_WEIGHT = 0.35;
const IMPORTANCE_RECENCY_WEIGHT = 0.25;
const IMPORTANCE_DEPTH_WEIGHT = 0.20;
const IMPORTANCE_OPEN_WEIGHT = 0.20;

/**
 * V2: score a domain's importance (0-1). Key domains are large, active,
 * deep, and have open questions. Minor/dormant domains score low and
 * render in compact mode.
 */
function scoreDomainImportance(e: {
  count: number;
  deep: number;
  moderate: number;
  superficial: number;
  recent30: number;
  openQuestion: { text: string } | null;
}): number {
  const total = e.deep + e.moderate + e.superficial;
  const depthRatio = total > 0 ? (e.deep * 1.0 + e.moderate * 0.5) / total : 0;
  const recencyRatio = e.count > 0 ? Math.min(1, e.recent30 / Math.max(e.count, 1)) : 0;
  const countScore = Math.min(1, e.count / 10); // 10+ conversations → full score
  const openScore = e.openQuestion ? 1 : 0;
  return (
    IMPORTANCE_COUNT_WEIGHT * countScore +
    IMPORTANCE_RECENCY_WEIGHT * recencyRatio +
    IMPORTANCE_DEPTH_WEIGHT * depthRatio +
    IMPORTANCE_OPEN_WEIGHT * openScore
  );
}

/** V2: decide if a domain should render compact. */
function shouldCompact(e: {
  count: number;
  recent30: number;
  deep: number;
  moderate: number;
  superficial: number;
}, importanceScore: number): boolean {
  // Very small: compact.
  if (e.count <= COMPACT_MAX_COUNT) return true;
  // Dormant + low depth: compact.
  const total = e.deep + e.moderate + e.superficial;
  if (e.recent30 === 0 && total <= 2) return true;
  // Low importance score: compact.
  return importanceScore < 0.25;
}

function latestSummaryByConversation(summaries: SummaryRecord[]): Map<number, SummaryRecord> {
  const byConv = new Map<number, SummaryRecord>();
  for (const rec of summaries) {
    if (typeof rec.conversationId !== "number") continue;
    const prev = byConv.get(rec.conversationId);
    if (!prev || (rec.createdAt ?? 0) > (prev.createdAt ?? 0)) byConv.set(rec.conversationId, rec);
  }
  return byConv;
}

function depthOf(rec: SummaryRecord | undefined): Depth | null {
  const meta = rec && (rec.structured as unknown as Record<string, unknown> | null | undefined)?.["meta_observations"];
  const level = meta && typeof (meta as { depth_level?: unknown }).depth_level === "string"
    ? (meta as { depth_level: string }).depth_level
    : null;
  return level === "superficial" || level === "moderate" || level === "deep" ? level : null;
}

/** First unresolved thread of a conversation's latest summary (same length
 * filter as the global open-loops section), or null. */
function firstUnresolvedThread(rec: SummaryRecord | undefined): string | null {
  const s = rec && (rec.structured as unknown as Record<string, unknown> | null | undefined);
  const threads = s && Array.isArray(s.unresolved_threads) ? (s.unresolved_threads as unknown[]) : [];
  for (const t of threads) {
    if (typeof t !== "string") continue;
    const text = t.trim();
    if (text.length >= 4) return text;
  }
  return null;
}

// ---- V3: Route clustering ---------------------------------------------------

/** Language for the route names this module synthesizes itself (platform /
 * fallback clusters). Follows the agent output-language setting, mirroring
 * the classify pipeline; topic and project names are already in the user's
 * language and pass through untouched. */
export type LearnLang = "zh" | "en";

/** Non-indexed capture fields listConversations passes through at runtime
 * (same structural read autoClassify makes): the captured working directory
 * and the capture source, used to cluster unclassified conversations. */
type LearnLocalFields = { _source?: string; _project_path?: string };

/** Project label for an unclassified conversation: the captured working
 * directory's basename, or the site hostname for browser-extension captures. */
function projectLabelOf(conv: Conversation & LearnLocalFields): string | null {
  const projectPath = typeof conv._project_path === "string" ? conv._project_path.trim() : "";
  if (projectPath) {
    const parts = projectPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }
  if (conv._source === "browser_extension" && conv.url) {
    try {
      return new URL(conv.url).hostname || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** One route candidate before ranking: a root-topic cluster, a project
 * cluster, or a platform cluster. */
interface LearnCluster {
  kind: "topic" | "project" | "platform";
  /** Root topic id for topic clusters; null for synthetic ones. */
  topicId: number | null;
  name: string;
  count: number;
  deep: number;
  moderate: number;
  superficial: number;
  recent7: number;
  recent30: number;
  lastActiveAt: number;
  openQuestion: { text: string; conversationId: number; at: number } | null;
  reps: Array<{ id: number; title: string; rank: number; updatedAt: number }>;
  /** V4: member platform / project tallies — the route synthesis's grounding
   * context (emitted as the top-3 labels on LearnDomain). */
  platforms: Map<string, number>;
  projects: Map<string, number>;
}

function emptyCluster(kind: LearnCluster["kind"], topicId: number | null, name: string): LearnCluster {
  return {
    kind,
    topicId,
    name,
    count: 0,
    deep: 0,
    moderate: 0,
    superficial: 0,
    recent7: 0,
    recent30: 0,
    lastActiveAt: 0,
    openQuestion: null,
    reps: [],
    platforms: new Map(),
    projects: new Map(),
  };
}

/** Fold one conversation's stats into a cluster. */
function addToCluster(
  entry: LearnCluster,
  conv: Conversation,
  rec: SummaryRecord | undefined,
  now: number,
): void {
  entry.count += 1;
  const updatedAt = conv.updated_at ?? 0;
  if (now - updatedAt <= 7 * DAY_MS) entry.recent7 += 1;
  if (now - updatedAt <= 30 * DAY_MS) entry.recent30 += 1;
  if (updatedAt > entry.lastActiveAt) entry.lastActiveAt = updatedAt;
  const d = depthOf(rec);
  if (d) entry[d] += 1;
  // The route's "next step": the unresolved thread left by its most recently
  // active conversation — one concrete question to follow up on.
  const unresolved = firstUnresolvedThread(rec);
  if (unresolved && (!entry.openQuestion || updatedAt > entry.openQuestion.at)) {
    entry.openQuestion = { text: unresolved, conversationId: conv.id as number, at: updatedAt };
  }
  entry.reps.push({
    id: conv.id as number,
    title: conv.title,
    rank: d ? DEPTH_RANK[d] : 0,
    updatedAt,
  });
  // V4: tally the route's platform / project mix for the synthesis context.
  entry.platforms.set(conv.platform, (entry.platforms.get(conv.platform) ?? 0) + 1);
  const project = projectLabelOf(conv);
  if (project) entry.projects.set(project, (entry.projects.get(project) ?? 0) + 1);
}

/** Top-N labels of a tally map, most frequent first (ties alphabetical). */
function topTallyLabels(tally: Map<string, number>, max: number): string[] {
  return Array.from(tally.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([label]) => label);
}

/** Merge tail clusters into the single fallback route. */
function mergeClusters(clusters: LearnCluster[]): LearnCluster {
  const merged = emptyCluster("platform", null, "");
  for (const cluster of clusters) {
    merged.count += cluster.count;
    merged.deep += cluster.deep;
    merged.moderate += cluster.moderate;
    merged.superficial += cluster.superficial;
    merged.recent7 += cluster.recent7;
    merged.recent30 += cluster.recent30;
    if (cluster.lastActiveAt > merged.lastActiveAt) merged.lastActiveAt = cluster.lastActiveAt;
    if (cluster.openQuestion && (!merged.openQuestion || cluster.openQuestion.at > merged.openQuestion.at)) {
      merged.openQuestion = cluster.openQuestion;
    }
    merged.reps.push(...cluster.reps);
    for (const [platform, n] of cluster.platforms) {
      merged.platforms.set(platform, (merged.platforms.get(platform) ?? 0) + n);
    }
    for (const [project, n] of cluster.projects) {
      merged.projects.set(project, (merged.projects.get(project) ?? 0) + n);
    }
  }
  return merged;
}

/** An unclassified platform cluster is still a meaningful route: "everything
 * not yet filed, from this one tool". */
function platformClusterName(platform: string, lang: LearnLang): string {
  return lang === "zh" ? `${platform} · 综合探索` : `${platform} · General exploration`;
}

/** Clip a cluster name for the fallback route's descriptive title. */
function clipName(name: string, max: number): string {
  const normalized = name.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/** The fallback route's title names what is actually inside (its two largest
 * clusters), so even the catch-all bucket says something concrete. */
function miscClusterName(clusters: LearnCluster[], lang: LearnLang): string {
  const shown = clusters.slice(0, 2).map((c) => clipName(c.name, 12));
  const more = clusters.length > 2;
  return lang === "zh"
    ? `随手探索：${shown.join("、")}${more ? " 等" : ""}`
    : `Side explorations: ${shown.join(", ")}${more ? ", …" : ""}`;
}

// ---- V5: Topic-family consolidation -----------------------------------------

/** Fine-grained themes fold up into a general parent theme — "nohup 学习"
 * belongs under "Linux 系统", not on its own card. Deliberately small: only
 * unambiguous tech word families. ASCII keywords match on token boundaries
 * (so "digital" doesn't hit "git"); CJK keywords match as substrings. */
const TOPIC_FAMILIES: ReadonlyArray<{ keywords: readonly string[]; zh: string; en: string }> = [
  {
    keywords: ["linux", "nohup", "systemctl", "systemd", "chmod", "chown", "bash", "ssh", "cron", "crontab", "ubuntu", "debian", "centos", "awk", "sed", "grep"],
    zh: "Linux 系统",
    en: "Linux",
  },
  {
    keywords: ["react", "usestate", "useeffect", "usememo", "usereducer", "jsx", "nextjs", "next.js"],
    zh: "React",
    en: "React",
  },
  { keywords: ["vue", "pinia", "nuxt"], zh: "Vue", en: "Vue" },
  {
    keywords: ["python", "pandas", "numpy", "django", "flask"],
    zh: "Python",
    en: "Python",
  },
  {
    keywords: ["docker", "kubernetes", "k8s", "容器"],
    zh: "Docker 容器",
    en: "Containers",
  },
  {
    keywords: ["mysql", "postgresql", "postgres", "sqlite", "redis", "mongodb", "sql", "数据库"],
    zh: "数据库",
    en: "Databases",
  },
  { keywords: ["git", "github", "gitlab"], zh: "Git 协作", en: "Git" },
  {
    keywords: ["typescript", "javascript", "nodejs", "node.js"],
    zh: "JavaScript/TypeScript",
    en: "JavaScript/TypeScript",
  },
];

const ASCII_KEYWORD = /^[a-z0-9.+#]+$/;

function keywordMatches(name: string, keyword: string): boolean {
  if (!ASCII_KEYWORD.test(keyword)) return name.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(name);
}

/** The parent theme a raw cluster name consolidates into, or null when no
 * family matches (the name then passes through untouched). */
function familyNameOf(rawName: string, lang: LearnLang): string | null {
  const name = rawName.toLowerCase();
  for (const family of TOPIC_FAMILIES) {
    if (family.keywords.some((keyword) => keywordMatches(name, keyword))) {
      return lang === "zh" ? family.zh : family.en;
    }
  }
  return null;
}

export function computeLearn(
  summaries: SummaryRecord[],
  topics: Topic[],
  conversations: Conversation[],
  now = Date.now(),
  corrections?: LearnCorrection[],
  lang: LearnLang = "zh",
): LearnProfile {
  const summaryByConv = latestSummaryByConversation(summaries);
  const liveConvs = conversations.filter((c) => !c.is_archived && !c.is_trash);

  // ---- Routes: cluster conversations into a handful of learning routes ----
  const topicById = new Map<number, Topic>();
  for (const t of topics) if (typeof t.id === "number") topicById.set(t.id, t);

  /** Walk to the root topic (the level-1 domain) with a cycle guard — routes
   * group by root so leaf-topic fragmentation collapses into one cluster. */
  const rootTopicOf = (topicId: number): Topic | null => {
    let current = topicById.get(topicId) ?? null;
    const guard = new Set<number>();
    while (current && current.parent_id !== null) {
      if (guard.has(current.id)) break;
      guard.add(current.id);
      const parent = topicById.get(current.parent_id);
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  const clusters = new Map<string, LearnCluster>();
  const clusterFor = (key: string, kind: LearnCluster["kind"], topicId: number | null, name: string) => {
    let entry = clusters.get(key);
    if (!entry) {
      entry = emptyCluster(kind, topicId, name);
      clusters.set(key, entry);
    }
    return entry;
  };

  // Pass 1: classified conversations aggregate under their root topic.
  // A topic_id dangling off the topics list (deleted topic) counts as
  // unclassified — V2 turned those into nameless "uncategorized" domains.
  // Unclassified conversations are staged: their final cluster depends on
  // project-popularity, decided in pass 2.
  const staged: Array<{ conv: Conversation; label: string | null }> = [];
  for (const conv of liveConvs) {
    if (typeof conv.id !== "number") continue;
    const topicId = typeof conv.topic_id === "number" ? conv.topic_id : null;
    const root = topicId !== null ? rootTopicOf(topicId) : null;
    if (root) {
      // V5: an over-specific root topic ("nohup 学习") folds into its parent
      // theme; family clusters share one key so sibling topics genuinely
      // merge into a single route.
      const family = familyNameOf(root.name, lang);
      const entry = family
        ? clusterFor(`family:${family}`, "topic", root.id, family)
        : clusterFor(`topic:${root.id}`, "topic", root.id, root.name);
      addToCluster(entry, conv, summaryByConv.get(conv.id), now);
    } else {
      staged.push({ conv, label: projectLabelOf(conv) });
    }
  }

  // Pass 2: unclassified conversations cluster by project; projects with too
  // few conversations to stand alone fold into their platform cluster.
  const projectCounts = new Map<string, number>();
  for (const { label } of staged) {
    if (!label) continue;
    const key = label.toLowerCase();
    projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
  }
  for (const { conv, label } of staged) {
    const standalone = label !== null && (projectCounts.get(label.toLowerCase()) ?? 0) >= MIN_PROJECT_CLUSTER;
    // V5 family folding applies to root topics only — a project label is a
    // directory / hostname, kept literal so site clustering stays intact.
    const entry = standalone
      ? clusterFor(`project:${(label as string).toLowerCase()}`, "project", null, label as string)
      : clusterFor(`platform:${conv.platform}`, "platform", null, platformClusterName(conv.platform, lang));
    addToCluster(entry, conv, summaryByConv.get(conv.id as number), now);
  }

  // Rank clusters by importance; named routes are the top MAX_LEARN_ROUTES,
  // the tail merges into one descriptive fallback route sorted last.
  const scored = Array.from(clusters.values())
    .map((cluster) => ({ cluster, score: scoreDomainImportance(cluster) }))
    .sort((a, b) => b.score - a.score || b.cluster.count - a.cluster.count || a.cluster.name.localeCompare(b.cluster.name));
  const routedTotal = scored.reduce((n, c) => n + c.cluster.count, 0);
  const named = scored.slice(0, MAX_LEARN_ROUTES);
  const tail = scored.slice(MAX_LEARN_ROUTES);
  // Share cap: the fallback route never holds more than MAX_MISC_SHARE of all
  // conversations — an oversized tail promotes its largest clusters back into
  // named routes (always terminates: promotion shrinks the tail).
  while (tail.length > 0) {
    const miscCount = tail.reduce((n, c) => n + c.cluster.count, 0);
    if (miscCount / routedTotal <= MAX_MISC_SHARE) break;
    named.push(tail.shift() as (typeof tail)[number]);
  }

  const toLearnDomain = (entry: { cluster: LearnCluster; score: number }): LearnDomain => {
    const { cluster: e, score: importanceScore } = entry;
    return {
      topicId: e.topicId,
      name: e.name,
      count: e.count,
      deep: e.deep,
      moderate: e.moderate,
      superficial: e.superficial,
      recent7: e.recent7,
      recent30: e.recent30,
      lastActiveAt: e.lastActiveAt,
      ...(e.openQuestion
        ? { openQuestion: { text: e.openQuestion.text, conversationId: e.openQuestion.conversationId } }
        : {}),
      representatives: e.reps
        .sort((a, b) => b.rank - a.rank || b.updatedAt - a.updatedAt)
        .slice(0, MAX_DOMAIN_REPS)
        .map((r) => ({ conversationId: r.id, title: r.title })),
      // V4: the full member id set (synthesis cache fingerprint) + the
      // platform / project context the route synthesis is grounded on.
      memberIds: e.reps.map((r) => r.id).sort((a, b) => a - b),
      platforms: topTallyLabels(e.platforms, MAX_CONTEXT_LABELS),
      projects: topTallyLabels(e.projects, MAX_CONTEXT_LABELS),
      importanceScore,
      compact: shouldCompact(e, importanceScore),
    };
  };

  // V5: routes come back heat-ordered — the one with the most conversations
  // leads (ties keep the importance order; Array.sort is stable).
  const domains: LearnDomain[] = named
    .slice()
    .sort((a, b) => b.cluster.count - a.cluster.count)
    .map(toLearnDomain);
  if (tail.length > 0) {
    const merged = mergeClusters(tail.map((c) => c.cluster));
    merged.name = miscClusterName(
      tail.map((c) => c.cluster),
      lang,
    );
    domains.push(toLearnDomain({ cluster: merged, score: scoreDomainImportance(merged) }));
  }

  // ---- Glossary: key_insights terms across summaries (deduped + ranked) ----
  // Rank by how often a term recurs (then recency) so the most-studied terms
  // survive the MAX_GLOSSARY cap — taking the arbitrary first-N in storage order
  // would drop high-value terms.
  type GlossaryAgg = LearnGlossaryEntry & { count: number; recencyAt: number };
  const glossaryMap = new Map<string, GlossaryAgg>();
  for (const rec of summaryByConv.values()) {
    const s = rec.structured as unknown as Record<string, unknown> | null | undefined;
    const insights = s && Array.isArray(s.key_insights) ? (s.key_insights as unknown[]) : [];
    const recencyAt = rec.createdAt ?? 0;
    for (const ki of insights) {
      let term = "";
      let def = "";
      if (typeof ki === "string") term = ki;
      else if (ki && typeof ki === "object") {
        term = typeof (ki as { term?: unknown }).term === "string" ? (ki as { term: string }).term : "";
        def = typeof (ki as { definition?: unknown }).definition === "string" ? (ki as { definition: string }).definition : "";
      }
      term = term.trim();
      if (term.length < 2 || term.length > 60) continue;
      const key = term.toLowerCase();
      const existing = glossaryMap.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.definition && def.trim()) existing.definition = def.trim();
        if (recencyAt > existing.recencyAt) existing.recencyAt = recencyAt;
      } else {
        glossaryMap.set(key, {
          term,
          definition: def.trim(),
          conversationId: rec.conversationId,
          count: 1,
          recencyAt,
        });
      }
    }
  }
  const glossary: LearnGlossaryEntry[] = Array.from(glossaryMap.values())
    .sort((a, b) => b.count - a.count || b.recencyAt - a.recencyAt)
    .slice(0, MAX_GLOSSARY)
    .map((entry) => ({
      term: entry.term,
      definition: entry.definition,
      conversationId: entry.conversationId,
    }));

  // ---- Open loops: unresolved_threads with their source conversation ----
  const openLoops: LearnOpenLoop[] = [];
  const seenLoops = new Set<string>();
  for (const rec of summaryByConv.values()) {
    const s = rec.structured as unknown as Record<string, unknown> | null | undefined;
    const threads = s && Array.isArray(s.unresolved_threads) ? (s.unresolved_threads as unknown[]) : [];
    for (const t of threads) {
      if (typeof t !== "string") continue;
      const text = t.trim();
      if (text.length < 4) continue;
      const key = text.toLowerCase();
      if (seenLoops.has(key)) continue;
      seenLoops.add(key);
      openLoops.push({ text, conversationId: rec.conversationId });
      if (openLoops.length >= MAX_OPEN_LOOPS) break;
    }
    if (openLoops.length >= MAX_OPEN_LOOPS) break;
  }

  const sampleSize = summaryByConv.size;
  const available = liveConvs.length >= MIN_LEARN_SAMPLE && (domains.length > 0 || glossary.length > 0);

  // V2: apply user corrections to glossary and open loops.
  const effectiveGlossary = corrections && corrections.length > 0
    ? applyGlossaryCorrections(glossary, corrections)
    : glossary;
  const effectiveLoops = corrections && corrections.length > 0
    ? applyOpenLoopCorrections(openLoops, corrections)
    : openLoops;

  return { available, sampleSize, domains, glossary: effectiveGlossary, openLoops: effectiveLoops };
}
