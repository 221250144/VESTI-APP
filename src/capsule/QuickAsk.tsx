import { useState } from 'react';
import { capsuleApi } from './api';
import { formatCopy, type CapsuleCopy } from './copy';

interface QuickAskProps {
  copy: CapsuleCopy;
  llmConfigured: boolean;
  onToast: (message: string) => void;
}

type AskPhase = 'idle' | 'loading' | 'done' | 'error';

/**
 * Home-screen quick question: Enter asks, the answer expands in place, ESC or
 * the collapse button folds it away. Grounded on recallSessions + the explore
 * agent kind via the capsuleQuickAsk IPC; disabled without an LLM configured.
 */
export function QuickAsk({ copy, llmConfigured, onToast }: QuickAskProps) {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<AskPhase>('idle');
  const [answer, setAnswer] = useState('');
  const [recalled, setRecalled] = useState(0);

  const collapseAnswer = () => {
    setPhase('idle');
    setAnswer('');
  };

  const submit = async () => {
    const api = capsuleApi();
    const query = question.trim();
    if (!api || !query || phase === 'loading') return;
    setPhase('loading');
    setAnswer('');
    try {
      const result = await api.quickAsk(query);
      setAnswer(result.answer);
      setRecalled(result.recalled);
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
      {phase === 'loading' && (
        <div className="quick-ask-status">
          <span className="quick-ask-spinner" aria-hidden />
          {copy.quickAskLoading}
        </div>
      )}
      {(phase === 'done' || phase === 'error') && (
        <div className={`quick-ask-answer${phase === 'error' ? ' error' : ''}`}>
          <div className="quick-ask-answer-body">{answer}</div>
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
