import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UpstreamWriteFileRequest, UpstreamWriteFileResult } from '../shared/contracts';

// P3 upstream export: restricted file writer for Obsidian vaults and Markdown
// export directories. Electron-free on purpose (node:fs/node:path only) so the
// path-confinement logic is unit-testable under vitest. Every write target is
// resolved and normalized against the user-chosen root; anything escaping the
// root is rejected before touching the disk.

const MAX_CONFLICT_ATTEMPTS = 50;
/** Read only the head of a file when matching the frontmatter uuid. */
const FRONTMATTER_PROBE_BYTES = 4096;

function isAbsoluteLike(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/** Normalize separators so stored relative paths stay platform-neutral. */
function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Resolve relativePath inside rootPath. Throws unless rootPath is absolute and
 * the resolved target stays strictly inside it (no `..` escape, no absolute
 * re-rooting, no NUL bytes).
 */
export function resolveInsideRoot(rootPath: string, relativePath: string): string {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    throw new Error('导出根目录必须是绝对路径');
  }
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\0')) {
    throw new Error('导出文件路径无效');
  }
  if (isAbsoluteLike(relativePath)) {
    throw new Error('导出文件路径必须是相对路径');
  }
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('导出路径越出所选目录');
  }
  return resolved;
}

/** `VestiExport/a/b.md` attempt 2 → `VestiExport/a/b (2).md`. */
export function bumpConflictPath(relativePath: string, attempt: number): string {
  const extension = path.extname(relativePath);
  const base = extension ? relativePath.slice(0, -extension.length) : relativePath;
  return `${base} (${attempt})${extension}`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** The frontmatter uuid line marks a file as owned by this conversation's export. */
export async function fileFrontmatterHasUuid(target: string, expectedUuid: string): Promise<boolean> {
  if (!expectedUuid) return false;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(target, 'r');
    const buffer = Buffer.alloc(FRONTMATTER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_PROBE_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    if (!head.startsWith('---')) return false;
    const end = head.indexOf('\n---', 3);
    if (end === -1) return false;
    const frontmatter = head.slice(3, end);
    return new RegExp(`^uuid:\\s*"?${escapeRegExp(expectedUuid)}"?\\s*$`, 'm').test(frontmatter);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** tmp-write + rename in the target directory, mirroring settingsService.persist(). */
async function writeFileAtomic(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.vesti-tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
}

/**
 * Write one exported Markdown file inside rootPath.
 *
 * Idempotent update strategy: when previousRelativePath (stored on the
 * conversation after the last export) still exists AND its frontmatter uuid
 * matches expectedUuid, that file is overwritten in place — re-exporting a
 * conversation updates the original note instead of creating a duplicate.
 * Otherwise the desired path is used; an existing file is only overwritten
 * when its uuid matches, otherwise a ` (2)`-style suffix is added.
 */
export async function writeUpstreamExportFile(
  request: UpstreamWriteFileRequest,
): Promise<UpstreamWriteFileResult> {
  const root = path.resolve(request.rootPath);
  const expectedUuid = typeof request.expectedUuid === 'string' ? request.expectedUuid : '';

  if (typeof request.previousRelativePath === 'string' && request.previousRelativePath.trim()) {
    const previousAbsolute = resolveInsideRoot(root, request.previousRelativePath);
    if (await pathExists(previousAbsolute)) {
      const owned = expectedUuid
        ? await fileFrontmatterHasUuid(previousAbsolute, expectedUuid)
        : true;
      if (owned) {
        await writeFileAtomic(previousAbsolute, request.content);
        return { relativePath: toPosixPath(path.relative(root, previousAbsolute)) };
      }
    }
  }

  const desiredAbsolute = resolveInsideRoot(root, request.relativePath);
  if (await pathExists(desiredAbsolute)) {
    if (await fileFrontmatterHasUuid(desiredAbsolute, expectedUuid)) {
      await writeFileAtomic(desiredAbsolute, request.content);
      return { relativePath: toPosixPath(path.relative(root, desiredAbsolute)) };
    }
    for (let attempt = 2; attempt <= MAX_CONFLICT_ATTEMPTS; attempt += 1) {
      const candidate = bumpConflictPath(request.relativePath, attempt);
      const candidateAbsolute = resolveInsideRoot(root, candidate);
      if (await pathExists(candidateAbsolute)) continue;
      await writeFileAtomic(candidateAbsolute, request.content);
      return { relativePath: toPosixPath(path.relative(root, candidateAbsolute)) };
    }
    throw new Error('导出失败：同名文件过多，请整理导出目录后重试');
  }

  await writeFileAtomic(desiredAbsolute, request.content);
  return { relativePath: toPosixPath(path.relative(root, desiredAbsolute)) };
}
