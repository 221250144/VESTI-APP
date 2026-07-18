import type { AstNode, AstRoot, AstTableNode } from "../ast";

const MIN_AST_CANONICAL_COVERAGE_RATIO = 0.55;
const MIN_MATH_CANONICAL_COVERAGE_RATIO = 0.2;
const MIN_SOURCE_TEXT_LENGTH_FOR_AST_COVERAGE = 120;

export interface AstStructureStats {
  blockNodes: number;
  hasList: boolean;
  hasTable: boolean;
  hasCodeBlock: boolean;
  hasMath: boolean;
  hasBlockquote: boolean;
  hasHeading: boolean;
  hasAttachment: boolean;
}

export function isAstRoot(value: unknown): value is AstRoot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { type?: unknown; children?: unknown };
  return candidate.type === "root" && Array.isArray(candidate.children);
}

export function astNodeToPlainText(node: AstNode): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "fragment":
    case "strong":
    case "em":
      return joinInlineText(node.children);
    case "p":
    case "h1":
    case "h2":
    case "h3":
    case "li":
    case "blockquote":
      return joinInlineText(node.children);
    case "ul":
    case "ol":
      return node.children.map(astNodeToPlainText).filter(Boolean).join("\n");
    case "br":
      return "\n";
    case "code_inline":
      return node.text;
    case "code_block":
      return node.code;
    case "table": {
      const { header, rows } = renderTablePlainText(node);
      return [header, ...rows].filter(Boolean).join("\n");
    }
    case "math":
      return node.tex;
    case "attachment":
      return node.name;
    default: {
      const exhaustiveGuard: never = node;
      return exhaustiveGuard;
    }
  }
}

export function extractAstPlainText(root: AstRoot): string {
  return normalizeCanonicalPlainText(
    root.children.map(astNodeToPlainText).filter(Boolean).join("\n\n")
  );
}

export function inspectAstStructure(root: AstRoot): AstStructureStats {
  const stats: AstStructureStats = {
    blockNodes: 0,
    hasList: false,
    hasTable: false,
    hasCodeBlock: false,
    hasMath: false,
    hasBlockquote: false,
    hasHeading: false,
    hasAttachment: false,
  };

  const walk = (node: AstNode): void => {
    switch (node.type) {
      case "p":
      case "h1":
      case "h2":
      case "h3":
      case "blockquote":
      case "code_block":
      case "table":
      case "ul":
      case "ol":
      case "li":
        stats.blockNodes += 1;
        break;
      default:
        break;
    }

    if (node.type === "ul" || node.type === "ol") stats.hasList = true;
    if (node.type === "table") stats.hasTable = true;
    if (node.type === "code_block") stats.hasCodeBlock = true;
    if (node.type === "math") stats.hasMath = true;
    if (node.type === "blockquote") stats.hasBlockquote = true;
    if (node.type === "h1" || node.type === "h2" || node.type === "h3") {
      stats.hasHeading = true;
    }
    if (node.type === "attachment") stats.hasAttachment = true;

    if (
      node.type === "fragment" ||
      node.type === "p" ||
      node.type === "h1" ||
      node.type === "h2" ||
      node.type === "h3" ||
      node.type === "ul" ||
      node.type === "ol" ||
      node.type === "li" ||
      node.type === "strong" ||
      node.type === "em" ||
      node.type === "blockquote"
    ) {
      node.children.forEach(walk);
      return;
    }

    if (node.type === "table" && node.kind === "v2") {
      node.columns.forEach((column) => column.header.forEach(walk));
      node.rows.forEach((row) => row.cells.forEach((cell) => cell.children.forEach(walk)));
    }
  };

  root.children.forEach(walk);
  return stats;
}

export function shouldPreferAstCanonicalText(params: {
  root: AstRoot | null | undefined;
  fallbackText?: string | null | undefined;
}): boolean {
  const { root, fallbackText } = params;
  if (!root) {
    return false;
  }

  const stats = inspectAstStructure(root);
  const hasStructuredSignal =
    stats.hasMath ||
    stats.hasTable ||
    stats.hasCodeBlock ||
    stats.hasList ||
    stats.hasBlockquote ||
    stats.hasHeading ||
    stats.hasAttachment;

  if (!hasStructuredSignal) {
    return false;
  }

  const normalizedFallback = normalizeCoverageText(fallbackText ?? "");
  if (!normalizedFallback) {
    return true;
  }

  if (normalizedFallback.length < MIN_SOURCE_TEXT_LENGTH_FOR_AST_COVERAGE) {
    return true;
  }

  const normalizedAstText = normalizeCoverageText(extractAstPlainText(root));
  if (!normalizedAstText) {
    return false;
  }

  const coverageRatio = normalizedAstText.length / normalizedFallback.length;
  const coverageFloor = stats.hasMath
    ? MIN_MATH_CANONICAL_COVERAGE_RATIO
    : MIN_AST_CANONICAL_COVERAGE_RATIO;

  return coverageRatio >= coverageFloor;
}

function joinInlineText(children: AstNode[]): string {
  return children.map(astNodeToPlainText).filter(Boolean).join(" ");
}

function renderTablePlainText(node: AstTableNode): {
  header: string;
  rows: string[];
} {
  if (node.kind === "v2") {
    const header = node.columns
      .map((column) => joinInlineText(column.header))
      .join(" | ");
    const rows = node.rows.map((row) =>
      row.cells.map((cell) => joinInlineText(cell.children)).join(" | ")
    );
    return { header, rows };
  }

  const header = node.headers.join(" | ");
  const rows = node.rows.map((row) => row.join(" | "));
  return { header, rows };
}

function normalizeCanonicalPlainText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeCoverageText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
