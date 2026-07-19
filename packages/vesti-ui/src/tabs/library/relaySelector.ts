// Relay project picker (P4a quality) — pure, React-free selection logic.
//
// The library relay multi-select lets the user pick conversations one by one;
// this model re-frames the same pool the way the agent platforms store
// sessions on disk: platform (kimi-code ~/.kimi-code/sessions/<workDirKey>/,
// claude-code projects/<path>/, codex sessions/<date>/) → folder/project →
// conversation. Whole-platform / whole-folder toggles resolve to the flat
// conversation-id selection the existing handoff-pack pipeline consumes.
// Subagent sessions are never listed (A1 folding): they ride along with their
// parent at generation time, only their count is shown on the parent row.

import type { ConversationTree, ConversationTreeSession } from "../../types";
import type { DesktopSourceFields } from "./sourceTree";

/** One selectable conversation row (a main session joined to its Dexie id). */
export interface RelaySelectorConversation {
  /** Dexie conversation id — the unit of the relay selection pool. */
  id: number;
  /** Capture-store session id (tree node id). */
  cliId: string;
  title: string;
  oneLiner: string | null;
  lastActivityAt: number;
  /** Folded subagent descendants; they follow the parent implicitly. */
  subagentCount: number;
}

export interface RelaySelectorProject {
  projectKey: string;
  label: string;
  pathOrDomain: string;
  /** Main sessions with a Dexie conversation row, newest first. */
  conversations: RelaySelectorConversation[];
}

export interface RelaySelectorPlatform {
  platform: string;
  host: string;
  projects: RelaySelectorProject[];
}

type SelectorConversationRecord = {
  id?: number;
  title?: string;
} & DesktopSourceFields;

function countDescendants(session: ConversationTreeSession): number {
  return (session.children ?? []).reduce(
    (sum, child) => sum + 1 + countDescendants(child),
    0
  );
}

/**
 * Build the platform → project → conversation picker model by joining the
 * conversation tree against the Dexie conversation list on `_cli_id`. Tree
 * sessions without a library row (not yet mirrored) are skipped; projects and
 * platforms with nothing selectable are omitted.
 */
export function buildRelaySelectorModel(args: {
  tree: ConversationTree | null;
  conversations: SelectorConversationRecord[];
}): RelaySelectorPlatform[] {
  const { tree, conversations } = args;
  if (!tree) return [];
  const conversationByCliId = new Map<string, { id: number; title: string }>();
  for (const record of conversations) {
    if (typeof record.id === "number" && typeof record._cli_id === "string") {
      conversationByCliId.set(record._cli_id, {
        id: record.id,
        title: typeof record.title === "string" ? record.title : "",
      });
    }
  }
  const platforms: RelaySelectorPlatform[] = [];
  for (const source of tree.sources) {
    const projects: RelaySelectorProject[] = [];
    for (const project of source.projects) {
      const rows: RelaySelectorConversation[] = [];
      for (const session of project.sessions) {
        const record = conversationByCliId.get(session.id);
        if (!record) continue;
        rows.push({
          id: record.id,
          cliId: session.id,
          title: record.title || session.title,
          oneLiner: session.oneLiner ?? null,
          lastActivityAt: session.lastActivityAt,
          subagentCount: countDescendants(session),
        });
      }
      if (rows.length === 0) continue;
      rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      projects.push({
        projectKey: project.projectKey,
        label: project.label,
        pathOrDomain: project.pathOrDomain,
        conversations: rows,
      });
    }
    if (projects.length === 0) continue;
    platforms.push({ platform: source.platform, host: source.host, projects });
  }
  return platforms;
}

// ---- Selection state ---------------------------------------------------------

export type RelayNodeCheckState = "checked" | "partial" | "unchecked";

export function projectConversationIds(project: RelaySelectorProject): number[] {
  return project.conversations.map((conversation) => conversation.id);
}

export function platformConversationIds(platform: RelaySelectorPlatform): number[] {
  return platform.projects.flatMap(projectConversationIds);
}

export function modelConversationIds(model: RelaySelectorPlatform[]): number[] {
  return model.flatMap(platformConversationIds);
}

/** Tri-state of a node checkbox over a flat id selection. */
export function relayNodeCheckState(
  selected: ReadonlySet<number>,
  ids: readonly number[]
): RelayNodeCheckState {
  if (ids.length === 0) return "unchecked";
  let hits = 0;
  for (const id of ids) {
    if (selected.has(id)) hits += 1;
  }
  if (hits === 0) return "unchecked";
  return hits === ids.length ? "checked" : "partial";
}

/**
 * Toggle a scope (platform / project / arbitrary id group): fully selected
 * scopes deselect entirely, anything else selects the whole scope.
 */
export function toggleRelayIds(
  selected: ReadonlySet<number>,
  ids: readonly number[]
): Set<number> {
  const next = new Set(selected);
  const allSelected =
    ids.length > 0 && ids.every((id) => selected.has(id));
  for (const id of ids) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** Toggle a single conversation row. */
export function toggleRelayConversation(
  selected: ReadonlySet<number>,
  id: number
): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
