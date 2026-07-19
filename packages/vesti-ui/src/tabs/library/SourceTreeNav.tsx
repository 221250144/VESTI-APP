// Source-tree navigation (P2b) — left-nav tree of
// source (terminal platforms / browser, native vs WSL) → project → topic,
// plus a "notes" source node that switches the list pane to the notes view.
//
// Pure presentational component: the aggregated model comes from
// `buildSourceTreeModel` (./sourceTree) and the selection is owned by the
// library tab so it can drive the conversation-list filter.

import { useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  FileText,
  Folder,
  Globe,
  Hash,
  Terminal,
} from "lucide-react";
import type {
  SourceRef,
  SourceSelection,
  SourceTreeModel,
  SourceTreeProjectNode,
  SourceTreeTopicNode,
} from "./sourceTree";
import {
  BROWSER_SOURCE,
  isWslHost,
  sourcePlatformLabel,
  wslDistro,
} from "./sourceTree";
import type { ProjectStateView } from "../../types";

export type SourceTreeNavLabels = {
  sectionLabel: string;
  notes: string;
  browser: string;
  wslBadge: string;
  /** Memory v2 */
  projectBrief?: string;
  activeFiles?: string;
  openQuestions?: string;
};

type SourceTreeNavProps = {
  model: SourceTreeModel;
  selection: SourceSelection | null;
  onSelect: (selection: SourceSelection) => void;
  notesCount: number;
  notesActive: boolean;
  onSelectNotes: () => void;
  labels: SourceTreeNavLabels;
  /** Memory v2: open the L2 project brief overlay for a project. */
  onOpenBrief?: (projectKey: string) => void;
};

function sameRef(a: SourceRef, b: SourceRef): boolean {
  return a.platform === b.platform && a.host === b.host;
}

function selectionEquals(
  a: SourceSelection | null,
  b: SourceSelection,
): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (!sameRef(a.source, b.source)) return false;
  if (a.kind === "source") return true;
  if (b.kind === "source") return false;
  if (a.projectKey !== b.projectKey) return false;
  if (a.kind === "project") return true;
  if (b.kind !== "topic") return false;
  return a.topicId === b.topicId;
}

const INDENT_BASE_PX = 8;
const INDENT_STEP_PX = 14;

function TreeRow({
  depth,
  selected,
  onClick,
  icon,
  label,
  count,
  badge,
  collapsible,
  expanded,
  onToggle,
  toggleLabel,
  hoverCard,
}: {
  depth: number;
  selected: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  badge?: ReactNode;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  /** Memory v2: content shown in a floating card while the row is hovered. */
  hoverCard?: ReactNode;
}) {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={collapsible ? expanded : undefined}
      className={`group relative flex w-full items-center rounded-lg transition-colors my-0.5 ${
        selected ? "bg-accent-primary-light" : "hover:bg-bg-surface-card"
      }`}
      style={{ paddingLeft: `${INDENT_BASE_PX + depth * INDENT_STEP_PX}px` }}
    >
      {hoverCard ? (
        <div className="pointer-events-none absolute left-full top-0 z-50 ml-1 hidden w-72 group-hover:block">
          {hoverCard}
        </div>
      ) : null}
      {collapsible ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
          aria-label={toggleLabel ?? (expanded ? "Collapse" : "Expand")}
          className="mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <ChevronDown
            strokeWidth={1.75}
            className={`h-4 w-4 transition-transform duration-150 ${
              expanded ? "" : "-rotate-90"
            }`}
          />
        </button>
      ) : (
        <span className="mr-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
      >
        {icon}
        <span
          className={`min-w-0 flex-1 truncate text-vesti-base font-sans ${
            selected ? "text-accent-primary" : "text-text-primary"
          }`}
        >
          {label}
        </span>
        {badge}
        <span className="shrink-0 text-vesti-sm font-sans text-text-tertiary">
          {count}
        </span>
      </button>
    </div>
  );
}

function WslBadge({ host, label }: { host: string; label: string }) {
  if (!isWslHost(host)) return null;
  const distro = wslDistro(host);
  return (
    <span className="shrink-0 rounded bg-bg-surface-card-active px-1.5 py-0.5 text-vesti-xs font-sans text-text-tertiary">
      {distro ? `${label}·${distro}` : label}
    </span>
  );
}

/** Memory v2: L0 "current state card" shown on project-row hover. */
function ProjectStateHoverCard({
  state,
  labels,
}: {
  state: ProjectStateView;
  labels: SourceTreeNavLabels;
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-app p-3 shadow-lg">
      <p className="text-vesti-sm font-sans text-text-primary line-clamp-2">
        {state.oneLiner || "—"}
      </p>
      {state.activeFiles.length > 0 ? (
        <div className="mt-2">
          <p className="text-[10px] font-sans font-semibold uppercase tracking-wider text-text-tertiary">
            {labels.activeFiles ?? "Active files (30d)"}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {state.activeFiles.slice(0, 6).map((file) => (
              <span
                key={file.path}
                title={`${file.path} · ${file.touches}×`}
                className="max-w-full truncate rounded bg-bg-surface-card px-1.5 py-0.5 text-vesti-xs font-sans text-text-secondary"
              >
                {file.path.split("/").pop() ?? file.path}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <p className="mt-2 text-vesti-xs font-sans text-text-tertiary">
        {labels.openQuestions ?? "Open questions"}: {state.openQuestions.length}
        {" · "}
        {state.sessionCount} sessions
      </p>
    </div>
  );
}

export function SourceTreeNav({
  model,
  selection,
  onSelect,
  notesCount,
  notesActive,
  onSelectNotes,
  labels,
  onOpenBrief,
}: SourceTreeNavProps) {
  // Collapse state is component-local. Default: sources expanded, projects
  // collapsed ("collapsed down to the project layer"); explicit user toggles
  // override the defaults.
  const [collapsedOverrides, setCollapsedOverrides] = useState<
    Record<string, boolean>
  >({});
  const isCollapsed = (key: string, defaultCollapsed: boolean) =>
    collapsedOverrides[key] ?? defaultCollapsed;
  const toggleCollapsed = (key: string, defaultCollapsed: boolean) =>
    setCollapsedOverrides((prev) => ({
      ...prev,
      [key]: !isCollapsed(key, defaultCollapsed),
    }));

  const renderTopic = (
    topic: SourceTreeTopicNode,
    source: SourceRef,
    project: SourceTreeProjectNode,
    depth: number,
  ) => {
    const key = `topic:${project.projectKey}:${topic.id}`;
    const nodeSelection: SourceSelection = {
      kind: "topic",
      source,
      projectKey: project.projectKey,
      topicId: topic.id,
    };
    const hasChildren = topic.children.length > 0;
    const collapsed = isCollapsed(key, true);
    return (
      <div key={key}>
        <TreeRow
          depth={depth}
          selected={selectionEquals(selection, nodeSelection)}
          onClick={() => onSelect(nodeSelection)}
          icon={
            <Hash
              strokeWidth={1.75}
              className="h-4 w-4 shrink-0 text-text-tertiary"
            />
          }
          label={topic.name}
          count={topic.count}
          collapsible={hasChildren}
          expanded={!collapsed}
          onToggle={() => toggleCollapsed(key, true)}
        />
        {hasChildren && !collapsed
          ? topic.children.map((child) =>
              renderTopic(child, source, project, depth + 1),
            )
          : null}
      </div>
    );
  };

  return (
    <div role="tree" aria-label={labels.sectionLabel}>
      {model.sources.length > 0 ? (
        <div className="px-2 pb-1 pt-2">
          <span className="text-[10px] font-sans font-semibold uppercase tracking-wider text-text-tertiary">
            {labels.sectionLabel}
          </span>
        </div>
      ) : null}
      {model.sources.map((source) => {
        const ref: SourceRef = { platform: source.platform, host: source.host };
        const key = `source:${source.platform}|${source.host}`;
        const isBrowser = source.platform === BROWSER_SOURCE.platform;
        const collapsed = isCollapsed(key, false);
        const sourceSelection: SourceSelection = { kind: "source", source: ref };
        return (
          <div key={key}>
            <TreeRow
              depth={0}
              selected={selectionEquals(selection, sourceSelection)}
              onClick={() => onSelect(sourceSelection)}
              icon={
                isBrowser ? (
                  <Globe
                    strokeWidth={1.75}
                    className="h-4 w-4 shrink-0 text-text-secondary"
                  />
                ) : (
                  <Terminal
                    strokeWidth={1.75}
                    className="h-4 w-4 shrink-0 text-text-secondary"
                  />
                )
              }
              label={sourcePlatformLabel(source.platform, labels.browser)}
              count={source.count}
              badge={<WslBadge host={source.host} label={labels.wslBadge} />}
              collapsible
              expanded={!collapsed}
              onToggle={() => toggleCollapsed(key, false)}
            />
            {!collapsed
              ? source.projects.map((project) => {
                  const projectKey = `project:${project.projectKey}`;
                  const projectSelection: SourceSelection = {
                    kind: "project",
                    source: ref,
                    projectKey: project.projectKey,
                  };
                  const hasTopics = project.topics.length > 0;
                  const projectCollapsed = isCollapsed(projectKey, true);
                  return (
                    <div key={projectKey}>
                      <TreeRow
                        depth={1}
                        selected={selectionEquals(selection, projectSelection)}
                        onClick={() => onSelect(projectSelection)}
                        icon={
                          <Folder
                            strokeWidth={1.75}
                            className="h-4 w-4 shrink-0 text-text-tertiary"
                          />
                        }
                        label={project.label}
                        count={project.count}
                        collapsible={hasTopics}
                        expanded={!projectCollapsed}
                        onToggle={() => toggleCollapsed(projectKey, true)}
                        hoverCard={
                          project.state ? (
                            <ProjectStateHoverCard
                              state={project.state}
                              labels={labels}
                            />
                          ) : undefined
                        }
                      />
                      {/* Memory v2: L2 project brief entry under the project. */}
                      {onOpenBrief && project.state ? (
                        <div
                          role="treeitem"
                          className="my-0.5 flex w-full items-center rounded-lg transition-colors hover:bg-bg-surface-card"
                          style={{ paddingLeft: `${INDENT_BASE_PX + 2 * INDENT_STEP_PX}px` }}
                        >
                          <button
                            type="button"
                            onClick={() => onOpenBrief(project.projectKey)}
                            className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left"
                          >
                            <FileText
                              strokeWidth={1.75}
                              className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
                            />
                            <span className="min-w-0 flex-1 truncate text-vesti-sm font-sans text-text-secondary">
                              {labels.projectBrief ?? "项目简报"}
                            </span>
                          </button>
                        </div>
                      ) : null}
                      {hasTopics && !projectCollapsed
                        ? project.topics.map((topic) =>
                            renderTopic(topic, ref, project, 2),
                          )
                        : null}
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
      {/* Notes hang in the tree as their own source node. */}
      <div
        role="treeitem"
        aria-selected={notesActive}
        className={`my-0.5 flex w-full items-center rounded-lg transition-colors ${
          notesActive ? "bg-accent-primary-light" : "hover:bg-bg-surface-card"
        }`}
        style={{ paddingLeft: `${INDENT_BASE_PX}px` }}
      >
        <span className="mr-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <button
          type="button"
          onClick={onSelectNotes}
          aria-current={notesActive ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
        >
          <BookOpen
            strokeWidth={1.75}
            className="h-4 w-4 shrink-0 text-text-secondary"
          />
          <span
            className={`min-w-0 flex-1 truncate text-vesti-base font-sans ${
              notesActive ? "text-accent-primary" : "text-text-primary"
            }`}
          >
            {labels.notes}
          </span>
          <span className="shrink-0 text-vesti-sm font-sans text-text-tertiary">
            {notesCount}
          </span>
        </button>
      </div>
    </div>
  );
}
