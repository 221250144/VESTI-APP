// Source-tree navigation (P2b) — left-nav tree of
// source (terminal platforms / browser, native vs WSL) → project → topic,
// plus a "notes" source node that switches the list pane to the notes view.
//
// Pure presentational component: the aggregated model comes from
// `buildSourceTreeModel` (./sourceTree) and the selection is owned by the
// library tab so it can drive the conversation-list filter.

import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  FileText,
  Folder,
  Hash,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
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
import { InfoTip } from "../../components/InfoTip";

/** Custom-folder row model, shared with the library tab (single definition
 * so the two sides cannot drift). */
export type FolderItem = { name: string; isCustom: boolean; isTag: boolean };

export type SourceTreeNavLabels = {
  sectionLabel: string;
  notes: string;
  browser: string;
  wslBadge: string;
  /** Memory v2 */
  projectBrief?: string;
  activeFiles?: string;
  openQuestions?: string;
  /** Custom folders merged into the browser source node. */
  folders?: string;
  createNewFolder?: string;
  newFolder?: string;
  folderActions?: string;
  rename?: string;
  delete?: string;
  /** Hover intro for the 来源 section header (label explanation system). */
  sectionTip?: string;
  /** Hover intro for the 我的笔记 row. */
  notesTip?: string;
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
  /** Custom folders rendered under the browser source node (or in a fallback
   * "browser" group at the end of the tree when no browser source exists). */
  folders?: FolderItem[];
  selectedFolder?: string | null;
  onSelectFolder?: (name: string) => void;
  onCreateFolder?: () => void;
  onRenameFolder?: (folder: FolderItem) => void;
  onDeleteFolder?: (folder: FolderItem) => void;
};

/** Where the custom-folder group lives: inside the browser source node when
 * the tree has one, otherwise as a fallback "browser" group appended after
 * the sources. Folders are user-owned, so the group (and the create entry)
 * must stay reachable even with no browser sessions or no folders yet. */
export type FolderGroupPlacement = "browser-source" | "fallback" | "hidden";

export function resolveFolderGroupPlacement(
  model: SourceTreeModel,
  opts: { folderCount: number; canCreate: boolean },
): FolderGroupPlacement {
  if (opts.folderCount === 0 && !opts.canCreate) return "hidden";
  const hasBrowserSource = model.sources.some(
    (source) => source.platform === BROWSER_SOURCE.platform,
  );
  return hasBrowserSource ? "browser-source" : "fallback";
}

function sameRef(a: SourceRef, b: SourceRef): boolean {
  return a.platform === b.platform && a.host === b.host;
}

function selectionEquals(
  a: SourceSelection | null,
  b: SourceSelection,
): boolean {
  if (!a) return false;
  // A platform-wide selection (home-dashboard deep link) owns no single tree
  // node; highlight every source node of that platform instead.
  if (a.kind === "platform") {
    return b.kind === "source" && b.source.platform === a.platform;
  }
  if (b.kind === "platform") return false;
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

/** One custom-folder row: same row chrome as the other tree rows (indent,
 * selection highlight, aria-current) plus the hover "..." menu with
 * rename/delete, mirroring the old standalone folders section. */
function FolderRow({
  depth,
  folder,
  selected,
  menuOpen,
  onSelect,
  onToggleMenu,
  onRename,
  onDelete,
  labels,
}: {
  depth: number;
  folder: FolderItem;
  selected: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onRename?: (folder: FolderItem) => void;
  onDelete?: (folder: FolderItem) => void;
  labels: SourceTreeNavLabels;
}) {
  const folderActionsLabel = labels.folderActions ?? "Folder actions";
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      className={`group relative flex w-full items-center rounded-lg transition-colors my-0.5 ${
        selected ? "bg-accent-primary-light" : "hover:bg-bg-surface-card"
      }`}
      style={{ paddingLeft: `${INDENT_BASE_PX + depth * INDENT_STEP_PX}px` }}
    >
      <span className="mr-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
      >
        <Folder
          strokeWidth={1.75}
          className="h-4 w-4 shrink-0 text-text-tertiary"
        />
        <span
          className={`min-w-0 flex-1 truncate text-vesti-base font-sans ${
            selected ? "text-accent-primary" : "text-text-primary"
          }`}
        >
          {folder.name}
        </span>
      </button>
      {onRename || onDelete ? (
        <div className="mr-1 flex shrink-0 items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu();
            }}
            className="w-5 h-5 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-bg-surface-card"
            title={folderActionsLabel}
            aria-label={`${folderActionsLabel}: ${folder.name}`}
          >
            <MoreHorizontal strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : null}
      {menuOpen && (onRename || onDelete) ? (
        <div
          className="absolute right-2 top-8 z-30 w-44 rounded-md border border-border-subtle bg-bg-primary shadow-[0_8px_24px_rgba(0,0,0,0.08)] py-1"
          onClick={(event) => event.stopPropagation()}
        >
          {onRename ? (
            <button
              type="button"
              onClick={() => onRename(folder)}
              className="w-full flex items-center gap-2 px-3 py-2 text-[13px] font-sans text-text-primary hover:bg-bg-surface-card transition-colors"
            >
              <Pencil strokeWidth={1.5} className="w-4 h-4" />
              <span>{labels.rename ?? "Rename"}</span>
            </button>
          ) : null}
          {onRename && onDelete ? (
            <div className="my-1 h-px bg-border-subtle" />
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(folder)}
              className="w-full flex items-center gap-2 px-3 py-2 text-[13px] font-sans text-danger hover:bg-bg-surface-card transition-colors"
            >
              <Trash2 strokeWidth={1.5} className="w-4 h-4" />
              <span>{labels.delete ?? "Delete"}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Custom-folder rows plus a quiet "new folder" entry at the end of the
 * group. Hooks-free on purpose so tests can drive it directly. */
export function SourceTreeFolderRows({
  depth,
  folders,
  selectedFolder,
  openMenuName,
  onToggleMenu,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  labels,
}: {
  depth: number;
  folders: FolderItem[];
  selectedFolder?: string | null;
  openMenuName?: string | null;
  onToggleMenu?: (name: string) => void;
  onSelectFolder?: (name: string) => void;
  onCreateFolder?: () => void;
  onRenameFolder?: (folder: FolderItem) => void;
  onDeleteFolder?: (folder: FolderItem) => void;
  labels: SourceTreeNavLabels;
}) {
  return (
    <>
      {folders.map((folder) => (
        <FolderRow
          key={folder.name}
          depth={depth}
          folder={folder}
          selected={selectedFolder === folder.name}
          menuOpen={openMenuName === folder.name}
          onSelect={() => onSelectFolder?.(folder.name)}
          onToggleMenu={() => onToggleMenu?.(folder.name)}
          onRename={onRenameFolder}
          onDelete={onDeleteFolder}
          labels={labels}
        />
      ))}
      {onCreateFolder ? (
        <div
          role="treeitem"
          className="my-0.5 flex w-full items-center rounded-lg transition-colors hover:bg-bg-surface-card"
          style={{
            paddingLeft: `${INDENT_BASE_PX + depth * INDENT_STEP_PX}px`,
          }}
        >
          <span className="mr-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <button
            type="button"
            onClick={onCreateFolder}
            aria-label={labels.createNewFolder ?? "Create new folder"}
            title={labels.newFolder ?? "New folder"}
            className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left"
          >
            <Plus
              strokeWidth={1.75}
              className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
            />
            <span className="min-w-0 flex-1 truncate text-vesti-sm font-sans text-text-tertiary">
              {labels.newFolder ?? "New folder"}
            </span>
          </button>
        </div>
      ) : null}
    </>
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
  folders,
  selectedFolder,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
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

  // Folder action menu (rename/delete) is component-local now; a
  // document-level click closes it, same contract the library tab used when
  // the folders were a standalone section.
  const [openFolderMenuName, setOpenFolderMenuName] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!openFolderMenuName) return;
    const handleClick = () => setOpenFolderMenuName(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [openFolderMenuName]);

  const folderList = folders ?? [];
  const folderPlacement = resolveFolderGroupPlacement(model, {
    folderCount: folderList.length,
    canCreate: Boolean(onCreateFolder),
  });
  const FOLDER_FALLBACK_KEY = "source:folder-fallback";

  const renderFolderRows = (depth: number) => (
    <SourceTreeFolderRows
      depth={depth}
      folders={folderList}
      selectedFolder={selectedFolder}
      openMenuName={openFolderMenuName}
      onToggleMenu={(name) =>
        setOpenFolderMenuName((prev) => (prev === name ? null : name))
      }
      onSelectFolder={onSelectFolder}
      onCreateFolder={onCreateFolder}
      onRenameFolder={
        onRenameFolder
          ? (folder) => {
              onRenameFolder(folder);
              setOpenFolderMenuName(null);
            }
          : undefined
      }
      onDeleteFolder={
        onDeleteFolder
          ? (folder) => {
              onDeleteFolder(folder);
              setOpenFolderMenuName(null);
            }
          : undefined
      }
      labels={labels}
    />
  );

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
          {labels.sectionTip ? (
            <InfoTip title={labels.sectionLabel} description={labels.sectionTip}>
              <span className="text-[10px] font-sans font-semibold uppercase tracking-wider text-text-tertiary">
                {labels.sectionLabel}
              </span>
            </InfoTip>
          ) : (
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider text-text-tertiary">
              {labels.sectionLabel}
            </span>
          )}
        </div>
      ) : null}
      {model.sources.map((source) => {
        const ref: SourceRef = { platform: source.platform, host: source.host };
        const key = `source:${source.platform}|${source.host}`;
        const collapsed = isCollapsed(key, false);
        const sourceSelection: SourceSelection = { kind: "source", source: ref };
        const isBrowserSource = source.platform === BROWSER_SOURCE.platform;
        return (
          <div key={key}>
            <TreeRow
              depth={0}
              selected={selectionEquals(selection, sourceSelection)}
              onClick={() => onSelect(sourceSelection)}
              icon={null}
              label={sourcePlatformLabel(source.platform, labels.browser)}
              count={source.count}
              badge={<WslBadge host={source.host} label={labels.wslBadge} />}
              collapsible
              expanded={!collapsed}
              onToggle={() => toggleCollapsed(key, false)}
            />
            {!collapsed ? (
              <>
                {source.projects.map((project) => {
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
                })}
                {/* Custom folders merge into the browser source node, right
                    after its domain project rows. */}
                {folderPlacement === "browser-source" && isBrowserSource
                  ? renderFolderRows(1)
                  : null}
              </>
            ) : null}
          </div>
        );
      })}
      {/* No browser sessions yet: folders still need a home — a light
          fallback "browser" group (default expanded) carries them, plus the
          create entry. */}
      {folderPlacement === "fallback" ? (
        <div>
          <TreeRow
            depth={0}
            selected={false}
            onClick={() => toggleCollapsed(FOLDER_FALLBACK_KEY, false)}
            icon={null}
            label={labels.browser}
            count={folderList.length}
            collapsible
            expanded={!isCollapsed(FOLDER_FALLBACK_KEY, false)}
            onToggle={() => toggleCollapsed(FOLDER_FALLBACK_KEY, false)}
          />
          {!isCollapsed(FOLDER_FALLBACK_KEY, false)
            ? renderFolderRows(1)
            : null}
        </div>
      ) : null}
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
        {labels.notesTip ? (
          <InfoTip title={labels.notes} description={labels.notesTip} className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onSelectNotes}
              aria-current={notesActive ? "page" : undefined}
              className="flex w-full min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
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
          </InfoTip>
        ) : (
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
        )}
      </div>
    </div>
  );
}
