import { useCallback, useEffect, useRef, useState } from 'react';
import { LOGO_BASE64 } from '../ui/logo';
import type { CapsuleState, VestiCapsuleApi } from '../shared/contracts';

type Locale = 'zh' | 'en' | 'ja' | 'ko';

const COPY: Record<Locale, Record<string, string>> = {
  zh: {
    dock: 'Vesti Dock',
    liveOn: '实时采集中',
    liveOff: '采集已暂停',
    syncing: '正在同步…',
    conversations: '已归档会话',
    syncNow: '立即同步',
    openMain: '打开主界面',
    pause: '暂停采集',
    resume: '恢复采集',
    hide: '隐藏悬浮球',
    menuOpen: '打开 Vesti',
    menuSync: '立即同步',
    menuWatching: '实时采集',
    menuHide: '隐藏悬浮球',
  },
  en: {
    dock: 'Vesti Dock',
    liveOn: 'Live capture on',
    liveOff: 'Capture paused',
    syncing: 'Syncing…',
    conversations: 'Archived sessions',
    syncNow: 'Sync now',
    openMain: 'Open Vesti',
    pause: 'Pause capture',
    resume: 'Resume capture',
    hide: 'Hide floating ball',
    menuOpen: 'Open Vesti',
    menuSync: 'Sync now',
    menuWatching: 'Live capture',
    menuHide: 'Hide floating ball',
  },
  ja: {
    dock: 'Vesti Dock',
    liveOn: 'リアルタイム収集中',
    liveOff: '収集を一時停止中',
    syncing: '同期中…',
    conversations: 'アーカイブ済み会話',
    syncNow: '今すぐ同期',
    openMain: 'メイン画面を開く',
    pause: '収集を一時停止',
    resume: '収集を再開',
    hide: 'フローティングボールを隠す',
    menuOpen: 'Vesti を開く',
    menuSync: '今すぐ同期',
    menuWatching: 'リアルタイム収集',
    menuHide: 'フローティングボールを隠す',
  },
  ko: {
    dock: 'Vesti Dock',
    liveOn: '실시간 수집 중',
    liveOff: '수집 일시 중지됨',
    syncing: '동기화 중…',
    conversations: '보관된 대화',
    syncNow: '지금 동기화',
    openMain: '메인 화면 열기',
    pause: '수집 일시 중지',
    resume: '수집 재개',
    hide: '플로팅 볼 숨기기',
    menuOpen: 'Vesti 열기',
    menuSync: '지금 동기화',
    menuWatching: '실시간 수집',
    menuHide: '플로팅 볼 숨기기',
  },
};

function capsuleApi(): VestiCapsuleApi | null {
  return typeof window !== 'undefined' && window.vestiCapsule ? window.vestiCapsule : null;
}

const DRAG_THRESHOLD_PX = 5;

export function Capsule() {
  const [state, setState] = useState<CapsuleState>({
    watching: false,
    syncing: false,
    conversationCount: 0,
    expanded: false,
  });
  const [locale, setLocale] = useState<Locale>('zh');
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
    };
    void bridge.getUiPreference('language').then(value => apply('language', value));
    void bridge.getUiPreference('theme').then(value => apply('theme', value));
    return bridge.onUiPreferenceChanged(apply);
  }, []);

  const copy = COPY[locale];

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      dragging: false,
    };
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (!drag.dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      drag.dragging = true;
    }
    if (drag.dragging) {
      capsuleApi()?.dragMove(event.screenX, event.screenY);
    }
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.dragging) {
        void capsuleApi()?.dragEnd(event.screenX, event.screenY);
      } else {
        void capsuleApi()?.setExpanded(!state.expanded);
      }
    },
    [state.expanded],
  );

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    capsuleApi()?.showContextMenu();
  }, []);

  if (!state.expanded) {
    return (
      <div className="capsule-root">
        <div
          className={`capsule-ball${state.syncing ? ' syncing' : ''}`}
          role="button"
          aria-label={copy.dock}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onContextMenu={handleContextMenu}
        >
          <img src={LOGO_BASE64} alt="Vesti" draggable={false} />
          <span className={`status-dot${state.watching ? ' watching' : ''}`} />
        </div>
      </div>
    );
  }

  return (
    <div className="capsule-root">
      <div className="capsule-panel" onContextMenu={handleContextMenu}>
        <div
          className="capsule-panel-header"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <img src={LOGO_BASE64} alt="Vesti" draggable={false} />
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

        <div className="capsule-panel-status">
          <div className="status-row">
            <span className={`dot${state.watching ? ' on' : ''}`} />
            <span>{state.watching ? copy.liveOn : copy.liveOff}</span>
          </div>
          <div className="status-row">
            <span className={`dot${state.syncing ? ' on' : ''}`} />
            <span>
              {state.syncing ? copy.syncing : `${copy.conversations}: `}
              {!state.syncing && <strong>{state.conversationCount}</strong>}
            </span>
          </div>
        </div>

        <div className="capsule-panel-actions">
          <button
            type="button"
            className="capsule-action primary"
            disabled={state.syncing}
            onClick={() => void capsuleApi()?.sync()}
          >
            <span className="icon">⟳</span>
            {copy.syncNow}
          </button>
          <button
            type="button"
            className="capsule-action"
            onClick={() => void capsuleApi()?.openMainWindow()}
          >
            <span className="icon">⌂</span>
            {copy.openMain}
          </button>
          <button
            type="button"
            className="capsule-action"
            onClick={() => void capsuleApi()?.toggleWatch()}
          >
            <span className="icon">{state.watching ? '⏸' : '▶'}</span>
            {state.watching ? copy.pause : copy.resume}
          </button>
        </div>

        <div className="capsule-panel-footer">
          <button
            type="button"
            className="capsule-hide"
            onClick={() => void capsuleApi()?.hideCapsule()}
          >
            {copy.hide}
          </button>
        </div>
      </div>
    </div>
  );
}
