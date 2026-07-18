import { unzipSync } from "fflate"
import type { NoteImportAssetRef, NoteImportMeta, ObsidianImportFileEntry } from "../types"
import { computeNoteHash, parseNoteFrontmatter, splitNoteFrontmatter } from "./markdown"

export interface PreparedObsidianNote {
  title: string
  content: string
  relativePath: string
  folderPath: string
  sourceMtime: number | null
  sourceFileHash: string
  importMeta: Omit<NoteImportMeta, "vault_id" | "vault_name" | "last_imported_note_hash" | "imported_at" | "last_imported_at" | "conflict">
}

export interface PreparedObsidianAsset {
  relativePath: string
  mimeType: string
  data: Uint8Array
  hash: string
}

export interface PreparedObsidianVault {
  name: string
  kind: "directory" | "zip"
  notes: PreparedObsidianNote[]
  assets: PreparedObsidianAsset[]
  unsupportedFiles: string[]
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif"
])

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  txt: "text/plain",
  csv: "text/csv"
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim()
}

function basename(path: string): string {
  const normalized = normalizePath(path)
  const segments = normalized.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? normalized
}

function dirname(path: string): string {
  const normalized = normalizePath(path)
  const segments = normalized.split("/").filter(Boolean)
  if (segments.length <= 1) {
    return ""
  }

  return segments.slice(0, -1).join("/")
}

function resolveRelativePath(baseFolder: string, targetPath: string): string {
  const normalizedTarget = normalizePath(targetPath)
  if (!normalizedTarget) {
    return ""
  }

  if (!normalizedTarget.startsWith(".") && !normalizedTarget.startsWith("..")) {
    return normalizedTarget
  }

  const stack = normalizePath(baseFolder)
    .split("/")
    .filter(Boolean)

  for (const segment of normalizedTarget.split("/")) {
    if (!segment || segment === ".") {
      continue
    }
    if (segment === "..") {
      stack.pop()
      continue
    }
    stack.push(segment)
  }

  return stack.join("/")
}

function withoutExtension(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "")
}

function extensionOf(path: string): string {
  const match = basename(path).match(/\.([^.]+)$/)
  return match ? match[1].toLowerCase() : ""
}

function firstHeading(content: string): string | null {
  const { body } = splitNoteFrontmatter(content)
  const lines = body.replace(/\r\n/g, "\n").split("\n")

  for (const line of lines) {
    const match = line.match(/^#\s+(.+?)\s*$/)
    if (!match) {
      continue
    }

    const heading = match[1]?.trim()
    if (heading) {
      return heading
    }
  }

  return null
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#/, "")
}

function extractInlineTags(content: string): string[] {
  const matches = content.match(/(^|\s)#([^\s#]+)/g) ?? []
  const tags = new Set<string>()

  for (const match of matches) {
    const cleaned = normalizeTag(match)
    if (cleaned) {
      tags.add(cleaned)
    }
  }

  return [...tags]
}

function extractFrontmatterTags(frontmatter: Record<string, unknown> | null): string[] {
  if (!frontmatter) {
    return []
  }

  const rawTags = frontmatter.tags
  if (typeof rawTags === "string") {
    const tag = normalizeTag(rawTags)
    return tag ? [tag] : []
  }

  if (Array.isArray(rawTags)) {
    return rawTags
      .filter((value): value is string => typeof value === "string")
      .map(normalizeTag)
      .filter(Boolean)
  }

  return []
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) {
      continue
    }

    const key = trimmed.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(trimmed)
  }

  return result
}

function parseWikiTarget(raw: string): string {
  const target = raw.split("|")[0]?.split("#")[0]?.trim() ?? ""
  return target
}

function extractWikilinks(content: string): { wikilinks: string[]; embeds: string[] } {
  const embedMatches = [...content.matchAll(/!\[\[([^\]]+)\]\]/g)].map((match) =>
    parseWikiTarget(match[1] ?? "")
  )
  const withoutEmbeds = content.replace(/!\[\[[^\]]+\]\]/g, "")
  const wikilinkMatches = [...withoutEmbeds.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) =>
    parseWikiTarget(match[1] ?? "")
  )

  return {
    wikilinks: dedupeStrings(wikilinkMatches),
    embeds: dedupeStrings(embedMatches)
  }
}

function isProbablyExternalHref(value: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("mailto:")
}

function collectMarkdownAssetRefs(
  content: string,
  baseFolder: string
): NoteImportAssetRef[] {
  const refs: NoteImportAssetRef[] = []
  const addRef = (path: string, kind: NoteImportAssetRef["kind"]) => {
    const normalized = resolveRelativePath(baseFolder, path)
    if (!normalized || isProbablyExternalHref(normalized) || normalized.startsWith("#")) {
      return
    }

    refs.push({
      path: normalized,
      asset_id: null,
      kind
    })
  }

  for (const match of content.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    addRef(parseWikiTarget(match[1] ?? ""), "embed")
  }

  for (const match of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    addRef(match[1] ?? "", "embed")
  }

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    addRef(match[1] ?? "", "link")
  }

  return refs
}

function inferMimeType(path: string, explicitType?: string): string {
  if (explicitType && explicitType !== "application/octet-stream") {
    return explicitType
  }

  return MIME_BY_EXTENSION[extensionOf(path)] ?? "application/octet-stream"
}

async function hashBytes(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)

  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data)
}

async function prepareMarkdownEntry(
  entry: ObsidianImportFileEntry,
  data: Uint8Array
): Promise<PreparedObsidianNote> {
  const relativePath = normalizePath(entry.path)
  const content = decodeUtf8(data)
  const folderPath = dirname(relativePath)
  const frontmatter = parseNoteFrontmatter(content)
  const { wikilinks, embeds } = extractWikilinks(content)
  const assetRefs = collectMarkdownAssetRefs(content, folderPath)
  const tags = dedupeStrings([
    ...extractFrontmatterTags(frontmatter),
    ...extractInlineTags(content)
  ])
  const title =
    (typeof frontmatter?.title === "string" && frontmatter.title.trim()) ||
    firstHeading(content) ||
    withoutExtension(relativePath) ||
    "Untitled"
  const sourceFileHash = await hashBytes(data)

  return {
    title,
    content,
    relativePath,
    folderPath: dirname(relativePath),
    sourceMtime:
      typeof entry.last_modified === "number" && Number.isFinite(entry.last_modified)
        ? entry.last_modified
        : null,
    sourceFileHash,
    importMeta: {
      relative_path: relativePath,
      folder_path: folderPath,
      frontmatter,
      wikilinks,
      embeds,
      tags,
      assets: assetRefs,
      source_mtime:
        typeof entry.last_modified === "number" && Number.isFinite(entry.last_modified)
          ? entry.last_modified
          : null,
      source_file_hash: sourceFileHash
    }
  }
}

async function prepareAssetEntry(
  entry: ObsidianImportFileEntry,
  data: Uint8Array
): Promise<PreparedObsidianAsset> {
  const relativePath = normalizePath(entry.path)

  return {
    relativePath,
    mimeType: inferMimeType(relativePath, entry.mime_type),
    data,
    hash: await hashBytes(data)
  }
}

async function prepareEntries(
  name: string,
  kind: "directory" | "zip",
  entries: ObsidianImportFileEntry[]
): Promise<PreparedObsidianVault> {
  const notes: PreparedObsidianNote[] = []
  const assets: PreparedObsidianAsset[] = []
  const unsupportedFiles: string[] = []

  for (const entry of entries) {
    const relativePath = normalizePath(entry.path)
    if (!relativePath) {
      continue
    }

    const extension = extensionOf(relativePath)
    const bytes = new Uint8Array(entry.data)

    if (extension === "md") {
      notes.push(await prepareMarkdownEntry(entry, bytes))
      continue
    }

    if (extension === "canvas" || relativePath.startsWith(".obsidian/")) {
      unsupportedFiles.push(relativePath)
      continue
    }

    assets.push(await prepareAssetEntry(entry, bytes))
  }

  return {
    name,
    kind,
    notes,
    assets,
    unsupportedFiles
  }
}

function stripCommonRootPrefix(paths: string[]): { root: string | null; normalized: string[] } {
  if (paths.length === 0) {
    return { root: null, normalized: [] }
  }

  const firstSegments = paths
    .map((path) => normalizePath(path).split("/").filter(Boolean))
    .filter((segments) => segments.length > 0)

  if (firstSegments.length === 0) {
    return { root: null, normalized: paths.map(normalizePath) }
  }

  const firstRoot = firstSegments[0]?.[0] ?? null
  if (
    !firstRoot ||
    firstSegments.some((segments) => segments.length < 2 || segments[0] !== firstRoot)
  ) {
    return { root: null, normalized: paths.map(normalizePath) }
  }

  return {
    root: firstRoot,
    normalized: paths.map((path) => {
      const normalizedPath = normalizePath(path)
      return normalizedPath.startsWith(`${firstRoot}/`)
        ? normalizedPath.slice(firstRoot.length + 1)
        : normalizedPath
    })
  }
}

export async function prepareObsidianDirectoryImport(
  vaultName: string,
  entries: ObsidianImportFileEntry[]
): Promise<PreparedObsidianVault> {
  return prepareEntries(vaultName, "directory", entries)
}

export async function prepareObsidianZipImport(
  fileName: string,
  data: ArrayBuffer
): Promise<PreparedObsidianVault> {
  const archiveName = fileName.replace(/\.zip$/i, "") || "Obsidian Vault"
  const zipEntries = unzipSync(new Uint8Array(data))
  const paths = Object.keys(zipEntries).filter((path) => !path.endsWith("/"))
  const { root, normalized } = stripCommonRootPrefix(paths)
  const entries: ObsidianImportFileEntry[] = normalized.map((path, index) => ({
    path,
    mime_type: inferMimeType(path),
    last_modified: Date.now(),
    data: zipEntries[paths[index]]?.buffer.slice(
      zipEntries[paths[index]].byteOffset,
      zipEntries[paths[index]].byteOffset + zipEntries[paths[index]].byteLength
    ) ?? new ArrayBuffer(0)
  }))

  return prepareEntries(root ?? archiveName, "zip", entries)
}

export async function computeImportedNoteHash(content: string): Promise<string> {
  return computeNoteHash(content)
}

export function isPreviewableAsset(relativePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(relativePath))
}
