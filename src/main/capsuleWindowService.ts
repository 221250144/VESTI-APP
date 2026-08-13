import { BrowserWindow, Menu, screen } from 'electron';
import path from 'node:path';
import {
  CAPSULE_BUBBLE_MOODS,
  IPC,
  type CapsuleBubbleMood,
  type CapsuleBubblePayload,
  type CapsuleState,
} from '../shared/contracts';

const BALL_SIZE = 56;
const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 344;
const EDGE_MARGIN = 16;
/** Bubble form height: card zone (68px) + a small gap over the ball row. */
const BUBBLE_HEIGHT = 130;
export const CAPSULE_BUBBLE_DEFAULT_TIMEOUT_MS = 8_000;
export const CAPSULE_BUBBLE_MIN_TIMEOUT_MS = 500;
export const CAPSULE_BUBBLE_MAX_TIMEOUT_MS = 30_000;
export const CAPSULE_BUBBLE_MAX_TEXT_CHARS = 200;

export interface CapsulePosition {
  x: number;
  y: number;
  expanded?: boolean;
}

interface CapsuleHost {
  getState(): Omit<CapsuleState, 'expanded' | 'bubble'>;
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

/** Validated bubble payload (main-process side of the show-bubble IPC). */
export interface NormalizedCapsuleBubble {
  text: string;
  mood: CapsuleBubbleMood | null;
  timeoutMs: number;
}

/**
 * Validate a show-bubble IPC payload: text must be non-empty within the
 * cap, mood is whitelist-filtered (unknown values drop to null), and the
 * timeout is clamped into 500-30000ms (default 8s). null = reject.
 */
export function normalizeCapsuleBubblePayload(value: unknown): NormalizedCapsuleBubble | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<CapsuleBubblePayload>;
  if (typeof input.text !== 'string') return null;
  const text = input.text.trim();
  if (!text || input.text.length > CAPSULE_BUBBLE_MAX_TEXT_CHARS) return null;
  const mood = CAPSULE_BUBBLE_MOODS.includes(input.mood as CapsuleBubbleMood)
    ? (input.mood as CapsuleBubbleMood)
    : null;
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? clamp(Math.round(input.timeoutMs), CAPSULE_BUBBLE_MIN_TIMEOUT_MS, CAPSULE_BUBBLE_MAX_TIMEOUT_MS)
      : CAPSULE_BUBBLE_DEFAULT_TIMEOUT_MS;
  return { text, mood, timeoutMs };
}

/**
 * Bubble-form window bounds: the ball keeps its exact screen position
 * while the card opens above it, widening toward the screen center - the
 * same anchor rule setExpanded uses for the panel.
 */
export function bubbleWindowBounds(
  ball: Electron.Rectangle,
  area: Electron.Rectangle,
): Electron.Rectangle {
  const width = PANEL_WIDTH;
  const height = BUBBLE_HEIGHT;
  const anchorRight = ball.x + BALL_SIZE / 2 > area.x + area.width / 2;
  const x = anchorRight ? ball.x + BALL_SIZE - width : ball.x;
  const y = clamp(
    ball.y + BALL_SIZE - height,
    area.y + EDGE_MARGIN,
    Math.max(area.y + EDGE_MARGIN, area.y + area.height - height - EDGE_MARGIN),
  );
  return { x, y, width, height };
}

/** Inverse of bubbleWindowBounds: fold the bubble form back onto the ball. */
export function ballBoundsFromBubble(
  bubble: Electron.Rectangle,
  anchorRight: boolean,
  area: Electron.Rectangle,
): Electron.Rectangle {
  const x = anchorRight ? bubble.x + bubble.width - BALL_SIZE : bubble.x;
  const y = clamp(
    bubble.y + bubble.height - BALL_SIZE,
    area.y + EDGE_MARGIN,
    Math.max(area.y + EDGE_MARGIN, area.y + area.height - BALL_SIZE - EDGE_MARGIN),
  );
  return { x, y, width: BALL_SIZE, height: BALL_SIZE };
}

/**
 * Owns the desktop floating capsule ("小猫头鹰悬浮球"): a small always-on-top
 * transparent window that collapses to the owl ball and expands into a quick
 * actions panel. Dragging leaves the ball anywhere inside the work area; the
 * position persists through the UI-prefs store.
 */
export class CapsuleWindowService {
  private window: BrowserWindow | null = null;
  private expanded = false;
  /** Temporary expanded-panel height override (dock flows); null = default. */
  private panelHeight: number | null = null;
  private dragOffset: { x: number; y: number } | null = null;
  /** Active bubble form state; null when the capsule is ball/panel only. */
  private bubble: {
    text: string;
    mood: CapsuleBubbleMood | null;
    anchorRight: boolean;
    timer: NodeJS.Timeout | null;
  } | null = null;

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
    if (this.bubble?.timer) clearTimeout(this.bubble.timer);
    this.bubble = null;
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
    if (this.bubble) {
      // Expand/collapse anchors on the ball: fold an open bubble back
      // first (in place, while hidden) so the math below sees ball bounds.
      const bubble = this.bubble;
      this.bubble = null;
      if (bubble.timer) clearTimeout(bubble.timer);
      const bounds = this.window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      this.window.hide();
      this.window.setBounds(ballBoundsFromBubble(bounds, bubble.anchorRight, area));
    }
    this.expanded = expanded;
    // Re-expanding always starts from the default panel height; dock flows
    // grow it again via setPanelHeight as needed.
    this.panelHeight = null;
    const bounds = this.window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    let next: Electron.Rectangle;
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
      next = { x, y, width, height };
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
      next = { x, y, width, height };
    }
    // Instant resize between hide/show instead of an animated setBounds:
    // animated resizes leave ghost frames on transparent Windows windows.
    // The enter transition lives in the content CSS (capsule-enter).
    this.window.hide();
    this.window.setBounds(next);
    this.window.showInactive();
    this.pushState();
  }

  /**
   * Temporarily grow/shrink the expanded panel (dock flows need more room
   * than the home screen). Instant hide/setBounds/show like setExpanded —
   * animated resizes leave ghost frames on transparent Windows windows.
   * Pass null to restore the default panel height.
   */
  async setPanelHeight(height: number | null): Promise<void> {
    if (!this.window || this.window.isDestroyed() || !this.expanded) return;
    const next = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : null;
    if (this.panelHeight === next) return;
    this.panelHeight = next;
    const bounds = this.window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const maxHeight = Math.max(PANEL_HEIGHT, area.height - EDGE_MARGIN * 2);
    const nextHeight = clamp(this.panelHeight ?? PANEL_HEIGHT, PANEL_HEIGHT, maxHeight);
    const y = clamp(
      bounds.y,
      area.y + EDGE_MARGIN,
      Math.max(area.y + EDGE_MARGIN, area.y + area.height - nextHeight - EDGE_MARGIN),
    );
    this.window.hide();
    this.window.setBounds({ x: bounds.x, y, width: PANEL_WIDTH, height: nextHeight });
    this.window.showInactive();
  }

  /**
   * Bubble form (third capsule shape): the ball stays exactly where it is
   * while a card opens above it; timeoutMs later the window folds back to
   * the ball. Only available from the collapsed ball - an open panel is
   * left alone. Re-showing replaces the content and restarts the timer.
   */
  async showBubble(payload: NormalizedCapsuleBubble): Promise<void> {
    if (!this.window || this.window.isDestroyed() || this.expanded) return;
    if (this.bubble) {
      if (this.bubble.timer) clearTimeout(this.bubble.timer);
      this.bubble.text = payload.text;
      this.bubble.mood = payload.mood;
    } else {
      const ball = this.window.getBounds();
      const area = screen.getDisplayMatching(ball).workArea;
      this.bubble = {
        text: payload.text,
        mood: payload.mood,
        anchorRight: ball.x + BALL_SIZE / 2 > area.x + area.width / 2,
        timer: null,
      };
      // Same instant hide/setBounds/show swap as setExpanded.
      this.window.hide();
      this.window.setBounds(bubbleWindowBounds(ball, area));
      this.window.showInactive();
    }
    this.bubble.timer = setTimeout(() => {
      void this.dismissBubble();
    }, payload.timeoutMs);
    this.pushState();
  }

  /** Fold the bubble form back to the ball (click, timeout, or API). */
  async dismissBubble(): Promise<void> {
    if (!this.bubble) return;
    const bubble = this.bubble;
    this.bubble = null;
    if (bubble.timer) clearTimeout(bubble.timer);
    if (this.window && !this.window.isDestroyed()) {
      const bounds = this.window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      this.window.hide();
      this.window.setBounds(ballBoundsFromBubble(bounds, bubble.anchorRight, area));
      this.window.showInactive();
    }
    this.pushState();
  }

  handleDragStart(screenX: number, screenY: number): void {
    if (!this.window) return;
    const bounds = this.window.getBounds();
    this.dragOffset = {
      x: clamp(screenX - bounds.x, 0, bounds.width),
      y: clamp(screenY - bounds.y, 0, bounds.height),
    };
  }

  handleDragCancel(): void {
    this.dragOffset = null;
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
    // Free placement: the ball stays where the user dropped it, only clamped
    // fully inside the work area. Panel/bubble anchoring derives its direction
    // from whichever screen half the ball sits in, so any position works.
    const x = clamp(
      bounds.x,
      area.x + EDGE_MARGIN,
      Math.max(area.x + EDGE_MARGIN, area.x + area.width - bounds.width - EDGE_MARGIN),
    );
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
    return {
      ...this.host.getState(),
      expanded: this.expanded,
      bubble: this.bubble
        ? { text: this.bubble.text, mood: this.bubble.mood, anchorRight: this.bubble.anchorRight }
        : null,
    };
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
