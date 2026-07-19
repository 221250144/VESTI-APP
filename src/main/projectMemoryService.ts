import {
  renderProjectStateMarkdown,
  type ProjectBrief,
  type ProjectState,
  type SessionDigest,
} from '@vesti/capture-core';
import { buildDepositMaintainTranscript, parseDepositMaintainPayload, type DepositMaintainOp } from '../shared/depositMaintain';
import type { AgentResult, AgentRunRequest } from '../shared/contracts';

/**
 * Project memory service (memory v2, L0 + L2).
 *
 * Hooks the same capture-sync-completed signal as the digest pipeline,
 * debounced. Every scan:
 *   1. refreshes fork lineage (codex rollout overlap detection),
 *   2. rebuilds every project's L0 state card (deterministic, no LLM),
 *   3. maintains L2 project briefs for a bounded number of projects whose
 *      digests moved since their last brief — distill (template
 *      'project_state') then deposit-maintain merge, reusing the two
 *      existing agent kinds. Without a configured LLM the brief degrades to
 *      the L0 card rendered as Markdown, so the feature never goes blank.
 */

const SCAN_DEBOUNCE_MS = 5_000;
const MAX_BRIEF_PROJECTS_PER_SCAN = 2;
const MIN_BRIEF_INTERVAL_MS = 10 * 60_000;
const DIGEST_TRANSCRIPT_BUDGET_CHARS = 12_000;

/** Storage surface the service needs; CaptureService implements it. */
export interface ProjectMemoryStore {
  refreshForkLineage(): number;
  rebuildProjectStates(): number;
  listProjectStates(): ProjectState[];
  getProjectState(projectKey: string): ProjectState | null;
  getProjectBrief(projectKey: string): ProjectBrief | null;
  upsertProjectBrief(brief: ProjectBrief): void;
  listSessionDigestsForProject(projectKey: string): SessionDigest[];
  projectLabel(projectKey: string): string;
}

export interface ProjectMemoryAgentRunner {
  run(request: AgentRunRequest, options?: { persist?: boolean }): Promise<AgentResult>;
}

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - 20))}…`;
}

/**
 * Distill input: the L0 card plus every session digest (newest first), fit
 * into the character budget. Pure and exported for tests.
 */
export function buildProjectBriefTranscript(
  state: ProjectState,
  projectLabel: string,
  digests: SessionDigest[],
  budgetChars = DIGEST_TRANSCRIPT_BUDGET_CHARS,
): string {
  const parts: string[] = [
    `项目：${projectLabel}（${state.projectKey}）`,
    '',
    '【L0 当前状态卡】',
    renderProjectStateMarkdown(state, projectLabel),
    '',
    '【会话摘要（新→旧）】',
  ];
  let used = parts.join('\n').length;
  for (const digest of digests) {
    const block = [
      `--- 会话 ${digest.sessionId}（${digest.updatedAt.slice(0, 10)}）`,
      digest.oneLiner ? `一句话：${digest.oneLiner}` : '',
      digest.keyTopics.length ? `主题：${digest.keyTopics.join('、')}` : '',
      digest.keyFiles.length ? `关键文件：${digest.keyFiles.join('、')}` : '',
      digest.decisions.length ? `决策：${digest.decisions.join('；')}` : '',
      digest.openQuestions.length ? `未决：${digest.openQuestions.join('；')}` : '',
    ].filter(Boolean).join('\n');
    if (used + block.length > budgetChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n');
}

export class ProjectMemoryService {
  private scanTimer: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  private lastBriefAt = new Map<string, number>();

  constructor(
    private readonly store: ProjectMemoryStore,
    private readonly agent: ProjectMemoryAgentRunner,
  ) {}

  /** Capture-sync hook: debounced L0 rebuild + bounded L2 maintenance. */
  requestScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.runOnce().catch(() => undefined);
    }, SCAN_DEBOUNCE_MS);
    this.scanTimer.unref?.();
  }

  /** One full pass; re-entrant calls share the in-flight scan. */
  async runOnce(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.run();
    try {
      await this.scanning;
    } finally {
      this.scanning = null;
    }
  }

  private async run(): Promise<void> {
    try {
      this.store.refreshForkLineage();
    } catch { /* lineage detection is best-effort */ }
    this.store.rebuildProjectStates();

    const candidates = this.store
      .listProjectStates()
      .filter(state => this.needsBrief(state))
      .slice(0, MAX_BRIEF_PROJECTS_PER_SCAN);
    for (const state of candidates) {
      try {
        await this.maintainBrief(state);
      } catch { /* one project's failure must not block the others */ }
    }
  }

  /** A brief is due when digests moved since the last brief and the per-
   * project rate limit allows another LLM pass. */
  private needsBrief(state: ProjectState): boolean {
    const digests = this.store.listSessionDigestsForProject(state.projectKey);
    if (digests.length === 0) return false;
    const brief = this.store.getProjectBrief(state.projectKey);
    if (brief) {
      const newestDigest = digests[0]?.updatedAt ?? '';
      if (newestDigest <= brief.updatedAt) return false;
    }
    const lastRun = this.lastBriefAt.get(state.projectKey) ?? 0;
    return Date.now() - lastRun >= MIN_BRIEF_INTERVAL_MS;
  }

  private async maintainBrief(state: ProjectState): Promise<void> {
    this.lastBriefAt.set(state.projectKey, Date.now());
    const label = this.store.projectLabel(state.projectKey);
    const digests = this.store.listSessionDigestsForProject(state.projectKey);
    const previous = this.store.getProjectBrief(state.projectKey);
    const now = new Date().toISOString();

    let contentMarkdown: string;
    let ops: DepositMaintainOp[] = [];
    try {
      const transcript = buildProjectBriefTranscript(state, label, digests);
      const distilled = await this.agent.run(
        {
          kind: 'distill',
          sessionId: `project:${state.projectKey}`,
          template: 'project_state',
          transcriptOverride: transcript,
        },
        { persist: false },
      );
      if (previous?.contentMarkdown) {
        // mem0-style merge: minimal ops over the old brief, keeping structure.
        const maintained = await this.agent.run(
          {
            kind: 'deposit-maintain',
            sessionId: `project:${state.projectKey}`,
            transcriptOverride: buildDepositMaintainTranscript(previous.contentMarkdown, distilled.content),
          },
          { persist: false },
        );
        const payload = parseDepositMaintainPayload(maintained.content);
        contentMarkdown = payload.merged_markdown;
        ops = payload.ops;
      } else {
        contentMarkdown = distilled.content;
      }
    } catch {
      // LLM unconfigured/outage: degrade to the deterministic L0 render.
      // Never overwrite a real brief with the fallback — it would lose the
      // LLM-maintained content; only fill the gap when no brief exists.
      if (previous) return;
      contentMarkdown = renderProjectStateMarkdown(state, label);
    }

    if (previous && previous.contentMarkdown === contentMarkdown) return;
    this.store.upsertProjectBrief({
      projectKey: state.projectKey,
      contentMarkdown: clip(contentMarkdown, 50_000),
      version: (previous?.version ?? 0) + 1,
      lastOps: JSON.stringify(ops),
      updatedAt: now,
    });
  }
}
