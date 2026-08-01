import { describe, expect, it } from "vitest";
import type {
  ConversationTree,
  ConversationTreeSession,
  Deposit,
  DepositScope,
  GenerateDepositInput,
} from "../../types";
import {
  findSweepHead,
  planDepositSweep,
  runDepositSweep,
  type DepositSweepPlanItem,
  type DepositSweepRunner,
} from "./sweep";

function session(id: string): ConversationTreeSession {
  return {
    id,
    title: id,
    messageCount: 1,
    lastActivityAt: 0,
    oneLiner: null,
    keyTopics: [],
    keyFiles: [],
    decisions: [],
  };
}

const TREE: ConversationTree = {
  generatedAt: "2026-07-31T00:00:00.000Z",
  sources: [
    {
      platform: "claude-code",
      host: "native",
      projects: [
        {
          projectKey: "cli_aaa",
          label: "vesti-app",
          pathOrDomain: "C:/dev/vesti-app",
          sessions: [session("claude-code:s1")],
        },
        {
          projectKey: "cli_empty",
          label: "empty",
          pathOrDomain: "C:/dev/empty",
          sessions: [],
        },
      ],
    },
    {
      platform: "kimi-code",
      host: "native",
      projects: [
        {
          projectKey: "cli_bbb",
          label: "other",
          pathOrDomain: "/home/u/other",
          sessions: [session("kimi-code:s2")],
        },
      ],
    },
  ],
};

function deposit(id: number, overrides: Partial<Deposit> = {}): Deposit {
  return {
    id,
    createdAt: 1000,
    updatedAt: 1000,
    template: "background_knowledge",
    title: `Deposit ${id}`,
    scope: { kind: "timerange", start: 0, end: 100 },
    contentMarkdown: `content ${id}`,
    version: 1,
    prevId: null,
    customInstruction: null,
    ...overrides,
  };
}

/** Stateful mock of the storage/LLM layer: generate persists a new version
 * (chained when previousId is given), emulating the distill+maintain pipeline.
 * `mergeContent` scripts what the maintain merge returns for chained runs. */
function makeRunner(options: {
  scopeIds?: (scope: DepositScope) => number[];
  mergeContent?: (input: GenerateDepositInput, previous: Deposit) => string;
  freshContent?: (input: GenerateDepositInput) => string;
  failOn?: (input: GenerateDepositInput) => boolean;
  seed?: Deposit[];
} = {}) {
  let nextId = 100;
  const deposits: Deposit[] = [...(options.seed ?? [])];
  const generated: GenerateDepositInput[] = [];
  const removed: number[] = [];
  const runner: DepositSweepRunner = {
    listDeposits: async () => [...deposits],
    resolveScope: async (scope) => options.scopeIds?.(scope) ?? [1],
    generate: async (input) => {
      generated.push(input);
      if (options.failOn?.(input)) throw new Error("LLM unavailable");
      const previous = input.previousId
        ? deposits.find((item) => item.id === input.previousId) ?? null
        : null;
      const contentMarkdown = previous
        ? options.mergeContent?.(input, previous) ?? previous.contentMarkdown
        : options.freshContent?.(input) ?? `fresh:${input.template}`;
      const created = deposit(nextId++, {
        template: input.template,
        scope: input.scope,
        contentMarkdown,
        version: previous ? previous.version + 1 : 1,
        prevId: previous?.id ?? null,
      });
      deposits.push(created);
      return created;
    },
    remove: async (id) => {
      removed.push(id);
      const index = deposits.findIndex((item) => item.id === id);
      if (index >= 0) deposits.splice(index, 1);
    },
  };
  return { runner, deposits, generated, removed };
}

const timerangeItem: DepositSweepPlanItem = {
  template: "background_knowledge",
  scope: { kind: "timerange", start: 0, end: 1000 },
};
const projectItem: DepositSweepPlanItem = {
  template: "project_state",
  scope: { kind: "project", projectKey: "cli_aaa", label: "claude-code · vesti-app" },
};

describe("planDepositSweep", () => {
  it("plans whole-history scopes plus one item per captured project", () => {
    const plan = planDepositSweep({ tree: TREE, now: 1234 });
    expect(plan).toEqual([
      { template: "background_knowledge", scope: { kind: "timerange", start: 0, end: 1234 } },
      {
        template: "project_state",
        scope: { kind: "project", projectKey: "cli_aaa", label: "claude-code · vesti-app" },
      },
      {
        template: "project_state",
        scope: { kind: "project", projectKey: "cli_bbb", label: "kimi-code · other" },
      },
      { template: "writing_style", scope: { kind: "timerange", start: 0, end: 1234 } },
    ]);
  });

  it("skips projects without sessions and tolerates a missing tree", () => {
    const keys = planDepositSweep({ tree: TREE })
      .filter((item) => item.scope.kind === "project")
      .map((item) => (item.scope.kind === "project" ? item.scope.projectKey : ""));
    expect(keys).not.toContain("cli_empty");
    expect(planDepositSweep({ tree: null })).toEqual([
      { template: "background_knowledge", scope: expect.objectContaining({ kind: "timerange" }) },
      { template: "writing_style", scope: expect.objectContaining({ kind: "timerange" }) },
    ]);
  });

  it("honors an explicit template subset", () => {
    const plan = planDepositSweep({ tree: TREE, templates: ["project_state"], now: 1 });
    expect(plan.map((item) => item.template)).toEqual(["project_state", "project_state"]);
  });
});

describe("findSweepHead", () => {
  it("matches the head by template + projectKey, ignoring buried versions", () => {
    const deposits = [
      deposit(1, { template: "project_state", scope: projectItem.scope }),
      deposit(2, {
        template: "project_state",
        scope: projectItem.scope,
        version: 2,
        prevId: 1,
        updatedAt: 2000,
      }),
      deposit(3, {
        template: "project_state",
        scope: { kind: "project", projectKey: "cli_bbb", label: "kimi-code · other" },
      }),
      deposit(4, { template: "writing_style", scope: projectItem.scope }),
    ];
    expect(findSweepHead(deposits, projectItem)?.id).toBe(2);
  });

  it("matches whole-history items by scope kind at chain level", () => {
    const head = deposit(7, {
      template: "background_knowledge",
      scope: { kind: "timerange", start: 0, end: 50 },
    });
    expect(findSweepHead([head], timerangeItem)?.id).toBe(7);
    expect(
      findSweepHead([{ ...head, template: "writing_style" }], timerangeItem),
    ).toBeNull();
  });
});

describe("runDepositSweep", () => {
  it("generates every preset on the first run and reports them as added", () => {
    const { runner, generated, deposits } = makeRunner();
    const plan = planDepositSweep({ tree: TREE, now: 5 });
    const progress: number[] = [];
    return runDepositSweep(runner, plan, (p) => progress.push(p.current)).then((summary) => {
      expect(summary).toMatchObject({ added: 4, updated: 0, skipped: 0, failed: 0 });
      expect(generated).toHaveLength(4);
      expect(generated.every((input) => input.previousId === undefined)).toBe(true);
      expect(deposits).toHaveLength(4);
      expect(progress).toEqual([1, 2, 3, 4]);
    });
  });

  it("is idempotent: a second run chains, finds nothing new and rolls back", async () => {
    const { runner, deposits, generated, removed } = makeRunner();
    const plan = planDepositSweep({ tree: TREE, now: 5 });
    const first = await runDepositSweep(runner, plan);
    expect(first.added).toBe(4);
    const sizeAfterFirst = deposits.length;

    // Second sweep: the mock merge returns the previous document unchanged,
    // so every item must chain onto its head and then roll the fresh version
    // back — no duplicate entries, no empty versions.
    const second = await runDepositSweep(runner, plan);
    expect(second).toMatchObject({ added: 0, updated: 0, skipped: 4, failed: 0 });
    expect(deposits).toHaveLength(sizeAfterFirst);
    expect(removed).toHaveLength(4);
    const chained = generated.slice(4);
    expect(chained.every((input) => typeof input.previousId === "number")).toBe(true);
    // Heads still form one chain per template+scope (all at v1).
    expect(deposits.every((item) => item.version === 1 && item.prevId === null)).toBe(true);
  });

  it("counts a chained version with fresh content as updated", async () => {
    const head = deposit(1, {
      template: "background_knowledge",
      scope: timerangeItem.scope,
      contentMarkdown: "old doc",
    });
    const { runner, deposits } = makeRunner({
      seed: [head],
      mergeContent: (_input, previous) => `${previous.contentMarkdown}\nnew insight`,
    });
    const summary = await runDepositSweep(runner, [timerangeItem]);
    expect(summary).toMatchObject({ added: 0, updated: 1, skipped: 0, failed: 0 });
    expect(deposits).toHaveLength(2);
    expect(deposits[1]).toMatchObject({ version: 2, prevId: 1, contentMarkdown: "old doc\nnew insight" });
  });

  it("treats NOOP-only maintain ops as unchanged even when text differs", async () => {
    const head = deposit(1, { scope: timerangeItem.scope, contentMarkdown: "old doc" });
    const base = makeRunner({ seed: [head] });
    const runner: DepositSweepRunner = {
      ...base.runner,
      generate: async (input) => {
        const created = await base.runner.generate(input);
        if (input.previousId) {
          created.contentMarkdown = "old doc but reformatted";
          created.lastOps = [{ op: "NOOP", section: "全部", reason: "无变化" }];
        }
        return created;
      },
    };
    const summary = await runDepositSweep(runner, [timerangeItem]);
    expect(summary.skipped).toBe(1);
    expect(base.deposits).toHaveLength(1);
  });

  it("skips empty scopes without calling the generator", async () => {
    const { runner, generated } = makeRunner({
      scopeIds: (scope) => (scope.kind === "project" ? [] : [1]),
    });
    const summary = await runDepositSweep(runner, [projectItem, timerangeItem]);
    expect(summary).toMatchObject({ added: 1, skipped: 1 });
    expect(generated).toHaveLength(1);
    expect(generated[0].template).toBe("background_knowledge");
  });

  it("isolates per-item failures and finishes the sweep", async () => {
    const { runner } = makeRunner({
      failOn: (input) => input.template === "project_state",
    });
    const summary = await runDepositSweep(runner, [timerangeItem, projectItem]);
    expect(summary).toMatchObject({ added: 1, failed: 1 });
    expect(summary.results[1].error).toBe("LLM unavailable");
  });
});
