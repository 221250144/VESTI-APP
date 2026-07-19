// Relay pack panel (P4a) — structured view of one handoff pack plus the
// handoff actions: copy the suggested prompt (universal clipboard fallback),
// copy/export the full Markdown, copy CLI launch commands (the pack file
// under the app relay dir), or push the suggested prompt into the browser
// extension outbox. All side effects go through optional StorageApi methods,
// so platforms without the desktop bridge simply hide those buttons.

import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Send,
  Terminal,
  X,
} from "lucide-react";
import { serializeRelayPackMarkdown } from "../../lib/relayMarkdown";
import type {
  RelayAvailability,
  RelayCliCommandView,
  RelayPack,
  StorageApi,
} from "../../types";

type RelayPanelProps = {
  /** The pack to show; null closes the panel. */
  pack: RelayPack | null;
  onClose: () => void;
  storage: StorageApi;
  /** labels.relay group (Record<string,string>); English fallbacks inline. */
  labels: Record<string, string>;
};

type Notice = { tone: "success" | "error"; message: string } | null;

export function RelayPanel({ pack, onClose, storage, labels }: RelayPanelProps) {
  const l = (key: string, fallback: string) => labels[key] ?? fallback;
  const [availability, setAvailability] = useState<RelayAvailability | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [cliCommands, setCliCommands] = useState<RelayCliCommandView[] | null>(null);
  const [cliLoading, setCliLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<"export" | "inject" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  // Reset per opened pack and probe capabilities (LLM / extension pairing).
  useEffect(() => {
    setCopiedKey(null);
    setCliCommands(null);
    setCliLoading(false);
    setBusyAction(null);
    setNotice(null);
    if (!pack) {
      setAvailability(null);
      return;
    }
    let cancelled = false;
    void storage.getRelayAvailability?.().then((value) => {
      if (!cancelled) setAvailability(value);
    });
    return () => {
      cancelled = true;
    };
  }, [pack, storage]);

  // Esc closes (same idiom as the organize panel).
  useEffect(() => {
    if (!pack) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [pack, onClose]);

  useEffect(() => {
    if (!copiedKey) return;
    const timeoutId = window.setTimeout(() => setCopiedKey(null), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [copiedKey]);

  if (!pack) return null;

  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopiedKey(key));
  };

  const exportMarkdown = async () => {
    if (!storage.exportRelayPackMarkdown) return;
    setBusyAction("export");
    setNotice(null);
    try {
      const result = await storage.exportRelayPackMarkdown(pack.id);
      if (result) {
        setNotice({
          tone: "success",
          message: l("exportedTo", "Exported to {path}").replace("{path}", result.relativePath),
        });
      }
    } catch (error) {
      setNotice({ tone: "error", message: (error as Error)?.message ?? String(error) });
    } finally {
      setBusyAction(null);
    }
  };

  const loadCliCommands = async () => {
    if (!storage.getRelayPackCliCommands || cliCommands) return;
    setCliLoading(true);
    setNotice(null);
    try {
      setCliCommands(await storage.getRelayPackCliCommands(pack.id));
    } catch (error) {
      setNotice({ tone: "error", message: (error as Error)?.message ?? String(error) });
    } finally {
      setCliLoading(false);
    }
  };

  const deliverToBrowser = async () => {
    if (!storage.deliverRelayPackToBrowser) return;
    setBusyAction("inject");
    setNotice(null);
    try {
      await storage.deliverRelayPackToBrowser(pack.id);
      setNotice({
        tone: "success",
        message: l("injected", "Queued — the extension picks it up on its next poll."),
      });
    } catch (error) {
      setNotice({ tone: "error", message: (error as Error)?.message ?? String(error) });
    } finally {
      setBusyAction(null);
    }
  };

  const payload = pack.pack;
  const injectDisabled =
    availability !== null && !availability.extensionConnected;

  const sectionTitle = (text: string) => (
    <h3 className="mb-1.5 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
      {text}
    </h3>
  );

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
        aria-label={l("title", "Relay pack")}
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border-subtle bg-bg-primary p-4 shadow-[0_16px_48px_rgba(0,0,0,0.18)]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-vesti-lg font-serif text-text-primary">
              {pack.title}
            </h2>
            <p className="text-vesti-sm font-sans text-text-tertiary">
              {new Date(pack.createdAt).toLocaleString()}
              {" · "}
              {l("conversationsFrom", "{count} source conversations").replace(
                "{count}",
                String(pack.conversationIds.length),
              )}
            </p>
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
          <section>
            {sectionTitle(l("sectionGoal", "Goal"))}
            <p className="whitespace-pre-wrap text-vesti-base font-sans text-text-primary">
              {payload.goal}
            </p>
          </section>

          <section>
            {sectionTitle(l("sectionState", "Current state"))}
            <p className="whitespace-pre-wrap text-vesti-base font-sans text-text-primary">
              {payload.current_state}
            </p>
          </section>

          {payload.key_decisions.length > 0 ? (
            <section>
              {sectionTitle(l("sectionDecisions", "Key decisions"))}
              <ul className="list-disc space-y-1 pl-5 text-vesti-base font-sans text-text-primary">
                {payload.key_decisions.map((decision, index) => (
                  <li key={index}>{decision}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {payload.key_files.length > 0 ? (
            <section>
              {sectionTitle(l("sectionFiles", "Key files"))}
              <div className="overflow-x-auto rounded-md border border-border-subtle">
                <table className="w-full text-left text-vesti-sm font-sans">
                  <thead>
                    <tr className="border-b border-border-subtle text-text-tertiary">
                      <th className="px-2 py-1.5 font-medium">{l("filePath", "File")}</th>
                      <th className="px-2 py-1.5 font-medium">{l("fileWhy", "Why")}</th>
                      <th className="px-2 py-1.5 font-medium">{l("fileState", "State")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.key_files.map((file, index) => (
                      <tr
                        key={`${file.path}-${index}`}
                        className="border-b border-border-subtle last:border-b-0"
                      >
                        <td className="max-w-40 break-all px-2 py-1.5 font-mono text-[12px] text-text-primary">
                          {file.path}
                        </td>
                        <td className="px-2 py-1.5 text-text-secondary">{file.why}</td>
                        <td className="px-2 py-1.5 text-text-secondary">{file.last_state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {payload.open_issues.length > 0 ? (
            <section>
              {sectionTitle(l("sectionIssues", "Open issues"))}
              <ul className="list-disc space-y-1 pl-5 text-vesti-base font-sans text-text-primary">
                {payload.open_issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {payload.next_steps.length > 0 ? (
            <section>
              {sectionTitle(l("sectionNext", "Next steps"))}
              <ol className="list-decimal space-y-1 pl-5 text-vesti-base font-sans text-text-primary">
                {payload.next_steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </section>
          ) : null}

          <section>
            {sectionTitle(l("sectionPrompt", "Suggested prompt"))}
            <div className="rounded-md border border-border-subtle bg-bg-surface-card p-3">
              <p className="whitespace-pre-wrap text-vesti-sm font-sans leading-relaxed text-text-primary">
                {pack.suggestedPrompt}
              </p>
            </div>
          </section>

          {/* CLI launch commands (lazily prepared: writes the pack file). */}
          {storage.getRelayPackCliCommands ? (
            <section>
              {sectionTitle(l("cliTitle", "Start a CLI session"))}
              {cliCommands === null ? (
                <button
                  type="button"
                  onClick={() => void loadCliCommands()}
                  disabled={cliLoading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:opacity-50"
                >
                  <Terminal strokeWidth={1.75} className="h-3.5 w-3.5" />
                  {cliLoading
                    ? l("preparing", "Preparing…")
                    : l("cliPrepare", "Write pack file & show commands")}
                </button>
              ) : (
                <div className="space-y-1.5">
                  {cliCommands.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface-card px-2.5 py-1.5"
                    >
                      <span className="shrink-0 text-vesti-sm font-sans font-medium text-text-secondary">
                        {entry.label}
                      </span>
                      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">
                        {entry.command}
                      </code>
                      <button
                        type="button"
                        onClick={() => copyText(`cli:${entry.id}`, entry.command)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-primary hover:text-text-secondary"
                        aria-label={l("copyCommand", "Copy")}
                      >
                        {copiedKey === `cli:${entry.id}` ? (
                          <Check strokeWidth={1.75} className="h-3.5 w-3.5 text-accent-primary" />
                        ) : (
                          <Copy strokeWidth={1.75} className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
          <button
            type="button"
            onClick={() => copyText("prompt", pack.suggestedPrompt)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-vesti-base font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover"
          >
            {copiedKey === "prompt" ? (
              <Check strokeWidth={1.75} className="h-3.5 w-3.5" />
            ) : (
              <Copy strokeWidth={1.75} className="h-3.5 w-3.5" />
            )}
            {copiedKey === "prompt"
              ? l("copied", "Copied")
              : l("copyPrompt", "Copy prompt")}
          </button>
          <button
            type="button"
            onClick={() => copyText("markdown", serializeRelayPackMarkdown(pack))}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
          >
            {copiedKey === "markdown" ? (
              <Check strokeWidth={1.75} className="h-3.5 w-3.5 text-accent-primary" />
            ) : (
              <Copy strokeWidth={1.75} className="h-3.5 w-3.5" />
            )}
            {copiedKey === "markdown"
              ? l("copied", "Copied")
              : l("copyMarkdown", "Copy Markdown")}
          </button>
          {storage.exportRelayPackMarkdown ? (
            <button
              type="button"
              onClick={() => void exportMarkdown()}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:opacity-50"
            >
              <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
              {busyAction === "export"
                ? l("exporting", "Exporting…")
                : l("exportMarkdown", "Export .md")}
            </button>
          ) : null}
          {storage.deliverRelayPackToBrowser ? (
            <button
              type="button"
              onClick={() => void deliverToBrowser()}
              disabled={busyAction !== null || injectDisabled}
              title={
                injectDisabled
                  ? l("extensionMissing", "Pair the browser extension first.")
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send strokeWidth={1.75} className="h-3.5 w-3.5" />
              {busyAction === "inject"
                ? l("injecting", "Sending…")
                : l("injectBrowser", "Send to browser")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
