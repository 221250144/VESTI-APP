// P6 capsule dock: pure logic behind the new capsule IPC surface — relay
// handoff draft assembly (local template, no LLM), prompt snapshot
// validation, prompt search merging and quick-ask context building. Kept
// free of Electron/service imports so the root vitest runner can cover it.

import type {
  CapsulePromptHit,
  CapsulePromptSnapshot,
  CapsulePromptSnapshotEntry,
  CapsuleRelayDraftRequest,
} from '../shared/contracts';

export const CAPSULE_DRAFT_MAX_SESSIONS = 20;
/** Draft stays under the extension outbox cap (20K) with headroom. */
export const CAPSULE_DRAFT_BUDGET_CHARS = 18_000;
export const CAPSULE_SEARCH_LIMIT = 8;
export const PROMPT_SNAPSHOT_MAX_ENTRIES = 300;
export const CAPSULE_QUICK_ASK_MAX_CHARS = 2_000;

export type CapsuleDraftLanguage = 'zh-CN' | 'en-US';

// ---- Input validation (IPC boundary) ----

const SESSION_ID_PATTERN = /^[\w:.-]+$/;

export function isCapsuleSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 2
    && value.length < 240
    && SESSION_ID_PATTERN.test(value);
}

export function normalizeRelayDraftRequest(value: unknown): CapsuleRelayDraftRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Partial<CapsuleRelayDraftRequest>;
  if (typeof request.platform !== 'string' || !request.platform.trim() || request.platform.length > 64) return null;
  if (typeof request.host !== 'string' || !request.host.trim() || request.host.length > 128) return null;
  if (typeof request.projectKey !== 'string' || !request.projectKey.trim() || request.projectKey.length > 300) return null;
  if (request.sessionIds !== undefined) {
    if (!Array.isArray(request.sessionIds)
      || request.sessionIds.length > CAPSULE_DRAFT_MAX_SESSIONS
      || !request.sessionIds.every(isCapsuleSessionId)) {
      return null;
    }
  }
  return {
    platform: request.platform.trim(),
    host: request.host.trim(),
    projectKey: request.projectKey.trim(),
    ...(request.sessionIds ? { sessionIds: [...new Set(request.sessionIds)] } : {}),
  };
}

// ---- Relay draft assembly (local template, LLM-free) ----

export interface CapsuleDraftDigest {
  oneLiner: string | null;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface CapsuleDraftSessionInput {
  sessionId: string;
  title: string;
  platform: string;
  projectLabel: string;
  lastActivityAt: number;
  gitBranch: string | null;
  gitRemote: string | null;
  digest: CapsuleDraftDigest | null;
  /** Last-resort context for sessions without a digest (recent excerpts). */
  recentMessages: Array<{ role: string; content: string }>;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function joinList(items: string[] | undefined, maxItems: number): string {
  return (items ?? [])
    .map(collapseWhitespace)
    .filter(Boolean)
    .slice(0, maxItems)
    .join('、');
}

function isoDate(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dedupeKeyFiles(sessions: CapsuleDraftSessionInput[], maxItems = 12): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const session of sessions) {
    for (const file of session.digest?.keyFiles ?? []) {
      const normalized = collapseWhitespace(file);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(normalized);
      if (files.length >= maxItems) return files;
    }
  }
  return files;
}

interface OpenQuestionEntry {
  question: string;
  sessionTitle: string;
}

function collectOpenQuestions(sessions: CapsuleDraftSessionInput[], maxItems = 10): OpenQuestionEntry[] {
  const entries: OpenQuestionEntry[] = [];
  for (const session of sessions) {
    for (const question of session.digest?.openQuestions ?? []) {
      const normalized = collapseWhitespace(question);
      if (!normalized) continue;
      entries.push({ question: normalized, sessionTitle: session.title });
      if (entries.length >= maxItems) return entries;
    }
  }
  return entries;
}

/**
 * Assemble the capsule handoff draft: project/session roster + digest
 * highlights + cross-session deduped key files + open questions. Pure
 * template — always available, with or without an LLM configured.
 */
export function assembleCapsuleRelayDraft(
  sessions: CapsuleDraftSessionInput[],
  options: { language: CapsuleDraftLanguage; projectLabel: string; budgetChars?: number },
): { text: string } {
  const budget = options.budgetChars ?? CAPSULE_DRAFT_BUDGET_CHARS;
  const english = options.language === 'en-US';
  const label = truncateText(options.projectLabel || sessions[0]?.projectLabel || '', 80)
    || (english ? 'Selected scope' : '所选范围');

  const rosterTitle = english ? '## Session roster' : '## 会话清单';
  const highlightsTitle = english ? '## Highlights' : '## 要点';
  const keyFilesTitle = english ? '## Key files (deduped across sessions)' : '## 关键文件（跨会话去重）';
  const openQuestionsTitle = english ? '## Open questions' : '## 未决事项汇总';

  const header = english
    ? `# Handoff context · ${label} (${sessions.length} session${sessions.length === 1 ? '' : 's'})\n> Assembled locally by the Vesti capsule (no AI compression yet).`
    : `# 交接上下文 · ${label}（${sessions.length} 个会话）\n> 由 Vesti 悬浮球本地拼装（尚未经 AI 压缩）。`;

  const roster = sessions.map((session, index) => {
    const date = isoDate(session.lastActivityAt);
    const oneLiner = session.digest?.oneLiner?.trim();
    const when = date ? ` · ${date}` : '';
    const line = `${index + 1}. 《${truncateText(session.title || (english ? 'Untitled session' : '未命名会话'), 80)}》（${session.platform}${when}）`;
    return oneLiner ? `${line}\n   ${english ? 'In one line: ' : '一句话：'}${truncateText(oneLiner, 120)}` : line;
  });

  const highlights = sessions.map((session, index) => {
    const title = `### ${index + 1}. 《${truncateText(session.title || (english ? 'Untitled session' : '未命名会话'), 80)}》`;
    const lines: string[] = [title];
    const git = [session.gitBranch?.trim(), session.gitRemote?.trim()].filter(Boolean).join(' · ');
    if (git) lines.push(`- Git：${truncateText(git, 200)}`);
    const digest = session.digest;
    const hasDigest = Boolean(
      digest?.oneLiner
      || (digest?.keyTopics.length ?? 0) > 0
      || (digest?.decisions.length ?? 0) > 0
      || (digest?.openQuestions.length ?? 0) > 0,
    );
    if (hasDigest && digest) {
      if (digest.oneLiner) lines.push(`- ${english ? 'One-liner' : '一句话'}：${truncateText(digest.oneLiner, 160)}`);
      const topics = joinList(digest.keyTopics, 6);
      if (topics) lines.push(`- ${english ? 'Key topics' : '关键主题'}：${topics}`);
      const decisions = joinList(digest.decisions, 6);
      if (decisions) lines.push(`- ${english ? 'Decisions' : '关键决策'}：${decisions}`);
      const openQuestions = joinList(digest.openQuestions, 6);
      if (openQuestions) lines.push(`- ${english ? 'Open questions' : '未决问题'}：${openQuestions}`);
    } else {
      // No digest yet: fall back to the session's recent message excerpts so
      // the draft never carries a voiceless session.
      const excerpts = session.recentMessages
        .filter(message => message.content.trim())
        .slice(-2)
        .map((message) => {
          const role = message.role === 'user'
            ? (english ? 'User' : '用户')
            : (english ? 'AI' : 'AI');
          return `  - [${role}] ${truncateText(message.content, 200)}`;
        });
      if (excerpts.length > 0) {
        lines.push(`- ${english ? 'Recent messages' : '最近消息'}：`);
        lines.push(...excerpts);
      } else {
        lines.push(`- ${english ? '(no digest yet)' : '（暂无索引摘要）'}`);
      }
    }
    return lines.join('\n');
  });

  const keyFiles = dedupeKeyFiles(sessions);
  const openQuestions = collectOpenQuestions(sessions);

  const blocks: string[] = [header, rosterTitle, roster.join('\n'), highlightsTitle, highlights.join('\n\n')];
  if (keyFiles.length > 0) blocks.push(keyFilesTitle, keyFiles.map(file => `- ${file}`).join('\n'));
  if (openQuestions.length > 0) {
    blocks.push(
      openQuestionsTitle,
      openQuestions
        .map((entry, index) => `${index + 1}. ${entry.question}（${english ? 'from' : '来自'}《${truncateText(entry.sessionTitle, 40)}》）`)
        .join('\n'),
    );
  }

  const text = blocks.join('\n\n');
  if (text.length <= budget) return { text };
  const marker = english ? '\n[context truncated]' : '\n[上下文已截断]';
  return { text: `${text.slice(0, Math.max(0, budget - marker.length))}${marker}` };
}

// ---- Prompt snapshot (renderer-written, capsule-read cache) ----

function asTrimmedString(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function asTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(tag => asTrimmedString(tag, 50))
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Validate + normalize a prompt snapshot coming over IPC or read from disk.
 * Caps every field so a malformed cache can never blow up the capsule.
 * Returns null when the value is not a recognizable snapshot at all.
 */
export function normalizePromptSnapshot(value: unknown): CapsulePromptSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CapsulePromptSnapshot>;
  if (!Array.isArray(candidate.prompts)) return null;
  const prompts: CapsulePromptSnapshotEntry[] = [];
  for (const item of candidate.prompts) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<CapsulePromptSnapshotEntry>;
    const title = asTrimmedString(entry.title, 200);
    const body = asTrimmedString(entry.body, 8_000);
    if (!title || !body) continue;
    prompts.push({
      id: asTrimmedString(entry.id, 128) || `prompt-${prompts.length + 1}`,
      title,
      description: asTrimmedString(entry.description, 500),
      tags: asTagList(entry.tags),
      body,
      source: asTrimmedString(entry.source, 200) || 'manual',
    });
    if (prompts.length >= PROMPT_SNAPSHOT_MAX_ENTRIES) break;
  }
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? candidate.updatedAt
    : Date.now();
  return { updatedAt, prompts };
}

export function promptSnapshotFileName(): string {
  return 'prompt-snapshot.json';
}

// ---- Prompt search (curated catalog + user snapshot) ----

export interface CapsuleCuratedPromptInput {
  id: string;
  title: string;
  body: string;
  description?: string;
  tags?: string[];
  source: string;
}

function matchesQuery(fields: string[], query: string): boolean {
  return fields.some(field => field.toLowerCase().includes(query));
}

/**
 * Merge user prompts (snapshot) with the curated catalog and filter by a
 * free-text query (title/body/description/tags/category). User prompts rank
 * first — they are personal; curated entries follow.
 */
export function searchCapsulePrompts(options: {
  query: string;
  curated: CapsuleCuratedPromptInput[];
  snapshot: CapsulePromptSnapshot | null;
  limit?: number;
}): CapsulePromptHit[] {
  const limit = options.limit ?? CAPSULE_SEARCH_LIMIT;
  const query = options.query.trim().toLowerCase();

  const userHits: CapsulePromptHit[] = (options.snapshot?.prompts ?? [])
    .filter(entry => !query
      || matchesQuery([entry.title, entry.body, entry.description, ...entry.tags, entry.source], query))
    .map(entry => ({
      id: entry.id,
      title: entry.title,
      description: entry.description,
      tags: entry.tags,
      body: entry.body,
      origin: 'user' as const,
      source: entry.source,
    }));

  const curatedHits: CapsulePromptHit[] = options.curated
    .filter(entry => !query
      || matchesQuery([entry.title, entry.body, entry.description ?? '', ...(entry.tags ?? []), entry.source], query))
    .map(entry => ({
      id: entry.id,
      title: entry.title,
      description: entry.description ?? '',
      tags: entry.tags ?? [],
      body: entry.body,
      origin: 'curated' as const,
      source: entry.source,
    }));

  return [...userHits, ...curatedHits].slice(0, limit);
}

// ---- Quick ask (recall-grounded explore) ----

export interface CapsuleQuickAskHit {
  title: string;
  oneLiner: string | null;
  snippet: string;
}

/**
 * Compact recall context for the explore agent kind: title + one-liner +
 * snippet per recalled session, capped to stay well under the transcript cap.
 */
export function buildQuickAskTranscript(
  hits: CapsuleQuickAskHit[],
  options: { language: CapsuleDraftLanguage; budgetChars?: number },
): string {
  const budget = options.budgetChars ?? 12_000;
  const english = options.language === 'en-US';
  if (hits.length === 0) {
    return english
      ? '(No archived conversations were recalled for this question.)'
      : '（没有为该问题召回到任何已归档会话。）';
  }
  const blocks = hits.map((hit, index) => {
    const lines = [`${index + 1}. 《${truncateText(hit.title || (english ? 'Untitled' : '未命名会话'), 80)}》`];
    if (hit.oneLiner?.trim()) {
      lines.push(`${english ? 'One-liner' : '一句话'}：${truncateText(hit.oneLiner, 200)}`);
    }
    if (hit.snippet.trim()) {
      lines.push(`${english ? 'Excerpt' : '片段'}：${truncateText(hit.snippet, 500)}`);
    }
    return lines.join('\n');
  });
  const header = english
    ? 'Recalled conversation excerpts (local archive):'
    : '召回的历史会话片段（本地归档）：';
  const text = `${header}\n\n${blocks.join('\n\n')}`;
  if (text.length <= budget) return text;
  const marker = english ? '\n[context truncated]' : '\n[上下文已截断]';
  return `${text.slice(0, Math.max(0, budget - marker.length))}${marker}`;
}
