import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConversationExportBundle, DataContributionState } from '../shared/contracts';
import { computeBundleFingerprint } from '../shared/exportFingerprint';
import { demoOpenAiBase } from './chatStream';
import { sessionContainsPii } from './piiFilter';
import { DEMO_BASE_URL, DEMO_SERVICE_TOKEN } from './settingsService';

export const CONTRIBUTION_BATCH_SIZE = 20;
export const CONTRIBUTION_INTERVAL_MS = 30 * 60_000;
export const CONTRIBUTION_INITIAL_DELAY_MS = 90_000;
export const CONTRIBUTION_REQUEST_DEBOUNCE_MS = 60_000;
export const CONTRIBUTION_UPLOAD_TIMEOUT_MS = 30_000;

/** Narrow capture surface the uploader needs (fakeable in tests). */
export interface ContributionCaptureSource {
  exportAllConversationBundles(): ConversationExportBundle[];
}

/** Narrow membership surface: the consent gate + anonymous contributor id. */
export interface ContributionMembershipSource {
  getDataContribution(): DataContributionState;
  getContributorId(): Promise<string | null>;
}

export interface ContributionServiceOptions {
  captureService: ContributionCaptureSource;
  membershipService: ContributionMembershipSource;
  /** Persistent incremental state, e.g. <dataDir>/contribution-state.json. */
  stateFilePath: string;
  /** Demo gateway base (may end in /api — mapped to /v1 like chat streams). */
  gatewayBase?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
  initialDelayMs?: number;
  requestDebounceMs?: number;
  uploadTimeoutMs?: number;
}

interface ContributionState {
  /** sessionId -> fingerprint of the last successfully uploaded snapshot. */
  uploaded: Record<string, number>;
  /** sessionId -> fingerprint of the last PII-hit snapshot (re-checked on change). */
  excluded: Record<string, number>;
  /** Clean snapshots awaiting upload; one entry per session, newest wins. */
  pending: ConversationExportBundle[];
  lastRunAt: number | null;
}

/**
 * RL data-contribution uploader (docs/PRIVACY-DATA-CONTRIBUTION.md).
 *
 * Uploads captured agent/CLI conversation bundles to the Vesti gateway —
 * only while the local membership account has explicitly consented
 * (membershipService.getDataContribution().enabled). Browser-extension data
 * never enters this pipeline: the capture SQLite store only holds CLI/agent
 * sessions. Sessions hitting the PII filter are excluded whole.
 *
 * Silent by design: every failure is swallowed (console.warn) and retried on
 * the next round — the user is never interrupted by telemetry.
 */
export class ContributionService {
  private readonly capture: ContributionCaptureSource;
  private readonly membership: ContributionMembershipSource;
  private readonly stateFilePath: string;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly requestDebounceMs: number;
  private readonly uploadTimeoutMs: number;
  private state: ContributionState = { uploaded: {}, excluded: {}, pending: [], lastRunAt: null };
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private requestTimer: NodeJS.Timeout | null = null;

  constructor(options: ContributionServiceOptions) {
    this.capture = options.captureService;
    this.membership = options.membershipService;
    this.stateFilePath = options.stateFilePath;
    const base = (options.gatewayBase ?? DEMO_BASE_URL).replace(/\/+$/, '');
    // /v1/collect/sessions lives on the gateway's OpenAI-style surface, so
    // the legacy /api suffix maps to /v1 exactly like the chat endpoints.
    this.endpoint = `${demoOpenAiBase(base)}/collect/sessions`;
    this.token = options.token ?? DEMO_SERVICE_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? CONTRIBUTION_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? CONTRIBUTION_INITIAL_DELAY_MS;
    this.requestDebounceMs = options.requestDebounceMs ?? CONTRIBUTION_REQUEST_DEBOUNCE_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? CONTRIBUTION_UPLOAD_TIMEOUT_MS;
  }

  /** Startup schedule: first round after a short delay, then on interval. */
  start(): void {
    if (this.initialTimer || this.intervalTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.runOnce();
      this.intervalTimer = setInterval(() => void this.runOnce(), this.intervalMs);
      this.intervalTimer.unref?.();
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    this.requestTimer = null;
  }

  /** Debounced trigger for the capture-sync hook: freshly stored captures run
   * a round soon after they land, without rebuilding bundles on every store. */
  requestRun(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      void this.runOnce();
    }, this.requestDebounceMs);
    this.requestTimer.unref?.();
  }

  /**
   * One diff → PII-filter → upload round. Serialized so timer ticks and
   * capture-sync triggers chain instead of overlapping. Never rejects.
   */
  runOnce(): Promise<void> {
    const run = this.queue.catch(() => undefined).then(() => this.runOnceInner());
    this.queue = run;
    return run;
  }

  private async runOnceInner(): Promise<void> {
    try {
      await this.loadState();
      this.state.lastRunAt = this.now();
      if (!this.membership.getDataContribution().enabled) {
        // Consent withdrawn (or never given): drop the queue so a later
        // opt-in never replays snapshots captured before consent.
        if (this.state.pending.length > 0) {
          this.state.pending = [];
          await this.persistState();
        }
        return;
      }
      const contributorId = await this.membership.getContributorId();
      if (!contributorId) return;
      this.collectPending(this.capture.exportAllConversationBundles());
      await this.persistState();
      await this.uploadPending(contributorId);
      await this.persistState();
    } catch (error) {
      console.warn('[vesti] data contribution round failed; will retry next round:', error);
    }
  }

  /** Diff freshly built bundles against persisted fingerprints, PII-filter
   * the changed ones, and merge survivors into the pending queue. */
  private collectPending(bundles: ConversationExportBundle[]): void {
    const pendingById = new Map(this.state.pending.map(bundle => [bundle.conversation._cli_id, bundle]));
    for (const bundle of bundles) {
      const sessionId = bundle.conversation._cli_id;
      const fingerprint = computeBundleFingerprint(bundle.conversation, bundle.messages);
      if (this.state.uploaded[sessionId] === fingerprint) continue;
      // Unchanged since the last PII hit — excluded sessions are re-checked
      // only when their content actually moves.
      if (this.state.excluded[sessionId] === fingerprint) continue;
      if (sessionContainsPii(bundle) !== null) {
        this.state.excluded[sessionId] = fingerprint;
        // A PII hit supersedes any older queued snapshot of the same session.
        pendingById.delete(sessionId);
        continue;
      }
      pendingById.set(sessionId, bundle);
    }
    this.state.pending = [...pendingById.values()];
  }

  /** Upload pending batches sequentially. A failed batch keeps itself and the
   * rest of the queue pending for the next round; only successfully uploaded
   * sessions get their fingerprint stamped. */
  private async uploadPending(contributorId: string): Promise<void> {
    while (this.state.pending.length > 0) {
      const batch = this.state.pending.slice(0, CONTRIBUTION_BATCH_SIZE);
      await this.postBatch(contributorId, batch);
      for (const bundle of batch) {
        const sessionId = bundle.conversation._cli_id;
        this.state.uploaded[sessionId] = computeBundleFingerprint(bundle.conversation, bundle.messages);
      }
      this.state.pending = this.state.pending.slice(batch.length);
      await this.persistState();
    }
  }

  private async postBatch(contributorId: string, sessions: ConversationExportBundle[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.uploadTimeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vesti-service-token': this.token,
        },
        body: JSON.stringify({ contributorId, sessions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`collect endpoint answered HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.stateFilePath, 'utf8'));
      this.state = normalizeContributionState(parsed);
    } catch {
      // Missing or corrupt state file: start fresh. Re-uploads are safe —
      // fingerprints rebuild from the capture store on the first round.
    }
  }

  private async persistState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const temporaryPath = `${this.stateFilePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(this.state), 'utf8');
    try {
      await fs.rename(temporaryPath, this.stateFilePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EEXIST', 'EPERM'].includes(code ?? '')) throw error;
      // Windows may refuse replacing an existing destination via rename.
      await fs.rm(this.stateFilePath, { force: true });
      await fs.rename(temporaryPath, this.stateFilePath);
    }
  }
}

function normalizeContributionState(value: unknown): ContributionState {
  const state: ContributionState = { uploaded: {}, excluded: {}, pending: [], lastRunAt: null };
  if (!isRecord(value)) return state;
  state.uploaded = normalizeFingerprintMap(value.uploaded);
  state.excluded = normalizeFingerprintMap(value.excluded);
  if (Array.isArray(value.pending)) {
    state.pending = value.pending.filter(isConversationExportBundle);
  }
  if (typeof value.lastRunAt === 'number' && Number.isFinite(value.lastRunAt)) {
    state.lastRunAt = value.lastRunAt;
  }
  return state;
}

function normalizeFingerprintMap(value: unknown): Record<string, number> {
  const map: Record<string, number> = {};
  if (!isRecord(value)) return map;
  for (const [key, fingerprint] of Object.entries(value)) {
    if (typeof fingerprint === 'number' && Number.isFinite(fingerprint)) map[key] = fingerprint;
  }
  return map;
}

function isConversationExportBundle(value: unknown): value is ConversationExportBundle {
  if (!isRecord(value) || !isRecord(value.conversation) || !Array.isArray(value.messages)) return false;
  const sessionId = value.conversation._cli_id;
  return typeof sessionId === 'string' && sessionId.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
