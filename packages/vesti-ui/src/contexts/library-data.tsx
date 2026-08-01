"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Conversation,
  ConversationDigest,
  ConversationTree,
  ProjectStateView,
  Topic,
  StorageApi,
} from "../types";
import {
  useExtensionSync,
  type ConversationUpdatedPayload,
} from "../hooks/use-extension-sync";

type LibraryDataContextValue = {
  topics: Topic[];
  conversations: Conversation[];
  /** Per-conversation digest (P1.5), keyed by conversation id; empty when the
   * platform has no digest pipeline. */
  digestByConversationId: Map<number, ConversationDigest>;
  /** Desktop conversation tree for the source-tree nav (P2b); null when the
   * platform has no capture pipeline (extension). */
  conversationTree: ConversationTree | null;
  /** Memory v2 L0 cards keyed by projectKey; empty without a capture pipeline. */
  projectStateByKey: Map<string, ProjectStateView>;
  refresh: () => Promise<void>;
  updateConversationInState: (payload: ConversationUpdatedPayload) => void;
};

const LibraryDataContext = createContext<LibraryDataContextValue | null>(null);

function recomputeTopicCounts(
  currentTopics: Topic[],
  currentConversations: Conversation[]
): Topic[] {
  const directCounts = new Map<number, number>();

  for (const conversation of currentConversations) {
    if ("is_archived" in conversation && conversation.is_archived) continue;
    if ("is_trash" in conversation && conversation.is_trash) continue;
    if (conversation.topic_id === null) continue;

    directCounts.set(
      conversation.topic_id,
      (directCounts.get(conversation.topic_id) ?? 0) + 1
    );
  }

  const withCounts = (node: Topic): Topic => {
    const children = node.children?.map(withCounts) ?? [];
    const childTotal = children.reduce((sum, child) => sum + (child.count ?? 0), 0);
    const count = (directCounts.get(node.id) ?? 0) + childTotal;
    return { ...node, children, count };
  };

  return currentTopics.map(withCounts);
}

type LibraryDataStateSetters = {
  setTopics: (value: Topic[]) => void;
  setConversations: (value: Conversation[]) => void;
  setDigestByConversationId: (
    value: Map<number, ConversationDigest>
  ) => void;
  setConversationTree: (value: ConversationTree | null) => void;
  setProjectStateByKey: (value: Map<string, ProjectStateView>) => void;
};

/**
 * Refreshes the library without letting optional desktop-memory APIs block the
 * core conversation list. Kept as a small state adapter so the failure mode is
 * covered without needing a browser renderer in unit tests.
 */
export async function refreshLibraryDataState(
  storage: StorageApi,
  setters: LibraryDataStateSetters
): Promise<void> {
  const coreLoad = (async () => {
    const [topicResult, conversationResult] = await Promise.allSettled([
      storage.getTopics(),
      storage.getConversations(),
    ]);

    if (topicResult.status === "fulfilled") {
      setters.setTopics(topicResult.value);
    } else {
      console.error("[library] Failed to load topics", topicResult.reason);
    }
    if (conversationResult.status === "fulfilled") {
      setters.setConversations(conversationResult.value);
    } else {
      console.error(
        "[library] Failed to load conversations",
        conversationResult.reason
      );
    }
  })();

  const auxiliaryLoad = (async () => {
    const [digestResult, treeResult, projectStatesResult] =
      await Promise.allSettled([
        storage.getConversationDigests?.() ?? Promise.resolve([]),
        storage.getConversationTree?.() ?? Promise.resolve(null),
        storage.getProjectStates?.() ?? Promise.resolve([]),
      ]);

    if (digestResult.status === "fulfilled") {
      setters.setDigestByConversationId(
        new Map(
          digestResult.value.map((digest) => [digest.conversationId, digest])
        )
      );
    } else {
      console.error(
        "[library] Failed to load conversation digests",
        digestResult.reason
      );
    }
    if (treeResult.status === "fulfilled") {
      setters.setConversationTree(treeResult.value);
    } else {
      console.error(
        "[library] Failed to load conversation tree",
        treeResult.reason
      );
    }
    if (projectStatesResult.status === "fulfilled") {
      setters.setProjectStateByKey(
        new Map(
          projectStatesResult.value.map((state) => [state.projectKey, state])
        )
      );
    } else {
      console.error(
        "[library] Failed to load project states",
        projectStatesResult.reason
      );
    }
  })();

  await Promise.all([coreLoad, auxiliaryLoad]);
}

export function LibraryDataProvider({
  storage,
  children,
}: {
  storage: StorageApi;
  children: ReactNode;
}) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [digestByConversationId, setDigestByConversationId] = useState<
    Map<number, ConversationDigest>
  >(new Map());
  const [conversationTree, setConversationTree] =
    useState<ConversationTree | null>(null);
  const [projectStateByKey, setProjectStateByKey] = useState<
    Map<string, ProjectStateView>
  >(new Map());

  const refresh = useCallback(async () => {
    await refreshLibraryDataState(storage, {
      setTopics,
      setConversations,
      setDigestByConversationId,
      setConversationTree,
      setProjectStateByKey,
    });
  }, [storage]);

  // Event-driven refresh scheduler. Data-update events arrive in storms
  // (capture sync → auto-classify → its own follow-up event, ...); a naive
  // listener would run the five-way reload above once per event and stack
  // overlapping runs. Events are coalesced with a short debounce, concurrent
  // runs are de-duplicated, and an event landing mid-run schedules exactly
  // one trailing run so nothing is lost.
  const REFRESH_DEBOUNCE_MS = 150;
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRunningRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (refreshRunningRef.current) {
        refreshQueuedRef.current = true;
        return;
      }
      const running = (async () => {
        try {
          await refresh();
        } finally {
          refreshRunningRef.current = null;
          if (refreshQueuedRef.current) {
            refreshQueuedRef.current = false;
            scheduleRefresh();
          }
        }
      })();
      refreshRunningRef.current = running;
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [scheduleRefresh]);

  const updateConversationInState = useCallback(
    (payload: ConversationUpdatedPayload) => {
      setConversations((prev) => {
        let changed = false;
        const next = prev.map((conversation) => {
          if (conversation.id !== payload.id) return conversation;

          const updates: Partial<Conversation> = {};

          if (payload.changes.topic_id !== undefined) {
            updates.topic_id = payload.changes.topic_id;
          }
          if (payload.changes.is_starred !== undefined) {
            updates.is_starred = payload.changes.is_starred;
          }

          if (Object.keys(updates).length === 0) {
            return conversation;
          }

          changed = true;
          return { ...conversation, ...updates };
        });

        if (changed) {
          setTopics((currentTopics) => recomputeTopicCounts(currentTopics, next));
          return next;
        }

        return prev;
      });
    },
    []
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Desktop (Electron): captureSync dispatches this DOM event after each
    // successful SQLite→Dexie import; in the extension this branch is inert.
    const onDesktopUpdate = () => {
      scheduleRefresh();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("vesti:data-updated", onDesktopUpdate);
    }
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
      return () => {
        if (typeof window !== "undefined") {
          window.removeEventListener("vesti:data-updated", onDesktopUpdate);
        }
      };
    }
    const handler = (message: unknown) => {
      if (
        typeof message === "object" &&
        message &&
        (message as { type?: string }).type === "VESTI_DATA_UPDATED"
      ) {
        scheduleRefresh();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      if (typeof window !== "undefined") {
        window.removeEventListener("vesti:data-updated", onDesktopUpdate);
      }
    };
  }, [scheduleRefresh]);

  useExtensionSync(updateConversationInState);

  const value = useMemo(
    () => ({
      topics,
      conversations,
      digestByConversationId,
      conversationTree,
      projectStateByKey,
      refresh,
      updateConversationInState,
    }),
    [
      topics,
      conversations,
      digestByConversationId,
      conversationTree,
      projectStateByKey,
      refresh,
      updateConversationInState,
    ]
  );

  return (
    <LibraryDataContext.Provider value={value}>
      {children}
    </LibraryDataContext.Provider>
  );
}

export function useLibraryData() {
  const ctx = useContext(LibraryDataContext);
  if (!ctx) {
    throw new Error("useLibraryData must be used within LibraryDataProvider");
  }
  return ctx;
}
