import YAML from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface SplitNoteFrontmatterResult {
  frontmatterRaw: string | null;
  body: string;
  hasFrontmatter: boolean;
}

export function splitNoteFrontmatter(content: string): SplitNoteFrontmatterResult {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return {
      frontmatterRaw: null,
      body: content,
      hasFrontmatter: false,
    };
  }

  return {
    frontmatterRaw: match[1] ?? null,
    body: content.slice(match[0].length),
    hasFrontmatter: true,
  };
}

export function parseNoteFrontmatter(
  content: string,
): Record<string, unknown> | null {
  const { frontmatterRaw } = splitNoteFrontmatter(content);
  if (!frontmatterRaw) return null;

  try {
    const parsed = YAML.parse(frontmatterRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hasLeadingFrontmatter(content: string): boolean {
  const split = splitNoteFrontmatter(content);
  return split.hasFrontmatter;
}

export function extractFrontmatterTitle(content: string): string | null {
  const frontmatter = parseNoteFrontmatter(content);
  if (!frontmatter || typeof frontmatter.title !== "string") {
    return null;
  }

  const normalized = frontmatter.title.trim();
  return normalized || null;
}

export function updateFrontmatterTitle(content: string, title: string): string {
  const split = splitNoteFrontmatter(content);
  if (!split.hasFrontmatter) {
    return content;
  }

  const frontmatter = parseNoteFrontmatter(content) ?? {};
  const normalized = title.trim();
  if (normalized) {
    frontmatter.title = normalized;
  } else {
    delete frontmatter.title;
  }

  const serialized = YAML.stringify(frontmatter, {
    lineWidth: 0,
    minContentWidth: 0,
  }).trimEnd();

  if (!serialized) {
    return split.body;
  }

  return `---\n${serialized}\n---\n${split.body}`;
}

export function resolveDisplayedNoteTitle(
  content: string,
  standaloneTitle: string,
): string {
  return extractFrontmatterTitle(content) ?? standaloneTitle;
}
