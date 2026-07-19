import { useEffect, useRef, useState } from 'react';
import type { CapsulePromptHit } from '../shared/contracts';
import { capsuleApi } from './api';
import type { CapsuleCopy } from './copy';

interface PromptAssistProps {
  copy: CapsuleCopy;
  extensionConnected: boolean;
  onExit: () => void;
  onToast: (message: string) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 提示词助手: searches the curated catalog + the user's prompt-library
 * snapshot (read via IPC — the capsule never loads Dexie) and offers copy /
 * send-to-browser delivery for the picked prompt.
 */
export function PromptAssist({ copy, extensionConnected, onExit, onToast }: PromptAssistProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CapsulePromptHit[] | null>(null);
  const [snapshotMissing, setSnapshotMissing] = useState(false);
  const [selected, setSelected] = useState<CapsulePromptHit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const api = capsuleApi();
    if (!api) return;
    void api.getPromptSnapshot()
      .then(snapshot => setSnapshotMissing(!snapshot || snapshot.prompts.length === 0))
      .catch(() => setSnapshotMissing(true));
    void api.searchPrompts('').then(setHits).catch(() => setHits([]));
  }, []);

  useEffect(() => {
    const api = capsuleApi();
    if (!api) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void api.searchPrompts(query).then(setHits).catch(() => setHits([]));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const sendToBrowser = async (body: string) => {
    const api = capsuleApi();
    if (!api || !extensionConnected) return;
    setError(null);
    try {
      await api.enqueueOutbox(body);
      onToast(copy.sentToBrowser);
    } catch (cause) {
      setError(errorMessage(cause, copy.actionFailed));
    }
  };

  return (
    <div className="capsule-flow">
      <div className="capsule-flow-header">
        {selected ? (
          <button type="button" className="flow-back" onClick={() => setSelected(null)}>
            ‹ {copy.back}
          </button>
        ) : (
          <button type="button" className="flow-back" onClick={onExit}>‹ {copy.back}</button>
        )}
        <span className="flow-title">{copy.prompts}</span>
      </div>

      {error && <div className="capsule-inline-error">{error}</div>}

      {selected ? (
        <>
          <div className="capsule-flow-body">
            <div className="prompt-detail-title">{selected.title}</div>
            {selected.description && <div className="prompt-detail-desc">{selected.description}</div>}
            <pre className="relay-preview prompt-body">{selected.body}</pre>
          </div>
          <div className="capsule-flow-footer">
            <button
              type="button"
              className="capsule-action"
              disabled={!extensionConnected}
              title={extensionConnected ? undefined : copy.browserNotConnected}
              onClick={() => void sendToBrowser(selected.body)}
            >
              {copy.sendToBrowser}
            </button>
            <button
              type="button"
              className="capsule-action primary"
              onClick={() => {
                void capsuleApi()?.copyText(selected.body).then(() => onToast(copy.copied));
              }}
            >
              {copy.deliverCopy}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="prompt-search">
            <input
              className="quick-ask-input"
              value={query}
              placeholder={copy.promptSearchPlaceholder}
              aria-label={copy.promptSearchPlaceholder}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
            />
          </div>
          <div className="capsule-flow-body">
            {snapshotMissing && <div className="capsule-note">{copy.promptNoSnapshot}</div>}
            {hits === null ? (
              <div className="capsule-empty">…</div>
            ) : hits.length === 0 ? (
              <div className="capsule-empty">{copy.promptEmpty}</div>
            ) : (
              <div className="prompt-list">
                {hits.map(hit => (
                  <button
                    key={`${hit.origin}:${hit.id}`}
                    type="button"
                    className="prompt-row"
                    onClick={() => setSelected(hit)}
                  >
                    <span className="prompt-row-head">
                      <span className="prompt-title">{hit.title}</span>
                      <span className={`prompt-origin ${hit.origin}`}>
                        {hit.origin === 'user' ? copy.promptFromUser : copy.promptFromCurated}
                      </span>
                    </span>
                    {hit.description && <span className="prompt-desc">{hit.description}</span>}
                    {hit.tags.length > 0 && (
                      <span className="prompt-tags">
                        {hit.tags.slice(0, 4).map(tag => (
                          <span key={tag} className="prompt-tag">{tag}</span>
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
