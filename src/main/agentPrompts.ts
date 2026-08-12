import type { DistillTemplate } from '../shared/contracts';
import { parseDepositMaintainPayload } from '../shared/depositMaintain';
import { parseDreamExtractPayload, parseDreamMaintainPayload } from '../shared/dreamMaintain';
import type { RuntimeAgentSettings } from './settingsService';

export interface AgentPromptInput {
  transcript: string;
  question?: string;
  /** Prompt variant selector for parameterized kinds (distill template). */
  template?: string;
  preferences: RuntimeAgentSettings;
}

export interface AgentChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AgentKindDefinition {
  buildPrompt(input: AgentPromptInput): AgentChatMessage[];
  parse?(raw: string): string;
}

const registry = new Map<string, AgentKindDefinition>();

/**
 * Agent kind registry. To add a kind: extend AgentKind in shared/contracts,
 * accept it in main.ts's validAgentRequest, then register a definition here.
 */
export function registerAgentKind(kind: string, definition: AgentKindDefinition): void {
  registry.set(kind, definition);
}

export function getAgentKindDefinition(kind: string): AgentKindDefinition {
  const definition = registry.get(kind);
  if (!definition) throw new Error(`未知的分析类型：${kind}`);
  return definition;
}

function promptAffixes(preferences: RuntimeAgentSettings): { language: string; custom: string } {
  const language = {
    'zh-CN': '使用清晰、简洁的中文 Markdown。',
    'en-US': 'Respond in clear English Markdown.',
    'ja-JP': '明確で簡潔な日本語の Markdown で回答してください。',
    'ko-KR': '명확하고 간결한 한국어 Markdown으로 답변하세요.',
  }[preferences.outputLanguage];
  const custom = preferences.customInstructions
    ? `\n用户的长期分析偏好：${preferences.customInstructions}`
    : '';
  return { language, custom };
}

registerAgentKind('summary', {
  buildPrompt({ transcript, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的会话总结助手。只能依据提供的会话，不补造事实。${language}${custom}`,
      },
      {
        // Strict ConversationSummaryV2 JSON (the shape the summaries table
        // already stores): the renderer validates + normalizes it
        // (src/ui/aiti/parseSummary.ts) and falls back to plain text when
        // the model answers prose instead.
        role: 'user',
        content: `请总结下面的会话，严格只输出一个 JSON 对象（不要 Markdown 代码块，不要任何额外文字），结构：
{
  "core_question": "一句话概括会话的核心问题",
  "thinking_journey": [{"step": 1, "speaker": "User", "assertion": "每一步的关键推进", "real_world_anchor": "对应的现实依据，没有则为 null"}],
  "key_insights": [{"term": "关键概念或结论", "definition": "一句话解释"}],
  "unresolved_threads": ["尚未解决的问题"],
  "meta_observations": {"thinking_style": "对思维风格的一句话观察", "emotional_tone": "对情绪基调的一句话观察", "depth_level": "superficial 或 moderate 或 deep"},
  "actionable_next_steps": ["建议的下一步"]
}
要求：speaker 只能是 "User" 或 "AI"；depth_level 只能是 "superficial"、"moderate"、"deep" 之一；thinking_journey 最多 10 步；key_insights 最多 8 条；没有内容的字段给空数组。

会话内容：
${transcript}`,
      },
    ];
  },
});

registerAgentKind('explore', {
  buildPrompt({ transcript, question, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的会话探索助手。仅依据提供的会话回答；区分事实、推断和建议，无法判断时明确说明。${language}${custom}`,
      },
      {
        role: 'user',
        content: `探索问题：${question || '这段会话中还有哪些值得继续探索的方向？'}\n\n会话内容：\n${transcript}`,
      },
    ];
  },
});

/**
 * Session digest (P1.5): structured index entry for the conversation tree.
 * The model must answer with strict JSON only; parse() validates and
 * normalizes the shape so downstream writes never see malformed output.
 * Bump DIGEST_VERSION in digestService.ts whenever this prompt's structure
 * changes so stale digests get regenerated.
 */
export interface DigestPayload {
  one_liner: string;
  key_topics: string[];
  key_files: string[];
  decisions: string[];
  open_questions: string[];
}

function asStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

export function parseDigestPayload(raw: string): DigestPayload {
  // Tolerate Markdown code fences around the JSON object.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('digest 输出不是 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  if (typeof parsed.one_liner !== 'string' || !parsed.one_liner.trim()) {
    throw new Error('digest 输出缺少 one_liner');
  }
  return {
    one_liner: parsed.one_liner.trim().slice(0, 200),
    key_topics: asStringList(parsed.key_topics, 8),
    key_files: asStringList(parsed.key_files, 8),
    decisions: asStringList(parsed.decisions, 8),
    open_questions: asStringList(parsed.open_questions, 8),
  };
}

registerAgentKind('digest', {
  buildPrompt({ transcript, preferences }) {
    const { language } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的会话索引助手。只依据提供的会话内容，输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: [
          '请为下面的会话生成索引摘要，内容字段使用设置中指定的输出语言，输出一个 JSON 对象，字段如下：',
          '{"one_liner": "一句话概括会话做了什么、结果如何（50 字以内）", "key_topics": ["关键主题，至多 6 个"], "key_files": ["涉及的关键文件路径，至多 6 个"], "decisions": ["已做出的决定，至多 6 条"], "open_questions": ["未解决的问题，至多 6 条"]}',
          '硬性规则：',
          '- one_liner 概括实际完成的工作与结论（如「修复了 X 的 Y 问题」「调研了 Z，结论是…」），不要复述用户的原始提问，不要以「用户要求」「请」开头。',
          '- one_liner、key_topics 和 decisions 中涉及具体数值（版本号、配置值、端口号、日期、数量、金额、时长、阈值等）时，必须原样保留数值与单位，不得概括化。反例（禁止）：把「超时时间定为 30s」写成「调整了超时参数」；把「升级到 v2.5.0」写成「升级了版本」；把「预算 1500 元」写成「讨论了预算」。正确写法：「超时时间定为 30s」「升级到 v2.5.0」「预算定为 1500 元」。',
          '- key_files 保留完整文件路径，不要只写目录名或框架名。',
          '没有内容的字段输出空数组。只输出 JSON 本身。',
          '',
          transcript,
        ].join('\n'),
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseDigestPayload(raw));
  },
});

/**
 * Auto-classify (P2a): file unclassified conversations into the manual topic
 * tree. The transcript carries the existing topic paths plus a numbered
 * candidate list; the model answers with a strict JSON array, one entry per
 * candidate. parse() validates and normalizes the shape so downstream writes
 * never see malformed output; the renderer additionally checks that every
 * ref maps back to a candidate and degrades the batch on bad output.
 */
export interface ClassifyAssignment {
  ref: number;
  topicPath: string[];
  newTopic: boolean;
  confidence: number;
}

export function parseClassifyPayload(raw: string): ClassifyAssignment[] {
  // Tolerate Markdown code fences around the JSON array.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('classify 输出不是 JSON 数组');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('classify 输出不是 JSON 数组');
  return parsed.map((item): ClassifyAssignment => {
    if (!item || typeof item !== 'object') throw new Error('classify 输出条目无效');
    const entry = item as Record<string, unknown>;
    if (typeof entry.ref !== 'number' || !Number.isInteger(entry.ref) || entry.ref < 1) {
      throw new Error('classify 输出包含非法 ref');
    }
    const topicPath = Array.isArray(entry.topicPath)
      ? entry.topicPath.map(segment => (typeof segment === 'string' ? segment.trim() : ''))
      : [];
    if (
      topicPath.length < 1 ||
      topicPath.length > 3 ||
      topicPath.some(segment => !segment)
    ) {
      throw new Error('classify 输出 topicPath 需为 1-3 层非空路径');
    }
    const confidence =
      typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : 0.5;
    return { ref: entry.ref, topicPath, newTopic: entry.newTopic === true, confidence };
  });
}

/**
 * AI relay / handoff (P4a): distill the condensed context of several selected
 * conversations into a structured handoff pack that can seed a fresh session
 * on any AI. The model answers with strict JSON only; parse() validates and
 * normalizes the shape so downstream persistence never sees malformed output.
 *
 * Schema v2 adds completed/in_progress/git_state/failed_paths/verification/
 * confidence; parse() is backward compatible — v1 output (current_state only)
 * still parses, missing v2 fields get empty defaults and never throw.
 */
export interface RelayPackKeyFile {
  path: string;
  why: string;
  last_state: string;
}

export interface RelayPackGitState {
  branch?: string;
  dirty_files: string[];
  last_commits: string[];
}

export interface RelayPackFailedPath {
  approach: string;
  why_failed: string;
}

export interface RelayPackVerification {
  commands: string[];
  last_results: string[];
}

export interface RelayPackConfidence {
  /** 0-1 overall confidence. */
  overall: number;
  low_areas: string[];
}

export interface RelayPackPayload {
  title: string;
  goal: string;
  /** v1 free-text state; v2 packs carry completed/in_progress instead and
   * leave this empty (''). */
  current_state: string;
  completed: string[];
  in_progress: string[];
  git_state: RelayPackGitState;
  key_decisions: string[];
  key_files: RelayPackKeyFile[];
  failed_paths: RelayPackFailedPath[];
  open_issues: string[];
  verification: RelayPackVerification;
  /** Verify-first checklist (V2): concrete checks the receiving AI runs
   * before building on the pack. Absent on v1 packs and when the model gave
   * no usable list. */
  verify_first?: string[];
  next_steps: string[];
  /** Absent when the model gave no usable confidence (always absent on v1). */
  confidence?: RelayPackConfidence;
  /** Deterministic file anchors (P4a quality): never produced by the model —
   * the desktop pipeline attaches them post-parse from captured tool
   * executions so the panel can badge key_files rows as anchored. */
  extracted_key_files?: Array<{
    path: string;
    touches: number;
    lastTouchedAt: number;
    conversationIds: number[];
  }>;
  suggested_prompt: string;
}

/** The suggested prompt must stay paste-ready; hard-cap it in parse. V2 packs
 * embed a condensed verify-first checklist, so the cap allows a little more
 * than the original 800. */
export const RELAY_SUGGESTED_PROMPT_MAX_CHARS = 1_200;

/**
 * Handoff framing: every suggested prompt must open with this fixed sentence
 * so the receiving AI treats the pack as another AI's summary — build on it,
 * don't redo it, and re-check the evidence at the source anchors before
 * trusting its conclusions. Pinned verbatim by the prompt template (Chinese
 * output → ZH sentence, English output → EN sentence).
 */
export const RELAY_HANDOFF_PREFIX_ZH =
  '【交接说明】以下内容来自另一个 AI 对先前工作的摘要：请在其已有成果的基础上继续，避免重复劳动；采信其中的结论之前，先回到对应的原文锚点复核证据。';
export const RELAY_HANDOFF_PREFIX_EN =
  '[Handoff] The following is another AI\'s summary of prior work: build on what is already done instead of redoing it, and before trusting any conclusion in it, go back to the referenced source anchors and re-check the evidence.';

/**
 * Verify-first handoff rule: every suggested prompt must end with this fixed
 * sentence so the receiving AI re-checks the last verification result before
 * trusting the pack. The prompt template pins the sentence verbatim (Chinese
 * output → ZH rule, English output → EN rule).
 */
export const RELAY_HANDOFF_RULE_ZH =
  '⚠️ 接手规则：在开始下一步之前，先重新验证上面「验证」部分的最后一步结果，确认无误后再信任并继续。';
export const RELAY_HANDOFF_RULE_EN =
  '⚠️ Handoff rule: before starting the next step, first re-verify the last result in the "Verification" section above; trust and continue only after it checks out.';

function asTrimmedString(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function asKeyFileList(value: unknown, maxItems: number): RelayPackKeyFile[] {
  if (!Array.isArray(value)) return [];
  const files: RelayPackKeyFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const path = asTrimmedString(entry.path, 300);
    if (!path) continue;
    files.push({
      path,
      why: asTrimmedString(entry.why, 300),
      last_state: asTrimmedString(entry.last_state, 300),
    });
    if (files.length >= maxItems) break;
  }
  return files;
}

function asGitState(value: unknown): RelayPackGitState {
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const branch = asTrimmedString(entry.branch, 200);
  return {
    ...(branch ? { branch } : {}),
    dirty_files: asStringList(entry.dirty_files, 20),
    last_commits: asStringList(entry.last_commits, 8),
  };
}

function asFailedPathList(value: unknown, maxItems: number): RelayPackFailedPath[] {
  if (!Array.isArray(value)) return [];
  const paths: RelayPackFailedPath[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const approach = asTrimmedString(entry.approach, 400);
    if (!approach) continue;
    paths.push({ approach, why_failed: asTrimmedString(entry.why_failed, 400) });
    if (paths.length >= maxItems) break;
  }
  return paths;
}

function asVerification(value: unknown): RelayPackVerification {
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    commands: asStringList(entry.commands, 12),
    last_results: asStringList(entry.last_results, 12),
  };
}

/** Confidence stays absent unless the model gave a usable 0-1 number. The
 * low-areas list arrives snake_case on v1 output, camelCase on V2. */
function asConfidence(value: unknown): RelayPackConfidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.overall !== 'number' || !Number.isFinite(entry.overall)) return undefined;
  return {
    overall: Math.min(1, Math.max(0, entry.overall)),
    low_areas: asStringList(entry.low_areas ?? entry.lowAreas, 8),
  };
}

export function parseRelayPayload(raw: string): RelayPackPayload {
  // Tolerate Markdown code fences around the JSON object.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('relay 输出不是 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const title = asTrimmedString(parsed.title, 200);
  if (!title) throw new Error('relay 输出缺少 title');
  const goal = asTrimmedString(parsed.goal, 2_000);
  if (!goal) throw new Error('relay 输出缺少 goal');
  // v1 field: v2 output leaves it out; v1 output keeps it. Never required.
  const currentState = asTrimmedString(parsed.current_state, 4_000);
  const suggestedPrompt = asTrimmedString(parsed.suggested_prompt, RELAY_SUGGESTED_PROMPT_MAX_CHARS);
  if (!suggestedPrompt) throw new Error('relay 输出缺少 suggested_prompt');
  const confidence = asConfidence(parsed.confidence);
  // Additive v2 field tolerated on v1-shaped output: only present when the
  // model actually supplied entries (never required, never throws).
  const verifyFirst = asStringList(parsed.verify_first ?? parsed.verifyFirst, 8);
  return {
    title,
    goal,
    current_state: currentState,
    completed: asStringList(parsed.completed, 12),
    in_progress: asStringList(parsed.in_progress, 12),
    git_state: asGitState(parsed.git_state),
    key_decisions: asStringList(parsed.key_decisions, 12),
    key_files: asKeyFileList(parsed.key_files, 12),
    failed_paths: asFailedPathList(parsed.failed_paths, 8),
    open_issues: asStringList(parsed.open_issues, 12),
    verification: asVerification(parsed.verification),
    ...(verifyFirst.length > 0 ? { verify_first: verifyFirst } : {}),
    next_steps: asStringList(parsed.next_steps, 12),
    ...(confidence ? { confidence } : {}),
    suggested_prompt: suggestedPrompt,
  };
}

// ---- V2 Relay Pack Parser (backward-compatible) ----------------------------

interface RelayPackDecisionV2 {
  decision: string;
  rationale: string;
}

interface RelayPackFailedPathV2 {
  approach: string;
  whyFailed: string;
  evidence: string;
}

interface RelayPackVerificationV2 {
  lastCommand: string;
  lastResult: string;
  passed: boolean;
}

interface RelayPackEnvironmentV2 {
  gitBranch?: string;
  gitRemote?: string;
  dirtyFiles?: string[];
  nodeVersion?: string;
  packageManager?: string;
}

/**
 * Parse V2 relay pack output. Auto-detects V1 vs V2 format and normalizes
 * both into the existing RelayPackPayload shape so downstream consumers
 * (RelayPanel, capsule, export) continue to work unchanged.
 */
export function parseRelayPayloadV2(raw: string): RelayPackPayload {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('relay 输出不是 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;

  // Auto-detect V2 format: meta.version === 2 and state is an object.
  const meta = (parsed.meta as Record<string, unknown> | undefined);
  const isV2 = meta?.version === 2 && typeof parsed.state === 'object' && parsed.state !== null;

  if (isV2) {
    return parseV2ToPayload(parsed);
  }
  // V1 fallback: delegate to the existing parser.
  return parseRelayPayload(raw);
}

function parseV2ToPayload(parsed: Record<string, unknown>): RelayPackPayload {
  const title = asTrimmedString(parsed.goal, 200) || asTrimmedString((parsed.meta as Record<string, unknown>)?.createdAt, 200) || 'V2 交接包';
  const goal = asTrimmedString(parsed.goal, 4_000);
  if (!goal) throw new Error('relay V2 输出缺少 goal');

  const state = (parsed.state as Record<string, unknown> | undefined) ?? {};
  const completed = asStringList(state.completed, 12);
  const inProgress = asStringList(state.inProgress, 12);
  const blocked = asStringList(state.blocked, 8);

  // V2 decisions: [{decision, rationale}] → flatten to "decision — rationale" strings
  const decisionsV2 = Array.isArray(parsed.decisions)
    ? (parsed.decisions as Array<Record<string, unknown>>)
        .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === 'object'))
        .map((d) => {
          const dec = asTrimmedString(d.decision, 300);
          const rat = asTrimmedString(d.rationale, 300);
          return rat ? `${dec} — ${rat}` : dec;
        })
        .filter(Boolean)
        .slice(0, 12)
    : [];

  // V2 failedPaths: [{approach, whyFailed, evidence}]
  const failedPathsV2 = Array.isArray(parsed.failedPaths)
    ? (parsed.failedPaths as Array<Record<string, unknown>>)
        .filter((fp): fp is Record<string, unknown> => Boolean(fp && typeof fp === 'object'))
        .map((fp) => ({
          approach: asTrimmedString(fp.approach, 400),
          why_failed: asTrimmedString(fp.whyFailed || fp.why_failed, 400),
        }))
        .filter((fp) => fp.approach)
        .slice(0, 8)
    : asFailedPathList(parsed.failedPaths || parsed.failed_paths, 8);

  // V2 verification: {lastCommand, lastResult, passed}
  const verificationV2 = (parsed.verification as Record<string, unknown> | undefined);
  const verification: RelayPackVerification = verificationV2
    ? {
        commands: verificationV2.lastCommand ? [asTrimmedString(verificationV2.lastCommand, 500)] : [],
        last_results: verificationV2.lastResult ? [asTrimmedString(verificationV2.lastResult, 500)] : [],
      }
    : { commands: [], last_results: [] };

  // V2 environment → merge into git_state
  const env = parsed.environment as RelayPackEnvironmentV2 | undefined;
  const gitState: RelayPackGitState = { dirty_files: [], last_commits: [] };
  if (env?.gitBranch) gitState.branch = env.gitBranch;
  if (env?.gitRemote) {
    // Store remote in the branch field as "branch · remote" format if both exist
    gitState.branch = gitState.branch
      ? `${gitState.branch} · ${env.gitRemote}`
      : env.gitRemote;
  }
  if (env?.dirtyFiles?.length) gitState.dirty_files = env.dirtyFiles.slice(0, 20);

  // Merge blocked items into open_issues so they're visible in V1 consumers.
  const openIssues = [
    ...asStringList(parsed.open_issues || parsed.openIssues, 12),
    ...(blocked.length > 0 ? blocked.map((b) => `[阻塞] ${b}`) : []),
  ].slice(0, 12);

  const handoffPrompt = asTrimmedString(
    parsed.handoffPrompt ?? parsed.suggested_prompt ?? '',
    RELAY_SUGGESTED_PROMPT_MAX_CHARS
  );
  if (!handoffPrompt) throw new Error('relay V2 输出缺少 handoffPrompt');

  const confidence = asConfidence(parsed.confidence);

  // V2 verifyFirst: the verify-before-acting checklist for the receiving AI.
  const verifyFirst = asStringList(parsed.verifyFirst ?? parsed.verify_first, 8);

  // Current state synthesizes completed + in_progress + blocked for v1 consumers.
  const currentStateParts = [
    ...completed.map((c) => `✓ ${c}`),
    ...inProgress.map((ip) => `↻ ${ip}`),
    ...blocked.map((b) => `⊘ ${b}`),
  ];
  const currentState = currentStateParts.join('\n').slice(0, 4_000);

  return {
    title,
    goal,
    current_state: currentState,
    completed,
    in_progress: inProgress,
    git_state: gitState,
    key_decisions: [...decisionsV2, ...asStringList(parsed.key_decisions, 12)].slice(0, 12),
    key_files: asKeyFileList(parsed.files ?? parsed.key_files, 12),
    failed_paths: failedPathsV2,
    open_issues: openIssues,
    verification,
    ...(verifyFirst.length > 0 ? { verify_first: verifyFirst } : {}),
    next_steps: asStringList(parsed.nextSteps ?? parsed.next_steps, 12),
    ...(confidence ? { confidence } : {}),
    suggested_prompt: handoffPrompt,
  };
}

registerAgentKind('relay', {
  buildPrompt({ transcript, preferences }) {
    const english = preferences.outputLanguage === 'en-US';
    const prefix = english ? RELAY_HANDOFF_PREFIX_EN : RELAY_HANDOFF_PREFIX_ZH;
    const rule = english ? RELAY_HANDOFF_RULE_EN : RELAY_HANDOFF_RULE_ZH;
    const language = english
      ? 'Write the whole pack in clear, concise English.'
      : '使用简洁的中文。';
    // V2 schema: unified format with structured decisions, environment capture,
    // blocked items, and programmatic verification fields. JSON keys use
    // straight quotes so the model reproduces parseable JSON verbatim.
    const schema = english
      ? '{"meta": {"version": 2, "createdAt": "ISO 8601 timestamp", "conversationCount": <N>}, "goal": "what this work aims to achieve (1-2 sentences, testable)", "state": {"completed": ["done items with evidence anchors, <= 8"], "inProgress": ["underway items and where they stopped, <= 8"], "blocked": ["items blocked by unresolved dependencies, <= 6"]}, "files": [{"path": "file path (verbatim from anchor list)", "why": "why this file matters", "last_state": "its current change state"}, "<= 8 — MUST choose from the program-extracted anchor list"], "decisions": [{"decision": "what was decided", "rationale": "why, and what alternatives were rejected"}, "<= 8"], "failedPaths": [{"approach": "approach tried and abandoned", "whyFailed": "why it failed", "evidence": "where in the conversation this is shown"}, "<= 6"], "verification": {"lastCommand": "the last verification command actually run", "lastResult": "its most recent output (truncated)", "passed": true}, "verifyFirst": ["concrete checks the receiving AI runs BEFORE touching anything, ordered, <= 6"], "nextSteps": ["suggested next steps in priority order, <= 8"], "confidence": {"overall": 0.0, "lowAreas": ["areas you are least sure about"]}, "environment": {"gitBranch": "...", "gitRemote": "...", "dirtyFiles": ["..."], "nodeVersion": "...", "packageManager": "..."}, "handoffPrompt": "self-contained prompt for a fresh AI session: background, goal, state, key files, todos, and a condensed verify-first checklist; paste-ready at session start, <= 1200 chars"}'
      : '{"meta": {"version": 2, "createdAt": "ISO 8601 时间戳", "conversationCount": <N>}, "goal": "这项工作要达成的可检验目标（一两句）", "state": {"completed": ["已完成事项，带证据锚点，至多 8 条"], "inProgress": ["进行中事项及停在哪一步，至多 8 条"], "blocked": ["被未解决依赖阻塞的事项，至多 6 条"]}, "files": [{"path": "文件路径（必须原样取自锚点清单）", "why": "为什么重要", "last_state": "该文件目前的改动状态"}, "至多 8 个，必须从程序提取的锚点清单选取"], "decisions": [{"decision": "做了什么决定", "rationale": "理由及否决的替代方案"}, "至多 8 条"], "failedPaths": [{"approach": "试过但放弃的方案", "whyFailed": "失败原因", "evidence": "上下文中的证据位置"}, "至多 6 条"], "verification": {"lastCommand": "实际执行的最后验证命令", "lastResult": "最近一次输出（截断）", "passed": true}, "verifyFirst": ["接手方在改动任何代码前必须先执行的验证步骤，按顺序，至多 6 条"], "nextSteps": ["建议的下一步，按优先级排序，至多 8 条"], "confidence": {"overall": 0.0, "lowAreas": ["你最没把握的部分"]}, "environment": {"gitBranch": "...", "gitRemote": "...", "dirtyFiles": ["..."], "nodeVersion": "...", "packageManager": "..."}, "handoffPrompt": "可直接粘贴到新 AI 会话开头的自包含交接提示词：背景、目标、现状、关键文件、待办与精简版接手先验证清单，1200 字以内"}';
    const notes = english
      ? [
          'Rules:',
          '- confidence.overall is a number between 0 and 1.',
          '- state.blocked lists things that CANNOT proceed until something else is resolved — distinct from inProgress.',
          '- decisions.rationale MUST include what alternatives were considered and rejected.',
          '- When the context contains a "## Key files (program-extracted, with anchors)" / "## 关键文件（程序提取，带锚点）" section, files MUST be chosen from that list with the paths kept verbatim — never invent files beyond it; derive "why" and "last_state" from the context.',
          '- failedPaths MUST preserve every failed attempt and rejection reason visible in the context — never drop them to make the pack look cleaner; output an empty array only when there genuinely were none. Include an "evidence" field pointing to which conversation or message shows the failure.',
          '- verification.lastCommand and verification.lastResult should be extracted from actual tool executions in the context when visible; set passed=false when the output indicates failure.',
          '- If nothing was verified, output "verification": {"lastCommand": "", "lastResult": "", "passed": false}.',
          '- verifyFirst is the "verify before acting" checklist: concrete, executable checks grounded in the context — re-run the last verification command, confirm the anchored key files exist in their described state, confirm the git branch and dirty files. Order them so the receiving AI can validate this pack before building on it; empty array only when nothing is verifiable.',
          '- The handoffPrompt must embed the verifyFirst checklist in condensed form (a short "verify first" list) between the state/files recap and the closing rule.',
          '- When the context contains a "## 项目记忆（跨会话状态，优先采信）" (project memory) section, treat it as the most current cross-session project state: align goal, state and environment with it — where older conversation fragments conflict, the project memory wins.',
          '- Each "## 会话 N" head (一句话/关键主题/关键决策/未决问题) is that conversation\'s compressed summary: synthesize primarily from the heads and use the "最近消息" excerpts as supporting evidence and detail, not as the full picture.',
          '- environment: extract git branch/remote from Git lines, node/package versions from tool output if visible. Omit the environment key entirely when nothing is known.',
          `- The handoffPrompt MUST start with this exact fixed sentence, verbatim:\n${prefix}`,
          `- The handoffPrompt MUST end with this exact fixed sentence, verbatim:\n${rule}`,
          'Use empty arrays for fields with no content. Output JSON only.',
        ]
      : [
          '要求：',
          '- confidence.overall 是 0 到 1 之间的数字。',
          '- state.blocked 列出因依赖未解决而无法推进的事项——与 inProgress 不同。',
          '- decisions.rationale 必须写明考虑过并否决了哪些替代方案。',
          '- 上下文包含「## 关键文件（程序提取，带锚点）」部分时，files 必须从该清单中选取并原样沿用其路径，不得虚构清单之外的文件；why 和 last_state 依据上下文推断。',
          '- failedPaths 必须完整保留上下文中出现的失败尝试与否决原因，不得为了让交接显得顺利而省略；确实没有时才输出空数组。每条附带 "evidence" 字段指向哪条会话或消息显示了该失败。',
          '- verification.lastCommand 和 verification.lastResult 应尽量从上下文中的工具执行记录提取；输出表明失败时 passed 设为 false。',
          '- 没有做过任何验证时输出 "verification": {"lastCommand": "", "lastResult": "", "passed": false}。',
          '- verifyFirst 是「接手先验证」清单：依据上下文写出的具体可执行检查——重跑最后一次验证命令、确认锚点清单中的关键文件存在且状态与描述相符、确认 git 分支与未提交改动。按先验证后动手的顺序排列，让接手方先核实本交接包再继续；确实没有可验证的事项时才输出空数组。',
          '- handoffPrompt 必须在现状与关键文件回顾之后、结尾固定规则之前，嵌入精简版 verifyFirst 清单（「接手先验证」列表）。',
          '- 上下文包含「## 项目记忆（跨会话状态，优先采信）」部分时，把它当作当前最新的跨会话项目状态：goal、state、environment 与之对齐；与较旧的会话片段冲突时以项目记忆为准。',
          '- 每个「## 会话 N」头部（一句话/关键主题/关键决策/未决问题）是该会话的压缩摘要：综合时以头部摘要为主，「最近消息」摘录作为证据与细节补充，不要把摘录当作全貌。',
          '- environment：从 Git 行提取分支/远程，从工具输出提取 node/包管理版本。完全未知时省略整个 environment 键。',
          `- handoffPrompt 必须以下面这句固定开场白原样开头：\n${prefix}`,
          `- handoffPrompt 必须以下面这句固定规则原样结尾：\n${rule}`,
          '没有内容的数组字段输出空数组。只输出 JSON 本身。',
        ];
    return [
      {
        role: 'system',
        content: `你是 Vesti 的会话交接助手。只依据提供的会话浓缩上下文做归纳，不补造事实；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: [
          english
            ? 'Below is the condensed context of several related conversations (it may carry: cross-session project memory, program-extracted key-file anchors, per-conversation digest summaries, recent key messages). Distill them into a "handoff pack" that lets another AI continue this work. ' + language + ' Output one JSON object with these fields:'
            : '下面是若干个相关会话的浓缩上下文（可能包含：跨会话项目记忆、程序提取的关键文件锚点、各会话索引摘要、最近关键消息）。请把它们归纳成一份”交接包”，让另一个 AI 能接着继续这项工作。' + language + '输出一个 JSON 对象，字段如下：',
          schema,
          ...notes,
          '',
          transcript,
        ].join('\n'),
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseRelayPayloadV2(raw));
  },
});

registerAgentKind('classify', {
  buildPrompt({ transcript, preferences }) {
    const { language } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的会话分类助手。只依据提供的会话信息与现有主题树，输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: [
          '请把下面编号的会话归入主题树，规则如下：',
          '1. 优先归入现有主题树中的主题；确实没有合适的现有主题时才新建（newTopic 为 true）。',
          '2. topicPath 是 1-3 层的主题路径，例如 ["前端", "React"]；归入现有主题时路径必须与现有路径一致；层级越少越好。',
          '3. confidence 是 0-1 之间的把握度；没有把握时给出低分，不要勉强归类。',
          '4. 只输出 JSON 数组，每个会话一条：{"ref": 编号, "topicPath": ["一级", "二级"], "newTopic": false, "confidence": 0.8}',
          '',
          transcript,
        ].join('\n'),
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseClassifyPayload(raw));
  },
});

/**
 * Knowledge extract (P4b): distill the condensed context of several selected
 * conversations into reusable knowledge assets — knowledge points, code
 * snippets, ADR-style decisions and prompts. The model answers with strict
 * JSON only; parse() validates and normalizes the shape so downstream
 * persistence never sees malformed output.
 */
export interface ExtractCodeSnippet {
  language: string;
  code: string;
  why: string;
}

export interface ExtractDecision {
  title: string;
  context: string;
  decision: string;
  consequences: string;
}

export interface ExtractPayload {
  knowledge_points: string[];
  code_snippets: ExtractCodeSnippet[];
  decisions: ExtractDecision[];
  prompts: string[];
}

function asCodeSnippetList(value: unknown, maxItems: number): ExtractCodeSnippet[] {
  if (!Array.isArray(value)) return [];
  const snippets: ExtractCodeSnippet[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const code = typeof entry.code === 'string' ? entry.code.replace(/\s+$/g, '').slice(0, 4_000) : '';
    if (!code.trim()) continue;
    snippets.push({
      language: asTrimmedString(entry.language, 40) || 'text',
      code,
      why: asTrimmedString(entry.why, 300),
    });
    if (snippets.length >= maxItems) break;
  }
  return snippets;
}

function asDecisionList(value: unknown, maxItems: number): ExtractDecision[] {
  if (!Array.isArray(value)) return [];
  const decisions: ExtractDecision[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const title = asTrimmedString(entry.title, 120);
    const decision = asTrimmedString(entry.decision, 600);
    if (!title && !decision) continue;
    decisions.push({
      title: title || decision.slice(0, 40),
      context: asTrimmedString(entry.context, 600),
      decision,
      consequences: asTrimmedString(entry.consequences, 600),
    });
    if (decisions.length >= maxItems) break;
  }
  return decisions;
}

export function parseExtractPayload(raw: string): ExtractPayload {
  // Tolerate Markdown code fences around the JSON object.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('extract 输出不是 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extract 输出不是 JSON 对象');
  }
  const payload: ExtractPayload = {
    knowledge_points: asStringList(parsed.knowledge_points, 12),
    code_snippets: asCodeSnippetList(parsed.code_snippets, 8),
    decisions: asDecisionList(parsed.decisions, 6),
    prompts: asStringList(parsed.prompts, 8),
  };
  if (
    payload.knowledge_points.length === 0 &&
    payload.code_snippets.length === 0 &&
    payload.decisions.length === 0 &&
    payload.prompts.length === 0
  ) {
    throw new Error('extract 输出没有任何有效内容');
  }
  return payload;
}

registerAgentKind('extract', {
  buildPrompt({ transcript, preferences }) {
    const { language } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的知识提取助手。只依据提供的会话浓缩上下文做提炼，不补造事实；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: [
          '下面是若干个相关会话的浓缩上下文（索引摘要 + 最近关键消息）。请提炼其中值得沉淀的知识资产，内容字段使用设置中指定的输出语言，输出一个 JSON 对象，字段如下：',
          '{"knowledge_points": ["值得记住的知识点、结论或经验，至多 12 条"], "code_snippets": [{"language": "语言", "code": "值得收藏的代码片段", "why": "为什么值得收藏"}，至多 8 个], "decisions": [{"title": "决策标题", "context": "背景与约束", "decision": "做出的决定", "consequences": "影响与后续"}，至多 6 条], "prompts": ["可复用的提示词，至多 8 条"]}',
          '没有内容的数组字段输出空数组。只输出 JSON 本身。',
          '',
          transcript,
        ].join('\n'),
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseExtractPayload(raw));
  },
});

/**
 * Deposit distillation (P4b): turn the condensed context of a scope of
 * conversations into a long-lived Markdown document for the deposits area.
 * The prompt is parameterized by template (DistillTemplate); 'custom' carries
 * the user's own instruction in `question`. The output is free-form Markdown,
 * so parse() is lenient: any non-empty body passes.
 */
export const DISTILL_TEMPLATES: readonly DistillTemplate[] = [
  'background_knowledge',
  'project_state',
  'writing_style',
  'custom',
];

const DISTILL_DIRECTIVES: Record<Exclude<DistillTemplate, 'custom'>, string> = {
  background_knowledge:
    '请提炼这位用户的个人背景知识：技能栈与熟练度、常用工具与工作环境、偏好与禁忌、工作方式与协作习惯。输出一份 Markdown 文档，让任何 AI 读完后能快速了解这位用户，并据此调整协作方式。',
  project_state:
    '请提炼这个项目的开发状态：整体架构、已做出的关键技术决策及理由、当前进度、关键文件的状态、待办事项与风险。输出一份 Markdown 文档，面向项目交接与复盘。',
  writing_style:
    '请提炼这位用户的写作风格：语气与态度、句式特点、用词偏好、结构习惯、应当避免的表达。输出一份 Markdown 文档，让 AI 能据此模仿用户的写作风格。',
};

export function buildDistillDirective(template: DistillTemplate, customInstruction?: string): string {
  if (template === 'custom') {
    const instruction = customInstruction?.trim();
    if (!instruction) throw new Error('自定义提炼需要先填写提炼指令');
    return `请按下面的提炼指令处理这些会话，输出一份 Markdown 文档：\n${instruction}`;
  }
  const directive = DISTILL_DIRECTIVES[template];
  if (!directive) throw new Error(`未知的沉淀模板：${template}`);
  return directive;
}

registerAgentKind('distill', {
  buildPrompt({ transcript, question, template, preferences }) {
    const { language } = promptAffixes(preferences);
    const directive = buildDistillDirective((template ?? 'custom') as DistillTemplate, question);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的知识沉淀助手。只依据提供的会话浓缩上下文做归纳，不补造事实；直接输出 Markdown 正文（不要 JSON、不要用代码围栏包裹全文）。${language}`,
      },
      {
        role: 'user',
        content: [directive, '', '会话浓缩上下文：', transcript].join('\n'),
      },
    ];
  },
  parse(raw) {
    const cleaned = raw.trim();
    if (!cleaned) throw new Error('distill 输出为空');
    return cleaned;
  },
});

/**
 * Deposit maintain (mem0-style): given the previous deposit document and a
 * fresh distillation (composed by the caller via
 * buildDepositMaintainTranscript), decide the minimal edit operations and
 * produce the merged document. Strict JSON; parse() validates the op enum and
 * required fields, and rejects empty merged_markdown.
 */
registerAgentKind('deposit-maintain', {
  buildPrompt({ transcript, preferences }) {
    const { language } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的沉淀维护助手。对比「旧版本沉淀内容」与「新提炼内容」，以最小改动把新信息合并进旧文档，删除过时内容；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: [
          '下面给出一份沉淀文档的旧版本和基于最新会话重新提炼的新内容。请输出维护操作与合并结果，JSON 对象字段如下：',
          '{"ops": [{"op": "ADD|UPDATE|DELETE|NOOP", "section": "所属小节标题", "old_text": "被替换或删除的旧原文（ADD/NOOP 可省略）", "new_text": "写入的新文本（DELETE/NOOP 可省略）", "reason": "为什么需要这个操作"}], "merged_markdown": "应用全部操作后的完整文档"}',
          'op 语义：ADD=新内容有而旧文档没有、值得加入的信息；UPDATE=旧内容仍相关但需按新信息改写；DELETE=旧内容已过时或被新内容否定；NOOP=保持不变的重要部分（至多 3 条，reason 说明为什么保留）。',
          'merged_markdown 必须非空，是应用全部操作后的最终文档（Markdown，保持原有小节结构，语言与旧文档一致）。只输出 JSON 本身。',
          '',
          transcript,
        ].join('\n'),
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseDepositMaintainPayload(raw));
  },
});

/**
 * Daily journal (P4c quality upgrade): two prompt variants behind the 'daily'
 * kind. 'daily-cluster' (pass 1) extracts one project's/session-cluster's
 * condensed context into a strict-JSON work brief; 'daily' (pass 2, default)
 * synthesizes the day report from the per-cluster briefs plus deterministic
 * data; 'weekly' aggregates a week of daily logs into a weekly report. Both
 * Markdown variants parse leniently (any non-empty body passes) — the cluster
 * JSON is validated renderer-side (dailyPipeline.parseDailyClusterPayload).
 */
export const DAILY_TEMPLATES = ['daily', 'weekly', 'daily-cluster'] as const;
export type DailyTemplate = (typeof DAILY_TEMPLATES)[number];

const DAILY_DIRECTIVES: Record<DailyTemplate, string> = {
  'daily-cluster': [
    '下面是某一天中一个项目/会话簇的浓缩上下文（fork/续写已合并为工作项，含会话索引摘要、子代理摘要、程序提取的文件锚点、网页摘要）。请把它提取成结构化工作要点，输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字），字段如下：',
    '{"theme": "一句话工作主题（20 字以内）", "goal": "这项工作要达成的目标（一两句，可检验）", "completed": ["今天实际完成的具体事项，每条带可验证的结果，至多 6 条"], "in_progress": ["进行中事项及停在哪一步，至多 4 条"], "decisions": ["今天做出的决策或排查出的结论，至多 4 条"], "open_questions": ["仍未解决的问题，至多 4 条"]}',
    '硬性规则：',
    '- completed 必须成就导向：写清"完成了什么、结果如何"（如「修复了 X 的 Y 问题」「实现并验证了 Z」），禁止"进行了讨论""展开调研"式空话。',
    '- 涉及具体数值（版本号、配置值、端口号、日期、数量、时长、阈值）时原样保留数值与单位，不得概括化。',
    '- 文件路径以程序提取的锚点清单为准，不得虚构清单之外的路径。',
    '- 多个 fork/续写会话是同一项工作，合并叙述，不要按会话逐条罗列。',
    '没有内容的字段输出空数组。只输出 JSON 本身。',
  ].join('\n'),
  daily: [
    '请把下面这一天（本地时区）的开发工作综合成一份高质量的个人开发工作记录（日报）。读者是未来的作者本人：读完要能准确回答"那天完成了什么、核心工作有哪些、和哪些文件相关"。',
    '输入材料：按项目/会话簇预提取的结构化要点（主题/目标/已完成/进行中/决策/未决）、程序提取的关键文件锚点（确定性数据）、网页端对话清单、项目记忆（跨会话状态）、昨日日报摘录（连续性上下文）。',
    'Markdown 输出，使用以下小节结构（标题逐字使用、不含任何括号注释、顺序不变；不要输出一级标题，不要新增其他小节）：',
    '## 今日完成',
    '## 项目工作流分解',
    '{{KEY_FILES}}',
    '## 决策与发现',
    '## 网页端对话摘要',
    '## 明日线索',
    '各小节写作要求：',
    '- 今日完成：成就导向清单，每条具体、可验证，写清完成了什么、结果如何；涉及数值/版本/路径时原样保留；忌"进行了讨论"式空话。',
    '- 项目工作流分解：每个项目一个 ### 子节（目标 / 今日进展 / 当前状态）；与项目记忆冲突时以项目记忆为准。',
    '- 决策与发现：今天定下的技术决策、方案取舍、排查出的结论；没有则写"无"。',
    '- 网页端对话摘要：输入中网页端对话的要点归纳，按主题合并；输入没有网页端对话时写"无"。',
    '- 明日线索：基于未决问题与最近上下文推断的优先事项，至多 5 条；没有则写"无"。',
    '规则：只依据提供的材料，不补造事实；关键文件小节由程序渲染——{{KEY_FILES}} 标记行必须原样保留在该位置，你不要自行罗列文件路径。',
  ].join('\n'),
  weekly: [
    '请把下面最近 7 天的日报条目汇总成一份周报。输入是各天日报的「今日完成」等小节摘录与统计——以日报内容为准归纳，不要从原始会话重新推导。Markdown 格式，使用以下小节结构（标题逐字使用、不含任何括号注释）：',
    '## 本周完成',
    '## 关键进展',
    '## 模式观察',
    '## 下周线索',
    '各小节写作要求：',
    '- 本周完成：跨天归纳实际完成的工作，按主题组织。',
    '- 关键进展：里程碑式的决定、突破或交付，至多 6 条。',
    '- 模式观察：工作习惯、平台/项目分布、反复出现的问题，3-5 条。',
    '- 下周线索：从本周未决问题推断的优先事项，至多 5 条。',
    '只依据提供的日报与统计，不补造事实；不要输出小节之外的标题。',
  ].join('\n'),
};

export function buildDailyDirective(template?: string): string {
  const variant = DAILY_TEMPLATES.includes(template as DailyTemplate)
    ? (template as DailyTemplate)
    : 'daily';
  return DAILY_DIRECTIVES[variant];
}

registerAgentKind('daily', {
  buildPrompt({ transcript, template, preferences }) {
    const { language } = promptAffixes(preferences);
    const directive = buildDailyDirective(template);
    const isCluster = template === 'daily-cluster';
    return [
      {
        role: 'system',
        content: isCluster
          ? `你是 Vesti 的工作记录提取助手。只依据提供的簇上下文做提取，不补造事实；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`
          : `你是 Vesti 的工作日志助手。只依据提供的活动记录做归纳，不补造事实；直接输出 Markdown 正文（不要 JSON、不要用代码围栏包裹全文）。${language}`,
      },
      {
        role: 'user',
        content: [directive, '', isCluster ? '簇上下文：' : '活动记录：', transcript].join('\n'),
      },
    ];
  },
  parse(raw) {
    const cleaned = raw.trim();
    if (!cleaned) throw new Error('daily 输出为空');
    return cleaned;
  },
});

/**
 * Persona footnote (P5 思维意象): annotate the user's resolved AITI imagery
 * with a 1-2 sentence literary note that weaves their recent obsessions into
 * the fixed imagery (e.g. "蝴蝶最近总绕着 ×× 飞"). The transcript carries the
 * type code + imagery name + verdict + obsessions + sample size. The model
 * must never re-pick or alter the imagery — it only annotates. parse() is
 * lenient: any non-empty body passes, collapsed to one line and capped.
 */
export const PERSONA_NOTE_MAX_CHARS = 200;

registerAgentKind('persona', {
  buildPrompt({ transcript, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: [
          '你是 Vesti 的意象注解助手。依据给定的思维意象（型码、意象名、判词、近期关注主题、样本量）写一段 1-2 句的注解。',
          '要求：延续判词的文学气质；把近期关注的主题自然织入意象（如“蝴蝶最近总绕着 ×× 飞”）；保持无人称的文学口吻，不要“你”字说教。',
          '严禁改变、重新选择或质疑意象与型码——只注解，不评判。直接输出注解正文（不要引号、不要标题、不要任何额外文字）。',
          language + custom,
        ].join('\n'),
      },
      {
        role: 'user',
        content: ['请为下面的思维意象写注脚：', '', transcript].join('\n'),
      },
    ];
  },
  parse(raw) {
    const cleaned = raw.trim().replace(/\s+/g, ' ');
    if (!cleaned) throw new Error('persona 输出为空');
    return cleaned.slice(0, PERSONA_NOTE_MAX_CHARS);
  },
});

// ---- AI 圆桌 (Roundtable) ----
// Both kinds keep prompt assembly on the renderer side (src/ui/roundtable):
// the transcriptOverride already carries the persona setup, the topic, the
// optional recall context and the output contract. These registrations only
// wrap it with the assistant preamble + a lenient parse.

/** One seat's turn: free-form prose (3-5 paragraphs); parse is lenient — any
 * non-empty body passes, fences stripped, hard-capped for storage. */
registerAgentKind('roundtable-turn', {
  buildPrompt({ transcript, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的圆桌讨论助手。严格保持给定的角色设定发言，立场鲜明、言之有物；不补造背景资料中没有的事实。${language}${custom}`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ];
  },
  parse(raw) {
    const cleaned = raw
      .trim()
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (!cleaned) throw new Error('roundtable-turn 输出为空');
    return cleaned.slice(0, 4000);
  },
});

/** The moderator's synthesis: strict JSON by contract, but parse stays
 * lenient (strip fences, require non-empty) — the renderer validates the JSON
 * shape (parseRoundtableSynthesis) and falls back to the raw text. */
registerAgentKind('roundtable-synthesis', {
  buildPrompt({ transcript, preferences }) {
    const { language } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的圆桌主持助手。只依据给出的成员发言做汇总，不引入新观点；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ];
  },
  parse(raw) {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (!cleaned) throw new Error('roundtable-synthesis 输出为空');
    return cleaned;
  },
});

/** AI 深化 (Learn deep-dive): one recall-grounded pass over a learning domain.
 * Same wiring as the roundtable kinds — the transcriptOverride (assembled in
 * src/ui/learn/learnDeepen) already carries the domain stats, the optional
 * recall context and the strict-JSON contract; this registration only wraps
 * it with the assistant preamble + a lenient parse. */
registerAgentKind('learn-deepen', {
  buildPrompt({ transcript, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的学习脉络分析助手。只依据给出的本地统计与背景资料做分析，不编造资料中没有的具体事实；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}${custom}`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ];
  },
  parse(raw) {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (!cleaned) throw new Error('learn-deepen 输出为空');
    return cleaned.slice(0, 4000);
  },
});

/** 路线级 LLM 合成 (Learn V4 route synthesis): one pass per learning route —
 * full-sentence title + interpretation + next steps. Same wiring as
 * 'learn-deepen': the transcriptOverride (assembled in
 * src/ui/learn/learnSynthesis) already carries the route stats, the digest
 * grounding and the strict-JSON contract; this registration only wraps it
 * with the assistant preamble + a lenient parse. The renderer applies the
 * title quality bar and falls back to the deterministic route label. */
registerAgentKind('learn-synthesis', {
  buildPrompt({ transcript, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的学习路线解读助手。只依据给出的路线统计与会话摘要做概括，不编造资料中没有的具体事实；标题必须是概括成果的完整句子，不要关键词堆砌；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}${custom}`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ];
  },
  parse(raw) {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (!cleaned) throw new Error('learn-synthesis 输出为空');
    return cleaned.slice(0, 2000);
  },
});

/**
 * Capsule prompt assistant (P6 follow-up): refine a prompt the user picked in
 * the floating dock. Two kinds, both fed through transcriptOverride (the
 * prompt body) with persist:false — nothing lands in the agent-results log.
 *
 * 'prompt-improve' answers strict JSON {"improved": string, "notes": string[]}
 * (up to 3 change notes); parse() validates and normalizes the shape.
 */
export interface PromptImprovePayload {
  improved: string;
  notes: string[];
}

export const PROMPT_IMPROVE_MAX_NOTES = 3;
export const PROMPT_CONTINUE_MAX_CHARS = 4_000;

export function parsePromptImprovePayload(raw: string): PromptImprovePayload {
  // Tolerate Markdown code fences around the JSON object.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('prompt-improve 输出不是 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('prompt-improve 输出不是 JSON 对象');
  }
  const improved = typeof parsed.improved === 'string' ? parsed.improved.trim() : '';
  if (!improved) throw new Error('prompt-improve 输出缺少 improved');
  return {
    improved: improved.slice(0, 8_000),
    notes: asStringList(parsed.notes, PROMPT_IMPROVE_MAX_NOTES),
  };
}

registerAgentKind('prompt-improve', {
  buildPrompt({ transcript, question, preferences }) {
    const { language } = promptAffixes(preferences);
    // The capsule's refine box sends the user's own instruction ("更简洁",
    // "改成面向代码审查的") via `question`; without it run the default
    // clarity/reusability pass.
    const instruction = question?.trim();
    const taskLine = instruction
      ? `请严格按照用户的要求优化下面这条提示词。用户的要求：「${instruction}」。除该要求外保持原意与语言不变，不要执行或回答提示词本身。`
      : '请优化下面这条提示词，让它更清晰、具体、可复用：明确角色与目标、补齐必要的约束与输出格式要求，但保持原意与语言不变。';
    return [
      {
        role: 'system',
        content: `你是 Vesti 的提示词优化助手。只改写用户给出的提示词，不执行它、不回答它；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: [
          taskLine,
          '严格只输出一个 JSON 对象：{"improved": "优化后的完整提示词", "notes": ["修改要点，至多 3 条，每条一句话"]}。',
          '',
          transcript,
        ].join('\n'),
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parsePromptImprovePayload(raw));
  },
});

/**
 * 'prompt-continue' continues the given prompt text in the same voice (extend
 * the instruction with fitting detail). Free-form output, so parse() is
 * lenient: any non-empty body passes, capped for the dock panel.
 */
registerAgentKind('prompt-continue', {
  buildPrompt({ transcript, preferences }) {
    const { language } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的提示词续写助手。沿用原文的语气、语言与结构续写用户给出的提示词，让它更完整可执行；直接输出续写后的完整提示词正文（保持原文开头，不要解释、不要 Markdown 代码围栏）。${language}`,
      },
      {
        role: 'user',
        content: ['请续写下面这条提示词：', '', transcript].join('\n'),
      },
    ];
  },
  parse(raw) {
    const cleaned = raw.trim();
    if (!cleaned) throw new Error('prompt-continue 输出为空');
    return cleaned.slice(0, PROMPT_CONTINUE_MAX_CHARS);
  },
});

// ---- 梦境 (Dream memory) ----
// Two kinds backing the memory-space dream pipeline. dream-extract reads a
// batch of compressed conversations and answers {"memories": [...]};
// dream-maintain merges those candidates into the library and answers
// {"ops": [...]}. Both parse through the shared dreamMaintain validators and
// re-serialize (the orchestration side parses them back) so the
// string->string AgentKindDefinition.parse signature is kept.

registerAgentKind('dream-extract', {
  buildPrompt({ transcript, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的「梦境」记忆提取器——在用户与 AI 的对话中寻找关于用户本人的长期记忆。只依据提供的内容，不补造事实。${language}${custom}`,
      },
      {
        role: 'user',
        content: `下面是一批用户与 AI 的对话记录（用户消息完整保留，AI 回复已压缩截断）。请提取关于「用户本人」的持久记忆事实。

提取类别（tag 字段只能取其一）：
- profile：身份与背景（职业、角色、技术栈、经验水平、所在领域）
- preference：偏好与习惯（代码风格、沟通方式、工具偏好、工作节奏、审美偏好）
- goal：目标与意图（正在推进的事、长期规划、想达到的状态）
- emotion：情绪与状态（疲惫、兴奋、焦虑、成就感、兴趣点的变化）
- relationship：与 AI 的协作模式（委托习惯、对 AI 的期待、交互偏好）
- event：重要事件（里程碑、发布、转折、生活变化）

规则：
1. 只记录有持久价值的事实——一次性问答、纯技术排错过程不记。
2. 每条事实必须自包含（脱离对话也能看懂），一句话为主；evidence 给一句简短依据。
3. 宁缺毋滥，没有新事实就输出空数组。同一事实只记一次。
4. fact 用用户的语言书写（默认中文）。

严格只输出一个 JSON 对象（不要 Markdown 代码块，不要任何额外文字）：
{"memories": [{"tag": "preference", "fact": "...", "evidence": "...", "session_ids": ["..."]}]}

对话记录：
${transcript}`,
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseDreamExtractPayload(raw));
  },
});

/** Render one existing memory entry for the maintain prompt: `id | tag | 内容`. */
function renderDreamExistingList(existing: unknown): string {
  if (!Array.isArray(existing) || existing.length === 0) return '（空）';
  return existing.map((item) => {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : '?';
    const tag = typeof entry.tag === 'string' && entry.tag ? entry.tag : '-';
    const content = typeof entry.content === 'string' && entry.content
      ? entry.content
      : (typeof entry.title === 'string' ? entry.title : '');
    return `- ${id} | ${tag} | ${content}`;
  }).join('\n');
}

/** Render one extracted candidate for the maintain prompt: `[tag] fact（依据：…）`. */
function renderDreamCandidateList(candidates: unknown): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return '（空）';
  return candidates.map((item) => {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const tag = typeof entry.tag === 'string' && entry.tag ? entry.tag : '-';
    const fact = typeof entry.fact === 'string' ? entry.fact : '';
    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
    return evidence ? `- [${tag}] ${fact}（依据：${evidence}）` : `- [${tag}] ${fact}`;
  }).join('\n');
}

registerAgentKind('dream-maintain', {
  buildPrompt({ transcript, preferences }) {
    const { language, custom } = promptAffixes(preferences);
    // The transcript slot carries the orchestrator-serialized
    // {"existing": [...], "candidates": [...]} JSON; non-JSON input is embedded
    // verbatim instead of being forced into the template.
    let existingList: string | null = null;
    let candidateList: string | null = null;
    try {
      const payload = JSON.parse(transcript) as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('not an object');
      }
      const input = payload as { existing?: unknown; candidates?: unknown };
      existingList = renderDreamExistingList(input.existing);
      candidateList = renderDreamCandidateList(input.candidates);
    } catch { /* 原文嵌入 */ }
    return [
      {
        role: 'system',
        content: `你是 Vesti 记忆空间的维护者，负责把新提取的记忆合并进用户的长期记忆库，保持它精炼、准确、不过时。${language}${custom}`,
      },
      {
        role: 'user',
        content: existingList === null || candidateList === null
          ? transcript
          : `现有记忆条目（id | tag | 内容）：
${existingList}

新提取的候选记忆：
${candidateList}

对每条候选逐一判定，输出维护操作：
- ADD：候选是全新事实 → 新建条目。
- UPDATE：候选与某条目同主题且带来新信息或修正 → 更新该条目，content 输出合并后的完整新内容（不是增量）。
- DELETE：候选证明某条目已过时或错误 → 删除该条目。
- NOOP：候选与已有条目重复或无持久价值 → 跳过。
另外：若两个现有条目冗余重复，可 UPDATE 保留者并 DELETE 另一者；若某条目明显过时也可主动 DELETE。

要求：
1. 合并后条目保持自包含、一两句话为主；title 为 4-12 字概括。
2. tag 只能是 profile / preference / goal / emotion / relationship / event。
3. 每条 op 附一句 reason。
4. 严格只输出一个 JSON 对象（不要 Markdown 代码块）：
{"ops": [{"op": "ADD|UPDATE|DELETE|NOOP", "target_id": "现有条目id或null", "tag": "...", "title": "...", "content": "...", "reason": "..."}]}`,
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseDreamMaintainPayload(raw));
  },
});
