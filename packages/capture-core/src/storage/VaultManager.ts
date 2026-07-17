/**
 * Vault Manager
 * Backs up raw JSONL files to ~/.vesti/vault/ with gzip compression
 * Provides recovery mechanism for agent reinstalls
 */

import fs from 'fs-extra';
import path from 'path';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';

export class VaultManager {
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async initialize(): Promise<void> {
    await fs.ensureDir(this.vaultPath);
  }

  /**
   * Backup a raw session file to the vault
   */
  async backup(filePath: string, platform: string, sessionId?: string): Promise<string> {
    const platformDir = path.join(this.vaultPath, platform, 'raw');
    await fs.ensureDir(platformDir);

    const basename = sessionId ? `${sessionId}.jsonl` : path.basename(filePath);
    const destPath = path.join(platformDir, `${basename}.gz`);

    // Skip if already backed up and source hasn't changed
    if (await fs.pathExists(destPath)) {
      const srcStat = await fs.stat(filePath);
      const dstStat = await fs.stat(destPath);
      if (dstStat.mtimeMs >= srcStat.mtimeMs) {
        return destPath;
      }
    }

    // Compress and copy
    const gzip = createGzip({ level: 9 });
    const source = createReadStream(filePath);
    const dest = createWriteStream(destPath);
    await pipeline(source, gzip, dest);

    return destPath;
  }

  /**
   * Backup all session files for a platform
   */
  async backupAll(files: string[], platform: string): Promise<{ backed: number; skipped: number; errors: number }> {
    let backed = 0, skipped = 0, errors = 0;

    for (const file of files) {
      try {
        const platformDir = path.join(this.vaultPath, platform, 'raw');
        const destPath = path.join(platformDir, `${path.basename(file)}.gz`);

        if (await fs.pathExists(destPath)) {
          const srcStat = await fs.stat(file);
          const dstStat = await fs.stat(destPath);
          if (dstStat.mtimeMs >= srcStat.mtimeMs) {
            skipped++;
            continue;
          }
        }

        await this.backup(file, platform);
        backed++;
      } catch {
        errors++;
      }
    }

    return { backed, skipped, errors };
  }

  /**
   * Restore a file from vault
   */
  async restore(vaultFile: string, destPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(destPath));
    const gunzip = createGunzip();
    const source = createReadStream(vaultFile);
    const dest = createWriteStream(destPath);
    await pipeline(source, gunzip, dest);
  }

  /**
   * List all backed up files for a platform
   */
  async listBackups(platform: string): Promise<Array<{ file: string; size: number; modified: number }>> {
    const dir = path.join(this.vaultPath, platform, 'raw');
    if (!await fs.pathExists(dir)) return [];

    const files = await fs.readdir(dir);
    const results: Array<{ file: string; size: number; modified: number }> = [];

    for (const file of files) {
      if (!file.endsWith('.gz')) continue;
      const stat = await fs.stat(path.join(dir, file));
      results.push({
        file: path.join(dir, file),
        size: stat.size,
        modified: stat.mtimeMs,
      });
    }

    return results.sort((a, b) => b.modified - a.modified);
  }

  /**
   * Get vault storage statistics
   */
  async getStats(): Promise<{ totalFiles: number; totalSize: number; platforms: Record<string, number> }> {
    let totalFiles = 0;
    let totalSize = 0;
    const platforms: Record<string, number> = {};

    if (!await fs.pathExists(this.vaultPath)) {
      return { totalFiles, totalSize, platforms };
    }

    const entries = await fs.readdir(this.vaultPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rawDir = path.join(this.vaultPath, entry.name, 'raw');
      if (!await fs.pathExists(rawDir)) continue;

      const files = await fs.readdir(rawDir);
      let platformSize = 0;
      for (const file of files) {
        const stat = await fs.stat(path.join(rawDir, file));
        platformSize += stat.size;
        totalFiles++;
      }
      totalSize += platformSize;
      platforms[entry.name] = files.length;
    }

    return { totalFiles, totalSize, platforms };
  }
}
