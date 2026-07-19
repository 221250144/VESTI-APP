// P4b deposits: unit tests for the pure helpers — version-chain logic and
// scope → conversation-id resolution. Node environment, no Dexie involved.

import { describe, expect, it } from "vitest";
import type { ConversationTree } from "../../shared/contracts";
import type { Deposit, DepositScope } from "../db/types";
import {
  collectVersionChain,
  findDepositHeads,
  nextDepositVersion,
  resolveScopeConversationIds,
  type ScopeResolutionData,
} from "./deposits";

function makeDeposit(overrides: Partial<Deposit> & { id: number }): Deposit {
  return {
    createdAt: 1_000,
    updatedAt: 1_000,
    template: "custom",
    title: `deposit ${overrides.id}`,
    scope: { kind: "selection", conversationIds: [] },
    contentMarkdown: "body",
    version: 1,
    prevId: null,
    customInstruction: null,
    ...overrides,
  };
}

describe("nextDepositVersion", () => {
  it("starts a fresh chain at v1 with no predecessor", () => {
    expect(nextDepositVersion(null)).toEqual({ version: 1, prevId: null });
  });

  it("chains a regeneration onto the previous head", () => {
    expect(nextDepositVersion({ id: 7, version: 3 })).toEqual({ version: 4, prevId: 7 });
  });
});

describe("collectVersionChain / findDepositHeads", () => {
  const v1 = makeDeposit({ id: 1, version: 1, prevId: null, createdAt: 1_000 });
  const v2 = makeDeposit({ id: 2, version: 2, prevId: 1, createdAt: 2_000 });
  const v3 = makeDeposit({ id: 3, version: 3, prevId: 2, createdAt: 3_000 });
  const other = makeDeposit({ id: 4, createdAt: 4_000 });

  it("walks the chain newest to oldest following prevId", () => {
    expect(collectVersionChain([v1, v2, v3, other], 3).map((d) => d.id)).toEqual([3, 2, 1]);
    expect(collectVersionChain([v1, v2, v3, other], 2).map((d) => d.id)).toEqual([2, 1]);
    expect(collectVersionChain([v1, v2, v3, other], 4).map((d) => d.id)).toEqual([4]);
  });

  it("stops on dangling predecessors and survives cycles", () => {
    expect(collectVersionChain([v2, v3], 3).map((d) => d.id)).toEqual([3, 2]);
    const cyclicA = makeDeposit({ id: 10, prevId: 11 });
    const cyclicB = makeDeposit({ id: 11, prevId: 10 });
    expect(collectVersionChain([cyclicA, cyclicB], 10).map((d) => d.id)).toEqual([10, 11]);
  });

  it("returns only current heads", () => {
    expect(findDepositHeads([v1, v2, v3, other]).map((d) => d.id)).toEqual([3, 4]);
  });
});

describe("resolveScopeConversationIds", () => {
  const tree: ConversationTree = {
    generatedAt: "2026-07-18T00:00:00.000Z",
    sources: [
      {
        platform: "kimi-cli",
        host: "local",
        projects: [
          {
            projectKey: "cli:/work/vesti",
            label: "vesti",
            pathOrDomain: "/work/vesti",
            sessions: [
              {
                id: "cli-session-1",
                title: "s1",
                messageCount: 10,
                lastActivityAt: 1,
                oneLiner: null,
                keyTopics: [],
                keyFiles: [],
                decisions: [],
              },
              {
                id: "cli-session-missing",
                title: "gone",
                messageCount: 1,
                lastActivityAt: 1,
                oneLiner: null,
                keyTopics: [],
                keyFiles: [],
                decisions: [],
              },
            ],
          },
        ],
      },
      {
        platform: "browser",
        host: "browser",
        projects: [
          {
            projectKey: "web:chatgpt.com",
            label: "chatgpt.com",
            pathOrDomain: "chatgpt.com",
            sessions: [
              {
                id: "browser:5",
                title: "web",
                messageCount: 3,
                lastActivityAt: 1,
                oneLiner: null,
                keyTopics: [],
                keyFiles: [],
                decisions: [],
              },
            ],
          },
        ],
      },
    ],
  };

  const data: ScopeResolutionData = {
    conversations: [
      { id: 1, topic_id: 7, updated_at: 100, _cli_id: "cli-session-1" },
      { id: 2, topic_id: 7, updated_at: 300 },
      { id: 3, topic_id: 8, updated_at: 200 },
      { id: 5, topic_id: null, updated_at: 50 },
    ],
    tree,
  };

  it("selection keeps the given order and drops unknown ids", () => {
    const scope: DepositScope = { kind: "selection", conversationIds: [3, 1, 99, 3, -1] };
    expect(resolveScopeConversationIds(scope, data)).toEqual([3, 1]);
  });

  it("topic filters by topic_id, newest first", () => {
    expect(resolveScopeConversationIds({ kind: "topic", topicId: 7, label: "t" }, data)).toEqual([2, 1]);
    expect(resolveScopeConversationIds({ kind: "topic", topicId: 42, label: "t" }, data)).toEqual([]);
  });

  it("timerange filters inclusively by updated_at", () => {
    const scope: DepositScope = { kind: "timerange", start: 100, end: 200 };
    expect(resolveScopeConversationIds(scope, data)).toEqual([3, 1]);
    expect(
      resolveScopeConversationIds({ kind: "timerange", start: 400, end: 500 }, data),
    ).toEqual([]);
  });

  it("project maps CLI session ids via _cli_id and browser ids via the prefix", () => {
    const cli = resolveScopeConversationIds(
      { kind: "project", projectKey: "cli:/work/vesti", label: "vesti" },
      data,
    );
    expect(cli).toEqual([1]);
    const web = resolveScopeConversationIds(
      { kind: "project", projectKey: "web:chatgpt.com", label: "chatgpt.com" },
      data,
    );
    expect(web).toEqual([5]);
  });

  it("project resolves to nothing for an unknown key or a missing tree", () => {
    expect(
      resolveScopeConversationIds({ kind: "project", projectKey: "nope", label: "x" }, data),
    ).toEqual([]);
    expect(
      resolveScopeConversationIds(
        { kind: "project", projectKey: "cli:/work/vesti", label: "vesti" },
        { ...data, tree: null },
      ),
    ).toEqual([]);
  });
});
