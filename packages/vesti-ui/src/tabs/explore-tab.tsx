
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
  const [error, setError] = useState<string | null>(null);
  // Live-typing state of the in-flight streaming turn (null = not streaming).
  const [streaming, setStreaming] = useState<{ raw: string; reasoning: string } | null>(null);

  // Persona / memory-scope switches: local state seeded from ui-preferences,
  // every change persisted back (window.vestiUi on the desktop host).
  const [persona, setPersona] = useState<CompanionPersona>("listener");
  const [memoryScope, setMemoryScope] = useState<CompanionMemoryScope>("full");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    } catch (err) {
      console.error("[Companion] Failed to load sessions:", err);
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
        const data = await storage.getExploreMessages(sessionId);
        setMessages(data || []);
      } catch (err) {
        console.error("[Companion] Failed to load messages:", err);
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
      setStreaming(null);
      // 主动开场: starting a fresh 夜话 lets the owl speak first, grounded in
      // long-term memories. Best-effort — a failure just leaves the composer.
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
      }
    },
    [storage, labels.deleteConversationConfirm, currentSessionId, handleNewChat, loadSessions],
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isSubmitting) return;

    if (!storage.askCompanion) {
      setError(labels.exploreUnavailable);
      return;
    }

    setIsSubmitting(true);
    setError(null);
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
      setError((err as Error)?.message ?? labels.failedToRetrieveAnswer);
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
    labels.failedToRetrieveAnswer,
    currentSessionId,
    persona,
    memoryScope,
    loadSessions,
  ]);

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
              currentSessionId={currentSessionId}
              onSelectSession={setCurrentSessionId}
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
        onDismissError={() => setError(null)}
        currentSessionTitle={currentSession?.title ?? null}
        showEmptyState={messages.length === 0 && !currentSessionId && !messagesLoading}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        inputValue={inputValue}
        onInputChange={setInputValue}
        onSubmit={() => void handleSubmit()}
        onOpenConversation={onOpenConversation}
        textareaRef={textareaRef}
        messagesEndRef={messagesEndRef}
      />
    </div>
  );
}
