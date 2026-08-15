import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapsuleBubbleMood, CapsuleDockStatus, CapsuleState } from '../shared/contracts';
import { capsuleApi } from './api';
import { COPY, type CapsuleLocale } from './copy';
import { CUSTOM_SKIN_ID, DEFAULT_SKIN_ID, resolveSkin } from './skins';
import { QuickAsk } from './QuickAsk';
import { RelayFlow } from './RelayFlow';
import { PromptAssist } from './PromptAssist';
import {
  isAmbientBubbleEnabled,
  isAgentNotifyEnabled,
  setAmbientBubbleEnabled,
  setAgentNotifyEnabled,
} from '../ui/companion/ambientBubble';
import owlCalm from '../ui/assets/owl/calm.png';
import owlThinking from '../ui/assets/owl/thinking.png';
import owlDelighted from '../ui/assets/owl/delighted.png';
import owlSpark from '../ui/assets/owl/spark.png';
import owlSleepy from '../ui/assets/owl/sleepy.png';
import owlWarm from '../ui/assets/owl/warm.png';

type PanelView = 'home' | 'relay' | 'prompts';

/** Temporary panel heights for the layered dock views (px). */
const FLOW_PANEL_HEIGHT = 560;
const TOAST_DURATION_MS = 2_400;

/** Bubble card shows at most this many characters (main caps payloads at 200). */
const BUBBLE_TEXT_MAX_CHARS = 80;

/** Mood owl icons inside the bubble card (same assets as the main renderer). */
const BUBBLE_MOOD_ICONS: Record<CapsuleBubbleMood, string> = {
  calm: owlCalm,
  thinking: owlThinking,
  delighted: owlDelighted,
  spark: owlSpark,
  sleepy: owlSleepy,
  warm: owlWarm,
};

const DRAG_THRESHOLD_PX = 5;

export function Capsule() {
  const [state, setState] = useState<CapsuleState>({
    watching: false,
    syncing: false,
    conversationCount: 0,
    expanded: false,
    bubble: null,
  });
  const [locale, setLocale] = useState<CapsuleLocale>('zh');
  const [skinId, setSkinId] = useState<string>(DEFAULT_SKIN_ID);
  // DIY 自定义皮肤：dataUrl 在运行时才存在（主进程 custom-owl.png），
  // owlCustomUpdatedAt pref 是主窗口重新生成后的刷新信号。
  const [customOwl, setCustomOwl] = useState<string | null>(null);
  const [customOwlNonce, setCustomOwlNonce] = useState(0);
  const [view, setView] = useState<PanelView>('home');
  const [dockStatus, setDockStatus] = useState<CapsuleDockStatus | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ambientEnabled, setAmbientEnabled] = useState<boolean>(true);
  const [agentNotifyEnabled, setAgentNotifyEnabledState] = useState<boolean>(true);
  const [dragging, setDragging] = useState(false);
  const dragFrameRef = useRef<number | null>(null);
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);

  useEffect(() => {
    const api = capsuleApi();
    if (!api) return;
    void api.getState().then(setState);
    return api.onStateChanged(setState);
  }, []);

  // Follow the shared language + theme preferences.
  useEffect(() => {
    const bridge = window.vestiUi;
    if (!bridge) return;
    const apply = (key: string, value: unknown) => {
      if (key === 'language' && value && typeof value === 'object') {
        const next = (value as { locale?: string }).locale;
        if (next === 'zh' || next === 'en' || next === 'ja' || next === 'ko') setLocale(next);
      }
      if (key === 'theme') {
        document.documentElement.dataset.theme = value === 'dark' ? 'dark' : 'light';
      }
      if (key === 'owlSkin') {
        setSkinId(value === CUSTOM_SKIN_ID ? CUSTOM_SKIN_ID : resolveSkin(value).id);
      }
      if (key === 'owlCustomUpdatedAt') {
        setCustomOwlNonce(nonce => nonce + 1);
      }
    };
    void bridge.getUiPreference('language').then(value => apply('language', value));
    void bridge.getUiPreference('theme').then(value => apply('theme', value));
    void bridge.getUiPreference('owlSkin').then(value => apply('owlSkin', value));
    return bridge.onUiPreferenceChanged(apply);
  }, []);

  // Load the bubble/notify toggles.
  useEffect(() => {
    void isAmbientBubbleEnabled().then(setAmbientEnabled).catch(() => undefined);
    void isAgentNotifyEnabled().then(setAgentNotifyEnabledState).catch(() => undefined);
  }, []);

  // Load the DIY skin artwork when the custom slot is selected.
  useEffect(() => {
    if (skinId !== CUSTOM_SKIN_ID) {
      setCustomOwl(null);
      return;
    }
    let cancelled = false;
    void window.vesti
      ?.readCustomOwl()
      .then(asset => {
        if (!cancelled) setCustomOwl(asset?.dataUrl ?? null);
      })
      .catch(() => {
        if (!cancelled) setCustomOwl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [skinId, customOwlNonce]);

  // Collapsing the ball always returns the panel to the home view.
  useEffect(() => {
    if (!state.expanded) setView('home');
  }, [state.expanded]);

  // Dock status (LLM / extension / sources) refreshes each time the panel
  // opens or a flow exits back home.
  useEffect(() => {
    if (!state.expanded) return;
    void capsuleApi()?.getDockStatus().then(setDockStatus).catch(() => setDockStatus(null));
  }, [state.expanded, view]);

  // Flow views get a taller window; home restores the default panel height.
  useEffect(() => {
    if (!state.expanded) return;
    void capsuleApi()?.setPanelHeight(view === 'home' ? null : FLOW_PANEL_HEIGHT);
  }, [state.expanded, view]);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  const copy = COPY[locale];
  const skin = resolveSkin(skinId);
  // 自定义槽位有图用图，没图（还没生成过）回落默认皮肤。
  const skinImage = skinId === CUSTOM_SKIN_ID && customOwl ? customOwl : skin.collapsed;

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    // Capture the pointer so move/up events keep targeting this element even
    // when the cursor leaves the small window mid-drag. Without capture the
    // drag stalls as soon as the cursor exits the ball rect (no more dragMove
    // IPC), pointerup is lost, and the stale drag offset left in the main
    // process made the ball jump on the next drag.
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      dragging: false,
    };
    capsuleApi()?.dragStart(event.screenX, event.screenY);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (!drag.dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      drag.dragging = true;
      setDragging(true);
    }
    if (drag.dragging) {
      pendingPointRef.current = { x: event.screenX, y: event.screenY };
      if (dragFrameRef.current === null) {
        dragFrameRef.current = window.requestAnimationFrame(() => {
          dragFrameRef.current = null;
          const point = pendingPointRef.current;
          pendingPointRef.current = null;
          if (point) capsuleApi()?.dragMove(point.x, point.y);
        });
      }
    }
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      pendingPointRef.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (drag.dragging) {
        capsuleApi()?.dragMove(event.screenX, event.screenY);
        void capsuleApi()?.dragEnd(event.screenX, event.screenY);
      } else {
        capsuleApi()?.dragCancel();
        void capsuleApi()?.setExpanded(!state.expanded);
      }
    },
    [state.expanded],
  );

  const handlePointerCancel = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    pendingPointRef.current = null;
    setDragging(false);
    capsuleApi()?.dragCancel();
  }, []);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      capsuleApi()?.showContextMenu({
        open: copy.menuOpen,
        sync: copy.menuSync,
        watching: copy.menuWatching,
        hide: copy.menuHide,
      });
    },
    [copy],
  );

  // 夜话 dock entry: open/focus the main window on the Explore tab (the
  // companion chat lives there) and fold the panel back to the ball.
  const handleOpenNightChat = useCallback(() => {
    void capsuleApi()?.openMainTab('explore');
    void capsuleApi()?.setExpanded(false);
  }, []);

  const handleDismissBubble = useCallback(() => {
    void capsuleApi()?.dismissBubble();
  }, []);

  // Bubble form: ball (unchanged spot) + a card above it. Click anywhere on
  // the card or the ball folds back to the plain ball; the main process also
  // auto-dismisses on its timeout.
  if (state.bubble) {
    const bubble = state.bubble;
    const moodIcon = bubble.mood ? BUBBLE_MOOD_ICONS[bubble.mood] : null;
    const text =
      bubble.text.length > BUBBLE_TEXT_MAX_CHARS
        ? `${bubble.text.slice(0, BUBBLE_TEXT_MAX_CHARS - 1)}…`
        : bubble.text;
    return (
      <div className="capsule-root">
        <div className={`capsule-bubble${bubble.anchorRight ? ' anchor-right' : ''}`}>
          <button type="button" className="capsule-bubble-card" onClick={handleDismissBubble}>
            {moodIcon && <img src={moodIcon} alt="" draggable={false} />}
            <span className="capsule-bubble-text">{text}</span>
          </button>
          <div className="capsule-bubble-ball">
            <div
              className={`capsule-ball${state.syncing ? ' syncing' : ''}`}
              role="button"
              aria-label={copy.dock}
              onClick={handleDismissBubble}
              onContextMenu={handleContextMenu}
            >
              <img src={skinImage} alt="Vesti" draggable={false} data-skin={skin.id} />
              <span className={`status-dot${state.watching ? ' watching' : ''}`} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!state.expanded) {
    return (
      <div className="capsule-root">
        <div
          className={`capsule-ball${state.syncing ? ' syncing' : ''}${dragging ? ' dragging' : ''}`}
          role="button"
          aria-label={copy.dock}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
        >
          <img src={skinImage} alt="Vesti" draggable={false} data-skin={skin.id} />
          <span className={`status-dot${state.watching ? ' watching' : ''}`} />
        </div>
      </div>
    );
  }

  const llmConfigured = dockStatus?.llmConfigured ?? false;
  const extensionConnected = dockStatus?.extensionConnected ?? false;

  return (
    <div className="capsule-root">
      <div className="capsule-panel" onContextMenu={handleContextMenu}>
        <div
          className={`capsule-panel-header${dragging ? ' dragging' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <img src={skinImage} alt="Vesti" draggable={false} data-skin={skin.id} />
          <span className="title">{copy.dock}</span>
          <button
            type="button"
            className="collapse"
            aria-label="Collapse"
            onClick={() => void capsuleApi()?.setExpanded(false)}
          >
            ×
          </button>
        </div>

        {view === 'home' && (
          <>
            <div className="capsule-home">
              <QuickAsk
                copy={copy}
                llmConfigured={llmConfigured}
                llmMode={dockStatus?.llmMode}
                defaultModelId={dockStatus?.defaultModelId}
                onToast={showToast}
              />
              <div className="capsule-home-actions">
                <button
                  type="button"
                  className="capsule-action primary"
                  onClick={() => setView('relay')}
                >
                  <span className="icon">⇄</span>
                  {copy.relay}
                </button>
                <button
                  type="button"
                  className="capsule-action primary"
                  onClick={() => setView('prompts')}
                >
                  <span className="icon">✦</span>
                  {copy.prompts}
                </button>
                <button
                  type="button"
                  className="capsule-action primary"
                  onClick={handleOpenNightChat}
                >
                  <img className="icon" src={owlCalm} alt="" draggable={false} />
                  {copy.nightChat}
                </button>
              </div>

              <div className="capsule-toggles">
                <label className="capsule-toggle">
                  <span className="min-w-0">
                    <span className="capsule-toggle-label">{copy.ambientBubble}</span>
                    <span className="capsule-toggle-hint">{copy.ambientBubbleHint}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={ambientEnabled}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setAmbientEnabled(next);
                      void setAmbientBubbleEnabled(next);
                    }}
                  />
                  <span className="capsule-toggle-switch" aria-hidden="true" />
                </label>
                <label className="capsule-toggle">
                  <span className="min-w-0">
                    <span className="capsule-toggle-label">{copy.agentNotify}</span>
                    <span className="capsule-toggle-hint">{copy.agentNotifyHint}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={agentNotifyEnabled}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setAgentNotifyEnabledState(next);
                      void setAgentNotifyEnabled(next);
                    }}
                  />
                  <span className="capsule-toggle-switch" aria-hidden="true" />
                </label>
              </div>
            </div>

            <div className="capsule-statusline">
              <span className={`dot${state.watching ? ' on' : ''}`} />
              <span>
                {copy.statusSources} <strong>{dockStatus?.sourceCount ?? '–'}</strong>
                {' · '}
                {copy.conversations} <strong>{state.conversationCount}</strong>
                {' · '}
                {state.syncing ? copy.syncing : state.watching ? copy.statusLive : copy.statusPaused}
              </span>
            </div>

            <div className="capsule-panel-footer">
              <button
                type="button"
                className="capsule-hide"
                onClick={() => void capsuleApi()?.openMainWindow()}
              >
                {copy.openMain}
              </button>
            </div>
          </>
        )}

        {view === 'relay' && (
          <RelayFlow
            copy={copy}
            llmConfigured={llmConfigured}
            extensionConnected={extensionConnected}
            onExit={() => setView('home')}
            onToast={showToast}
          />
        )}

        {view === 'prompts' && (
          <PromptAssist
            copy={copy}
            extensionConnected={extensionConnected}
            llmConfigured={llmConfigured}
            onExit={() => setView('home')}
            onToast={showToast}
          />
        )}

        {toast && <div className="capsule-toast">{toast}</div>}
      </div>
    </div>
  );
}
