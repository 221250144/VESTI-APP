import { useEffect, useMemo, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, StateField, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import createDOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";

type MarkdownNoteEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSaveRequest?: () => void | Promise<void>;
  placeholderText?: string;
  minHeight?: number;
  className?: string;
  ariaLabel?: string;
};

type TextRange = {
  from: number;
  to: number;
};

type MathRange = TextRange & {
  tex: string;
  display: boolean;
};

type TaskRange = TextRange & {
  checked: boolean;
};

function createTaskToggleButton(task: TaskRange): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-note-task-toggle";
  button.dataset.taskFrom = String(task.from);
  button.dataset.taskTo = String(task.to);
  button.dataset.checked = task.checked ? "true" : "false";
  button.setAttribute(
    "aria-label",
    task.checked ? "Mark task incomplete" : "Mark task complete",
  );
  button.setAttribute("aria-pressed", task.checked ? "true" : "false");

  const box = document.createElement("span");
  box.className = "cm-note-task-toggle-box";
  box.setAttribute("aria-hidden", "true");

  const check = document.createElement("span");
  check.className = "cm-note-task-toggle-check";
  check.textContent = "✓";
  box.appendChild(check);

  button.appendChild(box);

  return button;
}

class RenderedMarkdownBlockWidget extends WidgetType {
  constructor(
    private readonly html: string,
    private readonly tasks: TaskRange[],
  ) {
    super();
  }

  eq(other: RenderedMarkdownBlockWidget) {
    return (
      other.html === this.html &&
      JSON.stringify(other.tasks) === JSON.stringify(this.tasks)
    );
  }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-note-rendered-block";
    wrapper.innerHTML = this.html;

    const checkboxes = Array.from(
      wrapper.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    checkboxes.forEach((input, index) => {
      const task = this.tasks[index];
      if (!task) {
        return;
      }

      const button = createTaskToggleButton(task);

      const listItem = input.closest("li");
      if (listItem) {
        listItem.classList.add("cm-note-task-list-item");
        if (task.checked) {
          listItem.classList.add("cm-note-task-list-item-checked");
        }
        listItem.parentElement?.classList.add("cm-note-task-list");
      }

      input.replaceWith(button);
    });

    return wrapper;
  }

  ignoreEvent() {
    return false;
  }
}

class LinkWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly href: string,
  ) {
    super();
  }

  eq(other: LinkWidget) {
    return other.label === this.label && other.href === this.href;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-note-link-widget";
    element.textContent = this.label || this.href;
    element.setAttribute("title", this.href);
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

class TaskMarkerWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  eq(other: TaskMarkerWidget) {
    return (
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  toDOM() {
    const element = createTaskToggleButton({
      from: this.from,
      to: this.to,
      checked: this.checked,
    });
    element.classList.add("cm-note-task-widget");
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

class MathWidget extends WidgetType {
  constructor(
    private readonly tex: string,
    private readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return (
      other.tex === this.tex &&
      other.display === this.display
    );
  }

  toDOM() {
    const wrapper = document.createElement(this.display ? "div" : "span");
    wrapper.className = this.display
      ? "cm-note-math-block"
      : "cm-note-math-inline";

    try {
      wrapper.innerHTML = katex.renderToString(this.tex, {
        throwOnError: false,
        displayMode: this.display,
      });
    } catch {
      wrapper.textContent = this.tex;
    }

    return wrapper;
  }

  ignoreEvent() {
    return false;
  }
}

type PendingDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

function selectionHeadTouchesRange(state: EditorState, from: number, to: number): boolean {
  const { head } = state.selection.main;
  return head >= from && head <= to;
}

function lineTouchesSelection(state: EditorState, from: number, to: number): boolean {
  const line = state.doc.lineAt(state.selection.main.head);
  return from <= line.to && to >= line.from;
}

function normalizeHeadingLevel(nodeName: string): string | null {
  if (nodeName.startsWith("ATXHeading")) {
    return nodeName.replace("ATXHeading", "") || "1";
  }

  if (nodeName === "SetextHeading1") return "1";
  if (nodeName === "SetextHeading2") return "2";
  return null;
}

function getFrontmatterRange(doc: string): TextRange | null {
  const match = doc.match(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/);
  if (!match) {
    return null;
  }

  return {
    from: 0,
    to: match[0].length,
  };
}

function rangeIsWithin(rawRanges: TextRange[], from: number, to: number): boolean {
  return rawRanges.some((range) => from >= range.from && to <= range.to);
}

function rangeIntersects(rawRanges: TextRange[], from: number, to: number): boolean {
  return rawRanges.some((range) => from < range.to && to > range.from);
}

function parseMarkdownLink(source: string): { label: string; href: string } | null {
  const match = source.match(/^\[([^\]]+)\]\(([^)]+)\)$/s);
  if (!match) return null;

  const label = match[1]?.trim() ?? "";
  const href = match[2]?.trim() ?? "";
  if (!href) return null;

  return {
    label: label || href,
    href,
  };
}

function extractTaskRanges(source: string, baseFrom: number): TaskRange[] {
  const ranges: TaskRange[] = [];
  const lines = source.split("\n");
  let offset = 0;

  for (const line of lines) {
    const taskMatch = line.match(/^(\s*[-*+]\s+)(\[[ xX]\])\s+/);
    if (taskMatch) {
      const prefixLength = taskMatch[1]?.length ?? 0;
      const marker = taskMatch[2] ?? "[ ]";
      const from = baseFrom + offset + prefixLength;
      ranges.push({
        from,
        to: from + marker.length,
        checked: /\[[xX]\]/.test(marker),
      });
    }

    offset += line.length + 1;
  }

  return ranges;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  let cursor = index - 1;

  while (cursor >= 0 && text[cursor] === "\\") {
    slashCount += 1;
    cursor -= 1;
  }

  return slashCount % 2 === 1;
}

function renderMarkdownBlockHtml(source: string): string {
  try {
    const rendered = marked.parse(source, {
      async: false,
      breaks: true,
      gfm: true,
    });

    if (typeof window === "undefined") {
      return rendered;
    }

    try {
      return createDOMPurify(window).sanitize(rendered, {
        USE_PROFILES: { html: true },
      });
    } catch (error) {
      console.error("[note-editor] Failed to sanitize rendered markdown preview", error);
      return rendered;
    }
  } catch (error) {
    console.error("[note-editor] Failed to render markdown preview", error);
    return "";
  }
}

function isRenderableBlockNode(nodeName: string): boolean {
  return (
    nodeName === "Paragraph" ||
    nodeName === "BulletList" ||
    nodeName === "OrderedList" ||
    nodeName === "Blockquote" ||
    nodeName === "Table" ||
    nodeName === "HorizontalRule" ||
    nodeName.startsWith("ATXHeading") ||
    nodeName.startsWith("SetextHeading")
  );
}

function findBlockMathRanges(state: EditorState, rawRanges: TextRange[]): MathRange[] {
  const ranges: MathRange[] = [];
  let lineNumber = 1;

  while (lineNumber <= state.doc.lines) {
    const line = state.doc.line(lineNumber);
    if (rangeIntersects(rawRanges, line.from, line.to)) {
      lineNumber += 1;
      continue;
    }

    if (!/^\s*\$\$\s*$/.test(line.text)) {
      lineNumber += 1;
      continue;
    }

    let closingLineNumber = lineNumber + 1;
    while (closingLineNumber <= state.doc.lines) {
      const candidate = state.doc.line(closingLineNumber);
      if (rangeIntersects(rawRanges, candidate.from, candidate.to)) {
        break;
      }

      if (/^\s*\$\$\s*$/.test(candidate.text)) {
        const texLines: string[] = [];
        for (let inner = lineNumber + 1; inner < closingLineNumber; inner += 1) {
          texLines.push(state.doc.line(inner).text);
        }

        const tex = texLines.join("\n").trim();
        if (tex) {
          ranges.push({
            from: line.from,
            to: candidate.to,
            tex,
            display: true,
          });
        }

        lineNumber = closingLineNumber + 1;
        break;
      }

      closingLineNumber += 1;
    }

    if (closingLineNumber > state.doc.lines) {
      lineNumber += 1;
    }
  }

  return ranges;
}

function findInlineMathRanges(
  state: EditorState,
  rawRanges: TextRange[],
  blockMathRanges: MathRange[],
): MathRange[] {
  const ranges: MathRange[] = [];
  const blockedRanges = [...rawRanges, ...blockMathRanges];

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (rangeIntersects(blockedRanges, line.from, line.to)) {
      continue;
    }

    const text = line.text;
    let cursor = 0;
    while (cursor < text.length) {
      const openIndex = text.indexOf("$", cursor);
      if (openIndex < 0) break;

      if (text[openIndex + 1] === "$" || isEscaped(text, openIndex)) {
        cursor = openIndex + 1;
        continue;
      }

      let closeIndex = openIndex + 1;
      while (closeIndex < text.length) {
        const next = text.indexOf("$", closeIndex);
        if (next < 0) {
          closeIndex = -1;
          break;
        }

        if (text[next + 1] === "$" || isEscaped(text, next)) {
          closeIndex = next + 1;
          continue;
        }

        closeIndex = next;
        break;
      }

      if (closeIndex < 0) {
        break;
      }

      const tex = text.slice(openIndex + 1, closeIndex).trim();
      if (tex) {
        ranges.push({
          from: line.from + openIndex,
          to: line.from + closeIndex + 1,
          tex,
          display: false,
        });
      }

      cursor = closeIndex + 1;
    }
  }

  return ranges;
}

function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  const decorations: PendingDecoration[] = [];
  const doc = state.doc.toString();
  const tree = syntaxTree(state);
  const frontmatterRange = getFrontmatterRange(doc);
  const rawRanges: TextRange[] = [];
  const renderedRanges: TextRange[] = [];
  const lineClassNames = new Map<number, Set<string>>();

  const addLineClass = (position: number, className: string) => {
    const existing = lineClassNames.get(position) ?? new Set<string>();
    existing.add(className);
    lineClassNames.set(position, existing);
  };

  if (frontmatterRange) {
    rawRanges.push(frontmatterRange);
    let cursor = frontmatterRange.from;
    while (cursor <= frontmatterRange.to) {
      const line = state.doc.lineAt(cursor);
      addLineClass(line.from, "cm-note-frontmatter-line");
      cursor = line.to + 1;
    }
  }

  tree.iterate({
    enter(node) {
      if (node.name !== "FencedCode") {
        return;
      }

      rawRanges.push({ from: node.from, to: node.to });
      let cursor = node.from;
      while (cursor <= node.to) {
        const line = state.doc.lineAt(cursor);
        addLineClass(line.from, "cm-note-code-line");
        if (line.from === node.from) {
          addLineClass(line.from, "cm-note-code-line-start");
        }
        if (line.to === node.to) {
          addLineClass(line.from, "cm-note-code-line-end");
        }
        cursor = line.to + 1;
      }
      return false;
    },
  });

  const blockMathRanges = findBlockMathRanges(state, rawRanges);
  const inlineMathRanges = findInlineMathRanges(state, rawRanges, blockMathRanges);

  const cursor = tree.cursor();
  if (cursor.firstChild()) {
    do {
      if (!isRenderableBlockNode(cursor.name)) {
        continue;
      }

      const blockFrom = cursor.from;
      const blockTo = cursor.to;
      if (
        rangeIntersects(rawRanges, blockFrom, blockTo) ||
        selectionHeadTouchesRange(state, blockFrom, blockTo)
      ) {
        continue;
      }

      const source = doc.slice(blockFrom, blockTo).trim();
      if (!source) {
        continue;
      }

      const html = renderMarkdownBlockHtml(source);
      if (!html.trim()) {
        continue;
      }

      const tasks = extractTaskRanges(source, blockFrom);
      renderedRanges.push({ from: blockFrom, to: blockTo });
      decorations.push({
        from: blockFrom,
        to: blockTo,
        decoration: Decoration.replace({
          widget: new RenderedMarkdownBlockWidget(html, tasks),
          block: true,
        }),
      });
    } while (cursor.nextSibling());
  }

  tree.iterate({
    enter(node) {
      if (
        rangeIsWithin(rawRanges, node.from, node.to) ||
        rangeIsWithin(renderedRanges, node.from, node.to)
      ) {
        return false;
      }

      const isNodeActive = selectionHeadTouchesRange(state, node.from, node.to);
      const isLineActive = lineTouchesSelection(state, node.from, node.to);
      const headingLevel = normalizeHeadingLevel(node.name);

      if (headingLevel) {
        const line = state.doc.lineAt(node.from);
        addLineClass(line.from, "cm-note-heading");
        addLineClass(line.from, `cm-note-heading-${headingLevel}`);
      }

      if (node.name === "HeaderMark" && !isLineActive) {
        decorations.push({ from: node.from, to: node.to, decoration: Decoration.replace({}) });
      }

      if (node.name === "StrongEmphasis") {
        decorations.push({
          from: node.from,
          to: node.to,
          decoration: Decoration.mark({ class: "cm-note-strong" }),
        });
      }

      if (node.name === "Emphasis") {
        decorations.push({
          from: node.from,
          to: node.to,
          decoration: Decoration.mark({ class: "cm-note-emphasis" }),
        });
      }

      if (node.name === "EmphasisMark" && !isNodeActive) {
        decorations.push({ from: node.from, to: node.to, decoration: Decoration.replace({}) });
      }

      if (node.name === "InlineCode") {
        decorations.push({
          from: node.from,
          to: node.to,
          decoration: Decoration.mark({ class: "cm-note-inline-code" }),
        });
      }

      if (node.name === "CodeMark" && !isNodeActive) {
        decorations.push({ from: node.from, to: node.to, decoration: Decoration.replace({}) });
      }

      if (node.name === "Link") {
        if (isNodeActive) {
          return;
        }

        const parsed = parseMarkdownLink(doc.slice(node.from, node.to));
        if (!parsed) {
          return;
        }

        decorations.push({
          from: node.from,
          to: node.to,
          decoration: Decoration.replace({
            widget: new LinkWidget(parsed.label, parsed.href),
          }),
        });
        return false;
      }

      if (node.name === "CodeInfo") {
        decorations.push({
          from: node.from,
          to: node.to,
          decoration: Decoration.mark({ class: "cm-note-code-info" }),
        });
      }
    },
  });

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (
      rangeIntersects(rawRanges, line.from, line.to) ||
      rangeIntersects(renderedRanges, line.from, line.to)
    ) {
      continue;
    }

    const taskMatch = line.text.match(/^(\s*)([-*+]\s+)(\[[ xX]\])\s+/);
    if (!taskMatch || lineTouchesSelection(state, line.from, line.to)) {
      continue;
    }

    const indentLength = taskMatch[1]?.length ?? 0;
    const markerLength = (taskMatch[2]?.length ?? 0) + (taskMatch[3]?.length ?? 0) + 1;
    const taskPrefixLength = (taskMatch[1]?.length ?? 0) + (taskMatch[2]?.length ?? 0);
    const taskTokenLength = taskMatch[3]?.length ?? 3;
    const checked = /\[[xX]\]/.test(taskMatch[3] ?? "");

    decorations.push({
      from: line.from + indentLength,
      to: line.from + indentLength + markerLength,
      decoration: Decoration.replace({
        widget: new TaskMarkerWidget(
          checked,
          line.from + taskPrefixLength,
          line.from + taskPrefixLength + taskTokenLength,
        ),
      }),
    });

    if (checked) {
      decorations.push({
        from: line.from + indentLength + markerLength,
        to: line.to,
        decoration: Decoration.mark({ class: "cm-note-task-content-checked" }),
      });
    }
  }

  for (const range of blockMathRanges) {
    if (selectionHeadTouchesRange(state, range.from, range.to)) {
      continue;
    }

    decorations.push({
      from: range.from,
      to: range.to,
      decoration: Decoration.replace({
        widget: new MathWidget(range.tex, true),
        block: true,
      }),
    });
  }

  for (const range of inlineMathRanges) {
    if (selectionHeadTouchesRange(state, range.from, range.to)) {
      continue;
    }

    decorations.push({
      from: range.from,
      to: range.to,
      decoration: Decoration.replace({
        widget: new MathWidget(range.tex, false),
      }),
    });
  }

  for (const [lineFrom, classNames] of lineClassNames.entries()) {
    decorations.push({
      from: lineFrom,
      to: lineFrom,
      decoration: Decoration.line({
        attributes: { class: [...classNames].join(" ") },
      }),
    });
  }

  decorations.sort((left, right) => {
    if (left.from !== right.from) {
      return left.from - right.from;
    }

    const leftSide = (left.decoration as Decoration & { startSide?: number }).startSide ?? 0;
    const rightSide = (right.decoration as Decoration & { startSide?: number }).startSide ?? 0;
    if (leftSide !== rightSide) {
      return leftSide - rightSide;
    }

    return left.to - right.to;
  });

  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of decorations) {
    builder.add(entry.from, entry.to, entry.decoration);
  }

  return builder.finish();
}

const livePreviewDecorations = StateField.define<DecorationSet>({
  create(state) {
    return buildLivePreviewDecorations(state);
  },
  update(decorations, transaction) {
    if (!transaction.docChanged && !transaction.selection) {
      return decorations;
    }

    return buildLivePreviewDecorations(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function resolveTaskToggleTarget(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  const button = target.closest<HTMLButtonElement>(".cm-note-task-toggle");
  return button ?? null;
}

const taskToggleHandlers = EditorView.domEventHandlers({
  mousedown(event) {
    const toggle = resolveTaskToggleTarget(event.target);
    if (!toggle) {
      return false;
    }

    event.preventDefault();
    return true;
  },
  click(event, view) {
    const toggle = resolveTaskToggleTarget(event.target);
    if (!toggle) {
      return false;
    }

    const from = Number(toggle.dataset.taskFrom);
    const to = Number(toggle.dataset.taskTo);
    const checked = toggle.dataset.checked === "true";
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return true;
    }

    event.preventDefault();
    view.dispatch({
      changes: {
        from,
        to,
        insert: checked ? "[ ]" : "[x]",
      },
      userEvent: "input",
    });
    return true;
  },
});

function buildEditorTheme(minHeight: number): Extension {
  return EditorView.theme({
    "&": {
      width: "100%",
      backgroundColor: "transparent",
      color: "hsl(var(--text-primary))",
      fontSize: "15px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      overflow: "auto",
      maxWidth: "100%",
      fontFamily: "var(--font-ui)",
      lineHeight: "1.85",
    },
    ".cm-content": {
      minHeight: `${minHeight}px`,
      maxWidth: "100%",
      padding: "1.25rem 1.35rem 1.5rem",
      caretColor: "hsl(var(--text-primary))",
    },
    ".cm-line": {
      padding: "0",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      wordBreak: "break-word",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "hsl(var(--text-primary))",
    },
    ".cm-selectionBackground": {
      backgroundColor: "hsl(var(--accent-primary-light)) !important",
    },
    ".cm-placeholder": {
      color: "hsl(var(--text-tertiary))",
    },
    ".cm-note-heading": {
      color: "hsl(var(--text-primary))",
      fontFamily: "var(--font-serif)",
      fontWeight: "500",
      letterSpacing: "-0.01em",
    },
    ".cm-note-heading-1": {
      fontSize: "1.75rem",
      lineHeight: "2.35rem",
    },
    ".cm-note-heading-2": {
      fontSize: "1.45rem",
      lineHeight: "2rem",
    },
    ".cm-note-heading-3, .cm-note-heading-4, .cm-note-heading-5, .cm-note-heading-6": {
      fontSize: "1.1rem",
      lineHeight: "1.8rem",
    },
    ".cm-note-strong": {
      fontWeight: "700",
      color: "hsl(var(--text-primary))",
    },
    ".cm-note-emphasis": {
      fontStyle: "italic",
      color: "hsl(var(--text-primary))",
    },
    ".cm-note-inline-code": {
      borderRadius: "0.45rem",
      backgroundColor: "hsl(var(--bg-surface-card))",
      color: "hsl(var(--text-primary))",
      fontFamily: "var(--font-mono)",
      padding: "0 0.2rem",
    },
    ".cm-note-link-widget": {
      color: "hsl(var(--accent-primary))",
      textDecoration: "underline",
      textDecorationColor: "hsl(var(--accent-primary-muted))",
      textUnderlineOffset: "0.16em",
      cursor: "text",
    },
    ".cm-note-rendered-block": {
      color: "hsl(var(--text-primary))",
      fontFamily: "var(--font-ui)",
      lineHeight: "1.85",
      padding: "0.05rem 0",
      whiteSpace: "normal",
    },
    ".cm-note-rendered-block > *:first-child": {
      marginTop: "0",
    },
    ".cm-note-rendered-block > *:last-child": {
      marginBottom: "0",
    },
    ".cm-note-rendered-block h1, .cm-note-rendered-block h2, .cm-note-rendered-block h3, .cm-note-rendered-block h4, .cm-note-rendered-block h5, .cm-note-rendered-block h6": {
      color: "hsl(var(--text-primary))",
      fontFamily: "var(--font-serif)",
      fontWeight: "500",
      letterSpacing: "-0.01em",
      margin: "0.2rem 0 0.45rem",
    },
    ".cm-note-rendered-block h1": {
      fontSize: "1.75rem",
      lineHeight: "2.35rem",
    },
    ".cm-note-rendered-block h2": {
      fontSize: "1.45rem",
      lineHeight: "2rem",
    },
    ".cm-note-rendered-block h3, .cm-note-rendered-block h4, .cm-note-rendered-block h5, .cm-note-rendered-block h6": {
      fontSize: "1.1rem",
      lineHeight: "1.8rem",
    },
    ".cm-note-rendered-block p": {
      margin: "0.2rem 0 0.65rem",
    },
    ".cm-note-rendered-block ul, .cm-note-rendered-block ol": {
      margin: "0.2rem 0 0.7rem 1.3rem",
      padding: "0",
      listStylePosition: "outside",
    },
    ".cm-note-rendered-block ul": {
      listStyleType: "disc",
    },
    ".cm-note-rendered-block ol": {
      listStyleType: "decimal",
    },
    ".cm-note-rendered-block .cm-note-task-list": {
      listStyleType: "none",
      marginLeft: "0",
    },
    ".cm-note-rendered-block li": {
      margin: "0.14rem 0",
      display: "list-item",
    },
    ".cm-note-rendered-block .cm-note-task-list-item": {
      listStyleType: "none",
      display: "flex",
      alignItems: "center",
      gap: "0.5rem",
    },
    ".cm-note-rendered-block .cm-note-task-list-item-checked": {
      color: "hsl(var(--text-secondary))",
      textDecoration: "line-through",
      textDecorationColor: "hsl(var(--text-tertiary))",
      textDecorationThickness: "1.5px",
    },
    ".cm-note-rendered-block li::marker": {
      color: "hsl(var(--text-secondary))",
    },
    ".cm-note-rendered-block .cm-note-task-list-item::marker": {
      content: '""',
    },
    ".cm-note-task-toggle": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: "0",
      border: "0",
      background: "transparent",
      lineHeight: "1",
      padding: "0",
      cursor: "pointer",
    },
    ".cm-note-task-toggle-box": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "1.02rem",
      height: "1.02rem",
      borderRadius: "0.32rem",
      border: "1.5px solid hsl(var(--border-subtle))",
      backgroundColor: "hsl(var(--bg-secondary) / 0.75)",
      color: "transparent",
      transition: "border-color 120ms ease, background-color 120ms ease, color 120ms ease",
      boxSizing: "border-box",
    },
    ".cm-note-task-toggle-check": {
      fontSize: "0.72rem",
      fontWeight: "700",
      lineHeight: "1",
      transform: "translateY(-0.01rem)",
    },
    ".cm-note-task-toggle[data-checked='true'] .cm-note-task-toggle-box": {
      borderColor: "hsl(var(--text-secondary))",
      backgroundColor: "hsl(var(--text-secondary))",
      color: "white",
    },
    ".cm-note-task-toggle:hover": {
      color: "inherit",
    },
    ".cm-note-task-toggle:hover .cm-note-task-toggle-box": {
      borderColor: "hsl(var(--accent-primary))",
    },
    ".cm-note-task-toggle:focus-visible": {
      outline: "2px solid hsl(var(--border-focus))",
      outlineOffset: "2px",
      borderRadius: "0.35rem",
    },
    ".cm-note-rendered-block blockquote": {
      margin: "0.25rem 0 0.75rem",
      paddingLeft: "0.95rem",
      borderLeft: "2px solid hsl(var(--border-subtle))",
      color: "hsl(var(--text-secondary))",
    },
    ".cm-note-rendered-block a": {
      color: "hsl(var(--accent-primary))",
      textDecoration: "underline",
      textUnderlineOffset: "0.16em",
    },
    ".cm-note-rendered-block strong": {
      fontWeight: "700",
    },
    ".cm-note-rendered-block em": {
      fontStyle: "italic",
    },
    ".cm-note-rendered-block code": {
      borderRadius: "0.45rem",
      backgroundColor: "hsl(var(--bg-surface-card))",
      color: "hsl(var(--text-primary))",
      fontFamily: "var(--font-mono)",
      padding: "0.04rem 0.28rem",
      fontSize: "0.92em",
    },
    ".cm-note-rendered-block hr": {
      border: "0",
      borderTop: "1px solid hsl(var(--border-subtle))",
      margin: "0.8rem 0",
    },
    ".cm-note-rendered-block table": {
      width: "100%",
      borderCollapse: "collapse",
      margin: "0.25rem 0 0.8rem",
      fontSize: "0.95em",
    },
    ".cm-note-rendered-block th, .cm-note-rendered-block td": {
      border: "1px solid hsl(var(--border-subtle))",
      padding: "0.45rem 0.55rem",
      textAlign: "left",
      verticalAlign: "top",
    },
    ".cm-note-rendered-block th": {
      backgroundColor: "hsl(var(--bg-surface-card) / 0.7)",
      fontWeight: "600",
    },
    ".cm-note-task-widget": {
      marginRight: "0.15rem",
    },
    ".cm-note-task-content-checked": {
      color: "hsl(var(--text-secondary))",
      textDecoration: "line-through",
      textDecorationColor: "hsl(var(--text-tertiary))",
      textDecorationThickness: "1.5px",
    },
    ".cm-note-frontmatter-line": {
      color: "hsl(var(--text-secondary))",
      backgroundColor: "hsl(var(--bg-surface-card) / 0.6)",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
    },
    ".cm-note-code-line": {
      backgroundColor: "rgba(16, 19, 26, 0.96)",
      color: "#F8FAFC",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      lineHeight: "1.8",
      paddingLeft: "0.95rem",
      paddingRight: "0.95rem",
    },
    ".cm-note-code-line-start": {
      borderTopLeftRadius: "0.9rem",
      borderTopRightRadius: "0.9rem",
      paddingTop: "0.75rem",
    },
    ".cm-note-code-line-end": {
      borderBottomLeftRadius: "0.9rem",
      borderBottomRightRadius: "0.9rem",
      paddingBottom: "0.75rem",
      marginBottom: "0.35rem",
    },
    ".cm-note-code-info": {
      color: "#CBD5E1",
      fontSize: "12px",
      fontWeight: "600",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
    ".cm-note-math-inline": {
      display: "inline-flex",
      alignItems: "center",
      borderRadius: "0.45rem",
      backgroundColor: "hsl(var(--bg-surface-card) / 0.9)",
      padding: "0.08rem 0.35rem",
      color: "hsl(var(--text-primary))",
      maxWidth: "100%",
      overflowX: "auto",
      verticalAlign: "middle",
    },
    ".cm-note-math-block": {
      margin: "0.45rem 0",
      borderRadius: "0.95rem",
      border: "1px solid hsl(var(--border-subtle))",
      backgroundColor: "hsl(var(--bg-surface-card) / 0.82)",
      padding: "0.95rem 1rem",
      color: "hsl(var(--text-primary))",
      overflowX: "auto",
    },
  });
}

export function MarkdownNoteEditor({
  value,
  onChange,
  onSaveRequest,
  placeholderText = "Start writing...",
  minHeight = 240,
  className,
  ariaLabel = "Markdown note editor",
}: MarkdownNoteEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRequestRef = useRef(onSaveRequest);
  const isSyncingRef = useRef(false);
  const themeExtension = useMemo(() => buildEditorTheme(minHeight), [minHeight]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRequestRef.current = onSaveRequest;
  }, [onSaveRequest]);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        markdown(),
        EditorView.lineWrapping,
        themeExtension,
        placeholder(placeholderText),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              void onSaveRequestRef.current?.();
              return true;
            },
          },
          indentWithTab,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || isSyncingRef.current) {
            return;
          }

          onChangeRef.current(update.state.doc.toString());
        }),
        livePreviewDecorations,
        taskToggleHandlers,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    view.dom.setAttribute("aria-label", ariaLabel);
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ariaLabel, placeholderText, themeExtension]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    isSyncingRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
    isSyncingRef.current = false;
  }, [value]);

  return <div ref={containerRef} className={className} />;
}
