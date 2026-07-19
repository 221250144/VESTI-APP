import { deriveProjectKey, serializeVector } from '@vesti/capture-core';
import type { SessionDigest } from '@vesti/capture-core';
import type {
  AgentResult,
  AgentRunRequest,
  SessionDetail,
  SessionMessage,
} from '../shared/contracts';
import { parseDigestPayload, type DigestPayload } from './agentPrompts';

/**
 * Digest pipeline (P1.5): after each capture sync, sessions that are new or
 * grew since their last digest are queued (deduped, processed serially) and
 * summarized by the 'digest' agent kind into session_digests. LLM outages
 * degrade to a structural row (first user message as one_liner) — capture is
 * never blocked by digest failures. Bump DIGEST_VERSION when the digest
 * prompt structure changes; stale versions are regenerated automatically.
 */
export const DIGEST_VERSION = 1;

const RECENT_MESSAGE_LIMIT = 60;
const TRANSCRIPT_BUDGET_CHARS = 6_000;
const FALLBACK_ONE_LINER_CHARS = 100;
const TOOL_OUTPUT_CHARS = 200;
const MAX_RETRIES = 2;
const SCAN_DEBOUNCE_MS = 2_000;

/** Storage surface the pipeline needs; CaptureService implements it. */
export interface DigestSessionStore {
  getSession(id: string): SessionDetail | null;
  listSessionsNeedingDigest(digestVersion: number): Array<{ id: string; messageCount: number }>;
  upsertSessionDigest(digest: SessionDigest): void;
}

export interface DigestAgentRunner {
  run(request: AgentRunRequest, options?: { persist?: boolean }): Promise<AgentResult>;
}

export interface DigestEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

function formatDigestMessage(message: SessionMessage): string {
  const values = [
    message.contentText,
    message.contentToolName ? `工具：${message.contentToolName}` : undefined,
    message.contentToolOutput ? `工具结果：${message.contentToolOutput.slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
    message.contentToolError ? `工具错误：${message.contentToolError.slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  if (!values.length) return '';
  const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'AI' : '系统';
  return `${role}：${values.join('；')}`;
}

/**
 * Transcript from the most recent messages (newest wins): walk backwards
 * from the tail and prepend until the character budget is exhausted.
 */
export function buildDigestTranscript(
  messages: SessionMessage[],
  budgetChars = TRANSCRIPT_BUDGET_CHARS,
  recentLimit = RECENT_MESSAGE_LIMIT,
): string {
  const recent = messages.slice(-recentLimit);
  const parts: string[] = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const formatted = formatDigestMessage(recent[index]);
    if (!formatted) continue;
    // Stop at the budget once at least the newest message is included.
    if (used + formatted.length > budgetChars && parts.length > 0) break;
    parts.unshift(formatted);
    used += formatted.length;
  }
  return parts.join('\n');
}

export class DigestService {
  private queue: string[] = [];
  private queued = new Set<string>();
  private retryCounts = new Map<string, number>();
  private pumpPromise: Promise<void> | null = null;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: DigestSessionStore,
    private readonly agent: DigestAgentRunner,
    private readonly embedding: DigestEmbedder,
  ) {}

  /** Initial backfill scan at startup. */
  start(): void {
    void this.enqueuePending().catch(() => undefined);
  }

  /** Capture-sync hook: debounced re-scan for new or grown sessions. */
  requestScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.enqueuePending().catch(() => undefined);
    }, SCAN_DEBOUNCE_MS);
    this.scanTimer.unref?.();
  }

  /** Scan for sessions needing a digest, enqueue them, and wait for the
   * queue to drain. */
  async enqueuePending(): Promise<void> {
    for (const candidate of this.store.listSessionsNeedingDigest(DIGEST_VERSION)) {
      this.enqueue(candidate.id);
    }
    await this.pumpPromise;
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.kick();
  }

  private kick(): void {
    if (this.pumpPromise) return;
    this.pumpPromise = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        try {
          await this.process(id);
          this.retryCounts.delete(id);
          this.queued.delete(id);
        } catch {
          // Unexpected failure (e.g. storage): retry up to MAX_RETRIES times,
          // then leave a 'failed' row so the session is retried only when it
          // grows again — never loop forever on a broken session.
          const retries = (this.retryCounts.get(id) ?? 0) + 1;
          this.retryCounts.set(id, retries);
          if (retries <= MAX_RETRIES) {
            this.queue.push(id);
          } else {
            this.retryCounts.delete(id);
            this.queued.delete(id);
            this.writeFailedRow(id);
          }
        }
      }
    } finally {
      this.pumpPromise = null;
    }
  }

  private async process(sessionId: string): Promise<void> {
    const detail = this.store.getSession(sessionId);
    if (!detail || detail.messages.length === 0) return;
    const transcript = buildDigestTranscript(detail.messages);
    if (!transcript.trim()) return;

    // LLM digest: one retry on bad/unreachable output, then degrade.
    let payload: DigestPayload | null = null;
    for (let attempt = 0; attempt < 2 && !payload; attempt += 1) {
      try {
        const result = await this.agent.run(
          { kind: 'digest', sessionId, transcriptOverride: transcript },
          { persist: false },
        );
        payload = parseDigestPayload(result.content);
      } catch {
        payload = null;
      }
    }

    const base = this.baseDigest(detail);
    if (!payload) {
      // Degraded row: structural fallback, no embedding attempted.
      this.store.upsertSessionDigest({
        ...base,
        oneLiner: this.fallbackOneLiner(detail.messages),
        embeddingStatus: 'skipped',
      });
      return;
    }

    // Embed the digest text (one_liner + topics); outages mark 'skipped'.
    let embedding: Buffer | null = null;
    let embeddingStatus: SessionDigest['embeddingStatus'] = 'skipped';
    try {
      const [vector] = await this.embedding.embed([
        [payload.one_liner, ...payload.key_topics].join('\n'),
      ]);
      if (vector) {
        embedding = serializeVector(vector);
        embeddingStatus = 'ok';
      }
    } catch {
      embeddingStatus = 'skipped';
    }

    this.store.upsertSessionDigest({
      ...base,
      oneLiner: payload.one_liner,
      keyTopics: payload.key_topics,
      keyFiles: payload.key_files,
      decisions: payload.decisions,
      openQuestions: payload.open_questions,
      embedding,
      embeddingStatus,
    });
  }

  private baseDigest(detail: SessionDetail): SessionDigest {
    const session = detail.session;
    // detail.session is a full WorkSession at runtime; the contract type only
    // exposes the summary subset.
    const extended = session as { host?: string; gitRemote?: string };
    const host = extended.host ?? 'native';
    return {
      sessionId: session.id,
      host,
      platform: session.platform,
      projectKey: deriveProjectKey({
        platform: session.platform,
        host,
        projectPath: session.projectPath ?? '',
        gitRemote: extended.gitRemote,
      }),
      oneLiner: '',
      keyTopics: [],
      keyFiles: [],
      decisions: [],
      openQuestions: [],
      embedding: null,
      embeddingStatus: 'none',
      digestVersion: DIGEST_VERSION,
      messageCount: session.messageCount || detail.messages.length,
      updatedAt: new Date().toISOString(),
    };
  }

  private fallbackOneLiner(messages: SessionMessage[]): string {
    const firstUser = messages.find(message => message.role === 'user' && message.contentText?.trim());
    const text = (firstUser?.contentText ?? messages[0]?.contentText ?? '').replace(/\s+/g, ' ').trim();
    return text.slice(0, FALLBACK_ONE_LINER_CHARS);
  }

  private writeFailedRow(sessionId: string): void {
    try {
      const detail = this.store.getSession(sessionId);
      if (!detail) return;
      this.store.upsertSessionDigest({
        ...this.baseDigest(detail),
        oneLiner: this.fallbackOneLiner(detail.messages),
        embeddingStatus: 'failed',
      });
    } catch { /* the digest pipeline must never break capture */ }
  }
}
