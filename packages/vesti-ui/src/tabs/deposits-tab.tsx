"use client";

// 记忆空间 (memory space, formerly the P4b deposits area): the default view is
// a one-page overview of summary cards — memories ('dream' entries), dreams
// ('dream-log' journals incl. the owl diary), the daily log (read-only list +
// content) and the classic deposits workbench. Each card shows a count plus a
// short preview; clicking a card drills into the full section (back bar
// returns to the overview). The header carries the dream pipeline controls
// (manual run, auto toggle, full rebuild). Deposits persistence now rides on
// the same memory_entries store via the storage layer, transparently.
//
// Deposits workbench layout: left = template cards + history (version heads),
// right = the generation composer or the selected deposit (Markdown body,
// version chain, rename/delete, export). Dream sections live in
// ./deposits/memorySections, the daily-log section in ./deposits/dailyLogSection,
// and the card copy dictionary in ./deposits/memorySpaceCopy.

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  CloudMoon,
  Download,
  FolderGit2,
  Layers,
  Lightbulb,
  PenLine,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import { SendToMenu } from "../components/SendToMenu";
import { InfoTip } from "../components/InfoTip";
import { sanitizeFileBaseName } from "../lib/extractMarkdown";
import {
  CollapseChevron,
  DreamLogCard,
  DreamLogSection,
  DreamMemoryCard,
  DreamMemorySection,
  MemoryOverviewCard,
} from "./deposits/memorySections";
import { DailyLogCard, DailyLogSection } from "./deposits/dailyLogSection";
import { useSessionProjectMap } from "./deposits/memoryProjects";
import {
  MEMORY_SPACE_COPY,
  detectMemorySpaceLocale,
} from "./deposits/memorySpaceCopy";
import {
  planDepositSweep,
  runDepositSweep,
  type DepositSweepPlanItem,
  type DepositSweepProgress,
  type DepositSweepSummary,
} from "./deposits/sweep";
import type {
  Conversation,
  ConversationTree,
  Deposit,
  DepositMaintainOp,
  DepositScope,
  DepositTemplate,
  RelayAvailability,
  StorageApi,
  Topic,
} from "../types";

type DepositsTabProps = {
  storage: StorageApi;
  /** labels.deposits group (Record<string,string>); English fallbacks inline. */
  labels?: Record<string, string>;
  /** Library labels for the SendToMenu (Notion/Obsidian export). */
  sendToLabels?: Record<string, any>;
  /** 会员门控: true → dream entries disabled with the member-only hint. */
  dreamLocked?: boolean;
};

type DistillTemplateKey = Exclude<DepositTemplate, "extract">;
type ScopeKind = DepositScope["kind"];
/** Top-level memory-space views: the card overview (default) or one drilled-in section. */
type MemorySection = "overview" | "memories" | "dreamLogs" | "daily" | "deposits";

const TEMPLATE_ORDER: DistillTemplateKey[] = [
  "background_knowledge",
  "project_state",
  "writing_style",
  "custom",
];

const TEMPLATE_LABEL_KEYS: Record<DistillTemplateKey, [string, string]> = {
  background_knowledge: ["templateBackground", "descBackground"],
  project_state: ["templateProject", "descProject"],
  writing_style: ["templateWriting", "descWriting"],
  custom: ["templateCustom", "descCustom"],
};

const TEMPLATE_FALLBACKS: Record<DistillTemplateKey, [string, string]> = {
  background_knowledge: ["Background knowledge", "Skills, preferences and workflows — helps any AI understand you."],
  project_state: ["Project state", "Architecture, decisions, progress and todos — for handoff and review."],
  writing_style: ["Writing style", "Tone, phrasing and structure habits — for ghostwriting."],
  custom: ["Custom distill", "Your own distillation instruction."],
};

const RANGE_DAY_OPTIONS = [7, 30, 90] as const;
const DAY_MS = 86_400_000;

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function templateIcon(template: DepositTemplate, className: string) {
  switch (template) {
    case "background_knowledge":
      return <User strokeWidth={1.75} className={className} />;
    case "project_state":
      return <FolderGit2 strokeWidth={1.75} className={className} />;
    case "writing_style":
      return <PenLine strokeWidth={1.75} className={className} />;
    case "extract":
      return <Lightbulb strokeWidth={1.75} className={className} />;
    case "custom":
      return <Sparkles strokeWidth={1.75} className={className} />;
  }
}

/** Current heads: deposits no other deposit points to via prevId, newest first. */
function findDepositHeads(deposits: Deposit[]): Deposit[] {
  const referenced = new Set<number>();
  for (const deposit of deposits) {
    if (deposit.prevId !== null) referenced.add(deposit.prevId);
  }
  return deposits
    .filter((deposit) => !referenced.has(deposit.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Count mem0-style maintain ops by kind; NOOPs don't count as changes. */
function countMaintainOps(ops: DepositMaintainOp[]): {
  added: number;
  updated: number;
  deleted: number;
  total: number;
} {
  let added = 0;
  let updated = 0;
  let deleted = 0;
  for (const op of ops) {
    if (op.op === "ADD") added += 1;
    else if (op.op === "UPDATE") updated += 1;
    else if (op.op === "DELETE") deleted += 1;
  }
  return { added, updated, deleted, total: added + updated + deleted };
}

/** Walk a version chain newest → oldest (cycle-safe, stops on dangling ids). */
function collectVersionChain(deposits: Deposit[], headId: number): Deposit[] {
  const byId = new Map(deposits.map((deposit) => [deposit.id, deposit]));
  const chain: Deposit[] = [];
  const seen = new Set<number>();
  let currentId: number | null = headId;
  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const deposit = byId.get(currentId);
    if (!deposit) break;
    chain.push(deposit);
    currentId = deposit.prevId;
  }
  return chain;
}

function topicPathLabel(topic: Topic, byId: Map<number, Topic>): string {
  const names = [topic.name];
  const visited = new Set<number>([topic.id]);
  let current = topic;
  while (current.parent_id !== null) {
    const parent = byId.get(current.parent_id);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    names.unshift(parent.name);
    current = parent;
  }
  return names.join(" / ");
}

export function DepositsTab({ storage, labels, sendToLabels, dreamLocked = false }: DepositsTabProps) {
  const l = (key: string, fallback: string) => labels?.[key] ?? fallback;
  // Card chrome copy: component-local 4-locale dictionary (see
  // ./deposits/memorySpaceCopy); existing strings keep flowing through l().
  const copy = MEMORY_SPACE_COPY[detectMemorySpaceLocale(labels, sendToLabels)] ?? MEMORY_SPACE_COPY.en;

  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedHeadId, setSelectedHeadId] = useState<number | null>(null);
  const [viewId, setViewId] = useState<number | null>(null);
  const [availability, setAvailability] = useState<RelayAvailability | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Composer state (template → scope → generate).
  const [composerTemplate, setComposerTemplate] = useState<DistillTemplateKey | null>(null);
  const [scopeKind, setScopeKind] = useState<ScopeKind>("project");
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<number | null>(null);
  const [rangeDays, setRangeDays] = useState<(typeof RANGE_DAY_OPTIONS)[number]>(30);
  const [selectionIds, setSelectionIds] = useState<number[]>([]);
  const [selectionQuery, setSelectionQuery] = useState("");
  const [customInstruction, setCustomInstruction] = useState("");
  const [scopeCount, setScopeCount] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  // Scope-picker source data (loaded lazily on first composer open).
  const [tree, setTree] = useState<ConversationTree | null>(null);
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);

  // One-click full sweep: batch distillation across all preset scenarios.
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepProgress, setSweepProgress] = useState<DepositSweepProgress | null>(null);
  const [sweepSummary, setSweepSummary] = useState<DepositSweepSummary | null>(null);

  // Memory-space sections + dream pipeline controls (header). The default
  // "overview" view is the summary-card grid; the rest are drilled-in sections.
  const [section, setSection] = useState<MemorySection>("overview");
  const [dreaming, setDreaming] = useState(false);
  const [dreamProgress, setDreamProgress] = useState<string | null>(null);
  const [dreamNotice, setDreamNotice] = useState<string | null>(null);
  const [dreamDoneMessage, setDreamDoneMessage] = useState<string | null>(null);
  const [dreamAutoEnabled, setDreamAutoEnabledState] = useState<boolean | null>(null);
  /** null until probed; false drives the "first dream is a full pass" hint. */
  const [hasDreamLog, setHasDreamLog] = useState<boolean | null>(null);
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0);
  // session→project map for memory grouping + event-time date labels; one
  // tree load shared by the overview cards and the drilled-in sections.
  const sessionMap = useSessionProjectMap(storage, memoryRefreshKey);
  // The "New deposit" template list is a secondary control (the one-click
  // sweep above stays always visible) — collapsed by default.
  const [newDepositOpen, setNewDepositOpen] = useState(false);

  const available = Boolean(
    storage.listDeposits && storage.generateDeposit && storage.listMemoryEntries,
  );
  const llmMissing = availability !== null && !availability.llmConfigured;

  const refreshDeposits = async () => {
    if (!storage.listDeposits) return;
    try {
      const items = await storage.listDeposits();
      setDeposits(items);
      setLoadError(null);
    } catch (error) {
      setLoadError((error as Error)?.message ?? String(error));
    }
  };

  useEffect(() => {
    void refreshDeposits();
    // LLM probe: the relay availability surface is the existing capability
    // check (llmConfigured); deposits generation shares the same agent IPC.
    void storage.getRelayAvailability?.().then(setAvailability);
    // Dream controls: current auto toggle + whether any dream ran before
    // (a missing journal means the first run will be a full pass).
    void storage.getDreamAutoEnabled?.().then(setDreamAutoEnabledState).catch(() => setDreamAutoEnabledState(null));
    void storage.listMemoryEntries?.({ kind: "dream-log", limit: 1 })
      .then((entries) => setHasDreamLog(entries.length > 0))
      .catch(() => setHasDreamLog(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage]);

  // Lazily load scope-picker data the first time the composer opens.
  useEffect(() => {
    if (!composerTemplate) return;
    if (tree === null) {
      void storage.getConversationTree?.().then((value) => setTree(value ?? null)).catch(() => setTree(null));
    }
    if (topics === null) {
      void storage.getTopics().then(setTopics).catch(() => setTopics([]));
    }
    if (conversations === null) {
      void storage.getConversations().then((items) => {
        setConversations(
          [...items].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
        );
      }).catch(() => setConversations([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerTemplate, storage]);

  const heads = useMemo(() => findDepositHeads(deposits ?? []), [deposits]);
  const chain = useMemo(
    () => (selectedHeadId !== null ? collectVersionChain(deposits ?? [], selectedHeadId) : []),
    [deposits, selectedHeadId],
  );
  const viewDeposit = useMemo(
    () => (deposits ?? []).find((deposit) => deposit.id === viewId) ?? null,
    [deposits, viewId],
  );

  const viewHtml = useMemo(() => {
    if (!viewDeposit) return "";
    return DOMPurify.sanitize(
      marked.parse(viewDeposit.contentMarkdown, { gfm: true, breaks: false }) as string,
    );
  }, [viewDeposit]);

  const topicById = useMemo(
    () => new Map((topics ?? []).map((topic) => [topic.id, topic])),
    [topics],
  );

  const projectOptions = useMemo(
    () =>
      (tree?.sources ?? []).flatMap((source) =>
        source.projects.map((project) => ({
          projectKey: project.projectKey,
          label: `${source.platform} · ${project.label}`,
          sessionCount: project.sessions.length,
        })),
      ),
    [tree],
  );

  const filteredSelectionConversations = useMemo(() => {
    const query = selectionQuery.trim().toLowerCase();
    const list = conversations ?? [];
    const filtered = query
      ? list.filter((conversation) => conversation.title.toLowerCase().includes(query))
      : list;
    return filtered.slice(0, 20);
  }, [conversations, selectionQuery]);

  // The scope currently configured in the composer (null when incomplete).
  const composerScope: DepositScope | null = useMemo(() => {
    if (!composerTemplate) return null;
    switch (scopeKind) {
      case "project": {
        const option = projectOptions.find((item) => item.projectKey === projectKey);
        return option
          ? { kind: "project", projectKey: option.projectKey, label: option.label }
          : null;
      }
      case "topic": {
        const topic = topicId !== null ? topicById.get(topicId) : undefined;
        return topic
          ? { kind: "topic", topicId: topic.id, label: topicPathLabel(topic, topicById) }
          : null;
      }
      case "timerange": {
        const end = Date.now();
        return { kind: "timerange", start: end - rangeDays * DAY_MS, end };
      }
      case "selection":
        return selectionIds.length > 0
          ? { kind: "selection", conversationIds: selectionIds }
          : null;
    }
  }, [composerTemplate, scopeKind, projectKey, projectOptions, topicId, topicById, rangeDays, selectionIds]);

  // Preview how many conversations the scope resolves to (debounced).
  useEffect(() => {
    if (!composerScope || !storage.resolveDepositScope) {
      setScopeCount(null);
      return;
    }
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      storage
        .resolveDepositScope?.(composerScope)
        .then((ids) => {
          if (!cancelled) setScopeCount(ids.length);
        })
        .catch(() => {
          if (!cancelled) setScopeCount(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [composerScope, storage]);

  const openComposer = (template: DistillTemplateKey) => {
    setComposerTemplate(template);
    setNotice(null);
    setRenaming(false);
    setExportOpen(false);
  };

  const closeComposer = () => {
    setComposerTemplate(null);
    setScopeCount(null);
    setNotice(null);
  };

  const selectDeposit = (headId: number) => {
    setSelectedHeadId(headId);
    setViewId(headId);
    setComposerTemplate(null);
    setRenaming(false);
    setExportOpen(false);
    setOpsOpen(false);
    setNotice(null);
  };

  const onGenerated = (deposit: Deposit) => {
    closeComposer();
    void refreshDeposits().then(() => {
      setSelectedHeadId(deposit.id);
      setViewId(deposit.id);
    });
  };

  const handleGenerate = async () => {
    if (!storage.generateDeposit || !composerTemplate || !composerScope) return;
    const instruction = customInstruction.trim();
    if (composerTemplate === "custom" && !instruction) {
      setNotice(l("customInstructionRequired", "Enter your distillation instruction first."));
      return;
    }
    setGenerating(true);
    setNotice(null);
    try {
      const deposit = await storage.generateDeposit({
        template: composerTemplate,
        scope: composerScope,
        customInstruction: composerTemplate === "custom" ? instruction : undefined,
      });
      onGenerated(deposit);
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerate = async (head: Deposit) => {
    if (!storage.generateDeposit || head.template === "extract") return;
    setGenerating(true);
    setNotice(null);
    try {
      const deposit = await storage.generateDeposit({
        template: head.template,
        scope: head.scope,
        customInstruction: head.customInstruction ?? undefined,
        previousId: head.id,
      });
      onGenerated(deposit);
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    } finally {
      setGenerating(false);
    }
  };

  // One-click full sweep: every preset scenario, auto-scoped, chained onto the
  // existing heads (repeat runs merge instead of duplicating). Per-item
  // outcomes land in the summary line under the sweep card.
  const canSweep = Boolean(
    storage.listDeposits &&
      storage.resolveDepositScope &&
      storage.generateDeposit &&
      storage.deleteDeposit &&
      storage.getConversationTree,
  );

  const handleSweep = async () => {
    const {
      listDeposits,
      resolveDepositScope,
      generateDeposit,
      deleteDeposit,
      getConversationTree,
    } = storage;
    if (
      !listDeposits ||
      !resolveDepositScope ||
      !generateDeposit ||
      !deleteDeposit ||
      !getConversationTree ||
      sweepRunning ||
      llmMissing
    ) {
      return;
    }
    setSweepRunning(true);
    setSweepProgress(null);
    setSweepSummary(null);
    setNotice(null);
    try {
      const tree = (await getConversationTree().catch(() => null)) ?? null;
      const plan = planDepositSweep({ tree, now: Date.now() });
      const summary = await runDepositSweep(
        {
          listDeposits,
          resolveScope: resolveDepositScope,
          generate: generateDeposit,
          remove: deleteDeposit,
        },
        plan,
        (progress) => setSweepProgress(progress),
      );
      setSweepSummary(summary);
      await refreshDeposits();
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    } finally {
      setSweepRunning(false);
      setSweepProgress(null);
    }
  };

  const sweepItemLabel = (item: DepositSweepPlanItem): string =>
    item.scope.kind === "project"
      ? `${templateName(item.template)} · ${item.scope.label}`
      : templateName(item.template);

  // Dream pipeline: one manual/full run via the storage layer (src/ui/memory
  // underneath). The service itself is single-flight; the button state here
  // just mirrors the run and refreshes the dream sections when it lands.
  const handleDream = async (mode: "manual" | "full") => {
    if (!storage.runDream || dreaming || llmMissing || dreamLocked) return;
    if (mode === "full") {
      const confirmed = window.confirm(
        l(
          "dreamFullConfirm",
          "A full rebuild re-organizes your entire history and can take a long time. Continue?",
        ),
      );
      if (!confirmed) return;
    }
    setDreaming(true);
    setDreamNotice(null);
    setDreamDoneMessage(null);
    setDreamProgress(l("dreamRunning", "Dreaming…"));
    try {
      const result = await storage.runDream({
        mode,
        onProgress: (message) => {
          if (message) setDreamProgress(message);
        },
      });
      if (result.ok) {
        setDreamDoneMessage(result.message ?? null);
        setHasDreamLog(true);
        setMemoryRefreshKey((key) => key + 1);
      } else {
        setDreamNotice(
          l("dreamFailed", "Dream failed: {message}").replace(
            "{message}",
            result.error ?? "unknown",
          ),
        );
      }
    } catch (error) {
      setDreamNotice(
        l("dreamFailed", "Dream failed: {message}").replace(
          "{message}",
          (error as Error)?.message ?? String(error),
        ),
      );
    } finally {
      setDreaming(false);
      setDreamProgress(null);
    }
  };

  const handleDreamAutoToggle = async () => {
    if (!storage.setDreamAutoEnabled || dreamAutoEnabled === null || dreamLocked) return;
    const next = !dreamAutoEnabled;
    setDreamAutoEnabledState(next);
    try {
      await storage.setDreamAutoEnabled(next);
    } catch (error) {
      setDreamAutoEnabledState(!next);
      setDreamNotice((error as Error)?.message ?? String(error));
    }
  };

  const handleRename = async () => {
    if (!storage.renameDeposit || !viewDeposit) return;
    const title = renameTitle.trim();
    if (!title || title === viewDeposit.title) {
      setRenaming(false);
      return;
    }
    try {
      await storage.renameDeposit(viewDeposit.id, title);
      setRenaming(false);
      await refreshDeposits();
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    }
  };

  const handleDelete = async (deposit: Deposit) => {
    if (!storage.deleteDeposit) return;
    const confirmed = window.confirm(
      l("deleteConfirm", "Delete this deposit? Older versions are kept."),
    );
    if (!confirmed) return;
    try {
      await storage.deleteDeposit(deposit.id);
      if (selectedHeadId === deposit.id) {
        setSelectedHeadId(null);
        setViewId(null);
      } else if (viewId === deposit.id) {
        setViewId(selectedHeadId);
      }
      await refreshDeposits();
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    }
  };

  const handleDownload = (format: "md" | "json" | "txt") => {
    if (!viewDeposit) return;
    const base = sanitizeFileBaseName(viewDeposit.title);
    setExportOpen(false);
    if (format === "md") {
      downloadTextFile(`${base}.md`, viewDeposit.contentMarkdown, "text/markdown");
    } else if (format === "txt") {
      downloadTextFile(`${base}.txt`, viewDeposit.contentMarkdown, "text/plain");
    } else {
      downloadTextFile(
        `${base}.json`,
        JSON.stringify(
          {
            title: viewDeposit.title,
            template: viewDeposit.template,
            scope: viewDeposit.scope,
            version: viewDeposit.version,
            createdAt: viewDeposit.createdAt,
            updatedAt: viewDeposit.updatedAt,
            content_markdown: viewDeposit.contentMarkdown,
          },
          null,
          2,
        ),
        "application/json",
      );
    }
    setNotice(null);
  };

  const handleExportToDirectory = async () => {
    if (!storage.exportDepositMarkdown || !viewDeposit) return;
    setExporting(true);
    setExportOpen(false);
    setNotice(null);
    try {
      const result = await storage.exportDepositMarkdown(viewDeposit.id);
      if (result) {
        setNotice(
          l("exportedTo", "Exported to {path}").replace("{path}", result.relativePath),
        );
      }
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    } finally {
      setExporting(false);
    }
  };

  const describeScope = (scope: DepositScope): string => {
    switch (scope.kind) {
      case "project":
        return l("scopeDescProject", "Project: {label}").replace("{label}", scope.label);
      case "topic":
        return l("scopeDescTopic", "Topic: {label}").replace("{label}", scope.label);
      case "timerange":
        // Whole-history sweeps store [0, now]; show a label, not a 1970 date.
        if (scope.start <= 0) return l("scopeDescAll", "All conversations");
        return l("scopeDescTimerange", "Time window: {start} ~ {end}")
          .replace("{start}", new Date(scope.start).toLocaleDateString())
          .replace("{end}", new Date(scope.end).toLocaleDateString());
      case "selection":
        return l("scopeDescSelection", "Manual selection: {count} conversations").replace(
          "{count}",
          String(scope.conversationIds.length),
        );
    }
  };

  const templateName = (template: DepositTemplate): string => {
    if (template === "extract") return l("templateExtract", "Knowledge extract");
    const [nameKey] = TEMPLATE_LABEL_KEYS[template];
    const [fallback] = TEMPLATE_FALLBACKS[template];
    return l(nameKey, fallback);
  };

  const scopeKindButton = (kind: ScopeKind, label: string) => (
    <button
      key={kind}
      type="button"
      onClick={() => setScopeKind(kind)}
      className={`rounded-full px-3 py-1 text-vesti-sm font-sans transition-colors ${
        scopeKind === kind
          ? "bg-accent-primary-light text-accent-primary"
          : "text-text-tertiary hover:text-text-secondary"
      }`}
    >
      {label}
    </button>
  );

  if (!available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg-app">
        <CloudMoon strokeWidth={1.75} className="h-8 w-8 text-text-tertiary" />
        <p className="text-vesti-lg font-serif text-text-primary">
          {l("title", "Memory Space")}
        </p>
        <p className="text-vesti-base font-sans text-text-tertiary">
          {l("unavailable", "Memory space is unavailable in the current environment.")}
        </p>
      </div>
    );
  }

  const sectionTitle: Record<Exclude<MemorySection, "overview">, string> = {
    memories: copy.memories.title,
    dreamLogs: copy.dreams.title,
    daily: copy.daily.title,
    deposits: copy.deposits.title,
  };

  const sectionTip: Record<Exclude<MemorySection, "overview">, string> = {
    memories: copy.memories.tip,
    dreamLogs: copy.dreams.tip,
    daily: copy.daily.tip,
    deposits: copy.deposits.tip,
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-app">
      {/* Header: title + dream pipeline controls */}
      <header className="shrink-0 border-b border-border-subtle bg-bg-tertiary px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-vesti-lg font-serif text-text-primary">
              {l("title", "Memory Space")}
            </h1>
            <p className="mt-0.5 text-vesti-sm font-sans text-text-tertiary">
              {l(
                "subtitle",
                "Dreams distill each day's sessions into long-term memories; deposits keep distilled knowledge documents.",
              )}
            </p>
          </div>
          {storage.runDream ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                type="button"
                onClick={() => void handleDream("full")}
                disabled={dreaming || llmMissing || dreamLocked}
                title={
                  dreamLocked
                    ? l(
                        "dreamMemberOnly",
                        "Dreaming is a Beta member feature — this account is currently on the free tier.",
                      )
                    : llmMissing
                      ? l("llmMissing", "Configure a model in Settings first.")
                      : undefined
                }
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw strokeWidth={1.75} className="h-3.5 w-3.5" />
                {l("dreamFullRebuild", "Full rebuild")}
              </button>
              {storage.getDreamAutoEnabled && storage.setDreamAutoEnabled && dreamAutoEnabled !== null ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={dreamAutoEnabled}
                  disabled={dreamLocked}
                  title={
                    dreamLocked
                      ? l(
                          "dreamMemberOnly",
                          "Dreaming is a Beta member feature — this account is currently on the free tier.",
                        )
                      : undefined
                  }
                  onClick={() => void handleDreamAutoToggle()}
                  className="inline-flex items-center gap-1.5 text-vesti-sm font-sans text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      dreamAutoEnabled ? "bg-accent-primary" : "bg-bg-surface-hover"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-bg-primary shadow transition-transform ${
                        dreamAutoEnabled ? "translate-x-[18px]" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                  {l("dreamAuto", "Auto-dream")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleDream("manual")}
                disabled={dreaming || llmMissing || dreamLocked}
                title={
                  dreamLocked
                    ? l(
                        "dreamMemberOnly",
                        "Dreaming is a Beta member feature — this account is currently on the free tier.",
                      )
                    : llmMissing
                      ? l("llmMissing", "Configure a model in Settings first.")
                      : undefined
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-vesti-base font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {dreaming ? (
                  <RefreshCw strokeWidth={1.75} className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudMoon strokeWidth={1.75} className="h-3.5 w-3.5" />
                )}
                {dreaming ? l("dreamRunning", "Dreaming…") : l("dreamNow", "Dream")}
              </button>
            </div>
          ) : null}
        </div>
        {dreaming && dreamProgress ? (
          <p className="mt-2 text-vesti-sm font-sans text-text-secondary">{dreamProgress}</p>
        ) : null}
        {dreamLocked ? (
          <p className="mt-2 text-vesti-sm font-sans text-text-tertiary">
            {l(
              "dreamMemberOnly",
              "Dreaming is a Beta member feature — this account is currently on the free tier.",
            )}
          </p>
        ) : null}
        {!dreaming && hasDreamLog === false && !llmMissing ? (
          <p className="mt-2 text-vesti-sm font-sans text-text-tertiary">
            {l(
              "dreamFirstRunHint",
              "The first dream organizes your whole history — it can take a while.",
            )}
          </p>
        ) : null}
        {dreamDoneMessage ? (
          <p className="mt-2 text-vesti-sm font-sans text-text-secondary">{dreamDoneMessage}</p>
        ) : null}
        {dreamNotice ? (
          <p className="mt-2 text-vesti-sm font-sans text-danger">{dreamNotice}</p>
        ) : null}
      </header>

      {/* Drill-in bar: back to the overview + the current section's title */}
      {section !== "overview" ? (
        <nav className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-tertiary px-4 py-2">
          <button
            type="button"
            onClick={() => setSection("overview")}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-vesti-sm font-sans text-text-tertiary transition-colors hover:text-text-secondary"
          >
            <ChevronLeft strokeWidth={1.75} className="h-3.5 w-3.5" />
            {copy.backToOverview}
          </button>
          <span className="text-vesti-sm font-sans font-medium text-text-secondary">
            <InfoTip title={sectionTitle[section]} description={sectionTip[section]}>
              <span>{sectionTitle[section]}</span>
            </InfoTip>
          </span>
        </nav>
      ) : null}

      <div className="min-h-0 flex-1">
        {section === "overview" ? (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-3 px-6 py-5 md:grid-cols-2">
              <DreamMemoryCard
                storage={storage}
                l={l}
                refreshKey={memoryRefreshKey}
                copy={copy}
                sessionMap={sessionMap}
                onOpen={() => setSection("memories")}
              />
              <DreamLogCard
                storage={storage}
                l={l}
                refreshKey={memoryRefreshKey}
                copy={copy}
                sessionMap={sessionMap}
                onOpen={() => setSection("dreamLogs")}
              />
              {storage.listDailyLogs ? (
                <DailyLogCard
                  storage={storage}
                  copy={copy}
                  onOpen={() => setSection("daily")}
                />
              ) : null}
              <MemoryOverviewCard
                icon={<Archive strokeWidth={1.75} className="h-4 w-4" />}
                title={copy.deposits.title}
                count={deposits === null ? null : heads.length}
                description={copy.deposits.desc}
                previews={heads
                  .slice(0, 2)
                  .map(
                    (head) =>
                      `${head.title} · ${l("versionLabel", "v{version}").replace("{version}", String(head.version))}`,
                  )}
                emptyText={copy.deposits.empty}
                entryCountLabel={(count) =>
                  copy.entryCount.replace("{count}", String(count))
                }
                tip={copy.deposits.tip}
                onOpen={() => setSection("deposits")}
              />
            </div>
          </div>
        ) : section === "memories" ? (
          <DreamMemorySection
            storage={storage}
            l={l}
            refreshKey={memoryRefreshKey}
            copy={copy}
            sessionMap={sessionMap}
          />
        ) : section === "dreamLogs" ? (
          <DreamLogSection
            storage={storage}
            l={l}
            refreshKey={memoryRefreshKey}
            copy={copy}
            sessionMap={sessionMap}
          />
        ) : section === "daily" ? (
          <DailyLogSection storage={storage} copy={copy} />
        ) : (
    <div className="flex h-full overflow-hidden bg-bg-app">
      {/* Left column: templates + history */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border-subtle bg-bg-tertiary">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          <section>
            <button
              type="button"
              onClick={() => void handleSweep()}
              disabled={!canSweep || sweepRunning || llmMissing}
              title={llmMissing ? l("llmMissing", "Configure a model in Settings first.") : undefined}
              className="flex w-full items-start gap-2.5 rounded-lg border border-accent-primary/40 bg-accent-primary-light px-3 py-2.5 text-left transition-colors hover:border-accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="mt-0.5 shrink-0 text-accent-primary">
                {sweepRunning ? (
                  <RefreshCw strokeWidth={1.75} className="h-4 w-4 animate-spin" />
                ) : (
                  <Layers strokeWidth={1.75} className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-vesti-base font-sans font-medium text-text-primary">
                  {l("sweepAll", "One-click full sweep")}
                </span>
                <span className="mt-0.5 block text-vesti-sm font-sans leading-snug text-text-tertiary">
                  {sweepRunning && sweepProgress
                    ? l("sweepProgress", "Distilling {current}/{total}: {label}")
                        .replace("{current}", String(sweepProgress.current))
                        .replace("{total}", String(sweepProgress.total))
                        .replace("{label}", sweepItemLabel(sweepProgress.item))
                    : l(
                        "sweepAllHint",
                        "Distill every preset in one pass: background knowledge, each project's state, writing style.",
                      )}
                </span>
                {sweepRunning && sweepProgress ? (
                  <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-bg-surface-hover">
                    <span
                      className="block h-full rounded-full bg-accent-primary transition-[width] duration-300"
                      style={{
                        width: `${Math.round(
                          ((sweepProgress.current - 1) / Math.max(1, sweepProgress.total)) * 100,
                        )}%`,
                      }}
                    />
                  </span>
                ) : null}
              </span>
            </button>
            {llmMissing ? (
              <p className="mt-1.5 px-1 text-vesti-sm font-sans text-text-tertiary">
                {l("llmMissing", "Configure a model in Settings first.")}
              </p>
            ) : null}
            {sweepSummary ? (
              <p
                className={`mt-1.5 px-1 text-vesti-sm font-sans ${
                  sweepSummary.failed > 0 ? "text-danger" : "text-text-secondary"
                }`}
              >
                {l("sweepSummary", "Sweep complete: {added} added · {updated} updated · {skipped} skipped")
                  .replace("{added}", String(sweepSummary.added))
                  .replace("{updated}", String(sweepSummary.updated))
                  .replace("{skipped}", String(sweepSummary.skipped))}
                {sweepSummary.failed > 0
                  ? ` · ${l("sweepFailed", "{failed} failed").replace("{failed}", String(sweepSummary.failed))}`
                  : ""}
              </p>
            ) : null}
          </section>

          <section>
            <button
              type="button"
              aria-expanded={newDepositOpen}
              aria-label={`${newDepositOpen ? copy.collapseSection : copy.expandSection}: ${l("newDeposit", "New deposit")}`}
              onClick={() => setNewDepositOpen((open) => !open)}
              className="mb-1.5 flex w-full items-center gap-1.5 px-1 text-left text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary"
            >
              {l("newDeposit", "New deposit")}
              <span className="text-text-tertiary/60">({TEMPLATE_ORDER.length})</span>
              <CollapseChevron open={newDepositOpen} className="ml-auto" />
            </button>
            {newDepositOpen ? (
            <div className="space-y-1.5">
              {TEMPLATE_ORDER.map((template) => {
                const [nameKey, descKey] = TEMPLATE_LABEL_KEYS[template];
                const [nameFallback, descFallback] = TEMPLATE_FALLBACKS[template];
                return (
                  <button
                    key={template}
                    type="button"
                    onClick={() => openComposer(template)}
                    className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      composerTemplate === template
                        ? "border-accent-primary bg-bg-surface-card-active"
                        : "border-border-subtle bg-bg-surface-card hover:bg-bg-surface-card-hover"
                    }`}
                  >
                    <span className="mt-0.5 shrink-0 text-text-secondary">
                      {templateIcon(template, "h-4 w-4")}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-vesti-base font-sans font-medium text-text-primary">
                        {l(nameKey, nameFallback)}
                      </span>
                      <span className="mt-0.5 block text-vesti-sm font-sans leading-snug text-text-tertiary">
                        {l(descKey, descFallback)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            ) : null}
          </section>

          <section>
            <h2 className="mb-1.5 px-1 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
              {l("history", "History")}
            </h2>
            {loadError ? (
              <p className="px-1 py-2 text-vesti-sm font-sans text-danger">
                {l("failed", "Failed: {message}").replace("{message}", loadError)}
              </p>
            ) : deposits === null ? (
              <div className="flex items-center justify-center gap-2 py-6 text-text-secondary">
                <RefreshCw strokeWidth={1.75} className="h-4 w-4 animate-spin" />
              </div>
            ) : heads.length === 0 ? (
              <p className="px-1 py-2 text-vesti-sm font-sans text-text-tertiary">
                {l("historyEmpty", "No deposits yet. Pick a template to generate one.")}
              </p>
            ) : (
              <div className="space-y-1">
                {heads.map((head) => (
                  <button
                    key={head.id}
                    type="button"
                    onClick={() => selectDeposit(head.id)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                      selectedHeadId === head.id
                        ? "border-accent-primary bg-bg-surface-card-active"
                        : "border-transparent hover:bg-bg-surface-card"
                    }`}
                  >
                    <span className="shrink-0 text-text-tertiary">
                      {templateIcon(head.template, "h-4 w-4")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-vesti-base font-sans text-text-primary">
                        {head.title}
                      </span>
                      <span className="block text-vesti-sm font-sans text-text-tertiary">
                        {templateName(head.template)}
                        {" · "}
                        {l("versionLabel", "v{version}").replace(
                          "{version}",
                          String(head.version),
                        )}
                        {" · "}
                        {new Date(head.updatedAt).toLocaleDateString()}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>

      {/* Right pane: composer / deposit / empty state */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {composerTemplate ? (
          <div className="mx-auto max-w-2xl px-6 py-6">
            <div className="flex items-center gap-2">
              {templateIcon(composerTemplate, "h-5 w-5 text-text-secondary")}
              <h2 className="text-vesti-xl font-serif text-text-primary">
                {templateName(composerTemplate)}
              </h2>
            </div>

            {composerTemplate === "custom" ? (
              <div className="mt-4">
                <label className="mb-1 block text-vesti-sm font-sans font-medium text-text-secondary">
                  {l("customInstruction", "Distillation instruction")}
                </label>
                <textarea
                  value={customInstruction}
                  onChange={(event) => setCustomInstruction(event.target.value)}
                  rows={3}
                  placeholder={l(
                    "customInstructionPlaceholder",
                    "e.g. Distill the arguments and conclusions about personal finance.",
                  )}
                  className="w-full rounded-md border border-border-subtle bg-bg-surface-card px-3 py-2 text-vesti-base font-sans text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent-primary"
                />
              </div>
            ) : null}

            <div className="mt-4">
              <p className="mb-1.5 text-vesti-sm font-sans font-medium text-text-secondary">
                {l("scopeLabel", "Scope")}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {scopeKindButton("project", l("scopeProject", "Project"))}
                {scopeKindButton("topic", l("scopeTopic", "Topic"))}
                {scopeKindButton("timerange", l("scopeTimerange", "Time window"))}
                {scopeKindButton("selection", l("scopeSelection", "Manual selection"))}
              </div>

              <div className="mt-3">
                {scopeKind === "project" ? (
                  <select
                    value={projectKey ?? ""}
                    onChange={(event) => setProjectKey(event.target.value || null)}
                    className="w-full rounded-md border border-border-subtle bg-bg-surface-card px-3 py-2 text-vesti-base font-sans text-text-primary outline-none focus:border-accent-primary"
                  >
                    <option value="">
                      {l("scopeProjectPlaceholder", "Choose a project…")}
                    </option>
                    {projectOptions.map((option) => (
                      <option key={option.projectKey} value={option.projectKey}>
                        {option.label} ({option.sessionCount})
                      </option>
                    ))}
                  </select>
                ) : null}

                {scopeKind === "topic" ? (
                  <select
                    value={topicId ?? ""}
                    onChange={(event) =>
                      setTopicId(event.target.value ? Number(event.target.value) : null)
                    }
                    className="w-full rounded-md border border-border-subtle bg-bg-surface-card px-3 py-2 text-vesti-base font-sans text-text-primary outline-none focus:border-accent-primary"
                  >
                    <option value="">
                      {l("scopeTopicPlaceholder", "Choose a topic…")}
                    </option>
                    {(topics ?? []).map((topic) => (
                      <option key={topic.id} value={topic.id}>
                        {topicPathLabel(topic, topicById)}
                      </option>
                    ))}
                  </select>
                ) : null}

                {scopeKind === "timerange" ? (
                  <div className="flex items-center gap-1">
                    {RANGE_DAY_OPTIONS.map((days) => (
                      <button
                        key={days}
                        type="button"
                        onClick={() => setRangeDays(days)}
                        className={`rounded-full px-3 py-1 text-vesti-sm font-sans transition-colors ${
                          rangeDays === days
                            ? "bg-accent-primary-light text-accent-primary"
                            : "text-text-tertiary hover:text-text-secondary"
                        }`}
                      >
                        {l(`range${days}`, `Last ${days} days`)}
                      </button>
                    ))}
                  </div>
                ) : null}

                {scopeKind === "selection" ? (
                  <div className="rounded-md border border-border-subtle">
                    <div className="border-b border-border-subtle px-3 py-2">
                      <input
                        type="text"
                        value={selectionQuery}
                        onChange={(event) => setSelectionQuery(event.target.value)}
                        placeholder={l("selectionSearch", "Search conversation titles…")}
                        className="w-full bg-transparent text-vesti-base font-sans text-text-primary placeholder:text-text-tertiary outline-none"
                      />
                    </div>
                    <div className="max-h-56 overflow-y-auto p-1.5">
                      {filteredSelectionConversations.length === 0 ? (
                        <p className="px-2 py-3 text-vesti-sm font-sans text-text-tertiary">
                          {l("selectionEmpty", "No conversations match.")}
                        </p>
                      ) : (
                        filteredSelectionConversations.map((conversation) => {
                          const checked = selectionIds.includes(conversation.id);
                          return (
                            <button
                              key={conversation.id}
                              type="button"
                              onClick={() =>
                                setSelectionIds((current) =>
                                  checked
                                    ? current.filter((id) => id !== conversation.id)
                                    : [...current, conversation.id],
                                )
                              }
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-surface-card"
                            >
                              <span
                                aria-hidden="true"
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                  checked
                                    ? "border-accent-primary bg-accent-primary text-text-inverse"
                                    : "border-border-subtle bg-bg-primary text-transparent"
                                }`}
                              >
                                <Check strokeWidth={2} className="h-3 w-3" />
                              </span>
                              <span className="min-w-0 flex-1 truncate text-vesti-base font-sans text-text-primary">
                                {conversation.title || l("untitled", "Untitled")}
                              </span>
                              <span className="shrink-0 text-vesti-sm font-sans text-text-tertiary">
                                {conversation.platform}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                    <div className="border-t border-border-subtle px-3 py-1.5 text-vesti-sm font-sans text-text-tertiary">
                      {l("selectionCount", "{count} selected").replace(
                        "{count}",
                        String(selectionIds.length),
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

              {scopeCount !== null ? (
                <p
                  className={`mt-2 text-vesti-sm font-sans ${
                    scopeCount === 0 ? "text-danger" : "text-text-tertiary"
                  }`}
                >
                  {scopeCount === 0
                    ? l("scopeEmpty", "No conversations in this scope.")
                    : l("scopeCount", "{count} conversations in scope.").replace(
                        "{count}",
                        String(scopeCount),
                      )}
                </p>
              ) : null}
            </div>

            {llmMissing ? (
              <p className="mt-3 text-vesti-sm font-sans text-danger">
                {l("llmMissing", "Configure a model in Settings first.")}
              </p>
            ) : null}
            {notice ? (
              <p className="mt-3 text-vesti-sm font-sans text-danger">{notice}</p>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={
                  generating ||
                  !composerScope ||
                  scopeCount === 0 ||
                  llmMissing
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-vesti-base font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generating ? (
                  <RefreshCw strokeWidth={1.75} className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles strokeWidth={1.75} className="h-3.5 w-3.5" />
                )}
                {generating ? l("generating", "Generating…") : l("generate", "Generate")}
              </button>
              <button
                type="button"
                onClick={closeComposer}
                className="rounded-md px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
              >
                {l("cancel", "Cancel")}
              </button>
            </div>
          </div>
        ) : viewDeposit ? (
          <div className="mx-auto max-w-3xl px-6 py-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {renaming ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={renameTitle}
                      onChange={(event) => setRenameTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleRename();
                        if (event.key === "Escape") setRenaming(false);
                      }}
                      className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-surface-card px-2.5 py-1.5 text-vesti-base font-sans text-text-primary outline-none focus:border-accent-primary"
                    />
                    <button
                      type="button"
                      onClick={() => void handleRename()}
                      className="rounded-md bg-accent-primary px-2.5 py-1.5 text-vesti-sm font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover"
                    >
                      {l("save", "Save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(false)}
                      className="rounded-md px-2.5 py-1.5 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
                    >
                      {l("cancel", "Cancel")}
                    </button>
                  </div>
                ) : (
                  <h2 className="text-vesti-xl font-serif text-text-primary">
                    {viewDeposit.title}
                  </h2>
                )}
                <p className="mt-1 text-vesti-sm font-sans text-text-tertiary">
                  {templateName(viewDeposit.template)}
                  {" · "}
                  {l("versionLabel", "v{version}").replace(
                    "{version}",
                    String(viewDeposit.version),
                  )}
                  {" · "}
                  {describeScope(viewDeposit.scope)}
                  {" · "}
                  {new Date(viewDeposit.updatedAt).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {chain.length > 0 && viewDeposit.id === chain[0].id && viewDeposit.template !== "extract" ? (
                <button
                  type="button"
                  onClick={() => void handleRegenerate(chain[0])}
                  disabled={generating || llmMissing}
                  title={llmMissing ? l("llmMissing", "Configure a model in Settings first.") : undefined}
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw
                    strokeWidth={1.75}
                    className={`h-3.5 w-3.5 ${generating ? "animate-spin" : ""}`}
                  />
                  {generating ? l("generating", "Generating…") : l("regenerate", "Regenerate")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setRenaming(true);
                  setRenameTitle(viewDeposit.title);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
              >
                <Pencil strokeWidth={1.75} className="h-3.5 w-3.5" />
                {l("rename", "Rename")}
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setExportOpen((open) => !open)}
                  disabled={exporting}
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:opacity-50"
                >
                  <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
                  {exporting ? l("exporting", "Exporting…") : l("export", "Export")}
                  <ChevronDown strokeWidth={1.75} className="h-3 w-3" />
                </button>
                {exportOpen ? (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                    <div className="absolute left-0 z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-border-subtle bg-bg-surface-card py-1 shadow-lg">
                      <button
                        type="button"
                        onClick={() => handleDownload("md")}
                        className="block w-full px-3 py-2 text-left text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        {l("downloadMarkdown", "Download Markdown")}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownload("json")}
                        className="block w-full px-3 py-2 text-left text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        {l("downloadJson", "Download JSON")}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownload("txt")}
                        className="block w-full px-3 py-2 text-left text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        {l("downloadTxt", "Download TXT")}
                      </button>
                      {storage.exportDepositMarkdown ? (
                        <button
                          type="button"
                          onClick={() => void handleExportToDirectory()}
                          className="block w-full px-3 py-2 text-left text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        >
                          {l("exportMarkdown", "Export .md to folder…")}
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
              <SendToMenu
                storage={storage}
                labels={sendToLabels ?? {}}
                payload={{
                  title: viewDeposit.title,
                  markdown: viewDeposit.contentMarkdown,
                }}
              />
              <button
                type="button"
                onClick={() => void handleDelete(viewDeposit)}
                aria-label={l("delete", "Delete")}
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card hover:text-danger"
              >
                <Trash2 strokeWidth={1.75} className="h-3.5 w-3.5" />
                {l("delete", "Delete")}
              </button>
            </div>

            {llmMissing && viewDeposit.template !== "extract" ? (
              <p className="mt-2 text-vesti-sm font-sans text-text-tertiary">
                {l("llmMissing", "Configure a model in Settings first.")}
              </p>
            ) : null}
            {notice ? (
              <p className="mt-2 text-vesti-sm font-sans text-danger">{notice}</p>
            ) : null}

            {/* Maintain-ops summary (mem0-style merge), when this version was
                produced by a maintain pass. */}
            {viewDeposit.lastOps && viewDeposit.lastOps.length > 0 ? (
              <MaintainOpsBadge
                ops={viewDeposit.lastOps}
                open={opsOpen}
                onToggle={() => setOpsOpen((value) => !value)}
                l={l}
              />
            ) : null}

            {/* Version chain */}
            {chain.length > 1 ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-vesti-sm font-sans text-text-tertiary">
                  {l("versions", "Versions:")}
                </span>
                {chain.map((version) => (
                  <button
                    key={version.id}
                    type="button"
                    onClick={() => setViewId(version.id)}
                    className={`rounded-full px-2.5 py-0.5 text-vesti-sm font-sans transition-colors ${
                      viewDeposit.id === version.id
                        ? "bg-accent-primary-light text-accent-primary"
                        : "text-text-tertiary hover:text-text-secondary"
                    }`}
                  >
                    {l("versionLabel", "v{version}").replace(
                      "{version}",
                      String(version.version),
                    )}
                    {" · "}
                    {new Date(version.createdAt).toLocaleDateString()}
                  </button>
                ))}
              </div>
            ) : null}

            {/* Body */}
            <div
              className="prose prose-slate dark:prose-invert mt-4 max-w-none prose-headings:text-text-primary prose-p:leading-relaxed prose-p:text-text-primary prose-li:leading-relaxed prose-li:text-text-primary prose-strong:text-text-primary prose-em:text-text-primary prose-code:text-text-primary prose-a:text-accent-primary prose-blockquote:text-text-secondary"
              dangerouslySetInnerHTML={{ __html: viewHtml }}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
            <Archive strokeWidth={1.75} className="h-8 w-8 text-text-tertiary" />
            <p className="text-vesti-lg font-serif text-text-primary">
              {l("emptyTitle", "Pick a template or a deposit")}
            </p>
            <p className="max-w-md text-center text-vesti-base font-sans text-text-tertiary">
              {l(
                "emptyHint",
                "Generate a distilled document from a scope of conversations, or review saved deposits on the left.",
              )}
            </p>
          </div>
        )}
      </main>
    </div>
        )}
      </div>
    </div>
  );
}

/** Change-summary badge for a maintain-merged deposit version, expandable to
 * the per-op details (section, old → new text, reason). */
export function MaintainOpsBadge({
  ops,
  open,
  onToggle,
  l,
}: {
  ops: DepositMaintainOp[];
  open: boolean;
  onToggle: () => void;
  l: (key: string, fallback: string) => string;
}) {
  const counts = countMaintainOps(ops);
  const opLabel = (op: DepositMaintainOp["op"]): string => {
    switch (op) {
      case "ADD":
        return l("opAdd", "Add");
      case "UPDATE":
        return l("opUpdate", "Update");
      case "DELETE":
        return l("opDelete", "Delete");
      case "NOOP":
        return l("opNoop", "Keep");
    }
  };
  return (
    <div className="mt-3 rounded-lg border border-border-subtle bg-bg-surface-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="inline-flex items-center rounded-full bg-accent-primary-light px-2.5 py-0.5 text-vesti-sm font-sans font-medium text-accent-primary">
          {l("opsBadge", "{total} changes: {added} added · {updated} updated · {deleted} deleted")
            .replace("{total}", String(counts.total))
            .replace("{added}", String(counts.added))
            .replace("{updated}", String(counts.updated))
            .replace("{deleted}", String(counts.deleted))}
        </span>
        <ChevronDown
          strokeWidth={1.75}
          className={`h-3.5 w-3.5 text-text-tertiary transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <ul className="space-y-2 border-t border-border-subtle px-3 py-2.5">
          {ops.map((op, index) => (
            <li key={index} className="text-vesti-sm font-sans">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    op.op === "DELETE"
                      ? "bg-bg-tertiary text-danger"
                      : op.op === "NOOP"
                        ? "bg-bg-tertiary text-text-tertiary"
                        : "bg-bg-tertiary text-text-secondary"
                  }`}
                >
                  {opLabel(op.op)}
                </span>
                <span className="font-medium text-text-primary">{op.section}</span>
              </div>
              {op.old_text ? (
                <p className="mt-1 whitespace-pre-wrap text-text-tertiary line-through">
                  {op.old_text}
                </p>
              ) : null}
              {op.new_text ? (
                <p className="mt-1 whitespace-pre-wrap text-text-primary">{op.new_text}</p>
              ) : null}
              {op.reason ? (
                <p className="mt-1 text-text-tertiary">
                  {l("opsReason", "Reason")}: {op.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
