// 夜话 (Companion) pure view logic: ExploreMessage records → chat view models
// (strip the persisted `${mood}\n${body}` tag line, resolve the owl mood for
// the avatar), sidebar session-preview cleanup, and persona / memory-scope
// ui-preference parsing + IO. Kept React-free so vitest covers it in the node
// environment; the components in ./CompanionChat.tsx / ./CompanionSessions.tsx
// are thin renderers over these functions.
//
// NOTE: stripCompanionMoodLine duplicates the parse contract of
// src/ui/companion/companionService.ts (the UI package cannot import the app
// shell). If the service's `${mood}\n${body}` contract changes, update both.

import type {
  CompanionMemoryScope,
  CompanionMood,
  CompanionPersona,
  ExploreMessage,
  RelatedConversation,
  StorageApi,
} from "../../types";

export const COMPANION_PERSONA_PREF_KEY = "companion.persona";
export const COMPANION_MEMORY_SCOPE_PREF_KEY = "companion.memoryScope";

export const COMPANION_MOODS: readonly CompanionMood[] = [
  "calm",
  "thinking",
  "delighted",
  "spark",
  "sleepy",
  "warm",
];

export const DEFAULT_COMPANION_MOOD: CompanionMood = "calm";
export const DEFAULT_COMPANION_PERSONA: CompanionPersona = "listener";
export const DEFAULT_COMPANION_MEMORY_SCOPE: CompanionMemoryScope = "full";

const MOOD_LINE_PATTERN = /^(calm|thinking|delighted|spark|sleepy|warm)$/;

// ---- normalizers (stored prefs / agentMeta annotations may be anything) ------

export function normalizeCompanionMood(value: unknown): CompanionMood {
  return typeof value === "string" && (COMPANION_MOODS as readonly string[]).includes(value)
    ? (value as CompanionMood)
    : DEFAULT_COMPANION_MOOD;
}

export function normalizeCompanionPersona(value: unknown): CompanionPersona {
  return value === "listener" || value === "creator" ? value : DEFAULT_COMPANION_PERSONA;
}

export function normalizeCompanionMemoryScope(value: unknown): CompanionMemoryScope {
  return value === "full" || value === "memory" || value === "chat"
    ? value
    : DEFAULT_COMPANION_MEMORY_SCOPE;
}

// ---- mood tag-line contract ----------------------------------------------------

/** Strip a leading mood id line from persisted assistant content; content
 * without one is returned unchanged. Mirrors companionService's contract. */
export function stripCompanionMoodLine(content: string): string {
  const newline = content.indexOf("\n");
  if (newline === -1) {
    return MOOD_LINE_PATTERN.test(content.trim()) ? "" : content;
  }
  const first = content.slice(0, newline).trim();
  if (MOOD_LINE_PATTERN.test(first)) return content.slice(newline + 1).trim();
  return content;
}

/** Sniff the mood id from the content's first line ("" when not a mood line). */
function sniffMoodLine(content: string): CompanionMood | null {
  const newline = content.indexOf("\n");
  const first = (newline === -1 ? content : content.slice(0, newline)).trim();
  return MOOD_LINE_PATTERN.test(first) ? (first as CompanionMood) : null;
}

// ---- message → view model --------------------------------------------------------

export interface CompanionMessageView {
  id: string;
  role: "user" | "assistant";
  /** Display body: user content as-is, assistant content minus the mood line. */
  body: string;
  /** Owl avatar mood — assistant: agentMeta.mood, else the stripped first
   * line, else calm. User rows carry calm (unused). */
  mood: CompanionMood;
  persona?: CompanionPersona;
  /** Persisted thinking trace (streaming turns); the chat folds it into a
   * collapsible 思考过程 block above the answer bubble. */
  reasoning?: string;
  sources?: RelatedConversation[];
  timestamp: number;
}

export function toCompanionMessageView(message: ExploreMessage): CompanionMessageView {
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      body: message.content,
      mood: DEFAULT_COMPANION_MOOD,
      timestamp: message.timestamp,
    };
  }
  const metaMood = message.agentMeta?.mood;
  const reasoning = message.agentMeta?.reasoning?.trim();
  return {
    id: message.id,
    role: "assistant",
    body: stripCompanionMoodLine(message.content),
    mood:
      metaMood !== undefined
        ? normalizeCompanionMood(metaMood)
        : (sniffMoodLine(message.content) ?? DEFAULT_COMPANION_MOOD),
    persona: message.agentMeta?.persona,
    ...(reasoning ? { reasoning } : {}),
    sources: message.sources,
    timestamp: message.timestamp,
  };
}

// ---- live-stream display ---------------------------------------------------------

const FULL_MOOD_TAG_PATTERN = /^[\[【]\s*mood\s*:\s*[A-Za-z]+\s*[\]】]$/;
/** A partial first line that could still grow into a [mood:xxx] tag. */
const MOOD_TAG_PREFIX_PATTERN = /^[\[【]?\s*(m?o?o?d?\s*:?)?\s*[A-Za-z]*\s*[\]】]?$/;

/** What the streaming bubble shows while the RAW answer is still typing: the
 * [mood:xxx] tag line is chrome, not content — hide it (including its
 * in-progress prefixes) and only reveal the body once it starts arriving. */
export function streamDisplayBody(raw: string): string {
  const newline = raw.indexOf("\n");
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim();
  const isTagLine =
    FULL_MOOD_TAG_PATTERN.test(firstLine) || MOOD_LINE_PATTERN.test(firstLine);
  if (newline === -1) {
    return isTagLine || MOOD_TAG_PREFIX_PATTERN.test(firstLine) ? "" : raw;
  }
  return isTagLine ? raw.slice(newline + 1).trimStart() : raw;
}

/** Sidebar preview: the stored preview of a companion turn starts with the
 * mood id line (assistant content's first 100 chars) — strip it so the row
 * shows the answer's opening words instead. */
export function toCompanionSessionPreview(preview: string): string {
  return stripCompanionMoodLine(preview);
}

// ---- ui-preference IO (window.vestiUi via StorageApi) -----------------------------

export interface CompanionPreferences {
  persona: CompanionPersona;
  memoryScope: CompanionMemoryScope;
}

/** Read the persisted switches; anything missing/invalid degrades to the
 * defaults (listener / full), and a host without ui-prefs just gets defaults. */
export async function loadCompanionPreferences(
  storage: Pick<StorageApi, "getUiPreference">,
): Promise<CompanionPreferences> {
  if (!storage.getUiPreference) {
    return { persona: DEFAULT_COMPANION_PERSONA, memoryScope: DEFAULT_COMPANION_MEMORY_SCOPE };
  }
  const [personaValue, scopeValue] = await Promise.all([
    storage.getUiPreference(COMPANION_PERSONA_PREF_KEY).catch(() => null),
    storage.getUiPreference(COMPANION_MEMORY_SCOPE_PREF_KEY).catch(() => null),
  ]);
  return {
    persona: normalizeCompanionPersona(personaValue),
    memoryScope: normalizeCompanionMemoryScope(scopeValue),
  };
}

/** Persist one switch; fire-and-forget safe (missing bridge / write failure
 * degrades to a local-only state change). */
export async function saveCompanionPreference(
  storage: Pick<StorageApi, "setUiPreference">,
  key: typeof COMPANION_PERSONA_PREF_KEY | typeof COMPANION_MEMORY_SCOPE_PREF_KEY,
  value: CompanionPersona | CompanionMemoryScope,
): Promise<void> {
  if (!storage.setUiPreference) return;
  await storage.setUiPreference(key, value).catch(() => undefined);
}
