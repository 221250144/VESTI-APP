// Knowledge extract panel (P4b) — sectioned view of one extract result:
// knowledge points, code snippets (per-snippet copy), ADR-style decisions and
// reusable prompts. Actions: save into the deposits area (template
// 'extract'), export Markdown, export JSON. All side effects go through
// optional StorageApi methods, so platforms without the desktop bridge
// simply hide the save button.

import { useEffect, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  Download,
  Lightbulb,
  X,
} from "lucide-react";
import {
  sanitizeFileBaseName,
  serializeExtractMarkdown,
} from "../../lib/extractMarkdown";
import type { ExtractResult, StorageApi } from "../../types";

type ExtractPanelProps = {
  /** The extract result to show; null closes the panel. */
  result: ExtractResult | null;
  onClose: () => void;
  storage: StorageApi;
  /** labels.knowledgeExtract group (Record<string,string>); English fallbacks inline. */
  labels: Record<string, string>;
};

type Notice = { tone: "success" | "error"; message: string } | null;

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function ExtractPanel({ result, onClose, storage, labels }: ExtractPanelProps) {
  const l = (key: string, fallback: string) => labels[key] ?? fallback;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Reset per opened result.
  useEffect(() => {
    setCopiedKey(null);
    setSaving(false);
    setSaved(false);
    setNotice(null);
  }, [result]);

  // Esc closes (same idiom as the relay panel).
  useEffect(() => {
    if (!result) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [result, onClose]);

  useEffect(() => {
    if (!copiedKey) return;
    const timeoutId = window.setTimeout(() => setCopiedKey(null), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [copiedKey]);

  if (!result) return null;

  const { extract } = result;
  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopiedKey(key));
  };

  const saveToDeposits = async () => {
    if (!storage.createDeposit || saving || saved) return;
    setSaving(true);
    setNotice(null);
    try {
      await storage.createDeposit({
        template: "extract",
        title: result.title,
        scope: { kind: "selection", conversationIds: result.conversationIds },
        contentMarkdown: serializeExtractMarkdown(result),
      });
      setSaved(true);
      setNotice({
        tone: "success",
        message: l("savedToDeposits", "Saved to deposits."),
      });
    } catch (error) {
      setNotice({ tone: "error", message: (error as Error)?.message ?? String(error) });
    } finally {
      setSaving(false);
    }
  };

  const exportFile = (format: "md" | "json") => {
    const base = sanitizeFileBaseName(result.title);
    if (format === "md") {
      downloadTextFile(`${base}.md`, serializeExtractMarkdown(result), "text/markdown");
    } else {
      downloadTextFile(
        `${base}.json`,
        JSON.stringify(
          {
            title: result.title,
            conversationIds: result.conversationIds,
            extract: result.extract,
          },
          null,
          2,
        ),
        "application/json",
      );
    }
    setNotice({
      tone: "success",
      message: l("downloaded", "Downloaded {filename}").replace(
        "{filename}",
        `${base}.${format}`,
      ),
    });
  };

  const sectionTitle = (text: string) => (
    <h3 className="mb-1.5 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
      {text}
    </h3>
  );

  const copyIcon = (key: string) =>
    copiedKey === key ? (
      <Check strokeWidth={1.75} className="h-3.5 w-3.5 text-accent-primary" />
    ) : (
      <Copy strokeWidth={1.75} className="h-3.5 w-3.5" />
    );

  const isEmpty =
    extract.knowledge_points.length === 0 &&
    extract.code_snippets.length === 0 &&
    extract.decisions.length === 0 &&
    extract.prompts.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/25"
        aria-label={l("close", "Close")}
      />
      <div
        role="dialog"
        aria-label={l("title", "Knowledge extract")}
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border-subtle bg-bg-primary p-4 shadow-[0_16px_48px_rgba(0,0,0,0.18)]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <Lightbulb strokeWidth={1.75} className="h-4 w-4 shrink-0 text-text-secondary" />
            <div className="min-w-0">
              <h2 className="truncate text-vesti-lg font-serif text-text-primary">
                {result.title}
              </h2>
              <p className="text-vesti-sm font-sans text-text-tertiary">
                {l("conversationsFrom", "{count} source conversations").replace(
                  "{count}",
                  String(result.conversationIds.length),
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={l("close", "Close")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary"
          >
            <X strokeWidth={1.75} className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {isEmpty ? (
            <p className="py-6 text-center text-vesti-base font-sans text-text-tertiary">
              {l("empty", "Nothing to show.")}
            </p>
          ) : null}

          {extract.knowledge_points.length > 0 ? (
            <section>
              {sectionTitle(l("sectionKnowledge", "Knowledge points"))}
              <ul className="list-disc space-y-1 pl-5 text-vesti-base font-sans text-text-primary">
                {extract.knowledge_points.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {extract.code_snippets.length > 0 ? (
            <section>
              {sectionTitle(l("sectionCode", "Code snippets"))}
              <div className="space-y-2">
                {extract.code_snippets.map((snippet, index) => (
                  <div
                    key={index}
                    className="overflow-hidden rounded-md border border-border-subtle"
                  >
                    <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-surface-card px-2.5 py-1.5">
                      <span className="rounded bg-bg-primary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                        {snippet.language}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-vesti-sm font-sans text-text-tertiary">
                        {snippet.why}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyText(`code:${index}`, snippet.code)}
                        aria-label={l("copy", "Copy")}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-primary hover:text-text-secondary"
                      >
                        {copyIcon(`code:${index}`)}
                      </button>
                    </div>
                    <pre className="overflow-x-auto bg-bg-primary p-3 font-mono text-[12px] leading-relaxed text-text-primary">
                      {snippet.code}
                    </pre>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {extract.decisions.length > 0 ? (
            <section>
              {sectionTitle(l("sectionDecisions", "Decisions"))}
              <div className="space-y-2">
                {extract.decisions.map((decision, index) => (
                  <div
                    key={index}
                    className="rounded-md border border-border-subtle px-3 py-2"
                  >
                    <p className="text-vesti-base font-sans font-medium text-text-primary">
                      {index + 1}. {decision.title}
                    </p>
                    <dl className="mt-1 space-y-1 text-vesti-sm font-sans">
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-text-tertiary">
                          {l("decisionContext", "Context")}
                        </dt>
                        <dd className="min-w-0 text-text-secondary">
                          {decision.context || "—"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-text-tertiary">
                          {l("decisionLabel", "Decision")}
                        </dt>
                        <dd className="min-w-0 text-text-primary">
                          {decision.decision || "—"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-text-tertiary">
                          {l("decisionConsequences", "Consequences")}
                        </dt>
                        <dd className="min-w-0 text-text-secondary">
                          {decision.consequences || "—"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {extract.prompts.length > 0 ? (
            <section>
              {sectionTitle(l("sectionPrompts", "Prompts"))}
              <div className="space-y-1.5">
                {extract.prompts.map((prompt, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-2 rounded-md border border-border-subtle bg-bg-surface-card px-2.5 py-1.5"
                  >
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-vesti-sm font-sans leading-relaxed text-text-primary">
                      {prompt}
                    </p>
                    <button
                      type="button"
                      onClick={() => copyText(`prompt:${index}`, prompt)}
                      aria-label={l("copy", "Copy")}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-primary hover:text-text-secondary"
                    >
                      {copyIcon(`prompt:${index}`)}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {notice ? (
            <p
              className={`text-vesti-sm font-sans ${
                notice.tone === "error" ? "text-danger" : "text-accent-primary"
              }`}
            >
              {notice.message}
            </p>
          ) : null}
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-3">
          {storage.createDeposit ? (
            <button
              type="button"
              onClick={() => void saveToDeposits()}
              disabled={saving || saved}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-vesti-base font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saved ? (
                <Check strokeWidth={1.75} className="h-3.5 w-3.5" />
              ) : (
                <Archive strokeWidth={1.75} className="h-3.5 w-3.5" />
              )}
              {saved
                ? l("savedToDeposits", "Saved to deposits.")
                : saving
                  ? l("saving", "Saving…")
                  : l("saveToDeposits", "Save to deposits")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => exportFile("md")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
          >
            <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
            {l("exportMarkdown", "Export .md")}
          </button>
          <button
            type="button"
            onClick={() => exportFile("json")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
          >
            <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
            {l("exportJson", "Export JSON")}
          </button>
        </div>
      </div>
    </div>
  );
}
