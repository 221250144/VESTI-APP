import { useEffect, useRef, useState } from 'react';
import type { CapsulePromptHit } from '../shared/contracts';
import { capsuleApi } from './api';
import type { CapsuleCopy } from './copy';

interface PromptAssistProps {
  copy: CapsuleCopy;
  extensionConnected: boolean;
  llmConfigured: boolean;
  onExit: () => void;
  onToast: (message: string) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Result of an AI refine/continue run on the selected prompt. */
type RefineState =
  | { phase: 'idle' }
  | { phase: 'running'; mode: 'improve' | 'continue' }
  | { phase: 'done'; mode: 'improve'; improved: string; notes: string[] }
  | { phase: 'done'; mode: 'continue'; continued: string };

/**
 * 提示词助手: searches the curated catalog + the user's prompt-library
 * snapshot (read via IPC — the capsule never loads Dexie) and offers copy /
 * send-to-browser delivery for the picked prompt, plus AI improve / continue
 * (agent kinds 'prompt-improve' / 'prompt-continue', persist:false).
 */
export function PromptAssist({ copy, extensionConnected, llmConfigured, onExit, onToast }: PromptAssistProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CapsulePromptHit[] | null>(null);
  const [snapshotMissing, setSnapshotMissing] = useState(false);
  const [selected, setSelected] = useState<CapsulePromptHit | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The body the footer actions act on — replaced when the user adopts an AI
  // refine/continue result ("use this version").
  const [workingBody, setWorkingBody] = useState<string | null>(null);
  const [refine, setRefine] = useState<RefineState>({ phase: 'idle' });
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

  const selectHit = (hit: CapsulePromptHit | null) => {
    setSelected(hit);
    setWorkingBody(null);
    setRefine({ phase: 'idle' });
    setError(null);
  };

  const currentBody = workingBody ?? selected?.body ?? '';

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

  const copyBody = (body: string) => {
    void capsuleApi()?.copyText(body).then(() => onToast(copy.copied));
  };

  const runRefine = async (mode: 'improve' | 'continue') => {
    const api = capsuleApi();
    if (!api || !llmConfigured || refine.phase === 'running' || !currentBody.trim()) return;
    setError(null);
    setRefine({ phase: 'running', mode });
    try {
      if (mode === 'improve') {
        const result = await api.improvePrompt(currentBody);
        setRefine({ phase: 'done', mode, improved: result.improved, notes: result.notes });
      } else {
        const result = await api.continuePrompt(currentBody);
        setRefine({ phase: 'done', mode, continued: result.continued });
      }
    } catch (cause) {
      setRefine({ phase: 'idle' });
      setError(errorMessage(cause, copy.actionFailed));
    }
  };

  const refineResultText = refine.phase === 'done'
    ? (refine.mode === 'improve' ? refine.improved : refine.continued)
    : '';

  return (
    <div className="capsule-flow">
      <div className="capsule-flow-header">
        {selected ? (
          <button type="button" className="flow-back" onClick={() => selectHit(null)}>
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
            {refine.phase === 'done' ? (
              <>
                <pre className="relay-preview prompt-body">{refineResultText}</pre>
                {refine.mode === 'improve' && refine.notes.length > 0 && (
                  <div className="prompt-refine-notes">
                    <div className="prompt-refine-notes-title">{copy.promptImproveNotes}</div>
                    {refine.notes.map((note, index) => (
                      <div key={index} className="prompt-refine-note">· {note}</div>
                    ))}
                  </div>
                )}
              </>
            ) : refine.phase === 'running' ? (
              <div className="capsule-empty">
                {refine.mode === 'improve' ? copy.promptImproving : copy.promptContinuing}
              </div>
            ) : (
              <pre className="relay-preview prompt-body">{currentBody}</pre>
            )}
          </div>
          <div className="capsule-flow-footer">
            {refine.phase === 'done' ? (
              <>
                <button
                  type="button"
                  className="capsule-action"
                  onClick={() => copyBody(refineResultText)}
                >
                  {copy.deliverCopy}
                </button>
                <button
                  type="button"
                  className="capsule-action primary"
                  onClick={() => {
                    setWorkingBody(refineResultText);
                    setRefine({ phase: 'idle' });
                  }}
                >
                  {copy.promptUseResult}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="capsule-action"
                  disabled={!extensionConnected || refine.phase === 'running'}
                  title={extensionConnected ? undefined : copy.browserNotConnected}
                  onClick={() => void sendToBrowser(currentBody)}
                >
                  {copy.sendToBrowser}
                </button>
                <button
                  type="button"
                  className="capsule-action"
                  disabled={refine.phase === 'running'}
                  onClick={() => copyBody(currentBody)}
                >
                  {copy.deliverCopy}
                </button>
                <button
                  type="button"
                  className="capsule-action"
                  disabled={!llmConfigured || refine.phase === 'running'}
                  title={llmConfigured ? undefined : copy.promptLlmRequired}
                  onClick={() => void runRefine('improve')}
                >
                  {refine.phase === 'running' && refine.mode === 'improve'
                    ? copy.promptImproving
                    : copy.promptImprove}
                </button>
                <button
                  type="button"
                  className="capsule-action"
                  disabled={!llmConfigured || refine.phase === 'running'}
                  title={llmConfigured ? undefined : copy.promptLlmRequired}
                  onClick={() => void runRefine('continue')}
                >
                  {refine.phase === 'running' && refine.mode === 'continue'
                    ? copy.promptContinuing
                    : copy.promptContinue}
                </button>
              </>
            )}
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
                    onClick={() => selectHit(hit)}
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
