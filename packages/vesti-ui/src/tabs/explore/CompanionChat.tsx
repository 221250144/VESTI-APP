"use client";

// 夜话 chat panel: the header (title + persona / memory-scope switchers), the
// bubble stream (user right, 夜话 left with the mood-resolved owl avatar,
// Markdown bodies, recall-source chips), the thinking indicator, the gentle
// error bubble, the empty state and the composer. State and IO live in the
// coordinator (../explore-tab.tsx); view-model mapping lives in
// ./companionView.ts.

import { useMemo, type RefObject } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Loader2, PanelLeftClose, PanelLeftOpen, Send } from "lucide-react";
import type {
  CompanionMemoryScope,
  CompanionMood,
  CompanionOwlIcons,
  CompanionPersona,
  ExploreLabels,
  ExploreMessage,
} from "../../types";
import { ExploreSourceChips } from "../../components/ExploreBits";
import {
  streamDisplayBody,
  toCompanionMessageView,
  type CompanionMessageView,
} from "./companionView";

// ---- owl avatar ------------------------------------------------------------------

function OwlAvatar({
  icons,
  mood,
  className,
}: {
  icons: CompanionOwlIcons | undefined;
  mood: CompanionMood;
  className: string;
}) {
  const url = icons?.[mood] ?? icons?.calm;
  if (url) {
    return <img src={url} alt="" aria-hidden="true" className={className} draggable={false} />;
  }
  // Host without owl art (web preview): neutral monogram circle.
  return (
    <div
      aria-hidden="true"
      className={`flex items-center justify-center rounded-full border border-border-subtle bg-bg-surface-card text-text-secondary ${className}`}
    >
      <span className="text-[0.6em] font-sans">夜</span>
    </div>
  );
}

// ---- segmented switcher --------------------------------------------------------------

function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border-subtle bg-bg-surface-card p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={`rounded px-2.5 py-1 text-xs font-sans transition-colors ${
            value === option.value
              ? "bg-accent-primary text-text-inverse"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---- markdown body (same marked + DOMPurify path as the rest of explore) --------------

function CompanionMarkdown({ body }: { body: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(body, { gfm: true, breaks: false }) as string),
    [body],
  );
  return (
    <div
      className="prose prose-slate dark:prose-invert max-w-none prose-headings:text-text-primary prose-p:leading-relaxed prose-p:text-text-primary prose-li:leading-relaxed prose-li:text-text-primary prose-strong:text-text-primary prose-em:text-text-primary prose-code:text-text-primary prose-a:text-accent-primary prose-blockquote:text-text-secondary"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---- message rows -----------------------------------------------------------------------

function UserRow({ view, labels }: { view: CompanionMessageView; labels: ExploreLabels }) {
  return (
    <div className="py-3">
      <div className="mx-auto flex max-w-3xl justify-end px-4">
        <div className="max-w-[80%]">
          <p className="mb-1 text-right text-xs font-sans text-text-tertiary">{labels.you}</p>
          <div className="rounded-2xl rounded-tr-sm bg-accent-primary px-4 py-2.5 text-text-inverse">
            <p className="whitespace-pre-wrap text-[15px] font-sans leading-relaxed">{view.body}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantRow({
  view,
  labels,
  owlIcons,
  onOpenConversation,
}: {
  view: CompanionMessageView;
  labels: ExploreLabels;
  owlIcons: CompanionOwlIcons | undefined;
  onOpenConversation?: (conversationId: number) => void;
}) {
  return (
    <div className="py-3">
      <div className="mx-auto flex max-w-3xl gap-3 px-4">
        <OwlAvatar icons={owlIcons} mood={view.mood} className="h-9 w-9 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-sans text-text-tertiary">{labels.companion.title}</p>
          {view.reasoning ? (
            <details className="mb-2 rounded-xl border border-border-subtle bg-bg-primary px-3 py-2">
              <summary className="cursor-pointer select-none text-xs font-sans text-text-tertiary transition-colors hover:text-text-primary">
                {labels.companion.thinkingProcess}
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-xs font-sans leading-relaxed text-text-secondary">
                {view.reasoning}
              </p>
            </details>
          ) : null}
          <div className="rounded-2xl rounded-tl-sm border border-border-subtle bg-bg-surface-card px-4 py-3">
            <CompanionMarkdown body={view.body} />
          </div>
          {view.sources && view.sources.length > 0 ? (
            <div className="mt-2">
              <p className="mb-1.5 text-[11px] font-sans uppercase tracking-wider text-text-tertiary">
                {labels.sources}
              </p>
              <ExploreSourceChips sources={view.sources} onOpenConversation={onOpenConversation} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The in-flight streaming bubble: live-typed body (mood tag line hidden) and
 * the thinking trace folding open while it grows. */
function StreamingRow({
  labels,
  owlIcons,
  streaming,
}: {
  labels: ExploreLabels;
  owlIcons: CompanionOwlIcons | undefined;
  streaming: { raw: string; reasoning: string };
}) {
  const body = streamDisplayBody(streaming.raw);
  return (
    <div className="py-3">
      <div className="mx-auto flex max-w-3xl gap-3 px-4">
        <OwlAvatar
          icons={owlIcons}
          mood="thinking"
          className="h-9 w-9 shrink-0 animate-pulse rounded-full"
        />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-sans text-text-tertiary">{labels.companion.title}</p>
          {streaming.reasoning.trim() ? (
            <details open className="mb-2 rounded-xl border border-border-subtle bg-bg-primary px-3 py-2">
              <summary className="cursor-pointer select-none text-xs font-sans text-text-tertiary transition-colors hover:text-text-primary">
                {labels.companion.thinkingProcess}
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-xs font-sans leading-relaxed text-text-secondary">
                {streaming.reasoning}
              </p>
            </details>
          ) : null}
          <div className="rounded-2xl rounded-tl-sm border border-border-subtle bg-bg-surface-card px-4 py-3">
            {body ? (
              <CompanionMarkdown body={body} />
            ) : (
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary [animation-delay:300ms]" />
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ThinkingRow({
  labels,
  owlIcons,
}: {
  labels: ExploreLabels;
  owlIcons: CompanionOwlIcons | undefined;
}) {
  return (
    <div className="py-3">
      <div className="mx-auto flex max-w-3xl gap-3 px-4">
        <OwlAvatar
          icons={owlIcons}
          mood="thinking"
          className="h-9 w-9 shrink-0 animate-pulse rounded-full"
        />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-sans text-text-tertiary">{labels.companion.title}</p>
          <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border-subtle bg-bg-surface-card px-4 py-3">
            <span className="flex items-center gap-1" aria-hidden="true">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary [animation-delay:300ms]" />
            </span>
            <span className="text-sm font-sans text-text-secondary">{labels.companion.thinking}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorRow({
  error,
  labels,
  owlIcons,
  onDismiss,
}: {
  error: string;
  labels: ExploreLabels;
  owlIcons: CompanionOwlIcons | undefined;
  onDismiss: () => void;
}) {
  return (
    <div className="py-3">
      <div className="mx-auto flex max-w-3xl gap-3 px-4">
        <OwlAvatar icons={owlIcons} mood="sleepy" className="h-9 w-9 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-sans text-text-tertiary">{labels.companion.title}</p>
          <div className="rounded-2xl rounded-tl-sm border border-danger/30 bg-danger/5 px-4 py-3">
            <p className="text-sm font-sans text-text-primary">{labels.companion.errorTitle}</p>
            <p className="mt-1 text-xs font-sans leading-relaxed text-text-secondary">{error}</p>
            <button
              type="button"
              onClick={onDismiss}
              className="mt-2 text-xs font-sans text-text-tertiary transition-colors hover:text-text-primary"
            >
              {labels.dismiss}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- main panel ----------------------------------------------------------------------------

export interface CompanionChatProps {
  labels: ExploreLabels;
  owlIcons?: CompanionOwlIcons;
  persona: CompanionPersona;
  memoryScope: CompanionMemoryScope;
  onPersonaChange: (persona: CompanionPersona) => void;
  onScopeChange: (scope: CompanionMemoryScope) => void;
  messages: ExploreMessage[];
  messagesLoading: boolean;
  isSubmitting: boolean;
  /** In-flight streaming turn (null = idle or host without streaming). */
  streaming?: { raw: string; reasoning: string } | null;
  error: string | null;
  onDismissError: () => void;
  currentSessionTitle?: string | null;
  /** No session and nothing on screen yet: the big-owl welcome. */
  showEmptyState: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onOpenConversation?: (conversationId: number) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}

export function CompanionChat({
  labels,
  owlIcons,
  persona,
  memoryScope,
  onPersonaChange,
  onScopeChange,
  messages,
  messagesLoading,
  isSubmitting,
  streaming,
  error,
  onDismissError,
  currentSessionTitle,
  showEmptyState,
  sidebarOpen,
  onToggleSidebar,
  inputValue,
  onInputChange,
  onSubmit,
  onOpenConversation,
  textareaRef,
  messagesEndRef,
}: CompanionChatProps) {
  const companion = labels.companion;
  const views = useMemo(() => messages.map(toCompanionMessageView), [messages]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg-primary">
      {/* 页头: 夜话 + subtitle, persona / memory-scope switchers on the right. */}
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onToggleSidebar}
            className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-primary"
            title={sidebarOpen ? labels.closeSidebar : labels.openSidebar}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-4 w-4" strokeWidth={1.5} />
            ) : (
              <PanelLeftOpen className="h-4 w-4" strokeWidth={1.5} />
            )}
          </button>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-sans font-medium text-text-primary">{companion.title}</h2>
              <p className="truncate text-xs font-sans text-text-tertiary">{companion.subtitle}</p>
            </div>
            {currentSessionTitle ? (
              <p className="max-w-[280px] truncate text-[11px] font-sans text-text-tertiary">
                {currentSessionTitle}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-sans text-text-tertiary">{companion.personaLabel}</span>
            <SegmentedControl<CompanionPersona>
              ariaLabel={companion.personaLabel}
              value={persona}
              onChange={onPersonaChange}
              options={[
                { value: "listener", label: companion.personaListener },
                { value: "creator", label: companion.personaCreator },
              ]}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-sans text-text-tertiary">{companion.scopeLabel}</span>
            <SegmentedControl<CompanionMemoryScope>
              ariaLabel={companion.scopeLabel}
              value={memoryScope}
              onChange={onScopeChange}
              options={[
                { value: "full", label: companion.scopeFull, hint: companion.scopeFullHint },
                { value: "memory", label: companion.scopeMemory, hint: companion.scopeMemoryHint },
                { value: "chat", label: companion.scopeChat, hint: companion.scopeChatHint },
              ]}
            />
          </div>
        </div>
      </div>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto">
        {showEmptyState ? (
          <div className="flex h-full flex-col items-center justify-center p-10 text-center">
            <OwlAvatar
              icons={owlIcons}
              mood="calm"
              className="mb-5 h-28 w-28 rounded-full text-2xl"
            />
            <h3 className="font-[family-name:var(--font-lora)] text-xl text-text-primary">
              {companion.emptyTitle}
            </h3>
            <p className="mt-2 max-w-md text-[13px] font-sans leading-relaxed text-text-tertiary">
              {companion.emptyBody}
            </p>
          </div>
        ) : messagesLoading && views.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-accent-primary" />
          </div>
        ) : (
          <>
            {views.map((view) =>
              view.role === "user" ? (
                <UserRow key={view.id} view={view} labels={labels} />
              ) : (
                <AssistantRow
                  key={view.id}
                  view={view}
                  labels={labels}
                  owlIcons={owlIcons}
                  onOpenConversation={onOpenConversation}
                />
              ),
            )}
            {streaming ? (
              <StreamingRow labels={labels} owlIcons={owlIcons} streaming={streaming} />
            ) : isSubmitting ? (
              <ThinkingRow labels={labels} owlIcons={owlIcons} />
            ) : null}
            {error ? (
              <ErrorRow
                error={error}
                labels={labels}
                owlIcons={owlIcons}
                onDismiss={onDismissError}
              />
            ) : null}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* 输入区: Enter 发送, Shift+Enter 换行; 生成中禁用。 */}
      <div className="border-t border-border-subtle p-4">
        <div className="mx-auto max-w-3xl">
          <div className="relative flex items-end gap-2 rounded-lg border border-border-default bg-bg-primary transition-all focus-within:border-accent-primary focus-within:ring-2 focus-within:ring-accent-primary/20">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={companion.inputPlaceholder}
              disabled={isSubmitting}
              rows={1}
              className="max-h-32 flex-1 resize-none bg-transparent px-4 py-3 text-base font-sans text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-60"
              style={{ minHeight: "48px" }}
            />
            <div className="p-2">
              <button
                type="button"
                onClick={onSubmit}
                disabled={!inputValue.trim() || isSubmitting}
                title={companion.send}
                className="rounded-md bg-accent-primary p-2 text-text-inverse transition-all hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" strokeWidth={1.5} />
                )}
              </button>
            </div>
          </div>
          {isSubmitting ? (
            <p className="mt-2 text-center text-xs font-sans text-text-tertiary">
              {companion.thinking}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
