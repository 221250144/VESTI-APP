"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BarChart3, Briefcase, CheckSquare, Code2, Copy, Download, ExternalLink, Feather, GraduationCap, Languages, LayoutDashboard, Megaphone, Palette, PenLine, Plus, ScanSearch, Search, Shapes, Sparkles, Square, Trash2, Upload, Wrench, Zap, type LucideIcon } from "lucide-react";
import type {
  DashboardLabels,
  PlazaData,
  PlazaPrompt,
  Prompt,
  PromptScanCandidate,
  PromptScanProgress,
  PromptScanResult,
  StorageApi,
  UiThemeMode,
} from "../types";

interface PromptsTabProps {
  storage: StorageApi;
  themeMode?: UiThemeMode;
  isActive?: boolean;
  onOpenConversation?: (conversationId: number) => void;
  labels: DashboardLabels["prompts"];
  /** Plaza data (daily picks + supermarket catalog + adopted ids), host-built. */
  plaza?: PlazaData;
  /** Toggle adoption of a catalog prompt into the user's personal plaza. */
  onPlazaAdoptToggle?: (id: string, adopt: boolean) => void;
  /** Toggle adoption for MANY ids atomically (bulk select). Avoids the
   * read-modify-write race of calling onPlazaAdoptToggle in a loop. */
  onPlazaAdoptToggleMany?: (ids: string[], adopt: boolean) => void;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface EditorState {
  open: boolean;
  isNew: boolean;
  id: number | null;
  title: string;
  body: string;
  sourceConversationId: number | null;
}

const EMPTY_EDITOR: EditorState = {
  open: false,
  isNew: false,
  id: null,
  title: "",
  body: "",
  sourceConversationId: null,
};

// ---- 提示词超市 domain grid ---------------------------------------------------
//
// The supermarket renders as a domain-level card grid first (name + prompt
// count + one-line description); clicking a card drills into that domain's
// prompt list. Copy lives in this component-local dictionary (same pattern as
// the shell's DOCK_COPY) so the shared translation files stay untouched.

type PlazaLocale = "en" | "zh" | "ja" | "ko";

type PlazaDomainId =
  | "writing"
  | "coding"
  | "data"
  | "learning"
  | "productivity"
  | "translation"
  | "marketing"
  | "expert"
  | "art"
  | "uiux"
  | "creative"
  | "engineering";

/** Catalog category labels (en + zh spellings, lowercased) → domain id. The
 * host resolves category names in en/zh only, so both spellings are mapped. */
const DOMAIN_ID_BY_LABEL: Record<string, PlazaDomainId> = {
  writing: "writing",
  "写作": "writing",
  coding: "coding",
  "编程": "coding",
  "data & analysis": "data",
  "数据分析": "data",
  analysis: "data",
  "分析": "data",
  learning: "learning",
  "学习": "learning",
  productivity: "productivity",
  "效率办公": "productivity",
  "效率": "productivity",
  "translation & language": "translation",
  "翻译与语言": "translation",
  translation: "translation",
  "翻译": "translation",
  "marketing & growth": "marketing",
  "营销增长": "marketing",
  "expert roles": "expert",
  "专家角色": "expert",
  expert: "expert",
  "专家": "expert",
  "ai art & icons": "art",
  "ai 绘画与图标": "art",
  "ui/ux design": "uiux",
  "ui/ux 设计": "uiux",
  "creative writing": "creative",
  "创作与写作": "creative",
  engineering: "engineering",
  "工程效率": "engineering",
};

function plazaDomainId(category: string): PlazaDomainId | null {
  return DOMAIN_ID_BY_LABEL[category.trim().toLowerCase()] ?? null;
}

const DOMAIN_ICONS: Record<PlazaDomainId, LucideIcon> = {
  writing: PenLine,
  coding: Code2,
  data: BarChart3,
  learning: GraduationCap,
  productivity: Zap,
  translation: Languages,
  marketing: Megaphone,
  expert: Briefcase,
  art: Palette,
  uiux: LayoutDashboard,
  creative: Feather,
  engineering: Wrench,
};

function PlazaDomainIcon({ domainId, className }: { domainId: PlazaDomainId | null; className: string }) {
  const Icon = domainId ? DOMAIN_ICONS[domainId] : Shapes;
  return <Icon strokeWidth={1.7} className={className} />;
}

interface PromptsPlazaCopy {
  allDomains: string;
  /** "{count}" placeholder. */
  promptCount: string;
  domainFallbackDesc: string;
  domainDesc: Record<PlazaDomainId, string>;
}

const PROMPTS_PLAZA_COPY: Record<PlazaLocale, PromptsPlazaCopy> = {
  en: {
    allDomains: "All domains",
    promptCount: "{count} prompts",
    domainFallbackDesc: "Curated prompts for this domain.",
    domainDesc: {
      writing: "Polish, rewrite and draft everyday text.",
      coding: "Review, debug, refactor and explain code.",
      data: "Analysis, SQL, spreadsheets and charts.",
      learning: "Study plans, explanations and quizzes.",
      productivity: "Planning, email and status updates.",
      translation: "Translate, localize and proofread.",
      marketing: "Launch plans, ads, SEO and growth.",
      expert: "Expert personas for professional tasks.",
      art: "Emblems, mascots, illustrations and app icons.",
      uiux: "Design reviews, tokens and UI copy.",
      creative: "Blogs, READMEs and style mimicry.",
      engineering: "Reviews, refactors, tests and handoff docs.",
    },
  },
  zh: {
    allDomains: "全部领域",
    promptCount: "{count} 条",
    domainFallbackDesc: "该领域的精选提示词。",
    domainDesc: {
      writing: "润色、改写与日常文稿起草。",
      coding: "代码评审、调试、重构与讲解。",
      data: "数据分析、SQL、表格与图表。",
      learning: "学习计划、概念讲解与主动测验。",
      productivity: "计划安排、邮件与进度汇报。",
      translation: "翻译、本地化与语言校对。",
      marketing: "发布计划、广告、SEO 与增长。",
      expert: "面向专业任务的专家角色。",
      art: "徽章、吉祥物、插画与应用图标。",
      uiux: "设计评审、设计令牌与界面文案。",
      creative: "博客、README 与风格模仿。",
      engineering: "评审、重构、测试与交接文档。",
    },
  },
  ja: {
    allDomains: "すべての領域",
    promptCount: "{count} 件",
    domainFallbackDesc: "この領域の厳選プロンプト。",
    domainDesc: {
      writing: "文章の推敲・リライト・下書き作成。",
      coding: "コードレビュー・デバッグ・リファクタリング・解説。",
      data: "データ分析・SQL・スプレッドシート・グラフ。",
      learning: "学習計画・解説・クイズ。",
      productivity: "計画・メール・進捗報告。",
      translation: "翻訳・ローカライズ・校正。",
      marketing: "ローンチ計画・広告・SEO・グロース。",
      expert: "専門タスク向けのエキスパートペルソナ。",
      art: "エンブレム・マスコット・イラスト・アプリアイコン。",
      uiux: "デザインレビュー・デザイントークン・UI コピー。",
      creative: "ブログ・README・スタイル模倣。",
      engineering: "レビュー・リファクタリング・テスト・引き継ぎドキュメント。",
    },
  },
  ko: {
    allDomains: "전체 분야",
    promptCount: "{count}개",
    domainFallbackDesc: "이 분야의 엄선된 프롬프트.",
    domainDesc: {
      writing: "글 다듬기·재작성·초안 작성.",
      coding: "코드 리뷰·디버깅·리팩터링·설명.",
      data: "데이터 분석·SQL·스프레드시트·차트.",
      learning: "학습 계획·설명·퀴즈.",
      productivity: "계획·이메일·진행 상황 공유.",
      translation: "번역·로컬라이제이션·교정.",
      marketing: "출시 계획·광고·SEO·그로스.",
      expert: "전문 작업용 전문가 페르소나.",
      art: "엠블럼·마스코트·일러스트·앱 아이콘.",
      uiux: "디자인 리뷰·디자인 토큰·UI 카피.",
      creative: "블로그·README·스타일 모방.",
      engineering: "리뷰·리팩터링·테스트·인수인계 문서.",
    },
  },
};

/** The prompts label group is translated in all four locales, so the title
 * text is a reliable locale probe (kana before kanji for Japanese). */
function detectPromptsLocale(title: string): PlazaLocale {
  if (/[가-힯]/.test(title)) return "ko";
  if (/[ぁ-ゟァ-ヿ]/.test(title)) return "ja";
  if (/[一-鿿]/.test(title)) return "zh";
  return "en";
}

// Lightweight prompt repository: each entry is a concise trigger (唤醒词) + the
// original prompt body. Find / new / edit / delete only — auto-built from the
// user's high-frequency prompts. No categories / tags / quality / LLM enrichment.
export function PromptsTab({
  storage,
  isActive = false,
  onOpenConversation,
  labels,
  plaza,
  onPlazaAdoptToggle,
  onPlazaAdoptToggleMany,
}: PromptsTabProps) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [extractStatus, setExtractStatus] = useState<"idle" | "running">("idle");
  const [toast, setToast] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Conversation-library scan (agent sessions + browser chats → reviewable
  // prompt candidates the user adopts or ignores one by one).
  const [scanStatus, setScanStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [scanProgress, setScanProgress] = useState<PromptScanProgress | null>(null);
  const [scanResult, setScanResult] = useState<PromptScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [adoptedScanKeys, setAdoptedScanKeys] = useState<Set<string>>(new Set());
  const [ignoredScanKeys, setIgnoredScanKeys] = useState<Set<string>>(new Set());

  const supportsPrompts = Boolean(storage.listPrompts);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Multi-select for the adopted plaza shelf (我的广场) → bulk remove (un-adopt).
  const [selectedPlazaIds, setSelectedPlazaIds] = useState<Set<string>>(new Set());
  // Supermarket drill-in: null = the domain card grid; a category label = that
  // domain's prompt list.
  const [plazaCategory, setPlazaCategory] = useState<string | null>(null);
  const togglePlazaSelect = useCallback((id: string) => {
    setSelectedPlazaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handleBulkRemovePlaza = useCallback(() => {
    const ids = Array.from(selectedPlazaIds);
    if (ids.length === 0) return;
    // Prefer the atomic bulk path; the per-id loop races (each call does its own
    // read-modify-write so only one removal would survive).
    if (onPlazaAdoptToggleMany) {
      onPlazaAdoptToggleMany(ids, false);
    } else if (onPlazaAdoptToggle) {
      for (const id of ids) onPlazaAdoptToggle(id, false);
    } else {
      return;
    }
    setSelectedPlazaIds(new Set());
  }, [onPlazaAdoptToggle, onPlazaAdoptToggleMany, selectedPlazaIds]);

  const load = useCallback(async () => {
    if (!storage.listPrompts) {
      setStatus("error");
      setError(labels.unavailable);
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const result = await storage.listPrompts({ includeArchived: false });
      setPrompts(result);
      setStatus("ready");
    } catch (loadError) {
      setStatus("error");
      setError((loadError as Error)?.message ?? labels.loadFailed);
    }
  }, [storage, labels]);

  useEffect(() => {
    if (isActive && status === "idle") {
      void load();
    }
  }, [isActive, status, load]);

  // Auto-build the library ONLY when it's empty (one-time populate). Re-running
  // is an explicit user action (the Extract button), which refreshes the set —
  // this avoids the auto-accumulation that bloated the library across opens.
  const autoExtractDoneRef = useRef(false);
  useEffect(() => {
    if (!isActive || status !== "ready" || autoExtractDoneRef.current) return;
    if (!storage.extractPromptsFromLibrary) return;
    if (prompts.length > 0) return;
    autoExtractDoneRef.current = true;
    void (async () => {
      setExtractStatus("running");
      try {
        await storage.extractPromptsFromLibrary?.({ scope: "recent" });
        await load();
      } catch {
        /* silent — the manual extract button remains available */
      } finally {
        setExtractStatus("idle");
      }
    })();
  }, [isActive, status, prompts.length, storage, load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visiblePrompts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? prompts.filter(
          (p) =>
            p.title.toLowerCase().includes(needle) ||
            p.body.toLowerCase().includes(needle),
        )
      : prompts;
    return [...list].sort((a, b) => b.updated_at - a.updated_at);
  }, [prompts, search]);

  const openNew = useCallback(() => {
    setEditor({ ...EMPTY_EDITOR, open: true, isNew: true });
  }, []);

  // Plaza → prefill the editor as a NEW prompt so the user reviews/edits before
  // saving (dedup by body hash avoids accidental duplicates on save).
  const usePlazaPrompt = useCallback((p: PlazaPrompt) => {
    setEditor({
      open: true,
      isNew: true,
      id: null,
      title: p.title,
      body: p.body,
      sourceConversationId: null,
    });
  }, []);

  const plazaDaily = plaza?.daily ?? [];
  const supermarket = plaza?.supermarket ?? [];
  const adoptedSet = useMemo(() => new Set(plaza?.adoptedIds ?? []), [plaza?.adoptedIds]);
  const adoptedItems = useMemo(() => {
    if (adoptedSet.size === 0) return [] as PlazaPrompt[];
    const out: PlazaPrompt[] = [];
    for (const cat of supermarket) {
      for (const p of cat.prompts) {
        if (adoptedSet.has(p.id)) out.push(p);
      }
    }
    return out;
  }, [supermarket, adoptedSet]);
  const showPlaza =
    status === "ready" &&
    extractStatus !== "running" &&
    search.trim() === "" &&
    (plazaDaily.length > 0 || supermarket.length > 0);

  const plazaCopy =
    PROMPTS_PLAZA_COPY[detectPromptsLocale(labels.title)] ?? PROMPTS_PLAZA_COPY.en;
  // A stale selection (e.g. after a locale switch re-groups the catalog) falls
  // back to the domain grid.
  const activePlazaGroup = useMemo(
    () => supermarket.find((group) => group.category === plazaCategory) ?? null,
    [supermarket, plazaCategory],
  );
  const plazaDomainDesc = (category: string): string => {
    const domainId = plazaDomainId(category);
    return domainId ? plazaCopy.domainDesc[domainId] : plazaCopy.domainFallbackDesc;
  };

  const openEdit = useCallback((prompt: Prompt) => {
    setEditor({
      open: true,
      isNew: false,
      id: prompt.id,
      title: prompt.title,
      body: prompt.body,
      sourceConversationId: prompt.source_conversation_id,
    });
  }, []);

  const closeEditor = useCallback(() => setEditor(EMPTY_EDITOR), []);

  const handleSave = useCallback(async () => {
    const body = editor.body.trim();
    if (!body) {
      setToast(labels.toastBodyEmpty);
      return;
    }
    try {
      if (editor.isNew || editor.id === null) {
        if (!storage.createPrompt) return;
        const { created } = await storage.createPrompt({
          title: editor.title.trim() || undefined,
          body,
          source: "manual",
        });
        setToast(created ? labels.toastSaved : labels.toastDuplicate);
      } else {
        if (!storage.updatePrompt) return;
        await storage.updatePrompt(editor.id, {
          title: editor.title.trim() || undefined,
          body,
          // Promote to "manual" so an edited prompt survives a library refresh.
          source: "manual",
        });
        setToast(labels.toastUpdated);
      }
      closeEditor();
      await load();
    } catch (saveError) {
      setToast((saveError as Error)?.message ?? labels.toastSaveFailed);
    }
  }, [editor, storage, labels, closeEditor, load]);

  const handleDelete = useCallback(
    async (id: number) => {
      if (!storage.deletePrompt) return;
      try {
        await storage.deletePrompt(id);
        if (editor.id === id) closeEditor();
        setToast(labels.toastDeleted);
        await load();
      } catch (deleteError) {
        setToast((deleteError as Error)?.message ?? labels.toastDeleteFailed);
      }
    },
    [storage, labels, editor.id, closeEditor, load],
  );

  const handleBulkDelete = useCallback(async () => {
    if (!storage.deletePrompt || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    let deleted = 0;
    // Delete each independently so one failure doesn't abort the rest.
    for (const id of ids) {
      try {
        await storage.deletePrompt(id);
        deleted += 1;
        if (editor.id === id) closeEditor();
      } catch {
        // keep going; the partial count is reported below
      }
    }
    if (deleted === ids.length) setToast(labels.toastDeleted);
    else if (deleted === 0) setToast(labels.toastDeleteFailed);
    else setToast(`${labels.toastDeleted} · ${deleted}/${ids.length}`);
    // Always reconcile the UI to the DB, even on partial failure.
    clearSelection();
    await load();
  }, [storage, selectedIds, editor.id, closeEditor, labels, clearSelection, load]);

  const handleCopy = useCallback(
    async (prompt: Prompt) => {
      try {
        await navigator.clipboard.writeText(prompt.body);
        setToast(labels.toastCopied);
        if (storage.incrementPromptUsage) {
          await storage.incrementPromptUsage(prompt.id);
        }
      } catch {
        setToast(labels.toastClipboard);
      }
    },
    [storage, labels],
  );

  // #2 Backup: export/import the prompt library as a JSON file (self-contained;
  // survives reinstall). Uses the existing storage CRUD — no backend changes.
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const handleExport = useCallback(async () => {
    if (!storage.listPrompts) return;
    try {
      const all = await storage.listPrompts({ includeArchived: true });
      const payload = JSON.stringify(
        { schema: "vesti_prompts.v1", prompts: all },
        null,
        2,
      );
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "vesti-prompts-backup.json";
      link.click();
      URL.revokeObjectURL(url);
      setToast(labels.toastExported.replace("{n}", String(all.length)));
    } catch {
      setToast(labels.toastSaveFailed);
    }
  }, [storage, labels]);

  const handleImportFile = useCallback(
    async (file: File) => {
      if (!storage.createPrompt) return;
      let prompts: Array<{ title?: string; body?: string }> = [];
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.prompts)
            ? parsed.prompts
            : null;
        if (!list) throw new Error("bad format");
        prompts = list;
      } catch {
        setToast(labels.importFailed);
        return;
      }
      let imported = 0;
      let skipped = 0;
      for (const item of prompts) {
        const body = typeof item?.body === "string" ? item.body : "";
        if (!body.trim()) {
          skipped += 1;
          continue;
        }
        try {
          const { created } = await storage.createPrompt({
            title: typeof item?.title === "string" ? item.title : undefined,
            body,
            source: "manual",
          });
          if (created) imported += 1;
          else skipped += 1;
        } catch {
          skipped += 1;
        }
      }
      setToast(
        labels.toastImported
          .replace("{n}", String(imported))
          .replace("{skipped}", String(skipped)),
      );
      await load();
    },
    [storage, labels, load],
  );

  const handleExtract = useCallback(async () => {
    if (!storage.extractPromptsFromLibrary) return;
    setExtractStatus("running");
    try {
      const result = await storage.extractPromptsFromLibrary({ scope: "recent" });
      try {
        window.localStorage.setItem("vesti_prompts_last_extract", String(Date.now()));
      } catch {
        /* ignore */
      }
      // Distinguish the three ways "nothing new" happens — before this the
      // toast always read "archived 0 of N candidates", which looked broken.
      let message: string;
      if (result.candidates === 0) {
        message = labels.toastExtractEmpty;
      } else if (result.created === 0) {
        message = labels.toastExtractNone.replace("{candidates}", String(result.candidates));
      } else {
        message = labels.toastExtract
          .replace("{created}", String(result.created))
          .replace("{candidates}", String(result.candidates));
      }
      // An attempted-but-failed LLM distill falls back to heuristics; say so.
      if (result.llmError) message = `${message} ${labels.toastExtractLlmFallback}`;
      setToast(message);
      await load();
    } catch (extractError) {
      setToast((extractError as Error)?.message ?? labels.extractFailed);
    } finally {
      setExtractStatus("idle");
    }
  }, [storage, labels, load]);

  // Interactive library scan: review candidates, adopt into the prompts table
  // or ignore. Progress streams in through onProgress for large libraries.
  const handleScan = useCallback(async () => {
    if (!storage.scanPromptLibrary || scanStatus === "running") return;
    setScanStatus("running");
    setScanError(null);
    setScanResult(null);
    setScanProgress({ done: 0, total: 0 });
    setAdoptedScanKeys(new Set());
    setIgnoredScanKeys(new Set());
    try {
      const result = await storage.scanPromptLibrary({
        onProgress: (progress) => setScanProgress(progress),
      });
      setScanResult(result);
      setScanStatus("done");
    } catch (scanErr) {
      setScanError((scanErr as Error)?.message ?? labels.scanFailed);
      setScanStatus("error");
    }
  }, [storage, scanStatus, labels]);

  const handleAdoptCandidate = useCallback(
    async (candidate: PromptScanCandidate) => {
      if (!storage.createPrompt) return;
      try {
        await storage.createPrompt({
          title: candidate.title,
          body: candidate.body,
          category: candidate.category,
          tags: candidate.tags,
          quality_score: candidate.score,
          source: "extracted",
        });
        setAdoptedScanKeys((prev) => new Set(prev).add(candidate.key));
        setToast(labels.scanAdopted);
        await load();
      } catch (adoptError) {
        setToast((adoptError as Error)?.message ?? labels.toastSaveFailed);
      }
    },
    [storage, labels, load],
  );

  const handleIgnoreCandidate = useCallback((key: string) => {
    setIgnoredScanKeys((prev) => new Set(prev).add(key));
  }, []);

  const closeScanResults = useCallback(() => {
    setScanStatus("idle");
    setScanResult(null);
    setScanError(null);
    setScanProgress(null);
  }, []);

  const visibleScanCandidates = useMemo(
    () => (scanResult?.candidates ?? []).filter((candidate) => !ignoredScanKeys.has(candidate.key)),
    [scanResult, ignoredScanKeys],
  );

  if (!supportsPrompts) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-text-secondary">
        <p>{labels.unavailable}</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-bg-primary">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-6 py-4">
        <div>
          <h2 className="font-mono text-[13px] font-medium uppercase tracking-[0.26em] text-text-primary">
            {labels.title}
          </h2>
          <p className="mt-1 text-[12px] text-text-tertiary">
            {labels.summary.replace("{count}", String(prompts.length))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExtract}
            disabled={extractStatus === "running"}
            title={labels.extractTooltip}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary disabled:opacity-60"
          >
            <Sparkles strokeWidth={1.7} className="h-4 w-4" />
            {extractStatus === "running" ? labels.extracting : labels.extractFromChats}
          </button>
          {storage.scanPromptLibrary && (
            <button
              type="button"
              onClick={() => void handleScan()}
              disabled={scanStatus === "running"}
              title={labels.scanTooltip}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary disabled:opacity-60"
            >
              <ScanSearch strokeWidth={1.7} className="h-4 w-4" />
              {scanStatus === "running"
                ? scanProgress && scanProgress.total > 0
                  ? labels.scanProgress
                      .replace("{done}", String(scanProgress.done))
                      .replace("{total}", String(scanProgress.total))
                  : labels.scanning
                : labels.scanLibrary}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleExport()}
            title={labels.exportLabel}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary"
          >
            <Download strokeWidth={1.7} className="h-4 w-4" />
            {labels.exportLabel}
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            title={labels.importBackup}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary"
          >
            <Upload strokeWidth={1.7} className="h-4 w-4" />
            {labels.importLabel}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleImportFile(file);
            }}
          />
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-1.5 text-[13px] font-medium text-text-inverse transition-opacity hover:opacity-90"
          >
            <Plus strokeWidth={2} className="h-4 w-4" />
            {labels.newPrompt}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="border-b border-border-subtle px-6 py-3">
        <div className="relative">
          <Search
            strokeWidth={1.7}
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={labels.searchPlaceholder}
            className="w-full rounded-lg border border-border-subtle bg-bg-primary py-1.5 pl-8 pr-3 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-primary"
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Library scan: progress + reviewable candidate panel */}
        {(scanStatus === "running" || scanStatus === "done" || scanStatus === "error") && (
          <section className="mb-4 rounded-xl border border-border-subtle bg-bg-surface-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[13px] font-medium text-text-primary">
                  {labels.scanResultsTitle}
                </h3>
                {scanStatus === "running" && (
                  <p className="mt-1 text-[12px] text-text-tertiary">
                    {scanProgress && scanProgress.total > 0
                      ? labels.scanProgress
                          .replace("{done}", String(scanProgress.done))
                          .replace("{total}", String(scanProgress.total))
                      : labels.scanning}
                  </p>
                )}
                {scanStatus === "done" && scanResult && (
                  <p className="mt-1 text-[12px] text-text-tertiary">
                    {labels.scanSummary
                      .replace("{conversations}", String(scanResult.scannedConversations))
                      .replace("{inputs}", String(scanResult.scannedInputs))
                      .replace("{n}", String(visibleScanCandidates.length))}
                  </p>
                )}
                {scanStatus === "error" && (
                  <p className="mt-1 text-[12px] text-red-600">{scanError ?? labels.scanFailed}</p>
                )}
              </div>
              {scanStatus !== "running" && (
                <button
                  type="button"
                  onClick={closeScanResults}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-text-secondary hover:bg-bg-tertiary"
                >
                  {labels.scanClose}
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">{labels.scanPrivacy}</p>
            {scanStatus === "done" && scanResult?.truncated && (
              <p className="mt-1 text-[11px] text-text-tertiary">{labels.scanTruncated}</p>
            )}
            {scanStatus === "done" && scanResult && visibleScanCandidates.length === 0 && (
              <p className="mt-3 text-[12.5px] text-text-secondary">{labels.scanEmpty}</p>
            )}
            {scanStatus === "done" && visibleScanCandidates.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2">
                {visibleScanCandidates.map((candidate) => {
                  const adopted = adoptedScanKeys.has(candidate.key);
                  return (
                    <li
                      key={candidate.key}
                      className="rounded-lg border border-border-subtle bg-bg-primary p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-text-primary">
                            {candidate.title}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
                            <span>
                              {labels.scanUsedCount.replace("{n}", String(candidate.count))}
                            </span>
                            <span>·</span>
                            <span>
                              {labels.scanSourceCount.replace("{n}", String(candidate.sourceCount))}
                            </span>
                            {Array.from(new Set(candidate.sources.map((source) => source.origin))).map(
                              (origin) => (
                                <span
                                  key={origin}
                                  className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px]"
                                >
                                  {origin === "agent" ? labels.scanOriginAgent : labels.scanOriginBrowser}
                                </span>
                              ),
                            )}
                            {candidate.category && (
                              <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px]">
                                {candidate.category}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {candidate.alreadyInLibrary ? (
                            <span className="px-2 py-1 text-[11.5px] text-text-tertiary">
                              {labels.scanInLibrary}
                            </span>
                          ) : adopted ? (
                            <span className="px-2 py-1 text-[11.5px] text-accent-primary">
                              {labels.scanAdopted}
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleAdoptCandidate(candidate)}
                              className="rounded-lg border border-accent-primary px-2.5 py-1 text-[11.5px] text-accent-primary transition-colors hover:bg-accent-primary-light"
                            >
                              {labels.scanAdopt}
                            </button>
                          )}
                          {!adopted && (
                            <button
                              type="button"
                              onClick={() => handleIgnoreCandidate(candidate.key)}
                              className="rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-bg-tertiary"
                            >
                              {labels.scanIgnore}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[12px] leading-relaxed text-text-secondary">
                        {candidate.body}
                      </div>
                      {candidate.sources.length > 0 && (
                        <div className="mt-1.5 truncate text-[10.5px] text-text-tertiary">
                          {candidate.sources
                            .slice(0, 3)
                            .map((source) => source.title || source.conversationId)
                            .join(" · ")}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
        {(status === "loading" || extractStatus === "running") && prompts.length === 0 && (
          <p className="py-12 text-center text-[13px] text-text-tertiary">
            {extractStatus === "running" ? labels.extracting : labels.loading}
          </p>
        )}
        {status === "error" && (
          <div className="py-12 text-center text-[13px] text-red-600">
            {error}
            <div className="mt-3">
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-lg border border-border-subtle px-3 py-1.5 text-text-primary hover:bg-bg-surface-card"
              >
                {labels.retry}
              </button>
            </div>
          </div>
        )}
        {status === "ready" && extractStatus !== "running" && visiblePrompts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-[14px] text-text-secondary">
              {prompts.length === 0 ? labels.emptyNone : labels.emptyFiltered}
            </p>
            {prompts.length === 0 && (
              <p className="mt-1 max-w-sm text-[12px] text-text-tertiary">{labels.emptyHint}</p>
            )}
          </div>
        )}
        {selectedIds.size > 0 && (
          <div className="mb-2 flex items-center justify-between rounded-lg border border-accent-primary/40 bg-accent-primary-light px-3 py-2">
            <span className="text-[12px] font-medium text-accent-primary">
              {(labels.selectedCount ?? "{n} selected").replace("{n}", String(selectedIds.size))}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleBulkDelete()}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
              >
                <Trash2 strokeWidth={1.7} className="h-3.5 w-3.5" />
                {labels.deleteSelected ?? "Delete"}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-md px-2.5 py-1 text-[12px] text-text-secondary hover:bg-bg-tertiary"
              >
                {labels.clearSelection ?? "Cancel"}
              </button>
            </div>
          </div>
        )}
        {visiblePrompts.length > 0 && (
          <ul className="flex flex-col gap-2">
            {visiblePrompts.map((prompt) => {
              const selected = prompt.id != null && selectedIds.has(prompt.id);
              return (
              <li
                key={prompt.id}
                className={`group flex cursor-pointer items-start gap-3 rounded-xl border bg-bg-surface-card p-3.5 transition-shadow hover:shadow-[0_4px_14px_rgba(0,0,0,0.05)] ${
                  selected ? "border-accent-primary" : "border-border-subtle"
                }`}
                onClick={() => openEdit(prompt)}
              >
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (prompt.id != null) toggleSelect(prompt.id);
                  }}
                  className={`mt-0.5 shrink-0 rounded p-0.5 transition-opacity ${
                    selected ? "text-accent-primary opacity-100" : "text-text-tertiary opacity-0 group-hover:opacity-100"
                  }`}
                  aria-label={labels.selectAria ?? "Select"}
                >
                  {selected ? (
                    <CheckSquare strokeWidth={1.7} className="h-4 w-4" />
                  ) : (
                    <Square strokeWidth={1.7} className="h-4 w-4" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-text-primary">
                    {prompt.title}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-secondary">
                    {prompt.body}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCopy(prompt);
                    }}
                    className="rounded p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
                    aria-label={labels.copy}
                  >
                    <Copy strokeWidth={1.7} className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleDelete(prompt.id);
                    }}
                    className="rounded p-1.5 text-text-tertiary hover:bg-red-50 hover:text-red-600"
                    aria-label={labels.deleteAria}
                  >
                    <Trash2 strokeWidth={1.7} className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
        )}

        {/* 提示词广场 (Plaza): daily picks + my adopted shelf + the supermarket */}
        {showPlaza && (
          <section className="mt-8 border-t border-border-subtle pt-6">
            <h3 className="text-[13px] font-medium text-text-primary">{labels.plazaTitle}</h3>
            <p className="mt-1 text-[12px] text-text-tertiary">{labels.plazaSubtitle}</p>

            {plazaDaily.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-[12px] font-medium text-accent-primary">
                    {labels.plazaDaily}
                  </span>
                  <span className="text-[11px] text-text-tertiary">{labels.plazaDailyHint}</span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {plazaDaily.map((p) => (
                    <PlazaCard
                      key={p.id}
                      prompt={p}
                      labels={labels}
                      adopted={adoptedSet.has(p.id)}
                      onUse={() => usePlazaPrompt(p)}
                      onAdopt={
                        onPlazaAdoptToggle
                          ? () => onPlazaAdoptToggle(p.id, !adoptedSet.has(p.id))
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 我的广场: prompts the user adopted from the supermarket */}
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-text-secondary">{labels.myPlaza}</span>
                {selectedPlazaIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-accent-primary">
                      {(labels.selectedCount ?? "{n} selected").replace("{n}", String(selectedPlazaIds.size))}
                    </span>
                    <button
                      type="button"
                      onClick={handleBulkRemovePlaza}
                      className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90"
                    >
                      <Trash2 strokeWidth={1.7} className="h-3 w-3" />
                      {labels.deleteSelected ?? "Delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedPlazaIds(new Set())}
                      className="rounded-md px-2 py-0.5 text-[11px] text-text-secondary hover:bg-bg-tertiary"
                    >
                      {labels.clearSelection ?? "Cancel"}
                    </button>
                  </div>
                )}
              </div>
              {adoptedItems.length === 0 ? (
                <p className="text-[11.5px] text-text-tertiary">{labels.myPlazaEmpty}</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {adoptedItems.map((p) => {
                    const sel = selectedPlazaIds.has(p.id);
                    return (
                      <div key={p.id} className="group relative">
                        <button
                          type="button"
                          onClick={() => togglePlazaSelect(p.id)}
                          aria-label={labels.selectAria ?? "Select"}
                          className={`absolute left-1.5 top-1.5 z-10 rounded p-0.5 transition-opacity ${
                            sel ? "text-accent-primary opacity-100" : "text-text-tertiary opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          {sel ? (
                            <CheckSquare strokeWidth={1.7} className="h-4 w-4" />
                          ) : (
                            <Square strokeWidth={1.7} className="h-4 w-4" />
                          )}
                        </button>
                        <div className={sel ? "rounded-xl ring-1 ring-accent-primary" : ""}>
                          <PlazaCard
                            prompt={p}
                            labels={labels}
                            adopted
                            onUse={() => usePlazaPrompt(p)}
                            onAdopt={
                              onPlazaAdoptToggle ? () => onPlazaAdoptToggle(p.id, false) : undefined
                            }
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 提示词超市: domain-level card grid first; clicking a card drills
                into that domain's prompt list (existing PlazaCard actions). */}
            {supermarket.length > 0 && (
              <div className="mt-6 border-t border-border-subtle pt-5">
                {activePlazaGroup ? (
                  <div>
                    <button
                      type="button"
                      onClick={() => setPlazaCategory(null)}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary"
                    >
                      <ArrowLeft strokeWidth={1.7} className="h-3.5 w-3.5" />
                      {plazaCopy.allDomains}
                    </button>
                    <div className="mb-3 mt-3 flex items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-primary-light text-accent-primary">
                        <PlazaDomainIcon
                          domainId={plazaDomainId(activePlazaGroup.category)}
                          className="h-4 w-4"
                        />
                      </span>
                      <div className="min-w-0">
                        <h4 className="text-[13px] font-medium text-text-primary">
                          {activePlazaGroup.category}
                        </h4>
                        <p className="mt-0.5 text-[11.5px] text-text-tertiary">
                          {plazaDomainDesc(activePlazaGroup.category)}
                          {" · "}
                          {plazaCopy.promptCount.replace(
                            "{count}",
                            String(activePlazaGroup.prompts.length),
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {activePlazaGroup.prompts.map((p) => (
                        <PlazaCard
                          key={p.id}
                          prompt={p}
                          labels={labels}
                          adopted={adoptedSet.has(p.id)}
                          onUse={() => usePlazaPrompt(p)}
                          onAdopt={
                            onPlazaAdoptToggle
                              ? () => onPlazaAdoptToggle(p.id, !adoptedSet.has(p.id))
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <h4 className="text-[13px] font-medium text-text-primary">
                      {labels.supermarketTitle}
                    </h4>
                    <p className="mt-1 text-[12px] text-text-tertiary">{labels.supermarketSubtitle}</p>
                    <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                      {supermarket.map((group) => (
                        <button
                          key={group.category}
                          type="button"
                          onClick={() => setPlazaCategory(group.category)}
                          className="group flex items-start gap-3 rounded-xl border border-border-subtle bg-bg-surface-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent-primary/40 hover:shadow-[0_6px_20px_rgba(0,0,0,0.06)]"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary transition-colors group-hover:bg-accent-primary-light group-hover:text-accent-primary">
                            <PlazaDomainIcon
                              domainId={plazaDomainId(group.category)}
                              className="h-4 w-4"
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-[13px] font-medium text-text-primary">
                                {group.category}
                              </span>
                              <span className="shrink-0 text-[11px] text-text-tertiary">
                                {plazaCopy.promptCount.replace(
                                  "{count}",
                                  String(group.prompts.length),
                                )}
                              </span>
                            </span>
                            <span className="mt-1 block line-clamp-2 text-[12px] leading-relaxed text-text-tertiary">
                              {plazaDomainDesc(group.category)}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {/* Editor drawer */}
      {editor.open && (
        <div className="absolute inset-0 z-40 flex">
          <button
            type="button"
            aria-label={labels.closeEditor}
            className="flex-1 bg-black/20"
            onClick={closeEditor}
          />
          <div className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border-subtle bg-bg-primary shadow-xl">
            <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
              <h3 className="text-[14px] font-medium text-text-primary">
                {editor.isNew ? labels.editorNew : labels.editorEdit}
              </h3>
              <button
                type="button"
                onClick={closeEditor}
                className="rounded p-1 text-text-tertiary hover:bg-bg-surface-card hover:text-text-primary"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-3 px-5 py-4">
              <label className="text-[12px] font-medium text-text-secondary">
                {labels.fieldTitle}
                <input
                  value={editor.title}
                  onChange={(event) =>
                    setEditor((prev) => ({ ...prev, title: event.target.value }))
                  }
                  placeholder={labels.titlePlaceholder}
                  className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[13px] font-normal text-text-primary outline-none focus:border-accent-primary"
                />
              </label>
              <label className="flex flex-1 flex-col text-[12px] font-medium text-text-secondary">
                {labels.fieldBody}
                <textarea
                  value={editor.body}
                  onChange={(event) =>
                    setEditor((prev) => ({ ...prev, body: event.target.value }))
                  }
                  rows={12}
                  placeholder={labels.bodyPlaceholder}
                  className="mt-1 w-full flex-1 resize-y rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 font-mono text-[13px] font-normal leading-relaxed text-text-primary outline-none focus:border-accent-primary"
                />
              </label>
              {!editor.isNew && editor.sourceConversationId !== null && onOpenConversation && (
                <button
                  type="button"
                  onClick={() => onOpenConversation(editor.sourceConversationId as number)}
                  className="inline-flex items-center gap-1.5 self-start text-[12px] text-accent-primary hover:underline"
                >
                  <ExternalLink strokeWidth={1.7} className="h-3.5 w-3.5" />
                  {labels.openSource}
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
              {!editor.isNew && editor.id !== null ? (
                <button
                  type="button"
                  onClick={() => void handleDelete(editor.id as number)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
                >
                  <Trash2 strokeWidth={1.7} className="h-4 w-4" />
                  {labels.deleteBtn}
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeEditor}
                  className="rounded-lg border border-border-subtle px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-surface-card"
                >
                  {labels.cancel}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  className="rounded-lg bg-accent-primary px-4 py-1.5 text-[13px] font-medium text-text-inverse hover:opacity-90"
                >
                  {labels.save}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-text-primary px-4 py-2 text-[13px] text-bg-primary shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function PlazaCard({
  prompt,
  labels,
  onUse,
  adopted = false,
  onAdopt,
}: {
  prompt: PlazaPrompt;
  labels: DashboardLabels["prompts"];
  onUse: () => void;
  adopted?: boolean;
  onAdopt?: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onUse}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onUse();
        }
      }}
      className="group flex cursor-pointer flex-col rounded-xl border border-border-subtle bg-bg-surface-card p-3.5 transition-shadow hover:shadow-[0_4px_14px_rgba(0,0,0,0.05)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="truncate text-[13px] font-medium text-text-primary">{prompt.title}</div>
        <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-tertiary">
          {prompt.category}
        </span>
      </div>
      {prompt.description && (
        <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-text-tertiary">
          {prompt.description}
        </div>
      )}
      <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-secondary">
        {prompt.body}
      </div>
      {prompt.tags && prompt.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {prompt.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-tertiary"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {prompt.sourceUrl ? (
          <a
            href={prompt.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 text-[10.5px] text-text-tertiary hover:text-text-primary hover:underline"
          >
            <ExternalLink strokeWidth={1.7} className="h-3 w-3" />
            {labels.plazaSourcePrefix}
            {prompt.source}
          </a>
        ) : (
          <span className="text-[10.5px] text-text-tertiary">
            {labels.plazaSourcePrefix}
            {prompt.source}
          </span>
        )}
        <div className="flex items-center gap-1.5">
          {onAdopt && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onAdopt();
              }}
              aria-pressed={adopted}
              className={`rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors ${
                adopted
                  ? "border-accent-primary bg-accent-primary-light text-accent-primary"
                  : "border-border-subtle text-text-secondary hover:bg-bg-tertiary"
              }`}
            >
              {adopted ? labels.adopted : labels.adopt}
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onUse();
            }}
            className="rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] text-text-primary opacity-0 transition-opacity hover:bg-bg-tertiary group-hover:opacity-100"
          >
            {labels.plazaUse}
          </button>
        </div>
      </div>
    </div>
  );
}
