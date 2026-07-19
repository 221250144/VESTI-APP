// Relay pack history (P4a) — list of previously generated handoff packs.
// Picking one reopens the RelayPanel; deletion goes through the StorageApi.

import { useEffect, useState } from "react";
import { Package, RefreshCw, Trash2, X } from "lucide-react";
import type { RelayPack, StorageApi } from "../../types";

type RelayHistoryPanelProps = {
  open: boolean;
  onClose: () => void;
  storage: StorageApi;
  /** labels.relay group (Record<string,string>); English fallbacks inline. */
  labels: Record<string, string>;
  onSelect: (pack: RelayPack) => void;
};

export function RelayHistoryPanel({
  open,
  onClose,
  storage,
  labels,
  onSelect,
}: RelayHistoryPanelProps) {
  const l = (key: string, fallback: string) => labels[key] ?? fallback;
  const [packs, setPacks] = useState<RelayPack[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !storage.listRelayPacks) return;
    let cancelled = false;
    setPacks(null);
    setErrorMessage(null);
    storage
      .listRelayPacks()
      .then((items) => {
        if (!cancelled) setPacks(items);
      })
      .catch((error) => {
        if (!cancelled) setErrorMessage((error as Error)?.message ?? String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, storage]);

  // Esc closes (same idiom as the organize panel).
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const remove = async (pack: RelayPack) => {
    if (!storage.deleteRelayPack) return;
    setDeletingId(pack.id);
    try {
      await storage.deleteRelayPack(pack.id);
      setPacks((current) => current?.filter((item) => item.id !== pack.id) ?? null);
    } catch (error) {
      setErrorMessage((error as Error)?.message ?? String(error));
    } finally {
      setDeletingId(null);
    }
  };

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
        aria-label={l("historyTitle", "Relay packs")}
        className="relative flex max-h-[70vh] w-full max-w-md flex-col rounded-xl border border-border-subtle bg-bg-primary p-4 shadow-[0_16px_48px_rgba(0,0,0,0.18)]"
      >
        <div className="flex items-start justify-between gap-3 pb-3">
          <div className="flex items-center gap-2">
            <Package strokeWidth={1.75} className="h-4 w-4 text-text-secondary" />
            <h2 className="text-vesti-lg font-serif text-text-primary">
              {l("historyTitle", "Relay packs")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={l("close", "Close")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary"
          >
            <X strokeWidth={1.75} className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {errorMessage ? (
            <p className="py-6 text-center text-vesti-base font-sans text-danger">
              {l("loadFailed", "Failed: {message}").replace("{message}", errorMessage)}
            </p>
          ) : packs === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-vesti-base font-sans text-text-secondary">
              <RefreshCw strokeWidth={1.75} className="h-4 w-4 animate-spin" />
            </div>
          ) : packs.length === 0 ? (
            <p className="py-6 text-center text-vesti-base font-sans text-text-tertiary">
              {l("historyEmpty", "No relay packs yet. Select conversations and generate one.")}
            </p>
          ) : (
            <div className="space-y-1.5">
              {packs.map((pack) => (
                <div
                  key={pack.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(pack)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(pack);
                    }
                  }}
                  className="group flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-left transition-colors hover:bg-bg-surface-card"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-vesti-base font-sans font-medium text-text-primary">
                      {pack.title}
                    </p>
                    <p className="text-vesti-sm font-sans text-text-tertiary">
                      {new Date(pack.createdAt).toLocaleString()}
                      {" · "}
                      {l("historyCount", "{count} conversations").replace(
                        "{count}",
                        String(pack.conversationIds.length),
                      )}
                    </p>
                  </div>
                  {storage.deleteRelayPack ? (
                    <button
                      type="button"
                      disabled={deletingId === pack.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void remove(pack);
                      }}
                      aria-label={l("delete", "Delete")}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-opacity hover:bg-bg-primary hover:text-danger group-hover:opacity-100 disabled:opacity-50"
                    >
                      <Trash2 strokeWidth={1.75} className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
