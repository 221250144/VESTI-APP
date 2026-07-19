"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
    try {
      const [topicData, conversationData, digestData, treeData, projectStates] =
        await Promise.all([
          storage.getTopics(),
          storage.getConversations(),
          storage.getConversationDigests?.() ?? Promise.resolve([]),
          storage.getConversationTree?.() ?? Promise.resolve(null),
          storage.getProjectStates?.() ?? Promise.resolve([]),
        ]);
      setTopics(topicData);
      setConversations(conversationData);
      setDigestByConversationId(
        new Map(digestData.map((digest) => [digest.conversationId, digest]))
      );
      setConversationTree(treeData);
      setProjectStateByKey(
        new Map(projectStates.map((state) => [state.projectKey, state]))
      );
    } catch (error) {
      console.error("[dashboard] Failed to load library data", error);
    }
  }, [storage]);

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
      void refresh();
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
        void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      if (typeof window !== "undefined") {
        window.removeEventListener("vesti:data-updated", onDesktopUpdate);
      }
    };
  }, [refresh]);

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
