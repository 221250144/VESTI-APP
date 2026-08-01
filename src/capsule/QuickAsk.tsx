import { useEffect, useState } from 'react';
import {
  DEMO_PROXY_MODEL_IDS,
  type CapsuleQuickAskTurn,
  type LlmAccessMode,
} from '../shared/contracts';
import { capsuleApi } from './api';
import { formatCopy, type CapsuleCopy } from './copy';
import { renderAnswerHtml } from './markdown';

interface QuickAskProps {
  copy: CapsuleCopy;
  llmConfigured: boolean;
  /** From dock status; undefined until loaded (treated as demo). */
  llmMode?: LlmAccessMode;
  defaultModelId?: string;
  onToast: (message: string) => void;
}

type AskPhase = 'idle' | 'loading' | 'done' | 'error';

/** ui-prefs key for the picked quick-ask model ('' = settings default). */
const MODEL_PREF_KEY = 'quickAskModel';
/** Completed turns kept for multi-turn context (never persisted). */
const MAX_CONTEXT_TURNS = 4;
/** Bailian newcomer surfaced in BYOK mode next to the settings default. */
const BYOK_SUGGESTED_MODEL = 'deepseek-v4-flash';

const DEMO_MODELS = DEMO_PROXY_MODEL_IDS as readonly string[];

function isDemoModel(value: string): boolean {
  return DEMO_MODELS.includes(value);
}

/**
 * Home-screen quick question: Enter asks, the answer expands in place, ESC or
 * the collapse button folds it away. Grounded on recallSessions + the explore
 * agent kind via the capsuleQuickAsk IPC; disabled without an LLM configured.
 *
 * Model switching: demo-proxy mode offers exactly the gateway whitelist
 * (anything else would silently fall back to qwen-plus server-side); BYOK
 * mode is a free-form model id + suggestions. The choice persists in
 * ui-prefs. Completed turns (last few, memory only) are sent back as
 * lightweight multi-turn context.
 */
export function QuickAsk({ copy, llmConfigured, llmMode, defaultModelId, onToast }: QuickAskProps) {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<AskPhase>('idle');
  const [answer, setAnswer] = useState('');
  const [recalled, setRecalled] = useState(0);
  const [turns, setTurns] = useState<CapsuleQuickAskTurn[]>([]);
  const demoMode = llmMode !== 'custom_byok';
  const settingsModel = defaultModelId?.trim() || 'qwen-plus';
  const fallbackModel = demoMode && isDemoModel(settingsModel) ? settingsModel : 'qwen-plus';
  // Demo: concrete whitelist id. BYOK: free text ('' → settings default).
  const [modelId, setModelId] = useState(fallbackModel);
  const [customModel, setCustomModel] = useState('');
  // Until the persisted choice loads, follow the settings default.
  const [modelResolved, setModelResolved] = useState(false);

  useEffect(() => {
    setModelResolved(false);
    void window.vestiUi?.getUiPreference(MODEL_PREF_KEY)
      .then((value) => {
        if (typeof value === 'string' && value.trim()) {
          if (demoMode) {
            if (isDemoModel(value)) setModelId(value);
          } else {
            setCustomModel(value);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => setModelResolved(true));
  }, [demoMode]);

  useEffect(() => {
    if (!modelResolved && demoMode) setModelId(fallbackModel);
  }, [modelResolved, demoMode, fallbackModel]);

  const persistModel = (value: string) => {
    void window.vestiUi?.setUiPreference(MODEL_PREF_KEY, value).catch(() => undefined);
  };

  const byokSuggestions = [...new Set([settingsModel, BYOK_SUGGESTED_MODEL])];

  const collapseAnswer = () => {
    setPhase('idle');
    setAnswer('');
    setTurns([]);
  };

  const submit = async () => {
    const api = capsuleApi();
    const query = question.trim();
    if (!api || !query || phase === 'loading') return;
    setPhase('loading');
    setAnswer('');
    try {
      const override = demoMode ? modelId : customModel.trim();
      const result = await api.quickAsk(query, {
        ...(override ? { modelId: override } : {}),
        history: turns,
      });
      setAnswer(result.answer);
      setRecalled(result.recalled);
      setTurns(prev => [...prev, { question: query, answer: result.answer }].slice(-MAX_CONTEXT_TURNS));
      setPhase('done');
    } catch (error) {
      setAnswer(error instanceof Error ? error.message : copy.quickAskFailed);
      setPhase('error');
    }
  };

  return (
    <div className="quick-ask">
      <input
        className="quick-ask-input"
        value={question}
        disabled={!llmConfigured}
        placeholder={llmConfigured ? copy.quickAskPlaceholder : copy.quickAskDisabledHint}
        title={llmConfigured ? undefined : copy.quickAskDisabledHint}
        aria-label={copy.quickAskPlaceholder}
        onChange={event => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
          if (event.key === 'Escape') {
            if (phase === 'done' || phase === 'error') collapseAnswer();
            else setQuestion('');
          }
        }}
      />
      <div className="quick-ask-modelbar">
        <span className="quick-ask-model-label">{copy.quickAskModel}</span>
        {demoMode ? (
          <select
            className="quick-ask-model-select"
            value={modelId}
            disabled={!llmConfigured}
            aria-label={copy.quickAskModel}
            onChange={(event) => {
              setModelId(event.target.value);
              persistModel(event.target.value);
            }}
          >
            {DEMO_PROXY_MODEL_IDS.map(id => (
              <option key={id} value={id}>{id} · {copy.quickAskModelHints[id]}</option>
            ))}
          </select>
        ) : (
          <>
            <input
              className="quick-ask-model-input"
              value={customModel}
              disabled={!llmConfigured}
              placeholder={copy.quickAskModelCustomPlaceholder}
              aria-label={copy.quickAskModel}
              onChange={event => setCustomModel(event.target.value)}
              onBlur={() => persistModel(customModel.trim())}
            />
            <span className="quick-ask-model-chips">
              <span className="quick-ask-model-recommend">{copy.quickAskModelRecommend}</span>
              {byokSuggestions.map(id => (
                <button
                  key={id}
                  type="button"
                  className="quick-ask-model-chip"
                  title={id === BYOK_SUGGESTED_MODEL ? copy.quickAskModelV4FlashNote : undefined}
                  onClick={() => {
                    setCustomModel(id);
                    persistModel(id);
                  }}
                >
                  {id}{id === BYOK_SUGGESTED_MODEL ? ` · ${copy.quickAskModelNew}` : ''}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
      {phase === 'loading' && (
        <div className="quick-ask-status">
          <span className="quick-ask-spinner" aria-hidden />
          {copy.quickAskLoading}
        </div>
      )}
      {(phase === 'done' || phase === 'error') && (
        <div className={`quick-ask-answer${phase === 'error' ? ' error' : ''}`}>
          <div className="quick-ask-answer-body">
            {phase === 'done'
              ? turns.map((turn, index) => (
                  <div key={index} className="quick-ask-turn">
                    <div className="quick-ask-turn-q">{turn.question}</div>
                    <div
                      className="quick-ask-turn-a"
                      dangerouslySetInnerHTML={{ __html: renderAnswerHtml(turn.answer) }}
                    />
                  </div>
                ))
              : answer}
          </div>
          <div className="quick-ask-answer-bar">
            {phase === 'done' && (
              <span className="recalled">{formatCopy(copy.quickAskRecalled, { n: recalled })}</span>
            )}
            <span className="spacer" />
            {phase === 'done' && (
              <button
                type="button"
                onClick={() => {
                  void capsuleApi()?.copyText(answer).then(() => onToast(copy.copiedPlain));
                }}
              >
                {copy.copy}
              </button>
            )}
            <button type="button" onClick={collapseAnswer}>{copy.collapse}</button>
          </div>
        </div>
      )}
    </div>
  );
}
