import React, { useState } from 'react';
import { agentChoices, defaultAgentChoice } from '../utils/switchAgent';
import { Dialog } from './Dialog';

/**
 * Pick the agent one workstream should run, in the New project dialog's
 * shell and fields. Switching stops the agent running now, but nothing is
 * lost that a switch back can't restart, so it is a primary action.
 */
export function SwitchAgentDialog({ title, current, busy, onSwitch, onCancel }: {
  title: string;
  current: string | null;
  busy: boolean;
  onSwitch: (provider: string) => void;
  onCancel: () => void;
}) {
  const choices = agentChoices(current);
  const [picked, setPicked] = useState<string | null>(defaultAgentChoice(current));
  const currentLabel = choices.find(c => c.current)?.label ?? 'the current agent';

  return (
    <Dialog title={<>Switch agent · {title}</>} className="np-dialog" onClose={onCancel} closeDisabled={busy}>
      <form className="npf" onSubmit={e => { e.preventDefault(); if (picked && !busy) onSwitch(picked); }}>
        <div className="npf-field">
          <label htmlFor="switch-agent-select">Agent</label>
          <select
            id="switch-agent-select"
            value={picked ?? ''}
            onChange={e => setPicked(e.target.value)}
            disabled={busy}
            autoFocus
          >
            {choices.map(c => (
              <option key={c.id} value={c.id} disabled={c.current}>
                {c.label}{c.current ? ' (running now)' : ''}
              </option>
            ))}
          </select>
          <div className="npf-note usage-dim">
            This stops {currentLabel} in the agent pane, mid-task if it is working, and starts the new agent
            there fresh. The ctrl pane and any Review pane keep running.
          </div>
        </div>
        <div className="npf-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !picked}>
            {busy ? 'Switching…' : 'Switch'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
