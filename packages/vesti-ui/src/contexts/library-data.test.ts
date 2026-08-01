import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation, StorageApi, Topic } from "../types";
import { refreshLibraryDataState } from "./library-data";

describe("refreshLibraryDataState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps core conversations when the optional project-state API fails", async () => {
    const topics = [{ id: 1, name: "Captured" }] as Topic[];
    const conversations = [
      { id: 42, title: "Latest captured conversation" },
    ] as Conversation[];
    const projectStateError = new Error("no such table: project_state");
    const storage: StorageApi = {
      getTopics: vi.fn().mockResolvedValue(topics),
      getConversations: vi.fn().mockResolvedValue(conversations),
      getProjectStates: vi.fn().mockRejectedValue(projectStateError),
    };
    const setters = {
      setTopics: vi.fn(),
      setConversations: vi.fn(),
      setDigestByConversationId: vi.fn(),
      setConversationTree: vi.fn(),
      setProjectStateByKey: vi.fn(),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await refreshLibraryDataState(storage, setters);

    expect(setters.setTopics).toHaveBeenCalledOnce();
    expect(setters.setTopics).toHaveBeenCalledWith(topics);
    expect(setters.setConversations).toHaveBeenCalledOnce();
    expect(setters.setConversations).toHaveBeenCalledWith(conversations);
    expect(setters.setDigestByConversationId).toHaveBeenCalledWith(new Map());
    expect(setters.setConversationTree).toHaveBeenCalledWith(null);
    expect(setters.setProjectStateByKey).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[library] Failed to load project states",
      projectStateError
    );
  });
});
