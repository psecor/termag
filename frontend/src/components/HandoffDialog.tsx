import React, { useState } from 'react';
import type { HandoffMode } from '../types';
import { defaultHandoffMode, handoffModeChoices, handoffTargets } from '../utils/handoff';
import { PROVIDERS } from '../providers/registry';
import { Dialog } from './Dialog';

/**
 * Hand one workstream's agent off: pick how its
 * context is reset and, for a restart, which agent comes next. The backend
 * does the rest once the agent is at its prompt; progress shows over the
 * agent pane (HandoffStrip).
 */
export function HandoffDialog({ title, current, busy, error, onStart, onCancel }: {
  title: string;
  current: string | null;
  busy: boolean;
  error: string;
  onStart: (body: { mode: HandoffMode; provider?: string; note?: string }) => void;
  onCancel: () => void;
}) {
  const modes = handoffModeChoices(current);
  const [mode, setMode] = useState<HandoffMode>(defaultHandoffMode(current));
  const agents = handoffTargets(current);
  const [provider, setProvider] = useState<string>(current ?? agents[0]?.id ?? 'claude');
  const [note, setNote] = useState('');
  const chosen = modes.find(m => m.mode === mode);

  const submit = () => {
    if (busy) return;
    onStart({
      mode,
      ...(mode === 'restart' && provider !== current ? { provider } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };

  return (
    <Dialog title={<>Hand off · {title}</>} className="np-dialog" onClose={onCancel} closeDisabled={busy}>
      <form className="npf" onSubmit={e => { e.preventDefault(); submit(); }}>
        <div className="npf-field">
          <label htmlFor="handoff-mode-select">Then</label>
          <select id="handoff-mode-select" value={mode} onChange={e => setMode(e.target.value as HandoffMode)} disabled={busy} autoFocus>
            {modes.map(m => (
              <option key={m.mode} value={m.mode} disabled={!m.available}>
                {m.label}{m.available ? '' : ` (not for ${current ? PROVIDERS[current]?.displayName ?? current : 'this agent'})`}
              </option>
            ))}
          </select>
          {chosen && <div className="npf-note usage-dim">{chosen.detail}</div>}
        </div>
        {mode === 'restart' && (
          <div className="npf-field">
            <label htmlFor="handoff-agent-select">Next agent</label>
            <select id="handoff-agent-select" value={provider} onChange={e => setProvider(e.target.value)} disabled={busy}>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.label}{a.current ? ' (running now)' : ''}</option>
              ))}
            </select>
          </div>
        )}
        <div className="npf-field">
          <label htmlFor="handoff-note">Note for the next agent (optional)</label>
          <textarea id="handoff-note" rows={2} value={note} onChange={e => setNote(e.target.value)} disabled={busy} maxLength={2000} />
          <div className="npf-note usage-dim">
            The agent first writes a handoff (goal, state, decisions, next steps). When its turn ends the pane is
            reset and the next agent starts on it. The ctrl pane and any Review pane keep running.
          </div>
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="npf-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Starting…' : 'Hand off'}</button>
        </div>
      </form>
    </Dialog>
  );
}
