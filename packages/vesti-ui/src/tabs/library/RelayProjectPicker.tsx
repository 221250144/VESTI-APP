// Relay project picker (P4a quality) — platform → folder/project →
// conversation tri-level tree mirroring how the agent platforms store
// sessions on disk, offered as an alternative to picking conversations one by
// one in the library list. All state logic is pure (relaySelector.ts); this
// component only renders the model and reports the resulting flat id pool.
// Subagent sessions are never rows of their own (A1): they follow their
// parent into the handoff pack, only their count is shown.

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { sourcePlatformLabel } from "./sourceTree";
import {
  modelConversationIds,
  platformConversationIds,
  projectConversationIds,
  relayNodeCheckState,
  toggleRelayConversation,
  toggleRelayIds,
  type RelayNodeCheckState,
  type RelaySelectorPlatform,
} from "./relaySelector";

type RelayProjectPickerProps = {
  /** Tri-level model (buildRelaySelectorModel); empty renders an empty hint. */
  model: RelaySelectorPlatform[];
  /** Current relay selection pool (may include ids outside the tree — those
   * are preserved verbatim when the picker applies). */
  selectedIds: number[];
  /** Applies the merged selection pool and closes the picker. */
  onApply: (ids: number[]) => void;
  onClose: () => void;
  /** labels.relay group (Record<string,string>); English fallbacks inline. */
  labels: Record<string, string>;
};

function TriCheckbox({
  state,
  onToggle,
  ariaLabel,
}: {
  state: RelayNodeCheckState;
  onToggle: () => void;
  ariaLabel: string;
}) {
  const ref = useCallback(
    (element: HTMLInputElement | null) => {
      if (element) element.indeterminate = state === "partial";
    },
    [state]
  );
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "checked"}
      onChange={onToggle}
      aria-label={ariaLabel}
      className="h-3.5 w-3.5 shrink-0 accent-accent-primary"
    />
  );
}

export function RelayProjectPicker({
  model,
  selectedIds,
  onApply,
  onClose,
  labels,
}: RelayProjectPickerProps) {
  const l = (key: string, fallback: string) => labels[key] ?? fallback;
  const [selected, setSelected] = useState<Set<number>>(() => new Set(selectedIds));

  // Esc closes (same idiom as the relay pack panel).
  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const modelIds = useMemo(() => new Set(modelConversationIds(model)), [model]);

  const apply = () => {
    // Ids selected outside the tree (e.g. browser conversations picked in the
    // list) are not represented by any node — keep them untouched.
    const preserved = selectedIds.filter((id) => !modelIds.has(id));
    onApply([...preserved, ...selected]);
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
        aria-label={l("pickerTitle", "Select by project")}
        className="relative flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-border-subtle bg-bg-primary p-4 shadow-[0_16px_48px_rgba(0,0,0,0.18)]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-3">
          <div className="min-w-0">
            <h2 className="text-vesti-lg font-serif text-text-primary">
              {l("pickerTitle", "Select by project")}
            </h2>
            <p className="text-vesti-sm font-sans text-text-tertiary">
              {l(
                "pickerHint",
                "Agent platform → folder → conversation. Subagents follow their parent session."
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

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {model.length === 0 ? (
            <p className="py-6 text-center text-vesti-sm font-sans text-text-tertiary">
              {l("pickerEmpty", "No captured CLI sessions to group yet.")}
            </p>
          ) : (
            model.map((platform) => {
              const platformIds = platformConversationIds(platform);
              const platformLabel = sourcePlatformLabel(platform.platform);
              const hostSuffix =
                platform.host && platform.host !== "native" ? `（${platform.host}）` : "";
              return (
                <section key={`${platform.platform}|${platform.host}`} className="mb-3">
                  {/* Level 1: agent platform */}
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 hover:bg-bg-surface-card">
                    <TriCheckbox
                      state={relayNodeCheckState(selected, platformIds)}
                      onToggle={() =>
                        setSelected((current) => toggleRelayIds(current, platformIds))
                      }
                      ariaLabel={platformLabel}
                    />
                    <span className="text-vesti-base font-sans font-medium text-text-primary">
                      {platformLabel}
                      {hostSuffix}
                    </span>
                    <span className="text-vesti-sm font-sans text-text-tertiary">
                      · {platformIds.length}
                    </span>
                  </label>

                  {/* Level 2: folder / project */}
                  <div className="ml-5 space-y-0.5 border-l border-border-subtle pl-3">
                    {platform.projects.map((project) => {
                      const projectIds = projectConversationIds(project);
                      return (
                        <div key={project.projectKey}>
                          <label
                            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-bg-surface-card"
                            title={project.pathOrDomain}
                          >
                            <TriCheckbox
                              state={relayNodeCheckState(selected, projectIds)}
                              onToggle={() =>
                                setSelected((current) => toggleRelayIds(current, projectIds))
                              }
                              ariaLabel={project.label}
                            />
                            <span className="truncate text-vesti-sm font-sans font-medium text-text-secondary">
                              {project.label}
                            </span>
                            <span className="shrink-0 text-vesti-sm font-sans text-text-tertiary">
                              · {projectIds.length}
                            </span>
                          </label>

                          {/* Level 3: conversation */}
                          <div className="ml-5 space-y-0.5">
                            {project.conversations.map((conversation) => (
                              <label
                                key={conversation.id}
                                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-bg-surface-card"
                                title={conversation.oneLiner ?? conversation.title}
                              >
                                <TriCheckbox
                                  state={relayNodeCheckState(selected, [conversation.id])}
                                  onToggle={() =>
                                    setSelected((current) =>
                                      toggleRelayConversation(current, conversation.id)
                                    )
                                  }
                                  ariaLabel={conversation.title}
                                />
                                <span className="min-w-0 flex-1 truncate text-vesti-sm font-sans text-text-primary">
                                  {conversation.title}
                                </span>
                                {conversation.oneLiner ? (
                                  <span className="hidden max-w-48 truncate text-vesti-sm font-sans text-text-tertiary sm:inline">
                                    {conversation.oneLiner}
                                  </span>
                                ) : null}
                                {conversation.subagentCount > 0 ? (
                                  <span
                                    className="shrink-0 rounded-full bg-bg-surface-card px-1.5 py-0.5 text-[11px] font-sans text-text-tertiary"
                                    title={l(
                                      "pickerSubagents",
                                      "Subagents follow this session into the pack"
                                    )}
                                  >
                                    +{conversation.subagentCount}{" "}
                                    {l("pickerSubagentUnit", "subagents")}
                                  </span>
                                ) : null}
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-3">
          <span className="text-vesti-sm font-sans text-text-secondary">
            {l("selectedCount", "{count} selected").replace(
              "{count}",
              String(selected.size)
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
            >
              {l("exitSelectMode", "Cancel")}
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded-md bg-accent-primary px-3 py-1.5 text-vesti-base font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover"
            >
              {l("pickerApply", "Apply selection")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
