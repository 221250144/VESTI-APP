function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n");
}

function normalizeMarkdownOutput(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function serializeChildren(node: Node): string {
  return Array.from(node.childNodes)
    .map((child) => serializeNode(child))
    .join("");
}

function serializeListItem(content: string, prefix: string): string {
  const trimmed = normalizeMarkdownOutput(content);
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split("\n");
  return lines
    .map((line, index) => (index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`))
    .join("\n");
}

function serializeList(element: HTMLElement, ordered: boolean): string {
  const start = Number(element.getAttribute("start") ?? "1");
  const items = Array.from(element.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "LI")
    .map((item, index) =>
      serializeListItem(
        serializeChildren(item),
        ordered ? `${start + index}. ` : "- ",
      ),
    )
    .filter(Boolean);

  return items.length > 0 ? `${items.join("\n")}\n\n` : "";
}

function serializeTable(element: HTMLElement): string {
  const rows = Array.from(element.querySelectorAll("tr")).map((row) =>
    Array.from(row.children)
      .filter(
        (cell): cell is HTMLElement =>
          cell instanceof HTMLElement &&
          (cell.tagName === "TH" || cell.tagName === "TD"),
      )
      .map((cell) => normalizeMarkdownOutput(serializeChildren(cell)))
  );

  if (rows.length === 0) {
    return "";
  }

  const header = rows[0];
  const body = rows.slice(1);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];

  return `${lines.join("\n")}\n\n`;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeInlineWhitespace(node.textContent ?? "");
  }

  if (!(node instanceof HTMLElement)) {
    return serializeChildren(node);
  }

  const tag = node.tagName.toUpperCase();
  switch (tag) {
    case "BR":
      return "\n";
    case "HR":
      return "\n---\n\n";
    case "STRONG":
    case "B":
      return `**${serializeChildren(node)}**`;
    case "EM":
    case "I":
      return `*${serializeChildren(node)}*`;
    case "DEL":
    case "S":
    case "STRIKE":
      return `~~${serializeChildren(node)}~~`;
    case "CODE":
      if (node.parentElement?.tagName.toUpperCase() === "PRE") {
        return serializeChildren(node);
      }
      return `\`${normalizeInlineWhitespace(node.textContent ?? "")}\``;
    case "PRE": {
      const code = (node.textContent ?? "").replace(/\n$/, "");
      return code ? `\`\`\`\n${code}\n\`\`\`\n\n` : "";
    }
    case "A": {
      const label = normalizeMarkdownOutput(serializeChildren(node)) || normalizeInlineWhitespace(node.textContent ?? "");
      const href = node.getAttribute("href");
      return href ? `[${label || href}](${href})` : label;
    }
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const level = Number(tag[1] ?? "1");
      return `${"#".repeat(level)} ${normalizeMarkdownOutput(serializeChildren(node))}\n\n`;
    }
    case "P":
      return `${normalizeMarkdownOutput(serializeChildren(node))}\n\n`;
    case "BLOCKQUOTE": {
      const body = normalizeMarkdownOutput(serializeChildren(node));
      if (!body) return "";
      return `${body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n`;
    }
    case "UL":
      return serializeList(node, false);
    case "OL":
      return serializeList(node, true);
    case "LI":
      return serializeChildren(node);
    case "INPUT":
      if ((node as HTMLInputElement).type === "checkbox") {
        return (node as HTMLInputElement).checked ? "[x] " : "[ ] ";
      }
      return "";
    case "TABLE":
      return serializeTable(node);
    case "BUTTON":
    case "SVG":
    case "PATH":
      return "";
    default:
      return serializeChildren(node);
  }
}

export function serializeSelectionFragmentToMarkdown(fragment: DocumentFragment): string {
  return normalizeMarkdownOutput(serializeChildren(fragment));
}
