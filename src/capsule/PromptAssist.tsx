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

/** ui-prefs key holding per-prompt edited bodies ({ "origin:id": body }). */
const DRAFTS_PREF_KEY = 'promptAssistDrafts';
const DRAFT_SAVE_DEBOUNCE_MS = 400;

type DraftMap = Record<string, string>;

function draftKeyOf(hit: CapsulePromptHit): string {
  return `${hit.origin}:${hit.id}`;
}

function readDraftMap(value: unknown): DraftMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const drafts: DraftMap = {};
  for (const [key, body] of Object.entries(value as Record<string, unknown>)) {
    if (typeof body === 'string' && body.trim()) drafts[key] = body;
  }
  return drafts;
}

/**
 * 提示词助手: searches the curated catalog + the user's prompt-library
 * snapshot (read via IPC — the capsule never loads Dexie) and offers copy /
 * send-to-browser delivery for the picked prompt, plus AI improve / continue
 * (agent kinds 'prompt-improve' / 'prompt-continue', persist:false).
 *
 * The picked prompt is directly EDITABLE (drafts autosave to ui-prefs, so an
 * edit survives closing the dock), and the bottom refine box takes a
 * natural-language instruction ("更简洁", "改成面向代码审查的") that steers
 * the improve pass. Every AI round can be adopted on top of the previous one
 * (iteration); adopted bodies stack into a local history so each round is
 * reversible (回退). With no LLM configured the refine controls disable.
 */
export function PromptAssist({ copy, extensionConnected, llmConfigured, onExit, onToast }: PromptAssistProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CapsulePromptHit[] | null>(null);
  const [snapshotMissing, setSnapshotMissing] = useState(false);
  const [selected, setSelected] = useState<CapsulePromptHit | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The body the footer actions act on — user-editable; AI results replace it
  // on "use this version". null → the untouched original body.
  const [workingBody, setWorkingBody] = useState<string | null>(null);
  // Previous bodies, newest last — one entry per adopted AI round / revert.
  const [history, setHistory] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [refine, setRefine] = useState<RefineState>({ phase: 'idle' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest persisted draft map (kept in a ref so the debounced writer and
  // selectHit never read stale state).
  const draftsRef = useRef<DraftMap>({});

  useEffect(() => {
    const api = capsuleApi();
    if (!api) return;
    void api.getPromptSnapshot()
      .then(snapshot => setSnapshotMissing(!snapshot || snapshot.prompts.length === 0))
      .catch(() => setSnapshotMissing(true));
    void api.searchPrompts('').then(setHits).catch(() => setHits([]));
    void window.vestiUi?.getUiPreference(DRAFTS_PREF_KEY)
      .then(value => {
        draftsRef.current = readDraftMap(value);
      })
      .catch(() => undefined);
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

  const persistDrafts = (next: DraftMap) => {
    draftsRef.current = next;
    void window.vestiUi?.setUiPreference(DRAFTS_PREF_KEY, next).catch(() => undefined);
  };

  /** Debounced draft autosave; a body equal to the original drops the draft. */
  const scheduleDraftSave = (hit: CapsulePromptHit, body: string) => {
    if (draftSaveRef.current) clearTimeout(draftSaveRef.current);
    draftSaveRef.current = setTimeout(() => {
      draftSaveRef.current = null;
      const key = draftKeyOf(hit);
      const next = { ...draftsRef.current };
      if (body === hit.body) delete next[key];
      else next[key] = body;
      persistDrafts(next);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  };

  const selectHit = (hit: CapsulePromptHit | null) => {
    setSelected(hit);
    setWorkingBody(hit ? (draftsRef.current[draftKeyOf(hit)] ?? null) : null);
    setHistory([]);
    setInstruction('');
    setRefine({ phase: 'idle' });
    setError(null);
  };

  const currentBody = workingBody ?? selected?.body ?? '';

  /** Direct text edit — autosaves as the prompt's draft. */
  const editBody = (body: string) => {
    if (!selected) return;
    setWorkingBody(body);
    scheduleDraftSave(selected, body);
  };

  /** Adopt a new body (AI round result); the previous one stays recoverable. */
  const adoptBody = (body: string) => {
    if (!selected || body === currentBody) return;
    setHistory(stack => [...stack, currentBody]);
    setWorkingBody(body);
    scheduleDraftSave(selected, body);
  };

  const undoLast = () => {
    if (!selected || history.length === 0) return;
    const previous = history[history.length - 1];
    setHistory(stack => stack.slice(0, -1));
    setWorkingBody(previous);
    scheduleDraftSave(selected, previous);
  };

  const revertOriginal = () => {
    if (!selected || workingBody === null) return;
    setHistory(stack => [...stack, currentBody]);
    setWorkingBody(null);
    scheduleDraftSave(selected, selected.body);
  };

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

  const runRefine = async (mode: 'improve' | 'continue', withInstruction = false) => {
    const api = capsuleApi();
    if (!api || !llmConfigured || refine.phase === 'running' || !currentBody.trim()) return;
    setError(null);
    setRefine({ phase: 'running', mode });
    try {
      if (mode === 'improve') {
        const userInstruction = withInstruction ? instruction.trim() : '';
        const result = await api.improvePrompt(currentBody, userInstruction || undefined);
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

  const adoptRefineResult = () => {
    if (refine.phase !== 'done') return;
    adoptBody(refineResultText);
    setRefine({ phase: 'idle' });
    setInstruction('');
  };

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
              <>
                <textarea
                  className="relay-editor prompt-body-editor"
                  value={currentBody}
                  aria-label={copy.promptEditTitle}
                  onChange={event => editBody(event.target.value)}
                />
                {(history.length > 0 || (workingBody !== null && workingBody !== selected.body)) && (
                  <div className="prompt-edit-bar">
                    {history.length > 0 && (
                      <button type="button" className="prompt-edit-link" onClick={undoLast}>
                        ↩ {copy.promptUndo}
                      </button>
                    )}
                    {workingBody !== null && workingBody !== selected.body && (
                      <button type="button" className="prompt-edit-link" onClick={revertOriginal}>
                        {copy.promptRevert}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {refine.phase !== 'done' && (
            <div className="prompt-refine-bar">
              <input
                className="quick-ask-input"
                value={instruction}
                disabled={!llmConfigured || refine.phase === 'running'}
                placeholder={llmConfigured ? copy.promptRefinePlaceholder : copy.promptLlmRequired}
                aria-label={copy.promptRefinePlaceholder}
                title={llmConfigured ? undefined : copy.promptLlmRequired}
                onChange={event => setInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && instruction.trim()) void runRefine('improve', true);
                }}
              />
              <button
                type="button"
                className="capsule-action"
                disabled={
                  !llmConfigured
                  || refine.phase === 'running'
                  || !instruction.trim()
                  || !currentBody.trim()
                }
                title={llmConfigured ? undefined : copy.promptLlmRequired}
                onClick={() => void runRefine('improve', true)}
              >
                {copy.promptRefineSubmit}
              </button>
            </div>
          )}

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
                  onClick={adoptRefineResult}
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
