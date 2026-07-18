import fs from 'node:fs';
import path from 'node:path';

/**
 * Small JSON key-value store for renderer UI preferences (theme, language,
 * capsule position, ...). Lives next to settings.json in userData and is
 * deliberately schema-light: values are written by the renderer via a
 * whitelisted IPC bridge and broadcast to every window on change.
 */
export class UiPrefsService {
  private filePath = '';
  private prefs = new Map<string, unknown>();
  private notify?: (key: string, value: unknown) => void;

  async initialize(directory: string, notify: (key: string, value: unknown) => void): Promise<void> {
    this.filePath = path.join(directory, 'ui-prefs.json');
    this.notify = notify;
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (this.validKey(key)) this.prefs.set(key, value);
        }
      }
    } catch {
      // Missing or corrupt file: start empty.
    }
  }

  get(key: string): unknown {
    return this.prefs.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.validKey(key)) throw new Error('Invalid preference key');
    if (!this.validValue(value)) throw new Error('Invalid preference value');
    this.prefs.set(key, value);
    await this.flush();
    this.notify?.(key, value);
  }

  private validKey(key: unknown): key is string {
    return typeof key === 'string' && /^[\w.-]{1,100}$/.test(key);
  }

  private validValue(value: unknown): boolean {
    try {
      const json = JSON.stringify(value);
      return typeof json === 'string' && json.length <= 64 * 1024;
    } catch {
      return false;
    }
  }

  private async flush(): Promise<void> {
    const payload = JSON.stringify(Object.fromEntries(this.prefs), null, 2);
    const tempPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tempPath, payload, 'utf8');
    await fs.promises.rename(tempPath, this.filePath);
  }
}
