// Daily journal two-pass orchestration: pass 1 extracts a structured brief
// per project/session cluster (template 'daily-cluster', strict JSON), pass 2
// synthesizes the day's report from those briefs (template 'daily', Markdown).
// The LLM is injected as a small runner interface, so the whole orchestration
// — including every degradation path — is testable without Electron/Dexie:
//   - no runner (LLM unconfigured) → fully deterministic local journal;
//   - a failing cluster call → that cluster's deterministic brief;
//   - a failing synthesis call → the deterministic journal over the briefs.
// IO wiring (api.runAgent, locale, vault export) lives in dailyService.

import type { DailyLocale } from "./dailyActivity";
import type { RelayProjectMemory } from "../relay/relayContext";
import {
  DAILY_CLUSTER_LLM_LIMIT,
  buildClusterExtractionTranscript,
  buildDailySynthesisTranscript,
  buildDeterministicClusterBrief,
  clusterHasLlmMaterial,
  composeDailyMarkdown,
  type DailyClusterBrief,
  type DailyWorkModel,
} from "./dailyJournal";

/** Minimal LLM surface the pipeline needs; dailyService adapts api.runAgent.
 * Returns the raw body (cluster JSON or synthesis Markdown); throws on
 * transport/parse-unusable failures. */
export type DailyLlmRunner = (request: {
  template: "daily-cluster" | "daily";
  transcript: string;
}) => Promise<string>;

/** Normalize one cluster's raw pass-1 JSON into a brief. Kept local so the
 * renderer can validate before trusting model output. */
export interface DailyClusterPayload {
  theme: string;
  goal: string;
  completed: string[];
  in_progress: string[];
  decisions: string[];
  open_questions: string[];
}

function asStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

/** Tolerates Markdown fences; throws when the output is not a usable object. */
export function parseDailyClusterPayload(raw: string): DailyClusterPayload {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("daily-cluster 输出不是 JSON");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const theme = typeof parsed.theme === "string" ? parsed.theme.trim().slice(0, 120) : "";
  const goal = typeof parsed.goal === "string" ? parsed.goal.trim().slice(0, 600) : "";
  const completed = asStringList(parsed.completed, 6);
  if (!theme && !goal && completed.length === 0) {
    throw new Error("daily-cluster 输出没有任何有效内容");
  }
  return {
    theme: theme || goal.slice(0, 40) || completed[0].slice(0, 40),
    goal,
    completed,
    in_progress: asStringList(parsed.in_progress, 4),
    decisions: asStringList(parsed.decisions, 4),
    open_questions: asStringList(parsed.open_questions, 4),
  };
}

/**
 * Pass 1: one structured brief per cluster. LLM-backed for clusters with
 * digest/summary material (capped at DAILY_CLUSTER_LLM_LIMIT calls);
 * everything else — and every failed call — falls back to the deterministic
 * brief, so a partial outage degrades gracefully instead of blanking the day.
 */
export async function extractDailyClusterBriefs(
  model: DailyWorkModel,
  run: DailyLlmRunner | null
): Promise<DailyClusterBrief[]> {
  const briefs: DailyClusterBrief[] = [];
  let llmCalls = 0;
  for (const cluster of model.clusters) {
    const fallback = buildDeterministicClusterBrief(cluster);
    const worthLlm =
      run !== null && llmCalls < DAILY_CLUSTER_LLM_LIMIT && clusterHasLlmMaterial(cluster);
    if (!worthLlm) {
      briefs.push(fallback);
      continue;
    }
    llmCalls += 1;
    try {
      const raw = await run({
        template: "daily-cluster",
        transcript: buildClusterExtractionTranscript(cluster, model.fileAnchors),
      });
      const payload = parseDailyClusterPayload(raw);
      briefs.push({
        key: cluster.key,
        projectLabel: cluster.projectLabel,
        source: cluster.source,
        theme: payload.theme,
        goal: payload.goal,
        completed: payload.completed,
        inProgress: payload.in_progress,
        decisions: payload.decisions.length > 0 ? payload.decisions : fallback.decisions,
        openQuestions:
          payload.open_questions.length > 0 ? payload.open_questions : fallback.openQuestions,
        fromLlm: true,
      });
    } catch {
      briefs.push(fallback);
    }
  }
  return briefs;
}

/**
 * Pass 2 + composition: synthesize the report from the briefs, then layer the
 * deterministic data over the model's prose (file section, missing-section
 * repair). A synthesis failure still returns the deterministic journal built
 * from the (possibly LLM-extracted) briefs — never an empty day.
 */
export async function renderDailyJournal(input: {
  model: DailyWorkModel;
  briefs: DailyClusterBrief[];
  projectMemory: RelayProjectMemory[];
  previousLogMarkdown: string | null;
  run: DailyLlmRunner | null;
  locale: DailyLocale;
}): Promise<string> {
  let llmBody: string | null = null;
  if (input.run) {
    try {
      llmBody = await input.run({
        template: "daily",
        transcript: buildDailySynthesisTranscript({
          model: input.model,
          briefs: input.briefs,
          projectMemory: input.projectMemory,
          previousLogMarkdown: input.previousLogMarkdown,
        }),
      });
    } catch {
      llmBody = null;
    }
  }
  return composeDailyMarkdown({
    llmBody,
    model: input.model,
    briefs: input.briefs,
    locale: input.locale,
  });
}

/** Full two-pass pipeline for one day. */
export async function runDailyTwoPassPipeline(input: {
  model: DailyWorkModel;
  projectMemory: RelayProjectMemory[];
  previousLogMarkdown: string | null;
  run: DailyLlmRunner | null;
  locale: DailyLocale;
}): Promise<{ contentMarkdown: string; briefs: DailyClusterBrief[] }> {
  const briefs = await extractDailyClusterBriefs(input.model, input.run);
  const contentMarkdown = await renderDailyJournal({
    model: input.model,
    briefs,
    projectMemory: input.projectMemory,
    previousLogMarkdown: input.previousLogMarkdown,
    run: input.run,
    locale: input.locale,
  });
  return { contentMarkdown, briefs };
}
