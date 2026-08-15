
"use client";

// 夜话 (Companion) — the Explore ask pane. One owl conversation partner over
// the shared explore_sessions store: turns go through StorageApi.askCompanion
// (src/ui/companion/companionService on the desktop host), persisted assistant
// messages carry their mood in agentMeta + a `${mood}\n${body}` content line,
// and the persona / memory-scope switchers persist as ui-preferences. The
// rendering is split into ./explore/CompanionSessions (sidebar) and
// ./explore/CompanionChat (header + bubbles + composer); all message → view
// mapping lives in ./explore/companionView.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { ResizablePanelDivider } from "../components/ResizablePanelDivider";
import { useResizableWidth } from "../hooks/use-resizable-width";
import type {
  CompanionErrorView,
  CompanionMemoryScope,
  CompanionOwlIcons,
  CompanionPersona,
  ExploreLabels,
  ExploreMessage,
  ExploreSession,
  StorageApi,
  UiThemeMode,
} from "../types";
import {
  companionErrorFrom,
  COMPANION_MEMORY_SCOPE_PREF_KEY,
  COMPANION_PERSONA_PREF_KEY,
  loadCompanionPreferences,
  saveCompanionPreference,
} from "./explore/companionView";
import { CompanionSessions } from "./explore/CompanionSessions";
import { CompanionChat } from "./explore/CompanionChat";

type ExploreTabProps = {
  storage: StorageApi;
  themeMode?: UiThemeMode;
  onOpenConversation?: (conversationId: number) => void;
  labels: ExploreLabels;
  /** "继续深入" seed: the host hands a prefilled question (e.g. from the Learn
   * map); the composer adopts it once per nonce and takes focus. */
  seedQuery?: { text: string; nonce: number } | null;
  /** Owl mood icons resolved by the host (src/ui/assets/owl via import.meta.glob). */
  owlIcons?: CompanionOwlIcons;
};

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function ExploreTab({
  storage,
  themeMode = "light",
  onOpenConversation,
  labels,
  seedQuery,
  owlIcons,
}: ExploreTabProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<ExploreSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ExploreMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const justCreatedSessionRef = useRef<string | null>(null);

  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Classified failure banner + what its retry button should re-fire. Every
  // async path below (send, opener, history load, session list, rename,
  // delete, lost session) lands here instead of failing silently.
  const [error, setError] = useState<CompanionErrorView | null>(null);
  const [errorRetry, setErrorRetry] = useState<"send" | "opener" | "reload-messages" | null>(null);
  const [sessionsLoadError, setSessionsLoadError] = useState(false);
  // Live-typing state of the in-flight streaming turn (null = not streaming).
  const [streaming, setStreaming] = useState<{ raw: string; reasoning: string } | null>(null);

  // Persona / memory-scope switches: local state seeded from ui-preferences,
  // every change persisted back (window.vestiUi on the desktop host).
  const [persona, setPersona] = useState<CompanionPersona>("listener");
  const [memoryScope, setMemoryScope] = useState<CompanionMemoryScope>("full");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Mirror for loadSessions — depending on currentSessionId directly would
  // re-run the mount effect (and re-fetch the whole list) on every switch.
  const currentSessionIdRef = useRef<string | null>(null);
  currentSessionIdRef.current = currentSessionId;
  const sidebarPane = useResizableWidth({
    storageKey: "vesti.explore.sidebar-width",
    defaultWidth: 256,
    minWidth: 216,
    maxWidth: 360,
  });

  const currentSession = sessions.find((session) => session.id === currentSessionId);

  const loadSessions = useCallback(async () => {
    if (!storage.listExploreSessions) return;
    setSessionsLoading(true);
    try {
      const data = await storage.listExploreSessions(50);
      setSessions(data);
      setSessionsLoadError(false);
      // Lost-session cross-check: the open conversation fell out of the list
      // (deleted in another window / cleanup / corruption). The 50-row cap
      // can hide a still-existing session, so probe before declaring it lost —
      // and never bounce the user: the gentle banner + one-tap new chat do.
      const openId = currentSessionIdRef.current;
      if (openId && !data.some((session) => session.id === openId)) {
        const probe = await storage.getExploreSession?.(openId).catch(() => undefined);
        if (probe === null) {
          setError({ category: "session-lost", message: "" });
          setErrorRetry(null);
        }
      }
    } catch (err) {
      console.error("[Companion] Failed to load sessions:", err);
      setSessionsLoadError(true);
    } finally {
      setSessionsLoading(false);
    }
  }, [storage]);

  const loadMessages = useCallback(
    async (sessionId: string) => {
      if (!storage.getExploreMessages) return;
      // Clear first so the loading spinner (gated on messages.length === 0)
      // shows instead of the previous session's transcript while in flight.
      setMessages([]);
      setMessagesLoading(true);
      try {
        // Existence probe: a deleted session's messages read as an empty
        // array, indistinguishable from a fresh chat — catch it explicitly.
        const probe = await storage.getExploreSession?.(sessionId).catch(() => undefined);
        if (probe === null) {
          setError({ category: "session-lost", message: "" });
          setErrorRetry(null);
          return;
        }
        const data = await storage.getExploreMessages(sessionId);
        setMessages(data || []);
      } catch (err) {
        console.error("[Companion] Failed to load messages:", err);
        setError({ ...companionErrorFrom(err), category: "local" });
        setErrorRetry("reload-messages");
      } finally {
        setMessagesLoading(false);
      }
    },
    [storage],
  );

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Seed the switches from ui-preferences once (companion.persona /
  // companion.memoryScope — the dailyScheduler pref pattern).
  useEffect(() => {
    let cancelled = false;
    void loadCompanionPreferences(storage).then((prefs) => {
      if (cancelled) return;
      setPersona(prefs.persona);
      setMemoryScope(prefs.memoryScope);
    });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  // Adopt a host-seeded question ("继续深入" from the Learn map) once per
  // nonce: fill the composer and focus it so the user can edit/send at once.
  const seededNonceRef = useRef(0);
  useEffect(() => {
    if (!seedQuery || seedQuery.nonce === seededNonceRef.current) return;
    seededNonceRef.current = seedQuery.nonce;
    setInputValue(seedQuery.text);
    textareaRef.current?.focus();
  }, [seedQuery]);

  useEffect(() => {
    if (currentSessionId) {
      if (justCreatedSessionRef.current === currentSessionId) {
        justCreatedSessionRef.current = null;
        return;
      }
      void loadMessages(currentSessionId);
    } else {
      setMessages([]);
    }
  }, [currentSessionId, loadMessages]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isSubmitting, error, streaming]);

  const handlePersonaChange = (next: CompanionPersona) => {
    setPersona(next);
    void saveCompanionPreference(storage, COMPANION_PERSONA_PREF_KEY, next);
  };

  const handleScopeChange = (next: CompanionMemoryScope) => {
    setMemoryScope(next);
    void saveCompanionPreference(storage, COMPANION_MEMORY_SCOPE_PREF_KEY, next);
  };

  const handleNewChat = useCallback(
    (withOpener = true) => {
      setCurrentSessionId(null);
      setMessages([]);
      setInputValue("");
      setError(null);
      setErrorRetry(null);
      setStreaming(null);
      // 主动开场: starting a fresh 夜话 lets the owl speak first, grounded in
      // long-term memories. A failure surfaces as the gentle banner with a
      // retry — never a silent dead composer.
      if (!withOpener || !storage.askCompanion || isSubmitting) return;
      setIsSubmitting(true);
      void (async () => {
        try {
          const answer = await storage.askCompanion!({
            question: "",
            opener: true,
            persona,
            memoryScope,
            onStream: (raw) =>
              setStreaming((prev) => ({ raw, reasoning: prev?.reasoning ?? "" })),
            onReasoning: (reasoning) =>
              setStreaming((prev) => ({ raw: prev?.raw ?? "", reasoning })),
          });
          setStreaming(null);
          justCreatedSessionRef.current = answer.sessionId;
          setCurrentSessionId(answer.sessionId);
          // Mirror the persisted contract exactly like handleSubmit does.
          const openerMessage: ExploreMessage = {
            id: generateId(),
            sessionId: answer.sessionId,
            role: "assistant",
            content: `${answer.mood}\n${answer.content}`,
            sources: answer.sources,
            agentMeta: {
              mode: "agent",
              toolCalls: [],
              mood: answer.mood,
              persona: answer.persona,
              memoryScope,
              ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
            },
            timestamp: Date.now(),
          };
          setMessages([openerMessage]);
          await loadSessions();
        } catch (err) {
          console.error("[Companion] Opener error:", err);
          setStreaming(null);
          setError(companionErrorFrom(err));
          setErrorRetry("opener");
        } finally {
          setIsSubmitting(false);
        }
      })();
    },
    [storage, isSubmitting, persona, memoryScope, loadSessions],
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      if (!storage.renameExploreSession) return;
      try {
        await storage.renameExploreSession(sessionId, title);
        await loadSessions();
      } catch (err) {
        console.error("[Companion] Failed to rename session:", err);
        // Storage-layer failure: visible banner, nothing to re-fire (the
        // rename input already closed) — the user can simply rename again.
        setError({ ...companionErrorFrom(err), category: "local" });
        setErrorRetry(null);
      }
    },
    [storage, loadSessions],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!storage.deleteExploreSession) return;
      if (!confirm(labels.deleteConversationConfirm)) return;
      try {
        await storage.deleteExploreSession(sessionId);
        if (currentSessionId === sessionId) {
          // Deleting the active chat resets to the composer silently — firing
          // an opener here would spend credits on a gesture that isn't "start
          // a new conversation".
          handleNewChat(false);
        }
        await loadSessions();
      } catch (err) {
        console.error("[Companion] Failed to delete session:", err);
        setError({ ...companionErrorFrom(err), category: "local" });
        setErrorRetry(null);
      }
    },
    [storage, labels.deleteConversationConfirm, currentSessionId, handleNewChat, loadSessions],
  );

  const handleSubmit = useCallback(async (textOverride?: string) => {
    // Welcome-area chips hand their prompt in directly; the composer's own
    // send reads the textarea state.
    const trimmed = (textOverride ?? inputValue).trim();
    if (!trimmed || isSubmitting) return;

    if (!storage.askCompanion) {
      setError({ category: "unknown", message: labels.exploreUnavailable });
      setErrorRetry(null);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setErrorRetry(null);
    setStreaming(null);

    const optimisticUserMessage: ExploreMessage = {
      id: generateId(),
      sessionId: currentSessionId || "temp",
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, optimisticUserMessage]);
    setInputValue("");

    try {
      const answer = await storage.askCompanion({
        sessionId: currentSessionId || undefined,
        question: trimmed,
        persona,
        memoryScope,
        // Live typing: the host streams raw chunks (mood tag line included —
        // the bubble hides it) plus the thinking trace when the model has one.
        onStream: (raw) =>
          setStreaming((prev) => ({ raw, reasoning: prev?.reasoning ?? "" })),
        onReasoning: (reasoning) =>
          setStreaming((prev) => ({ raw: prev?.raw ?? "", reasoning })),
      });
      setStreaming(null);

      if (!currentSessionId) {
        justCreatedSessionRef.current = answer.sessionId;
        setCurrentSessionId(answer.sessionId);
      }

      // Mirror the persisted contract (`${mood}\n${body}` + agentMeta) so the
      // live bubble renders exactly like a reloaded one.
      const assistantMessage: ExploreMessage = {
        id: generateId(),
        sessionId: answer.sessionId,
        role: "assistant",
        content: `${answer.mood}\n${answer.content}`,
        sources: answer.sources,
        agentMeta: {
          mode: "agent",
          toolCalls: [],
          mood: answer.mood,
          persona: answer.persona,
          memoryScope,
          ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
        },
        timestamp: Date.now(),
      };

      if (!currentSessionId) {
        setMessages([optimisticUserMessage, assistantMessage]);
      } else {
        setMessages((prev) => [...prev, assistantMessage]);
      }

      await loadSessions();
    } catch (err) {
      console.error("[Companion] Submit error:", err);
      setStreaming(null);
      // Classified, gentle banner: 网络连不上 vs 服务配置问题 vs 积分用尽 vs
      // 会话丢失 — each with its own copy, and a retry for everything that
      // re-firing could fix (session-lost offers a fresh 夜话 instead).
      const view = companionErrorFrom(err);
      setError(view);
      setErrorRetry(view.category === "session-lost" ? null : "send");
      setMessages((prev) => prev.filter((message) => message.id !== optimisticUserMessage.id));
      // Restore the question so a transient failure doesn't lose the typing.
      setInputValue(trimmed);
      textareaRef.current?.focus();
    } finally {
      setIsSubmitting(false);
    }
  }, [
    inputValue,
    isSubmitting,
    storage,
    labels.exploreUnavailable,
    currentSessionId,
    persona,
    memoryScope,
    loadSessions,
  ]);

  /** The banner's retry button re-fires whatever failed: the last send (the
   * composer kept the text), the opener, or the history reload. */
  const handleErrorRetry = useCallback(() => {
    if (errorRetry === "send") void handleSubmit();
    else if (errorRetry === "opener") handleNewChat(true);
    else if (errorRetry === "reload-messages" && currentSessionId) {
      void loadMessages(currentSessionId);
    }
  }, [errorRetry, currentSessionId, handleSubmit, handleNewChat, loadMessages]);

  /** Switching sessions dismisses any stale banner from the previous one. */
  const handleSelectSession = useCallback((sessionId: string) => {
    setError(null);
    setErrorRetry(null);
    setCurrentSessionId(sessionId);
  }, []);

  return (
    <div className="relative flex h-full">
      {sidebarOpen ? (
        <>
          <div className="shrink-0 bg-bg-tertiary" style={{ width: `${sidebarPane.width}px` }}>
            <CompanionSessions
              labels={labels}
              themeMode={themeMode}
              sessions={sessions}
              loading={sessionsLoading}
              loadError={sessionsLoadError}
              onRetryLoad={() => void loadSessions()}
              currentSessionId={currentSessionId}
              onSelectSession={handleSelectSession}
              onNewChat={() => handleNewChat()}
              onRenameSession={handleRenameSession}
              onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
            />
          </div>

          <ResizablePanelDivider
            ariaLabel={labels.resizeSidebarAria}
            onPointerDown={sidebarPane.handlePointerDown}
            onNudge={sidebarPane.nudgeWidth}
            isDragging={sidebarPane.isDragging}
          />
        </>
      ) : null}

      <CompanionChat
        labels={labels}
        owlIcons={owlIcons}
        persona={persona}
        memoryScope={memoryScope}
        onPersonaChange={handlePersonaChange}
        onScopeChange={handleScopeChange}
        messages={messages}
        messagesLoading={messagesLoading}
        isSubmitting={isSubmitting}
        streaming={streaming}
        error={error}
        onDismissError={() => {
          setError(null);
          setErrorRetry(null);
        }}
        onRetryError={errorRetry ? handleErrorRetry : null}
        onNewChat={() => handleNewChat(true)}
        currentSessionTitle={currentSession?.title ?? null}
        // A failure banner must never hide behind the welcome screen (e.g. a
        // failed opener leaves no messages and no session).
        showEmptyState={messages.length === 0 && !currentSessionId && !messagesLoading && !error}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        inputValue={inputValue}
        onInputChange={setInputValue}
        onSubmit={() => void handleSubmit()}
        onSendText={(text) => void handleSubmit(text)}
        onOpenConversation={onOpenConversation}
        textareaRef={textareaRef}
        messagesEndRef={messagesEndRef}
      />
    </div>
  );
}
