import { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapsuleWindowService,
  ballBoundsFromBubble,
  bubbleWindowBounds,
  normalizeCapsuleBubblePayload,
} from './capsuleWindowService';
import { IPC } from '../shared/contracts';

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const BALL = 56;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

vi.mock('electron', () => {
  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = [];
    bounds: Rect;
    hidden = true;
    destroyed = false;
    webContents = {
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    on = vi.fn();
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);

    constructor(options: { width: number; height: number }) {
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      MockBrowserWindow.instances.push(this);
    }
    showInactive() {
      this.hidden = false;
    }
    show() {
      this.hidden = false;
    }
    hide() {
      this.hidden = true;
    }
    close() {
      this.destroyed = true;
    }
    setBounds(next: Rect) {
      this.bounds = { ...next };
    }
    setPosition(x: number, y: number) {
      this.bounds = { ...this.bounds, x, y };
    }
    getBounds(): Rect {
      return { ...this.bounds };
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return !this.hidden && !this.destroyed;
    }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    screen: {
      getPrimaryDisplay: () => ({ workArea: AREA }),
      getDisplayMatching: () => ({ workArea: AREA }),
      getDisplayNearestPoint: () => ({ workArea: AREA }),
    },
  };
});

type MockWindow = InstanceType<typeof BrowserWindow> & { bounds: Rect };

function mockWindows(): MockWindow[] {
  return (BrowserWindow as unknown as { instances: MockWindow[] }).instances;
}

function makeHost() {
  return {
    getState: () => ({ watching: false, syncing: false, conversationCount: 3 }),
    sync: vi.fn(async () => undefined),
    toggleWatch: vi.fn(async () => true),
    openMainWindow: vi.fn(),
    loadPreference: () => null,
    savePreference: vi.fn(async () => undefined),
    iconPath: () => 'icon.png',
  };
}

async function shownService(): Promise<{ service: CapsuleWindowService; win: MockWindow }> {
  const service = new CapsuleWindowService(makeHost());
  await service.show();
  const win = mockWindows()[mockWindows().length - 1];
  // No saved position: ball docks at the right edge, 64px above the bottom.
  expect(win.bounds).toEqual({ x: 1848, y: 920, width: BALL, height: BALL });
  return { service, win };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockWindows().length = 0;
  // Vite-injected globals (declared in global.d.ts) — force the loadFile path.
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'test');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('normalizeCapsuleBubblePayload', () => {
  it('accepts a minimal payload and applies defaults', () => {
    expect(normalizeCapsuleBubblePayload({ text: '今天也想听听你的进展' })).toEqual({
      text: '今天也想听听你的进展',
      mood: null,
      timeoutMs: 8_000,
    });
  });

  it('keeps whitelisted moods and drops unknown ones', () => {
    expect(normalizeCapsuleBubblePayload({ text: 'hi', mood: 'sleepy' })?.mood).toBe('sleepy');
    expect(normalizeCapsuleBubblePayload({ text: 'hi', mood: 'angry' })?.mood).toBeNull();
  });

  it('clamps timeoutMs into 500-30000 and defaults non-numbers', () => {
    expect(normalizeCapsuleBubblePayload({ text: 'hi', timeoutMs: 100 })?.timeoutMs).toBe(500);
    expect(normalizeCapsuleBubblePayload({ text: 'hi', timeoutMs: 99_999 })?.timeoutMs).toBe(30_000);
    expect(normalizeCapsuleBubblePayload({ text: 'hi', timeoutMs: '8s' })?.timeoutMs).toBe(8_000);
  });

  it('rejects empty / oversized / non-string text and non-objects', () => {
    expect(normalizeCapsuleBubblePayload(null)).toBeNull();
    expect(normalizeCapsuleBubblePayload('hi')).toBeNull();
    expect(normalizeCapsuleBubblePayload({})).toBeNull();
    expect(normalizeCapsuleBubblePayload({ text: '' })).toBeNull();
    expect(normalizeCapsuleBubblePayload({ text: '   ' })).toBeNull();
    expect(normalizeCapsuleBubblePayload({ text: 42 })).toBeNull();
    expect(normalizeCapsuleBubblePayload({ text: 'x'.repeat(201) })).toBeNull();
    expect(normalizeCapsuleBubblePayload({ text: 'x'.repeat(200) })?.text).toHaveLength(200);
  });
});

describe('bubble bounds math', () => {
  it('grows above the ball toward the screen center, ball position preserved', () => {
    const ball = { x: 1848, y: 920, width: BALL, height: BALL };
    const bubble = bubbleWindowBounds(ball, AREA);
    expect(bubble).toEqual({ x: 1564, y: 846, width: 340, height: 130 });
    // The ball's screen rect is identical inside the new window.
    expect(bubble.x + bubble.width - BALL).toBe(ball.x);
    expect(bubble.y + bubble.height - BALL).toBe(ball.y);
    expect(ballBoundsFromBubble(bubble, true, AREA)).toEqual(ball);
  });

  it('widens left-anchored balls to the right', () => {
    const ball = { x: 16, y: 920, width: BALL, height: BALL };
    const bubble = bubbleWindowBounds(ball, AREA);
    expect(bubble).toEqual({ x: 16, y: 846, width: 340, height: 130 });
    expect(ballBoundsFromBubble(bubble, false, AREA)).toEqual(ball);
  });

  it('clamps against the work-area top when the ball sits too high', () => {
    const ball = { x: 1848, y: 4, width: BALL, height: BALL };
    const bubble = bubbleWindowBounds(ball, AREA);
    expect(bubble.y).toBe(16);
    expect(bubble.height).toBe(130);
  });
});

describe('CapsuleWindowService bubble form', () => {
  it('showBubble resizes to the ball+card window and pushes the payload', async () => {
    const { service, win } = await shownService();
    await service.showBubble({ text: '梦境整理好了', mood: 'sleepy', timeoutMs: 8_000 });
    expect(win.bounds).toEqual({ x: 1564, y: 846, width: 340, height: 130 });
    expect(service.getState().bubble).toEqual({
      text: '梦境整理好了',
      mood: 'sleepy',
      anchorRight: true,
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC.capsuleStateChanged,
      expect.objectContaining({ bubble: expect.objectContaining({ text: '梦境整理好了' }) }),
    );
  });

  it('dismissBubble folds the window back onto the unmoved ball', async () => {
    const { service, win } = await shownService();
    await service.showBubble({ text: 'hi', mood: null, timeoutMs: 8_000 });
    await service.dismissBubble();
    expect(win.bounds).toEqual({ x: 1848, y: 920, width: BALL, height: BALL });
    expect(service.getState().bubble).toBeNull();
  });

  it('auto-dismisses after timeoutMs', async () => {
    const { service, win } = await shownService();
    await service.showBubble({ text: 'hi', mood: null, timeoutMs: 500 });
    vi.advanceTimersByTime(499);
    expect(service.getState().bubble).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getState().bubble).toBeNull();
    expect(win.bounds).toEqual({ x: 1848, y: 920, width: BALL, height: BALL });
  });

  it('re-showing replaces the content without resizing and restarts the timer', async () => {
    const { service, win } = await shownService();
    await service.showBubble({ text: '第一条', mood: 'calm', timeoutMs: 8_000 });
    const boundsAfterFirst = win.bounds;
    vi.advanceTimersByTime(7_900);
    await service.showBubble({ text: '第二条', mood: 'warm', timeoutMs: 8_000 });
    expect(win.bounds).toEqual(boundsAfterFirst);
    expect(service.getState().bubble).toMatchObject({ text: '第二条', mood: 'warm' });
    // The original timer was reset: 7.9s after the replacement still shows.
    vi.advanceTimersByTime(7_900);
    expect(service.getState().bubble).not.toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(service.getState().bubble).toBeNull();
  });

  it('ignores showBubble while the panel is expanded', async () => {
    const { service, win } = await shownService();
    await service.setExpanded(true);
    const panelBounds = win.bounds;
    await service.showBubble({ text: 'hi', mood: null, timeoutMs: 8_000 });
    expect(win.bounds).toEqual(panelBounds);
    expect(service.getState().bubble).toBeNull();
  });

  it('setExpanded(true) from the bubble anchors the panel on the ball spot', async () => {
    const { service, win } = await shownService();
    await service.showBubble({ text: 'hi', mood: null, timeoutMs: 8_000 });
    await service.setExpanded(true);
    expect(service.getState().bubble).toBeNull();
    expect(win.bounds).toEqual({ x: 1564, y: 632, width: 340, height: 344 });
    vi.advanceTimersByTime(10_000);
    expect(service.getState().expanded).toBe(true);
  });

  it('hide() clears a pending bubble timer', async () => {
    const { service } = await shownService();
    await service.showBubble({ text: 'hi', mood: null, timeoutMs: 8_000 });
    await service.hide();
    vi.advanceTimersByTime(10_000);
    expect(service.getState().bubble).toBeNull();
  });
});
