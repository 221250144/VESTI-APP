import { useEffect, useMemo, useState } from 'react';
import type {
  CapsuleProjectView,
  CapsuleRelayDraft,
  RelayCliCommand,
} from '../shared/contracts';
import { capsuleApi } from './api';
import { formatCopy, type CapsuleCopy } from './copy';

type RelayStep = 'scope' | 'preview' | 'edit' | 'deliver';

interface RelayFlowProps {
  copy: CapsuleCopy;
  llmConfigured: boolean;
  extensionConnected: boolean;
  onExit: () => void;
  onToast: (message: string) => void;
}

function projectRef(project: CapsuleProjectView): string {
  return `${project.platform}::${project.host}::${project.projectKey}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * AI 接力 flow inside the capsule panel: scope → local compressed preview →
 * editable text → inject (clipboard / browser outbox / CLI commands). The
 * window is temporarily grown by the parent while this view is active.
 */
export function RelayFlow({ copy, llmConfigured, extensionConnected, onExit, onToast }: RelayFlowProps) {
  const [step, setStep] = useState<RelayStep>('scope');
  const [projects, setProjects] = useState<CapsuleProjectView[] | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [checkedSessions, setCheckedSessions] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<CapsuleRelayDraft | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'build' | 'polish' | 'browser' | 'cli' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cliCommands, setCliCommands] = useState<RelayCliCommand[] | null>(null);

  useEffect(() => {
    void capsuleApi()?.getProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  const selectedProject = useMemo(
    () => projects?.find(project => projectRef(project) === selectedRef) ?? null,
    [projects, selectedRef],
  );

  const buildDraft = async () => {
    const api = capsuleApi();
    if (!api || !selectedProject || busy) return;
    setBusy('build');
    setError(null);
    try {
      const sessionIds = [...checkedSessions];
      const result = await api.buildRelayDraft({
        platform: selectedProject.platform,
        host: selectedProject.host,
        projectKey: selectedProject.projectKey,
        ...(sessionIds.length > 0 ? { sessionIds } : {}),
      });
      setDraft(result);
      setText(result.text);
      setStep('preview');
    } catch (cause) {
      setError(errorMessage(cause, copy.actionFailed));
    } finally {
      setBusy(null);
    }
  };

  const polish = async () => {
    const api = capsuleApi();
    if (!api || busy) return;
    setBusy('polish');
    setError(null);
    try {
      const result = await api.relayAiPolish(text);
      setText(result.suggestedPrompt);
      setStep('edit');
    } catch (cause) {
      setError(errorMessage(cause, copy.actionFailed));
    } finally {
      setBusy(null);
    }
  };

  const sendToBrowser = async () => {
    const api = capsuleApi();
    if (!api || !extensionConnected || busy) return;
    setBusy('browser');
    setError(null);
    try {
      await api.enqueueOutbox(text);
      onToast(copy.sentToBrowser);
    } catch (cause) {
      setError(errorMessage(cause, copy.actionFailed));
    } finally {
      setBusy(null);
    }
  };

  const generateCli = async () => {
    const api = capsuleApi();
    if (!api || busy) return;
    setBusy('cli');
    setError(null);
    try {
      const result = await api.prepareRelayCli({
        id: Date.now(),
        slug: selectedProject?.label ?? 'capsule-relay',
        markdown: text,
      });
      setCliCommands(result.commands);
    } catch (cause) {
      setError(errorMessage(cause, copy.actionFailed));
    } finally {
      setBusy(null);
    }
  };

  const toggleSession = (sessionId: string) => {
    setCheckedSessions((previous) => {
      const next = new Set(previous);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  return (
    <div className="capsule-flow">
      <div className="capsule-flow-header">
        <button type="button" className="flow-back" onClick={step === 'scope' ? onExit : () => {
          setError(null);
          setCliCommands(null);
          setStep(step === 'deliver' ? 'edit' : step === 'edit' ? 'preview' : 'scope');
        }}>
          ‹ {copy.back}
        </button>
        <span className="flow-title">
          {step === 'scope' && copy.relayScopeTitle}
          {step === 'preview' && copy.relayPreviewTitle}
          {step === 'edit' && copy.relayEditTitle}
          {step === 'deliver' && copy.relayDeliverTitle}
        </span>
      </div>

      {error && <div className="capsule-inline-error">{error}</div>}

      {step === 'scope' && (
        <>
          <div className="capsule-flow-body">
            {projects === null ? (
              <div className="capsule-empty">…</div>
            ) : projects.length === 0 ? (
              <div className="capsule-empty">{copy.relayProjectEmpty}</div>
            ) : (
              <div className="project-list">
                {projects.map((project) => {
                  const ref = projectRef(project);
                  const selected = ref === selectedRef;
                  return (
                    <div key={ref} className={`project-item${selected ? ' selected' : ''}`}>
                      <label className="project-row">
                        <input
                          type="radio"
                          name="capsule-relay-project"
                          checked={selected}
                          onChange={() => {
                            setSelectedRef(ref);
                            setCheckedSessions(new Set());
                          }}
                        />
                        <span className="project-label" title={project.pathOrDomain}>
                          {project.label}
                        </span>
                        <span className="project-meta">
                          {project.platform} · {project.sessionCount} {copy.relaySessionsUnit}
                        </span>
                      </label>
                      {selected && project.recentSessions.length > 0 && (
                        <div className="session-picks">
                          <div className="session-picks-title">{copy.relaySessionPick}</div>
                          {project.recentSessions.map(session => (
                            <label key={session.sessionId} className="session-row">
                              <input
                                type="checkbox"
                                checked={checkedSessions.has(session.sessionId)}
                                onChange={() => toggleSession(session.sessionId)}
                              />
                              <span className="session-title" title={session.title}>
                                {session.title}
                              </span>
                              {session.oneLiner && (
                                <span className="session-oneliner" title={session.oneLiner}>
                                  {session.oneLiner}
                                </span>
                              )}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="capsule-flow-footer">
            <button type="button" className="capsule-action" onClick={onExit}>{copy.cancel}</button>
            <button
              type="button"
              className="capsule-action primary"
              disabled={!selectedProject || busy !== null}
              onClick={() => void buildDraft()}
            >
              {busy === 'build' ? '…' : copy.relayBuild}
            </button>
          </div>
        </>
      )}

      {step === 'preview' && draft && (
        <>
          <div className="capsule-flow-body">
            <div className="capsule-note">{copy.relayPreviewNote}</div>
            <pre className="relay-preview">{text}</pre>
          </div>
          <div className="capsule-flow-footer">
            <button type="button" className="capsule-action" onClick={() => setStep('scope')}>
              {copy.back}
            </button>
            {llmConfigured && (
              <button
                type="button"
                className="capsule-action"
                disabled={busy !== null}
                onClick={() => void polish()}
              >
                {busy === 'polish' ? copy.relayPolishing : `✦ ${copy.relayPolish}`}
              </button>
            )}
            <button
              type="button"
              className="capsule-action primary"
              disabled={busy !== null}
              onClick={() => setStep('edit')}
            >
              {copy.relayEdit}
            </button>
          </div>
        </>
      )}

      {step === 'edit' && (
        <>
          <div className="capsule-flow-body">
            <textarea
              className="relay-editor"
              value={text}
              onChange={event => setText(event.target.value)}
              aria-label={copy.relayEditTitle}
            />
          </div>
          <div className="capsule-flow-footer">
            <span className="char-count">{formatCopy(copy.relayChars, { n: text.length })}</span>
            <span className="spacer" />
            <button type="button" className="capsule-action" onClick={() => setStep('preview')}>
              {copy.back}
            </button>
            <button
              type="button"
              className="capsule-action primary"
              disabled={!text.trim()}
              onClick={() => {
                setCliCommands(null);
                setStep('deliver');
              }}
            >
              {copy.relayDeliver}
            </button>
          </div>
        </>
      )}

      {step === 'deliver' && (
        <>
          <div className="capsule-flow-body">
            <button
              type="button"
              className="capsule-action primary deliver"
              onClick={() => {
                void capsuleApi()?.copyText(text).then(() => onToast(copy.copied));
              }}
            >
              <span className="icon">⧉</span>
              {copy.deliverCopy}
            </button>
            <button
              type="button"
              className="capsule-action deliver"
              disabled={!extensionConnected || busy !== null}
              title={extensionConnected ? undefined : copy.browserNotConnected}
              onClick={() => void sendToBrowser()}
            >
              <span className="icon">⇢</span>
              {copy.sendToBrowser}
              {!extensionConnected && <span className="hint">（{copy.browserNotConnected}）</span>}
            </button>
            <button
              type="button"
              className="capsule-action deliver"
              disabled={busy !== null}
              onClick={() => void generateCli()}
            >
              <span className="icon">›_</span>
              {copy.deliverCli}
            </button>
            {cliCommands && (
              <div className="cli-list">
                {cliCommands.map(command => (
                  <div key={command.id} className="cli-row">
                    <span className="cli-label">{command.label}</span>
                    <code className="cli-command" title={command.command}>{command.command}</code>
                    <button
                      type="button"
                      className="cli-copy"
                      onClick={() => {
                        void capsuleApi()?.copyText(command.command).then(() => onToast(copy.copiedPlain));
                      }}
                    >
                      {copy.copy}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="capsule-flow-footer">
            <button type="button" className="capsule-action" onClick={() => setStep('edit')}>
              {copy.back}
            </button>
            <button type="button" className="capsule-action" onClick={onExit}>
              {copy.collapse}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
