import React, { useState } from 'react';
import { handoffApi } from '../../services/api';
import type { HandoffMode } from '../../types';
import { handoffModeChoices, handoffTargets } from '../../utils/handoff';
import { Sheet, apiError } from './Sheet';

/**
 * The phone's Hand off, the desktop dialog in a
 * sheet: one tap per mode the agent can do, a next agent for a restart, and
 * an optional note. Progress then shows in the conversation's banner.
 */
export function HandoffSheet({ projectId, workstreamId, title, current, onStarted, onClose }: {
  projectId: string;
  workstreamId: string;
  title: string;
  current: string | null;
  /** The fallback notice, if any, shows on the banner through the handoff's reason. */
  onStarted: () => void;
  onClose: () => void;
}) {
  const modes = handoffModeChoices(current).filter(m => m.available);
  const agents = handoffTargets(current);
  const [provider, setProvider] = useState<string>(current ?? agents[0]?.id ?? 'claude');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<HandoffMode | null>(null);
  const [error, setError] = useState('');

  const start = async (mode: HandoffMode) => {
    if (busy) return;
    setBusy(mode);
    setError('');
    try {
      await handoffApi.start(projectId, workstreamId, {
        mode, surface: 'mobile',
        ...(mode === 'restart' && provider !== current ? { provider } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onStarted();
    } catch (err) {
      setError(apiError(err, 'Could not start the handoff'));
      setBusy(null);
    }
  };

  return (
    <Sheet title={`Hand off · ${title}`} onClose={onClose}>
      <div className="m-form">
        <p className="m-form-note">The agent writes a handoff when its turn ends. Then the pane is reset and the next agent starts on it.</p>
        {agents.length > 1 && modes.some(m => m.mode === 'restart') && (
          <label className="m-field">
            <span className="m-field-label">Next agent (restart)</span>
            <select className="m-text" value={provider} onChange={e => setProvider(e.target.value)} disabled={busy !== null}>
              {agents.map(a => <option key={a.id} value={a.id}>{a.label}{a.current ? ' (running now)' : ''}</option>)}
            </select>
          </label>
        )}
        <label className="m-field">
          <span className="m-field-label">Note for the next agent (optional)</span>
          <input className="m-text" value={note} onChange={e => setNote(e.target.value)} maxLength={2000} disabled={busy !== null} />
        </label>
        {error && <div className="m-form-error" role="alert">{error}</div>}
      </div>
      <div className="m-sheet-actions">
        {modes.map(m => (
          <button key={m.mode} className="m-sheet-action" disabled={busy !== null} onClick={() => { void start(m.mode); }}>
            {busy === m.mode ? 'Starting…' : m.mode === 'restart' && provider !== current ? `Restart on ${agents.find(a => a.id === provider)?.label ?? provider}` : m.label}
          </button>
        ))}
        <button className="m-sheet-action m-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
