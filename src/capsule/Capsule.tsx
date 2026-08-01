import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapsuleDockStatus, CapsuleState } from '../shared/contracts';
import { capsuleApi } from './api';
import { COPY, type CapsuleLocale } from './copy';
import { DEFAULT_SKIN_ID, resolveSkin } from './skins';
import { QuickAsk } from './QuickAsk';
import { RelayFlow } from './RelayFlow';
import { PromptAssist } from './PromptAssist';

type PanelView = 'home' | 'relay' | 'prompts';

/** Temporary panel heights for the layered dock views (px). */
const FLOW_PANEL_HEIGHT = 560;
const TOAST_DURATION_MS = 2_400;

const DRAG_THRESHOLD_PX = 5;

export function Capsule() {
  const [state, setState] = useState<CapsuleState>({
    watching: false,
    syncing: false,
    conversationCount: 0,
    expanded: false,
  });
  const [locale, setLocale] = useState<CapsuleLocale>('zh');
  const [skinId, setSkinId] = useState<string>(DEFAULT_SKIN_ID);
  const [view, setView] = useState<PanelView>('home');
  const [dockStatus, setDockStatus] = useState<CapsuleDockStatus | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        setSkinId(resolveSkin(value).id);
      }
    };
    void bridge.getUiPreference('language').then(value => apply('language', value));
    void bridge.getUiPreference('theme').then(value => apply('theme', value));
    void bridge.getUiPreference('owlSkin').then(value => apply('owlSkin', value));
    return bridge.onUiPreferenceChanged(apply);
  }, []);

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
          <img src={skin.collapsed} alt="Vesti" draggable={false} data-skin={skin.id} />
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
          <img src={skin.collapsed} alt="Vesti" draggable={false} data-skin={skin.id} />
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
