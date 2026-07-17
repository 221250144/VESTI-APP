import { BrowserWindow, Menu, screen } from 'electron';
import path from 'node:path';
import { IPC, type CapsuleState } from '../shared/contracts';

const BALL_SIZE = 64;
const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 344;
const EDGE_MARGIN = 16;

export interface CapsulePosition {
  x: number;
  y: number;
  expanded?: boolean;
}

interface CapsuleHost {
  getState(): Omit<CapsuleState, 'expanded'>;
  sync(): Promise<unknown>;
  toggleWatch(): Promise<boolean>;
  openMainWindow(): void;
  loadPreference(key: string): unknown;
  savePreference(key: string, value: unknown): Promise<void>;
  iconPath(): string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Owns the desktop floating capsule ("小猫头鹰悬浮球"): a small always-on-top
 * transparent window that collapses to the owl ball and expands into a quick
 * actions panel. Dragging snaps to the nearest left/right screen edge; the
 * position persists through the UI-prefs store.
 */
export class CapsuleWindowService {
  private window: BrowserWindow | null = null;
  private expanded = false;
  private dragOffset: { x: number; y: number } | null = null;

  constructor(private host: CapsuleHost) {}

  isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  async show(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      this.pushState();
      return;
    }
    const saved = this.normalizeSavedPosition(this.host.loadPreference('capsule.position'));
    this.expanded = saved?.expanded ?? false;
    const bounds = this.expanded
      ? { width: PANEL_WIDTH, height: PANEL_HEIGHT }
      : { width: BALL_SIZE, height: BALL_SIZE };

    this.window = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      icon: this.host.iconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());

    if (saved) {
      this.window.setBounds({ ...saved, ...bounds });
    } else {
      const area = screen.getPrimaryDisplay().workArea;
      this.window.setBounds({
        x: area.x + area.width - bounds.width - EDGE_MARGIN,
        y: area.y + area.height - bounds.height - EDGE_MARGIN * 4,
        ...bounds,
      });
    }

    this.window.on('closed', () => {
      this.window = null;
    });
    this.window.webContents.on('did-finish-load', () => this.pushState());

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      await this.window.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/capsule.html`);
    } else {
      await this.window.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/capsule.html`),
      );
    }
    this.window.showInactive();
  }

  async hide(): Promise<void> {
    this.window?.close();
    this.window = null;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.host.savePreference('capsule.enabled', enabled);
    if (enabled) await this.show();
    else await this.hide();
  }

  isEnabled(): boolean {
    return this.host.loadPreference('capsule.enabled') !== false;
  }

  async setExpanded(expanded: boolean): Promise<void> {
    if (!this.window || this.expanded === expanded) return;
    this.expanded = expanded;
    const bounds = this.window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    if (expanded) {
      const width = PANEL_WIDTH;
      const height = PANEL_HEIGHT;
      const anchorRight = bounds.x + BALL_SIZE / 2 > area.x + area.width / 2;
      const x = anchorRight
        ? bounds.x + BALL_SIZE - width
        : bounds.x;
      const y = clamp(
        bounds.y + BALL_SIZE - height,
        area.y + EDGE_MARGIN,
        Math.max(area.y + EDGE_MARGIN, area.y + area.height - height - EDGE_MARGIN),
      );
      this.window.setBounds({ x, y, width, height }, true);
    } else {
      const width = BALL_SIZE;
      const height = BALL_SIZE;
      const anchorRight = bounds.x + bounds.width / 2 > area.x + area.width / 2;
      const x = anchorRight ? bounds.x + bounds.width - width : bounds.x;
      const y = clamp(
        bounds.y + bounds.height - height,
        area.y + EDGE_MARGIN,
        Math.max(area.y + EDGE_MARGIN, area.y + area.height - height - EDGE_MARGIN),
      );
      this.window.setBounds({ x, y, width, height }, true);
    }
    this.pushState();
  }

  handleDragMove(screenX: number, screenY: number): void {
    if (!this.window) return;
    if (!this.dragOffset) {
      const bounds = this.window.getBounds();
      this.dragOffset = { x: screenX - bounds.x, y: screenY - bounds.y };
    }
    this.window.setPosition(
      Math.round(screenX - this.dragOffset.x),
      Math.round(screenY - this.dragOffset.y),
    );
  }

  async handleDragEnd(screenX: number, screenY: number): Promise<void> {
    if (!this.window) return;
    this.dragOffset = null;
    const bounds = this.window.getBounds();
    const area = screen.getDisplayNearestPoint({ x: screenX, y: screenY }).workArea;
    const anchorRight = bounds.x + bounds.width / 2 > area.x + area.width / 2;
    const x = anchorRight
      ? area.x + area.width - bounds.width - EDGE_MARGIN
      : area.x + EDGE_MARGIN;
    const y = clamp(
      bounds.y,
      area.y + EDGE_MARGIN,
      Math.max(area.y + EDGE_MARGIN, area.y + area.height - bounds.height - EDGE_MARGIN),
    );
    this.window.setBounds({ x, y, width: bounds.width, height: bounds.height }, true);
    await this.host.savePreference('capsule.position', { x, y, expanded: this.expanded });
  }

  showContextMenu(labels: { open: string; sync: string; watching: string; hide: string }): void {
    if (!this.window) return;
    const menu = Menu.buildFromTemplate([
      { label: labels.open, click: () => this.host.openMainWindow() },
      { label: labels.sync, click: () => void this.host.sync() },
      {
        label: labels.watching,
        type: 'checkbox',
        checked: this.host.getState().watching,
        click: () => void this.host.toggleWatch(),
      },
      { type: 'separator' },
      { label: labels.hide, click: () => void this.setEnabled(false) },
    ]);
    menu.popup({ window: this.window });
  }

  pushState(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC.capsuleStateChanged, this.getState());
    }
  }

  getState(): CapsuleState {
    return { ...this.host.getState(), expanded: this.expanded };
  }

  async destroy(): Promise<void> {
    await this.hide();
  }

  private normalizeSavedPosition(value: unknown): (CapsulePosition & { width?: never }) | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<CapsulePosition>;
    if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return null;
    const point = { x: candidate.x, y: candidate.y };
    // Clamp into whichever display currently contains (or is nearest to) the point.
    const area = screen.getDisplayNearestPoint(point).workArea;
    return {
      x: clamp(candidate.x, area.x, Math.max(area.x, area.x + area.width - BALL_SIZE)),
      y: clamp(candidate.y, area.y, Math.max(area.y, area.y + area.height - BALL_SIZE)),
      expanded: candidate.expanded === true,
    };
  }
}
