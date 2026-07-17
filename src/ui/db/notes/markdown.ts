import YAML from "yaml"

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const EXCERPT_MAX_LENGTH = 140

export interface SplitNoteFrontmatterResult {
  frontmatterRaw: string | null
  body: string
  hasFrontmatter: boolean
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

export function splitNoteFrontmatter(content: string): SplitNoteFrontmatterResult {
  const match = content.match(FRONTMATTER_PATTERN)
  if (!match) {
    return {
      frontmatterRaw: null,
      body: content,
      hasFrontmatter: false
    }
  }

  return {
    frontmatterRaw: match[1] ?? null,
    body: content.slice(match[0].length),
    hasFrontmatter: true
  }
}

export function parseNoteFrontmatter(
  content: string
): Record<string, unknown> | null {
  const { frontmatterRaw } = splitNoteFrontmatter(content)
  if (!frontmatterRaw) {
    return null
  }

  try {
    const parsed = YAML.parse(frontmatterRaw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }

    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function extractFrontmatterTitle(content: string): string | null {
  const frontmatter = parseNoteFrontmatter(content)
  if (!frontmatter) {
    return null
  }

  const rawTitle = frontmatter.title
  if (typeof rawTitle !== "string") {
    return null
  }

  const normalized = rawTitle.trim()
  return normalized || null
}

export function updateFrontmatterTitle(
  content: string,
  title: string
): string {
  const split = splitNoteFrontmatter(content)
  if (!split.hasFrontmatter) {
    return content
  }

  const nextFrontmatter = parseNoteFrontmatter(content) ?? {}
  const normalized = title.trim()
  if (normalized) {
    nextFrontmatter.title = normalized
  } else {
    delete nextFrontmatter.title
  }

  const serialized = YAML.stringify(nextFrontmatter, {
    lineWidth: 0,
    minContentWidth: 0
  }).trimEnd()

  if (!serialized) {
    return split.body
  }

  return `---\n${serialized}\n---\n${split.body}`
}

function stripMarkdownSyntax(value: string): string {
  return value
    .replace(/!\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, target: string, label: string) =>
      (label || target).trim()
    )
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\[( |x|X)\]/g, " ")
}

export function buildNoteExcerpt(content: string): string {
  const { body } = splitNoteFrontmatter(content)
  const normalized = stripMarkdownSyntax(body)
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!normalized) {
    return ""
  }

  return truncate(normalized, EXCERPT_MAX_LENGTH)
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

export async function computeNoteHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return toHex(digest)
}
