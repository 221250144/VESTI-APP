import { autoUpdater as defaultAutoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import type { UpdatePhase, UpdateStatusView } from '../shared/contracts';

export const UPDATE_INITIAL_DELAY_MS = 15_000;
export const UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60_000;

/**
 * Narrow autoUpdater surface the service drives (electron-updater's
 * AppUpdater in production, a fake in tests).
 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: UpdateInfo) => void): unknown;
  on(event: 'update-not-available', listener: (info: UpdateInfo) => void): unknown;
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateDownloadedEvent) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateServiceOptions {
  /** app.isPackaged — dev/unpackaged builds disable the updater entirely. */
  isPackaged: boolean;
  /** app.getVersion() */
  currentVersion: string;
  autoUpdater?: AutoUpdaterLike;
  initialDelayMs?: number;
  pollIntervalMs?: number;
  /** Silent log line; update failures never surface as dialogs. */
  log?: (line: string) => void;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Auto-update state machine (electron-updater, generic provider).
 *
 *   idle → checking → available → downloading → downloaded
 *              ↓          ↓             ↓
 *           (none)      error ←─────────┘
 *
 * - Downloads are user-gated: autoDownload stays false, only downloadUpdate()
 *   (Settings About card / update banner) pulls the installer.
 * - Silent by design: network errors are logged and reflected in the status
 *   view (About card shows 检查失败); nothing ever pops a dialog.
 * - Automatic polling skips itself while a check/download is in flight or a
 *   downloaded update is waiting — re-checking then would only rediscover the
 *   same version and could clobber the ready-to-install state.
 * - Dev builds (isPackaged false) are a complete no-op: no timers, no events,
 *   every action returns the disabled status unchanged.
 */
export class UpdateService {
  private readonly enabled: boolean;
  private readonly currentVersion: string;
  private readonly injectedUpdater: AutoUpdaterLike | undefined;
  private readonly initialDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly log: (line: string) => void;
  private updater: AutoUpdaterLike | null = null;
  private status: UpdateStatusView;
  private readonly listeners = new Set<(status: UpdateStatusView) => void>();
  private initialTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: UpdateServiceOptions) {
    this.enabled = options.isPackaged;
    this.currentVersion = options.currentVersion;
    this.injectedUpdater = options.autoUpdater;
    this.initialDelayMs = options.initialDelayMs ?? UPDATE_INITIAL_DELAY_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? UPDATE_POLL_INTERVAL_MS;
    this.log = options.log ?? (line => console.warn(`[vesti] update: ${line}`));
    this.status = {
      enabled: this.enabled,
      phase: 'idle',
      currentVersion: this.currentVersion,
      latestVersion: null,
      percent: null,
      bytesPerSecond: null,
      error: null,
      checkedAt: null,
    };
  }

  /** Wire autoUpdater events and start the delayed-then-interval schedule. */
  start(): void {
    if (!this.enabled || this.updater) return;
    // Resolved lazily: touching the electron-updater autoUpdater getter
    // instantiates the platform updater, which dev builds never need.
    const updater = this.injectedUpdater ?? (defaultAutoUpdater as unknown as AutoUpdaterLike);
    this.updater = updater;
    // Downloads are user-confirmed (downloadUpdate); installs ride the normal
    // app quit once phase === 'downloaded'.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => this.transition('checking'));
    updater.on('update-available', info =>
      this.transition('available', { latestVersion: info.version, checkedAt: Date.now() }));
    updater.on('update-not-available', () =>
      this.transition('idle', { latestVersion: null, percent: null, bytesPerSecond: null, checkedAt: Date.now() }));
    updater.on('download-progress', progress =>
      this.transition('downloading', {
        percent: Math.max(0, Math.min(100, progress.percent)),
        bytesPerSecond: progress.bytesPerSecond,
      }));
    updater.on('update-downloaded', info =>
      this.transition('downloaded', {
        latestVersion: info.version ?? this.status.latestVersion,
        percent: 100,
        bytesPerSecond: null,
      }));
    updater.on('error', error => this.handleError(error));

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.checkForUpdates();
      this.pollTimer = setInterval(() => void this.checkForUpdates(), this.pollIntervalMs);
      this.pollTimer.unref?.();
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.initialTimer = null;
    this.pollTimer = null;
  }

  getStatus(): UpdateStatusView {
    return { ...this.status };
  }

  /**
   * Manual or scheduled check. Concurrency-guarded: while a check/download is
   * running — or a downloaded update is waiting for restart — this is a no-op
   * returning the current status (a re-check could only rediscover the same
   * version and must not clobber the ready-to-install state).
   */
  async checkForUpdates(): Promise<UpdateStatusView> {
    if (!this.enabled || !this.updater) return this.getStatus();
    const phase = this.status.phase;
    if (phase === 'checking' || phase === 'downloading' || phase === 'downloaded') {
      return this.getStatus();
    }
    this.transition('checking', { error: null });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      // electron-updater also emits 'error'; handleError is idempotent.
      this.handleError(error);
    }
    return this.getStatus();
  }

  /** User-confirmed download of the discovered update. */
  async downloadUpdate(): Promise<UpdateStatusView> {
    if (!this.enabled || !this.updater) return this.getStatus();
    if (this.status.phase !== 'available') return this.getStatus();
    this.transition('downloading', { percent: 0, bytesPerSecond: null, error: null });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.handleError(error);
    }
    return this.getStatus();
  }

  /** Quit and install; valid only once the update is downloaded. */
  quitAndInstall(): void {
    if (!this.enabled || !this.updater) return;
    if (this.status.phase !== 'downloaded') {
      throw new Error('当前没有可安装的已下载更新');
    }
    this.updater.quitAndInstall();
  }

  onStatusChanged(listener: (status: UpdateStatusView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transition(phase: UpdatePhase, patch: Partial<UpdateStatusView> = {}): void {
    this.status = { ...this.status, ...patch, phase };
    const snapshot = this.getStatus();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Failures land in the status view (About card) and the log — never a dialog. */
  private handleError(error: unknown): void {
    const message = errorText(error);
    this.log(`check/download failed: ${message}`);
    this.transition('error', { error: message, bytesPerSecond: null });
  }
}
