// Project resolution for memory entries: flattens the conversation tree into
// a session→project map so the 记忆 (memories) section can group cards by
// project, and every date label can prefer the time the underlying
// conversations actually happened over the entry's own write time.
//
// Everything here is pure logic (unit-tested in memoryProjects.test.ts)
// except the useSessionProjectMap hook at the bottom.

import { useEffect, useState } from "react";
import type {
  ConversationTree,
  ConversationTreeSession,
  MemoryEntryView,
  StorageApi,
} from "../../types";

/** session id → owning project, flattened from the conversation tree. */
export interface SessionProjectInfo {
  projectKey: string;
  projectLabel: string;
  /** The session's own last-activity timestamp (ms). */
  lastActivityAt: number;
}

export type SessionProjectMap = ReadonlyMap<string, SessionProjectInfo>;

export const EMPTY_SESSION_PROJECT_MAP: SessionProjectMap = new Map();

/** Project bucket of grouped entries. projectKey/projectLabel are null for
 * the 未关联 (unlinked) bucket, which always sorts last. */
export interface MemoryProjectGroup {
  projectKey: string | null;
  projectLabel: string | null;
  entries: MemoryEntryView[];
  /** Newest entry event time in the group (ms) — drives card ordering. */
  latestAt: number;
}

/** Flatten the conversation tree into session id → project info, recursing
 * into subagent children. Null/absent tree → empty map (callers degrade to
 * the unlinked bucket and plain dates, never an error state). */
export function buildSessionProjectMap(tree: ConversationTree | null): SessionProjectMap {
  const map = new Map<string, SessionProjectInfo>();
  const walk = (
    session: ConversationTreeSession,
    project: { projectKey: string; projectLabel: string },
  ) => {
    map.set(session.id, { ...project, lastActivityAt: session.lastActivityAt });
    for (const child of session.children ?? []) walk(child, project);
  };
  for (const source of tree?.sources ?? []) {
    for (const project of source.projects) {
      const identity = { projectKey: project.projectKey, projectLabel: project.label };
      for (const session of project.sessions) walk(session, identity);
    }
  }
  return map;
}

/** The project a memory entry belongs to: the project most of its source
 * sessions resolve to (majority wins); ties go to the project whose matched
 * session was active most recently. Null when nothing resolves. */
export function resolveEntryProject(
  entry: MemoryEntryView,
  map: SessionProjectMap,
): { projectKey: string; projectLabel: string } | null {
  const tallies = new Map<string, { projectLabel: string; hits: number; latestAt: number }>();
  for (const id of entry.sourceSessionIds ?? []) {
    const info = map.get(id);
    if (!info) continue;
    const tally = tallies.get(info.projectKey);
    if (tally) {
      tally.hits += 1;
      tally.latestAt = Math.max(tally.latestAt, info.lastActivityAt);
    } else {
      tallies.set(info.projectKey, {
        projectLabel: info.projectLabel,
        hits: 1,
        latestAt: info.lastActivityAt,
      });
    }
  }
  let winner: { projectKey: string; projectLabel: string; hits: number; latestAt: number } | null =
    null;
  for (const [projectKey, tally] of tallies) {
    if (
      !winner ||
      tally.hits > winner.hits ||
      (tally.hits === winner.hits && tally.latestAt > winner.latestAt)
    ) {
      winner = { projectKey, ...tally };
    }
  }
  return winner ? { projectKey: winner.projectKey, projectLabel: winner.projectLabel } : null;
}

/** Earliest lastActivityAt across the entry's resolvable source sessions —
 * the best proxy for when the conversations behind the memory happened. */
export function earliestSessionActivity(
  entry: MemoryEntryView,
  map: SessionProjectMap,
): number | null {
  let earliest: number | null = null;
  for (const id of entry.sourceSessionIds ?? []) {
    const info = map.get(id);
    if (!info) continue;
    earliest = earliest === null ? info.lastActivityAt : Math.min(earliest, info.lastActivityAt);
  }
  return earliest;
}

/** Comparable event time (ms) for sorting: entryDate → earliest session
 * activity → updatedAt. */
export function entryEventTime(entry: MemoryEntryView, map: SessionProjectMap): number {
  if (entry.entryDate) {
    const parsed = Date.parse(entry.entryDate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return earliestSessionActivity(entry, map) ?? entry.updatedAt;
}

/** Display date for an entry: the stored entryDate wins; otherwise the
 * earliest source-session activity date; the write time is the last resort. */
export function entryDateLabel(entry: MemoryEntryView, sessionMap?: SessionProjectMap): string {
  if (entry.entryDate) return entry.entryDate;
  const earliest = earliestSessionActivity(entry, sessionMap ?? EMPTY_SESSION_PROJECT_MAP);
  if (earliest !== null) return new Date(earliest).toLocaleDateString();
  return new Date(entry.updatedAt).toLocaleDateString();
}

/** Group entries by their resolved project. Groups are ordered by the newest
 * entry event time inside, descending; the unlinked bucket (projectKey null)
 * always comes last, even when its entries are the newest. */
export function groupEntriesByProject(
  entries: MemoryEntryView[],
  map: SessionProjectMap,
): MemoryProjectGroup[] {
  const byKey = new Map<string, MemoryProjectGroup>();
  const unlinked: MemoryProjectGroup = {
    projectKey: null,
    projectLabel: null,
    entries: [],
    latestAt: 0,
  };
  for (const entry of entries) {
    const resolved = resolveEntryProject(entry, map);
    const time = entryEventTime(entry, map);
    if (!resolved) {
      unlinked.entries.push(entry);
      unlinked.latestAt = Math.max(unlinked.latestAt, time);
      continue;
    }
    let group = byKey.get(resolved.projectKey);
    if (!group) {
      group = {
        projectKey: resolved.projectKey,
        projectLabel: resolved.projectLabel,
        entries: [],
        latestAt: 0,
      };
      byKey.set(resolved.projectKey, group);
    }
    group.entries.push(entry);
    group.latestAt = Math.max(group.latestAt, time);
  }
  const groups = [...byKey.values()].sort((a, b) => b.latestAt - a.latestAt);
  if (unlinked.entries.length > 0) groups.push(unlinked);
  return groups;
}

/** Toggle one key in an expanded-keys set. Components hold the set in state
 * and start with an empty set — i.e. everything collapsed by default. */
export function toggleExpandedKey(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Load the conversation tree once (on mount and whenever refreshKey bumps)
 * and flatten it into a session→project map. A missing bridge or a load
 * failure degrades to the empty map — grouping falls back to 未关联 and date
 * labels to the old behavior; nothing surfaces an error. */
export function useSessionProjectMap(storage: StorageApi, refreshKey: number): SessionProjectMap {
  const [map, setMap] = useState<SessionProjectMap>(EMPTY_SESSION_PROJECT_MAP);
  useEffect(() => {
    if (!storage.getConversationTree) {
      setMap(EMPTY_SESSION_PROJECT_MAP);
      return;
    }
    let cancelled = false;
    void storage
      .getConversationTree()
      .then((tree) => {
        if (!cancelled) setMap(buildSessionProjectMap(tree));
      })
      .catch(() => {
        if (!cancelled) setMap(EMPTY_SESSION_PROJECT_MAP);
      });
    return () => {
      cancelled = true;
    };
  }, [storage, refreshKey]);
  return map;
}
