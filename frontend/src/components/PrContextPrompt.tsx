import React, { useEffect, useRef, useState } from 'react';
import type { AgentStatus } from '../types';
import { handoffApi, sessionsApi, statusApi } from '../services/api';
import { fmtContextTokens, promptContextTokens, prPromptTitle, shouldShowPrPrompt } from '../utils/prPrompt';
import { isHandoffOpen } from '../utils/handoff';

interface Props {
  projectId: string;
  instanceId: string | null | undefined;
  workstream: string;
  /** The agent session's tmux name (for dismiss) and its live status entry. */
  session: string;
  status: AgentStatus | undefined;
  /** The workstream's id when this viewer may hand the agent off (owner, flag on); null hides Hand off. */
  handoffWorkstreamId?: string | null;
}

/** How long the arrival pulse runs before the card settles. */
const ARRIVAL_MS = 4_000;

/**
 * "PR opened · context 180K · shrink the context?" with Compact / Clear / Keep, as an overlay strip
 * across the top of the agent pane once the agent is back at its prompt after
 * opening or merging a PR, if its context is big enough to be worth shrinking.
 * Compact is the highlighted default: it keeps the thread but drops the bulk;
 * Clear starts fresh. Alt+Shift+C compacts from the keyboard while the card
 * shows (Ctrl+Shift+C is Chrome's inspect-element and never reaches the page).
 *
 * Deliberately NOT a modal: it fires from a background event, must not block
 * reading the agent's final output, and several projects can have one pending
 * at once (the tile dot covers the ones you are not looking at). Salience
 * comes from placement over the pane, a solid accent band, and a short
 * entrance pulse instead.
 *
 * Shown only while the agent is `idle`: in `waiting` Claude has a permission
 * or input dialog up, and typing "/compact" + Enter would press Enter on it.
 *
 * Actions type into the agent pane through the owner's agent (tmux is per
 * unix user), exactly as MetaTerm does. Keep just dismisses. Hand off (owner,
 * behind agent-handoff-enabled) asks the backend for a clear-mode handoff:
 * the agent writes a handoff first, then /clear and
 * a read-in — the card hides while it runs and HandoffStrip takes over. The card also
 * disappears on its own once the context reading drops, which is what
 * /compact and /clear cause.
 */
export function PrContextPrompt({ projectId, instanceId, workstream, session, status, handoffWorkstreamId }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<null | 'compact' | 'clear' | 'handoff'>(null);
  const [handoffError, setHandoffError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [arrivedAt, setArrivedAt] = useState<number | null>(null);

  // Reset local state when a NEW milestone arrives.
  const at = status?.milestone?.at;
  useEffect(() => { setDismissed(false); setBusy(null); setHandoffError(''); }, [at]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const m = status?.milestone;
  const visible = !!m && !isHandoffOpen(status?.handoff)
    && shouldShowPrPrompt({ status: status?.status, milestone: m, contextTokens: status?.contextTokens, now, dismissed });

  // Stamp the arrival when the card BECOMES visible (the agent going idle),
  // not when the milestone was recorded mid-turn — otherwise the entrance
  // pulse would have run and finished before anyone could see it.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) { setArrivedAt(Date.now()); setNow(Date.now()); }
    wasVisible.current = visible;
  }, [visible]);
  // Tick faster during the arrival window so `is-new` drops off on time.
  useEffect(() => {
    if (arrivedAt == null) return;
    const t = setTimeout(() => setNow(Date.now()), ARRIVAL_MS + 50);
    return () => clearTimeout(t);
  }, [arrivedAt]);

  const dismiss = () => {
    setDismissed(true);
    statusApi.dismissMilestone(session, instanceId).catch(() => {});
  };
  const act = async (kind: 'compact' | 'clear') => {
    if (busy) return;
    setBusy(kind);
    try {
      await sessionsApi.sendKeys(projectId, 'agent', { workstream, keys: `/${kind}`, enter: true });
      // The context reading will drop and resolve the milestone server-side;
      // hide now so the card doesn't linger while the scanner catches up.
      setDismissed(true);
      statusApi.dismissMilestone(session, instanceId).catch(() => {});
    } catch {
      setBusy(null);
    }
  };

  const handOff = async () => {
    if (busy || !handoffWorkstreamId) return;
    setBusy('handoff');
    setHandoffError('');
    try {
      // A fallback notice (the agent restarts instead) rides on the row's
      // reason, which HandoffStrip shows once the card is gone.
      await handoffApi.start(projectId, handoffWorkstreamId, { mode: 'clear' });
      setDismissed(true);
      statusApi.dismissMilestone(session, instanceId).catch(() => {});
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setHandoffError(msg ?? 'Could not start the handoff');
      setBusy(null);
    }
  };

  // Keyboard fast path while the card is visible. The terminal has focus, so
  // a bare key would be typed into the agent; capture-phase + preventDefault
  // keeps the chord out of xterm. Alt+Shift+C is free in Chrome, Firefox and
  // Safari (Ctrl+Shift+C opens DevTools' inspector in Chrome).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyC') {
        e.preventDefault();
        e.stopPropagation();
        void act('compact');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, busy, projectId, workstream]);

  if (!m || !visible) return null;

  const ctx = promptContextTokens(m, status?.contextTokens) ?? 0;
  const isNew = arrivedAt != null && now - arrivedAt < ARRIVAL_MS;
  return (
    <div className={`pr-prompt${isNew ? ' is-new' : ''}`} role="status" aria-live="assertive">
      <span className="pr-prompt-text">
        <strong>{prPromptTitle(m)}</strong>
        {m.url && <> · <a href={m.url} target="_blank" rel="noreferrer">{m.url.replace(/^https:\/\/github\.com\//, '')}</a></>}
        <> · context {fmtContextTokens(ctx)}</>
        {handoffError
          ? <span className="pr-prompt-q" role="alert"> · {handoffError}</span>
          : <span className="pr-prompt-q"> · shrink the context?</span>}
      </span>
      <span className="pr-prompt-actions">
        <button className="pr-prompt-btn pr-prompt-btn--primary" onClick={() => void act('compact')} disabled={busy !== null} title="Type /compact into the agent pane: keeps the thread, drops the bulk (Alt+Shift+C)">
          {busy === 'compact' ? 'Compacting…' : 'Compact'}<kbd className="pr-prompt-kbd">⌥⇧C</kbd>
        </button>
        <button className="pr-prompt-btn" onClick={() => void act('clear')} disabled={busy !== null} title="Type /clear into the agent pane: start fresh">
          {busy === 'clear' ? 'Clearing…' : 'Clear'}
        </button>
        {handoffWorkstreamId && (
          <button className="pr-prompt-btn" onClick={() => void handOff()} disabled={busy !== null} title="Have the agent write a handoff, then /clear and read it back in">
            {busy === 'handoff' ? 'Handing off…' : 'Hand off'}
          </button>
        )}
        <button className="pr-prompt-btn pr-prompt-btn--ghost" onClick={dismiss} disabled={busy !== null} title="Keep the context as is">Keep</button>
      </span>
    </div>
  );
}
