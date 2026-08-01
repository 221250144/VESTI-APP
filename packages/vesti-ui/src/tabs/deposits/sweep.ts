// One-click full deposit sweep (P4b): plan + run a batch distillation across
// the preset templates, so the user no longer triggers each scenario by hand.
//
// Pure orchestration, no IO of its own — the DepositSweepRunner interface is
// the storage/LLM surface (desktop storage methods in production, mocks in
// tests), which keeps the whole flow deterministic and unit-testable.
//
// Scope planning reuses the existing scope kinds: background knowledge and
// writing style distill the whole captured history (a [0, now] time window,
// mirroring the composer's time-window scope); project state generates one
// deposit per captured project, reusing the conversation tree's project
// grouping.
//
// Idempotency (integrated with the mem0-style maintain merge): every plan
// item chains onto the existing head for the same template+scope fingerprint
// via previousId, so the fresh distillation is merged into the previous
// document instead of forking a new entry. When the merge leaves the document
// unchanged (maintain answered with NOOP-only ops, or the Markdown is
// identical), the fresh version is rolled back — repeat sweeps create neither
// duplicate entries nor empty versions.

import type {
  ConversationTree,
  Deposit,
  DepositScope,
  DepositTemplate,
  GenerateDepositInput,
} from "../../types";

/** Preset scenarios the sweep covers. "custom" needs a user instruction and
 * "extract" is a different flow, so neither is sweepable. */
export type DepositSweepTemplate = Exclude<DepositTemplate, "extract" | "custom">;

export const DEPOSIT_SWEEP_TEMPLATES: DepositSweepTemplate[] = [
  "background_knowledge",
  "project_state",
  "writing_style",
];

export interface DepositSweepPlanItem {
  template: DepositSweepTemplate;
  scope: DepositScope;
}

/** The storage/LLM surface the sweep needs (mocked in tests). */
export interface DepositSweepRunner {
  listDeposits(): Promise<Deposit[]>;
  resolveScope(scope: DepositScope): Promise<number[]>;
  generate(input: GenerateDepositInput): Promise<Deposit>;
  remove(id: number): Promise<void>;
}

export type DepositSweepOutcome = "added" | "updated" | "skipped" | "failed";

export interface DepositSweepItemResult {
  item: DepositSweepPlanItem;
  outcome: DepositSweepOutcome;
  error?: string;
}

export interface DepositSweepSummary {
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  results: DepositSweepItemResult[];
}

export interface DepositSweepProgress {
  /** 1-based index of the item currently being distilled. */
  current: number;
  total: number;
  item: DepositSweepPlanItem;
}

/**
 * Build the sweep plan: one whole-history item per non-project preset, plus
 * one project-scope item per captured project (projects without sessions are
 * left out). Empty scopes are tolerated — the runner skips them later.
 */
export function planDepositSweep(args: {
  tree: ConversationTree | null;
  templates?: DepositSweepTemplate[];
  now?: number;
}): DepositSweepPlanItem[] {
  const templates = args.templates ?? DEPOSIT_SWEEP_TEMPLATES;
  const now = args.now ?? Date.now();
  const items: DepositSweepPlanItem[] = [];
  for (const template of templates) {
    if (template === "project_state") {
      for (const source of args.tree?.sources ?? []) {
        for (const project of source.projects) {
          if (project.sessions.length === 0) continue;
          items.push({
            template,
            scope: {
              kind: "project",
              projectKey: project.projectKey,
              label: `${source.platform} · ${project.label}`,
            },
          });
        }
      }
    } else {
      items.push({ template, scope: { kind: "timerange", start: 0, end: now } });
    }
  }
  return items;
}

/** Current heads: deposits no other deposit points to via prevId. */
function findDepositHeads(deposits: Deposit[]): Deposit[] {
  const referenced = new Set<number>();
  for (const deposit of deposits) {
    if (deposit.prevId !== null) referenced.add(deposit.prevId);
  }
  return deposits.filter((deposit) => !referenced.has(deposit.id));
}

/**
 * The existing head a sweep item chains onto: same template and same scope
 * identity — the projectKey for project scopes; the scope kind alone for the
 * whole-history time window, so manual runs and sweeps share one chain per
 * preset. Newest match wins when duplicates somehow exist.
 */
export function findSweepHead(
  deposits: Deposit[],
  item: DepositSweepPlanItem,
): Deposit | null {
  const heads = findDepositHeads(deposits)
    .filter((head) => {
      if (head.template !== item.template) return false;
      if (item.scope.kind === "project") {
        return (
          head.scope.kind === "project" &&
          head.scope.projectKey === item.scope.projectKey
        );
      }
      return head.scope.kind === item.scope.kind;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return heads[0] ?? null;
}

/** True when the regenerated version carries no change: the maintain pass
 * answered NOOP for every section, or the merged Markdown matches the
 * previous version verbatim. */
function isUnchanged(previous: Deposit, created: Deposit): boolean {
  const ops = created.lastOps;
  if (ops && ops.length > 0 && ops.every((op) => op.op === "NOOP")) return true;
  return created.contentMarkdown.trim() === previous.contentMarkdown.trim();
}

/**
 * Run the plan sequentially (progress callback fires before each item).
 * Per-item failures are isolated and reported, they never abort the sweep.
 * Outcomes feed the summary: added (fresh v1), updated (new merged version),
 * skipped (empty scope or unchanged content — the fresh version is rolled
 * back), failed (runner error).
 */
export async function runDepositSweep(
  runner: DepositSweepRunner,
  plan: DepositSweepPlanItem[],
  onProgress?: (progress: DepositSweepProgress) => void,
): Promise<DepositSweepSummary> {
  const results: DepositSweepItemResult[] = [];
  for (const [index, item] of plan.entries()) {
    onProgress?.({ current: index + 1, total: plan.length, item });
    try {
      const conversationIds = await runner.resolveScope(item.scope);
      if (conversationIds.length === 0) {
        results.push({ item, outcome: "skipped" });
        continue;
      }
      const previous = findSweepHead(await runner.listDeposits(), item);
      const created = await runner.generate({
        template: item.template,
        scope: item.scope,
        previousId: previous?.id,
      });
      if (previous && isUnchanged(previous, created)) {
        await runner.remove(created.id);
        results.push({ item, outcome: "skipped" });
      } else {
        results.push({ item, outcome: previous ? "updated" : "added" });
      }
    } catch (error) {
      results.push({
        item,
        outcome: "failed",
        error: (error as Error)?.message ?? String(error),
      });
    }
  }
  const count = (outcome: DepositSweepOutcome) =>
    results.filter((result) => result.outcome === outcome).length;
  return {
    added: count("added"),
    updated: count("updated"),
    skipped: count("skipped"),
    failed: count("failed"),
    results,
  };
}
