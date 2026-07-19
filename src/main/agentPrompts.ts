import type { DistillTemplate } from '../shared/contracts';
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
        role: 'user',
        content: `请总结下面的会话，包含：主题、关键结论、已做决定、未解决问题、建议的下一步。没有内容的栏目请写“无”。\n\n${transcript}`,
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
          '{"one_liner": "一句话概括会话主题（50 字以内）", "key_topics": ["关键主题，至多 6 个"], "key_files": ["涉及的关键文件路径，至多 6 个"], "decisions": ["已做出的决定，至多 6 条"], "open_questions": ["未解决的问题，至多 6 条"]}',
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
 */
export interface RelayPackKeyFile {
  path: string;
  why: string;
  last_state: string;
}

export interface RelayPackPayload {
  title: string;
  goal: string;
  current_state: string;
  key_decisions: string[];
  key_files: RelayPackKeyFile[];
  open_issues: string[];
  next_steps: string[];
  suggested_prompt: string;
}

/** The suggested prompt must stay paste-ready; hard-cap it in parse. */
export const RELAY_SUGGESTED_PROMPT_MAX_CHARS = 800;

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
  const currentState = asTrimmedString(parsed.current_state, 4_000);
  if (!currentState) throw new Error('relay 输出缺少 current_state');
  const suggestedPrompt = asTrimmedString(parsed.suggested_prompt, RELAY_SUGGESTED_PROMPT_MAX_CHARS);
  if (!suggestedPrompt) throw new Error('relay 输出缺少 suggested_prompt');
  return {
    title,
    goal,
    current_state: currentState,
    key_decisions: asStringList(parsed.key_decisions, 12),
    key_files: asKeyFileList(parsed.key_files, 12),
    open_issues: asStringList(parsed.open_issues, 12),
    next_steps: asStringList(parsed.next_steps, 12),
    suggested_prompt: suggestedPrompt,
  };
}

registerAgentKind('relay', {
  buildPrompt({ transcript, preferences }) {
    const { language } = promptAffixes(preferences);
    return [
      {
        role: 'system',
        content: `你是 Vesti 的会话交接助手。只依据提供的会话浓缩上下文做归纳，不补造事实；输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
      },
      {
        role: 'user',
        content: [
          '下面是若干个相关会话的浓缩上下文（索引摘要 + 最近关键消息）。请把它们归纳成一份“交接包”，让另一个 AI 能接着继续这项工作。内容字段使用设置中指定的输出语言，输出一个 JSON 对象，字段如下：',
          '{"title": "交接包标题（30 字以内）", "goal": "这项工作要达成的目标", "current_state": "目前已完成什么、进行到哪一步", "key_decisions": ["已做出的关键决定及理由，至多 8 条"], "key_files": [{"path": "关键文件路径", "why": "为什么重要", "last_state": "该文件目前的改动状态"}，至多 8 个], "open_issues": ["尚未解决的问题，至多 8 条"], "next_steps": ["建议的下一步，按优先级排序，至多 8 条"], "suggested_prompt": "一段可直接粘贴到任意 AI 新会话开头的自包含中文交接提示词：包含背景、目标、现状、关键文件和待办，800 字以内"}',
          '没有内容的数组字段输出空数组。只输出 JSON 本身。',
          '',
          transcript,
        ].join('\n'),
      },
    ];
  },
  parse(raw) {
    return JSON.stringify(parseRelayPayload(raw));
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
 * Daily log (P4c): turn one local day's condensed activity context (CLI
 * session digests + browser conversation summaries) into a structured daily
 * report. The prompt is parameterized by template: 'daily' (default) writes
 * the day report, 'weekly' aggregates a week of daily logs into a weekly
 * report. The output is free-form Markdown, so parse() is lenient: any
 * non-empty body passes.
 */
export const DAILY_TEMPLATES = ['daily', 'weekly'] as const;
export type DailyTemplate = (typeof DAILY_TEMPLATES)[number];

const DAILY_DIRECTIVES: Record<DailyTemplate, string> = {
  daily: [
    '请把下面这一天（本地时区）的 AI 使用活动写成一份日报，Markdown 格式，严格使用以下小节结构：',
    '## 今日概览（基于哪些 agent / 平台完成了什么，3-6 句）',
    '## 关键文件与状态（列出涉及的代码文件及进度状态；没有则写“无”）',
    '## 网页端 AI 对话摘要（各网页会话的要点；没有则写“无”）',
    '## 明日待办线索（从今天的未决问题与收尾状态推断，至多 5 条）',
    '只依据提供的活动记录，不补造事实；不要输出小节之外的标题。',
  ].join('\n'),
  weekly: [
    '请把下面最近 7 天的日报与活动统计汇总成一份周报，Markdown 格式，严格使用以下小节结构：',
    '## 本周完成（跨天归纳实际完成的工作，按主题组织）',
    '## 关键进展（里程碑式的决定、突破或交付，至多 6 条）',
    '## 模式观察（工作习惯、平台/项目分布、反复出现的问题，3-5 条）',
    '## 下周线索（从本周未决问题推断的优先事项，至多 5 条）',
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
    return [
      {
        role: 'system',
        content: `你是 Vesti 的工作日志助手。只依据提供的活动记录做归纳，不补造事实；直接输出 Markdown 正文（不要 JSON、不要用代码围栏包裹全文）。${language}`,
      },
      {
        role: 'user',
        content: [directive, '', '活动记录：', transcript].join('\n'),
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
