"use client";

// 夜话 session sidebar: the explore_sessions list the ask pane always had
// (grouped today / yesterday / earlier, rename + delete row actions), with the
// companion twist — the "new chat" button says 新的夜话 and stored previews
// get the mood tag line stripped via toCompanionSessionPreview.

import { Loader2, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExploreLabels, ExploreSession, UiThemeMode } from "../../types";
import { toCompanionSessionPreview } from "./companionView";

function groupSessionsByTime(sessions: ExploreSession[]): {
  today: ExploreSession[];
  yesterday: ExploreSession[];
  earlier: ExploreSession[];
} {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;

  return sessions.reduce(
    (groups, session) => {
      if (session.updatedAt >= startOfToday) {
        groups.today.push(session);
      } else if (session.updatedAt >= startOfYesterday) {
        groups.yesterday.push(session);
      } else {
        groups.earlier.push(session);
      }
      return groups;
    },
    { today: [], yesterday: [], earlier: [] } as {
      today: ExploreSession[];
      yesterday: ExploreSession[];
      earlier: ExploreSession[];
    }
  );
}

export interface CompanionSessionsProps {
  labels: ExploreLabels;
  themeMode?: UiThemeMode;
  sessions: ExploreSession[];
  loading: boolean;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => void;
}

export function CompanionSessions({
  labels,
  themeMode = "light",
  sessions,
  loading,
  currentSessionId,
  onSelectSession,
  onNewChat,
  onRenameSession,
  onDeleteSession,
}: CompanionSessionsProps) {
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const grouped = useMemo(() => groupSessionsByTime(sessions), [sessions]);

  useEffect(() => {
    if (renameTargetId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameTargetId]);

  const submitRename = async () => {
    if (!renameTargetId) return;
    const trimmed = renameValue.trim();
    const target = sessions.find((session) => session.id === renameTargetId);
    setRenameTargetId(null);
    if (!trimmed || !target || trimmed === target.title) return;
    await onRenameSession(renameTargetId, trimmed);
  };

  const renderSessionItem = (session: ExploreSession) => {
    const isActive = session.id === currentSessionId;
    const isRenaming = renameTargetId === session.id;

    return (
      <div
        key={session.id}
        onClick={() => onSelectSession(session.id)}
        className={`group relative flex items-center gap-2 rounded-lg px-3 py-2 transition-all ${
          isActive ? "bg-bg-surface-card-active" : "cursor-pointer hover:bg-bg-surface-card"
        }`}
      >
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename();
                  if (event.key === "Escape") setRenameTargetId(null);
                }}
                onBlur={() => void submitRename()}
                className="flex-1 rounded border border-border-default bg-bg-primary px-2 py-1 text-sm font-sans text-text-primary focus:border-accent-primary focus:outline-none"
              />
            </div>
          ) : (
            <>
              <p className="truncate text-sm font-sans text-text-primary">
                {session.title || labels.untitledSession}
              </p>
              <p className="truncate text-xs font-sans text-text-tertiary">
                {session.preview ? toCompanionSessionPreview(session.preview) : labels.noMessages}
              </p>
            </>
          )}
        </div>

        {!isRenaming && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setRenameTargetId(session.id);
                setRenameValue(session.title);
              }}
              className="rounded p-1 text-text-tertiary hover:bg-bg-surface-card hover:text-text-primary"
              title={labels.rename}
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteSession(session.id);
              }}
              className="rounded p-1 text-text-tertiary hover:bg-bg-surface-card hover:text-danger"
              title={labels.delete}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (groupLabel: string, groupSessions: ExploreSession[]) =>
    groupSessions.length > 0 ? (
      <div key={groupLabel}>
        <p className="px-3 py-1 text-[10px] font-sans uppercase tracking-wider text-text-tertiary">
          {groupLabel}
        </p>
        <div className="space-y-0.5">{groupSessions.map(renderSessionItem)}</div>
      </div>
    ) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-subtle p-3">
        <button
          type="button"
          onClick={onNewChat}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
            themeMode === "dark"
              ? "bg-bg-secondary text-text-primary hover:bg-bg-surface-card-hover"
              : "bg-accent-primary text-text-inverse hover:bg-accent-primary/90"
          }`}
        >
          <MessageSquarePlus className="h-4 w-4" strokeWidth={1.5} />
          <span className="text-sm font-sans font-medium">{labels.companion.newChat}</span>
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-2">
        {loading ? (
          <div className="py-4 text-center">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-accent-primary" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-4 text-center text-xs font-sans text-text-tertiary">
            {labels.noConversationsYet}
          </div>
        ) : (
          <>
            {renderGroup(labels.today, grouped.today)}
            {renderGroup(labels.yesterday, grouped.yesterday)}
            {renderGroup(labels.earlier, grouped.earlier)}
          </>
        )}
      </div>
    </div>
  );
}
