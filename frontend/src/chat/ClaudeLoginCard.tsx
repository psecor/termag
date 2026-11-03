// Claude Enterprise sign-in above the simple-UI composer. The code field is
// masked (disc glyphs, including Firefox) and blocked from session replay; it
// is cleared before it is sent. It is not type=password: Chrome would offer
// to save the one-time code. Leaving the chat cancels a sign-in still in
// progress so the box does not sit at the paste prompt.
import React, { useEffect, useRef, useState } from 'react';
import { claudeLoginApi } from '../services/api';
import type { InstanceStatus } from '../types';
import { REPLAY_BLOCK_CLASS } from '../observability';
import {
  loginCard, loginCodeError, loginTransport, safeLoginMessage, sawLoginFlow, takeLoginView,
  type ClaudeLoginView, type LoginCardModel, type LoginTransport,
} from './claudeLogin';

const POLL_MS = 4000;
const POLL = new Set(['offline', 'starting', 'submitting', 'needs-code']);
// Failures that say nothing about sign-in clear up on their own: ask again.
const POLL_TRANSPORT = new Set<LoginTransport>(['offline', 'unreachable', 'check-failed']);

export function ClaudeLoginPanel({
  card, busy, draft, localError, onDraft, onStart, onSubmit,
}: {
  card: LoginCardModel | null;
  busy: boolean;
  draft: string;
  localError?: string;
  onDraft: (value: string) => void;
  onStart: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  if (!card || card.mode === 'hidden') return null;
  const error = localError || card.error;
  return (
    <section className={`chat-claude-login${card.mode === 'quiet' ? ' chat-claude-login-quiet' : ''}`} data-mode={card.mode} role="status" aria-live="polite">
      <h2>{card.title}</h2>
      <p>{card.body}</p>
      {error && <p data-error="">{error}</p>}
      {card.url && <a href={card.url} target="_blank" rel="noopener noreferrer">Open the Claude sign-in page</a>}
      {card.mode === 'needs-code' && (
        <form className="chat-claude-login-row" onSubmit={onSubmit}>
          <div className="chat-claude-login-mask">
            <input
              type="text"
              className={`${REPLAY_BLOCK_CLASS} chat-claude-login-code`}
              value={draft}
              onChange={e => onDraft(e.target.value)}
              autoComplete="one-time-code"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Claude sign-in code"
              placeholder="Paste the code"
              disabled={busy}
              name="claude-sign-in-code"
            />
            {draft ? <span className="chat-claude-login-discs" aria-hidden="true">{'•'.repeat(Array.from(draft).length)}</span> : null}
          </div>
          <button type="submit" className="btn-primary" disabled={busy || !draft.trim()}>Continue</button>
        </form>
      )}
      {card.primary === 'start' && <button type="button" className="btn-primary" onClick={onStart} disabled={busy}>Sign in</button>}
      {card.primary === 'retry' && <button type="button" className="btn-tiny" onClick={onStart} disabled={busy}>Start again</button>}
    </section>
  );
}

function messageOf(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  return safeLoginMessage(data?.error);
}

export function ClaudeLoginCard({ projectId, owner, enabled, box, hostShowsBox, authFailure }: {
  projectId: string;
  owner: boolean;
  enabled: boolean;
  /** The box feed's status, so a box that is down can say why. */
  box?: InstanceStatus | null;
  /** The chat's status line already says the box or its agent is down, so the card does not. */
  hostShowsBox?: boolean;
  /** Changes each time a turn fails on Claude's sign-in; null once Claude answers again. */
  authFailure?: number | null;
}) {
  const [view, setView] = useState<ClaudeLoginView | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [transport, setTransport] = useState<LoginTransport>(null);
  const [transportError, setTransportError] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // A turn failed on the sign-in. Claude can still read as signed in then
  // (an expired token on disk), so the card offers a fresh sign-in anyway.
  const [authLost, setAuthLost] = useState(false);
  const loadRef = useRef<(() => void) | null>(null);
  const phaseRef = useRef<string | null>(null);
  const viewRef = useRef<ClaudeLoginView | null>(null);
  // Bumped when a status read starts, when start/submit settles, and when
  // the chat changes, so a poll or a late reply from another chat cannot
  // cover a finished sign-in or stick the wrong box's state.
  const viewGen = useRef(0);
  const transportRef = useRef<LoginTransport>(null);
  const engagedRef = useRef(false);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  useEffect(() => {
    viewRef.current = view;
    phaseRef.current = view?.phase ?? null;
  }, [view]);
  useEffect(() => { transportRef.current = transport; }, [transport]);

  useEffect(() => {
    // ChatView reuses this card across pane chats. Drop the previous chat's
    // view and generation before asking this one, or a late start/submit
    // can keep a signed-in card on the wrong box.
    viewGen.current += 1;
    viewRef.current = null;
    phaseRef.current = null;
    engagedRef.current = false;
    transportRef.current = null;
    setView(null);
    setEngaged(false);
    setTransport(null);
    setTransportError(undefined);
    setDraft('');
    setLocalError(undefined);
    setBusy(false);
    setAuthLost(false);

    if (!enabled || !projectId) return;
    let stop = false;
    const load = () => {
      const forProject = projectId;
      const gen = ++viewGen.current;
      claudeLoginApi.status(forProject).then(next => {
        if (stop || projectRef.current !== forProject) return;
        const chosen = takeLoginView(viewRef.current, next, gen, viewGen.current);
        if (!chosen || chosen === viewRef.current) return;
        viewRef.current = chosen;
        setView(chosen);
        setTransport(null);
        setTransportError(undefined);
        if (sawLoginFlow(chosen.phase)) { engagedRef.current = true; setEngaged(true); }
      }, err => {
        if (stop || projectRef.current !== forProject || gen !== viewGen.current) return;
        setTransport(loginTransport(err, 'status'));
        setTransportError(messageOf(err));
      });
    };
    loadRef.current = load;
    void load();
    const id = window.setInterval(() => {
      const phase = phaseRef.current;
      const current = transportRef.current;
      if (POLL_TRANSPORT.has(current) || (phase != null && POLL.has(phase))) void load();
    }, POLL_MS);
    return () => {
      stop = true;
      loadRef.current = null;
      window.clearInterval(id);
      // The route and the box RPC already exist. Calling them here stops the
      // CLI when the chat changes or the card goes away. A finished sign-in
      // has no process to kill.
      const phase = phaseRef.current;
      if (engagedRef.current && phase !== 'ready' && phase !== 'unavailable') {
        void claudeLoginApi.cancel(projectId).catch(() => {});
      }
    };
  }, [enabled, projectId]);

  // A turn failed on the sign-in: ask the box again and offer a fresh one.
  useEffect(() => {
    if (authFailure == null) { setAuthLost(false); return; }
    setAuthLost(true);
    loadRef.current?.();
  }, [authFailure]);

  if (!enabled) return null;
  const card = loginCard(view, { owner, engaged, transport, transportError, box, hostShowsBox, authLost });

  const onStart = () => {
    const forProject = projectId;
    setBusy(true);
    setLocalError(undefined);
    engagedRef.current = true;
    setEngaged(true);
    (authLost ? claudeLoginApi.start(forProject, { reauth: true }) : claudeLoginApi.start(forProject)).then(next => {
      if (projectRef.current !== forProject) return;
      viewGen.current += 1;
      viewRef.current = next;
      setView(next);
      setTransport(null);
      setTransportError(undefined);
      if (sawLoginFlow(next.phase)) setEngaged(true);
    }, err => {
      if (projectRef.current !== forProject) return;
      setTransport(loginTransport(err));
      setTransportError(messageOf(err));
    }).finally(() => {
      if (projectRef.current !== forProject) return;
      setBusy(false);
    });
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const forProject = projectId;
    const code = draft;
    setDraft('');
    const rejected = loginCodeError(code);
    if (rejected) { setLocalError(rejected); return; }
    setLocalError(undefined);
    setBusy(true);
    claudeLoginApi.submit(forProject, code.trim()).then(next => {
      if (projectRef.current !== forProject) return;
      viewGen.current += 1;
      viewRef.current = next;
      setView(next);
      setTransport(null);
      setTransportError(undefined);
      if (next.phase === 'ready' || sawLoginFlow(next.phase)) { engagedRef.current = true; setEngaged(true); }
      if (next.phase === 'ready') setAuthLost(false);
    }, err => {
      if (projectRef.current !== forProject) return;
      setTransport(loginTransport(err));
      setTransportError(messageOf(err));
    }).finally(() => {
      if (projectRef.current !== forProject) return;
      setBusy(false);
    });
  };

  return <ClaudeLoginPanel card={card} busy={busy} draft={draft} localError={localError} onDraft={setDraft} onStart={onStart} onSubmit={onSubmit} />;
}
