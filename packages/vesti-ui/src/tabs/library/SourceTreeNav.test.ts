// Tests for the custom-folder group merged into the source-tree nav.
//
// The repo's test runner is node-only (no jsdom / testing-library), so the
// structural cases render the component to static markup via
// `react-dom/server`, and the interaction cases drive the hooks-free
// `SourceTreeFolderRows` directly (calling it as a function and invoking the
// onClick props on the returned element tree).

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveFolderGroupPlacement,
  SourceTreeFolderRows,
  SourceTreeNav,
  type FolderItem,
  type SourceTreeNavLabels,
} from "./SourceTreeNav";
import type { SourceTreeModel } from "./sourceTree";

const LABELS: SourceTreeNavLabels = {
  sectionLabel: "Sources",
  notes: "我的笔记",
  browser: "浏览器",
  wslBadge: "WSL",
  folders: "文件夹",
  createNewFolder: "创建新文件夹",
  newFolder: "新建文件夹",
  folderActions: "文件夹操作",
  rename: "重命名",
  delete: "删除",
};

const MODEL_WITH_BROWSER: SourceTreeModel = {
  sources: [
    {
      platform: "claude-code",
      host: "native",
      count: 1,
      projects: [
        { projectKey: "cli_aaa", label: "vesti-app", count: 1, topics: [] },
      ],
    },
    {
      platform: "browser",
      host: "browser",
      count: 2,
      projects: [
        {
          projectKey: "web:example.com",
          label: "example.com",
          count: 2,
          topics: [],
        },
      ],
    },
  ],
};

const MODEL_NO_BROWSER: SourceTreeModel = {
  sources: [MODEL_WITH_BROWSER.sources[0]],
};

const FOLDERS: FolderItem[] = [
  { name: "工作", isCustom: true, isTag: false },
  { name: "archive", isCustom: false, isTag: true },
];

function renderNav(
  props: Partial<Parameters<typeof SourceTreeNav>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(SourceTreeNav, {
      model: MODEL_WITH_BROWSER,
      selection: null,
      onSelect: () => {},
      notesCount: 0,
      notesActive: false,
      onSelectNotes: () => {},
      labels: LABELS,
      ...props,
    }),
  );
}

// ---- element-tree helpers (interaction cases) -------------------------------

const FAKE_EVENT = { stopPropagation: () => {}, preventDefault: () => {} };

/** Plain-text content of a host-element subtree; non-host components
 * (lucide icons) are opaque. */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    const element = node as { type?: unknown; props?: { children?: unknown } };
    if (typeof element.type === "string") {
      return textOf(element.props?.children);
    }
  }
  return "";
}

/** All <button> elements in a host-element subtree (does not descend into
 * non-host components). */
function collectButtons(node: unknown, into: unknown[] = []): unknown[] {
  if (!node || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, into);
    return into;
  }
  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (element.type === "button") into.push(element);
  if (typeof element.type === "string") {
    collectButtons(element.props?.children, into);
  }
  return into;
}

type FolderRowsProps = Parameters<typeof SourceTreeFolderRows>[0];

/** Expand SourceTreeFolderRows and its (internal) FolderRow children into
 * host-element trees: [folderRows, newFolderRow]. */
function expandFolderRows(props: FolderRowsProps): {
  folderRows: unknown[];
  newFolderRow: unknown;
} {
  const fragment = SourceTreeFolderRows(props) as unknown as {
    props: { children?: unknown };
  };
  const children = fragment.props.children as unknown[];
  const rowElements = (children[0] as unknown[]) ?? [];
  const folderRows = rowElements.map((rowElement) => {
    const element = rowElement as { type: (p: unknown) => unknown; props: unknown };
    return element.type(element.props);
  });
  return { folderRows, newFolderRow: children[1] ?? null };
}

function folderRowProps(
  overrides: Partial<FolderRowsProps> = {},
  events: string[] = [],
): FolderRowsProps {
  return {
    depth: 1,
    folders: FOLDERS,
    selectedFolder: null,
    openMenuName: null,
    onToggleMenu: (name) => events.push(`toggle:${name}`),
    onSelectFolder: (name) => events.push(`select:${name}`),
    onCreateFolder: () => events.push("create"),
    onRenameFolder: (folder) => events.push(`rename:${folder.name}`),
    onDeleteFolder: (folder) => events.push(`delete:${folder.name}`),
    labels: LABELS,
    ...overrides,
  };
}

// ---- placement logic ---------------------------------------------------------

describe("resolveFolderGroupPlacement", () => {
  it("puts the group inside the browser source node when it exists", () => {
    expect(
      resolveFolderGroupPlacement(MODEL_WITH_BROWSER, {
        folderCount: 2,
        canCreate: true,
      }),
    ).toBe("browser-source");
  });

  it("uses the browser source node even with no folders when create is available", () => {
    expect(
      resolveFolderGroupPlacement(MODEL_WITH_BROWSER, {
        folderCount: 0,
        canCreate: true,
      }),
    ).toBe("browser-source");
  });

  it("hides the group inside the browser node when empty and not creatable", () => {
    expect(
      resolveFolderGroupPlacement(MODEL_WITH_BROWSER, {
        folderCount: 0,
        canCreate: false,
      }),
    ).toBe("hidden");
  });

  it("falls back to a standalone browser group when no browser source exists", () => {
    expect(
      resolveFolderGroupPlacement(MODEL_NO_BROWSER, {
        folderCount: 2,
        canCreate: true,
      }),
    ).toBe("fallback");
  });

  it("keeps the create entry reachable via the fallback group with zero folders", () => {
    expect(
      resolveFolderGroupPlacement(MODEL_NO_BROWSER, {
        folderCount: 0,
        canCreate: true,
      }),
    ).toBe("fallback");
  });

  it("renders nothing without browser source, folders or create entry", () => {
    expect(
      resolveFolderGroupPlacement(MODEL_NO_BROWSER, {
        folderCount: 0,
        canCreate: false,
      }),
    ).toBe("hidden");
  });
});

// ---- structural rendering (SSR) ----------------------------------------------

describe("SourceTreeNav folder group rendering", () => {
  it("renders folder rows under the browser source, after its domain project rows", () => {
    const html = renderNav({
      folders: FOLDERS,
      onSelectFolder: () => {},
      onCreateFolder: () => {},
    });
    expect(html).toContain("工作");
    expect(html).toContain("archive");
    expect(html.indexOf("浏览器")).toBeLessThan(html.indexOf("example.com"));
    expect(html.indexOf("example.com")).toBeLessThan(html.indexOf("工作"));
    expect(html.indexOf("工作")).toBeLessThan(html.indexOf("archive"));
  });

  it("renders the quiet new-folder entry at the end of the group", () => {
    const html = renderNav({ folders: FOLDERS, onCreateFolder: () => {} });
    expect(html).toContain("新建文件夹");
    expect(html.indexOf("archive")).toBeLessThan(html.indexOf("新建文件夹"));
    expect(html).toContain('aria-label="创建新文件夹"');
  });

  it("marks the selected folder like any other selected tree row", () => {
    const html = renderNav({
      folders: FOLDERS,
      selectedFolder: "工作",
      onSelectFolder: () => {},
    });
    expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
    expect(html.indexOf('aria-current="page"')).toBeLessThan(
      html.indexOf("工作"),
    );
    expect(html).toContain("bg-accent-primary-light");
  });

  it("renders no folder rows when the folders prop is omitted", () => {
    const html = renderNav();
    expect(html).not.toContain("工作");
    expect(html).not.toContain("新建文件夹");
  });

  it("appends a fallback browser group at the end of the tree when no browser source exists", () => {
    const html = renderNav({
      model: MODEL_NO_BROWSER,
      folders: FOLDERS,
      onSelectFolder: () => {},
      onCreateFolder: () => {},
    });
    expect(html).toContain("浏览器");
    expect(html).toContain("工作");
    expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("浏览器"));
    expect(html.indexOf("浏览器")).toBeLessThan(html.indexOf("工作"));
    // The fallback group sits before the notes node at the end of the tree.
    expect(html.indexOf("archive")).toBeLessThan(html.indexOf("我的笔记"));
  });

  it("fallback group keeps the create entry reachable with zero folders", () => {
    const html = renderNav({
      model: MODEL_NO_BROWSER,
      onCreateFolder: () => {},
    });
    expect(html).toContain("浏览器");
    expect(html).toContain("新建文件夹");
  });

  it("renders no fallback group without folders and without a create entry", () => {
    const html = renderNav({ model: MODEL_NO_BROWSER });
    expect(html).not.toContain("浏览器");
    expect(html).not.toContain("新建文件夹");
  });
});

// ---- interaction (direct drive of the hooks-free rows) ------------------------

describe("SourceTreeFolderRows interaction", () => {
  it("clicking a folder row fires onSelectFolder with the folder name", () => {
    const events: string[] = [];
    const { folderRows } = expandFolderRows(folderRowProps({}, events));
    const buttons = collectButtons(folderRows[0]);
    const selectButton = buttons.find((button) =>
      textOf(button).includes("工作"),
    ) as { props: { onClick: (e: unknown) => void } };
    expect(selectButton).toBeDefined();
    selectButton.props.onClick(FAKE_EVENT);
    expect(events).toEqual(["select:工作"]);
  });

  it("marks the selected folder row with aria-current", () => {
    const { folderRows } = expandFolderRows(
      folderRowProps({ selectedFolder: "archive" }),
    );
    const buttons = collectButtons(folderRows[1]) as Array<{
      props: Record<string, unknown>;
    }>;
    const selectButton = buttons.find((button) =>
      textOf(button).includes("archive"),
    );
    expect(selectButton?.props["aria-current"]).toBe("page");
  });

  it("the hover menu button toggles the menu for that folder", () => {
    const events: string[] = [];
    const { folderRows } = expandFolderRows(folderRowProps({}, events));
    const buttons = collectButtons(folderRows[0]) as Array<{
      props: Record<string, unknown>;
    }>;
    const menuButton = buttons.find(
      (button) => button.props["aria-label"] === "文件夹操作: 工作",
    );
    expect(menuButton).toBeDefined();
    (menuButton!.props.onClick as (e: unknown) => void)(FAKE_EVENT);
    expect(events).toEqual(["toggle:工作"]);
  });

  it("does not render rename/delete while the menu is closed", () => {
    const { folderRows } = expandFolderRows(folderRowProps());
    const buttons = collectButtons(folderRows[0]);
    expect(
      buttons.find((button) => textOf(button).includes("重命名")),
    ).toBeUndefined();
    expect(
      buttons.find((button) => textOf(button).includes("删除")),
    ).toBeUndefined();
  });

  it("open menu fires onRenameFolder / onDeleteFolder with the folder", () => {
    const events: string[] = [];
    const { folderRows } = expandFolderRows(
      folderRowProps({ openMenuName: "工作" }, events),
    );
    const buttons = collectButtons(folderRows[0]) as Array<{
      props: { onClick?: (e: unknown) => void };
    }>;
    const renameButton = buttons.find((button) =>
      textOf(button).includes("重命名"),
    );
    const deleteButton = buttons.find((button) =>
      textOf(button).includes("删除"),
    );
    expect(renameButton).toBeDefined();
    expect(deleteButton).toBeDefined();
    renameButton!.props.onClick?.(FAKE_EVENT);
    deleteButton!.props.onClick?.(FAKE_EVENT);
    expect(events).toEqual(["rename:工作", "delete:工作"]);
  });

  it("the new-folder entry fires onCreateFolder", () => {
    const events: string[] = [];
    const { newFolderRow } = expandFolderRows(folderRowProps({}, events));
    const buttons = collectButtons(newFolderRow) as Array<{
      props: Record<string, unknown>;
    }>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props["aria-label"]).toBe("创建新文件夹");
    expect(textOf(newFolderRow)).toContain("新建文件夹");
    (buttons[0].props.onClick as () => void)();
    expect(events).toEqual(["create"]);
  });

  it("renders no new-folder entry without onCreateFolder", () => {
    const { newFolderRow } = expandFolderRows(
      folderRowProps({ onCreateFolder: undefined }),
    );
    expect(newFolderRow).toBeNull();
  });
});
