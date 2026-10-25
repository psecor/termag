import React, { useState } from 'react';
import { agentChoices, defaultAgentChoice } from '../utils/switchAgent';
import { useBackendChoices } from '../providers/useBackendChoices';
import { BackendModelFields, offeredChoice } from './BackendModelFields';
import { Dialog } from './Dialog';

/**
 * Pick the agent one workstream should run, in the New project dialog's
 * shell and fields. Switching stops the agent running now, but nothing is
 * lost that a switch back can't restart, so it is a primary action.
 *
 * With `start` (the provider to preselect), the workstream has no agent yet
 * (an un-archived project whose agents were not restored): the same picker
 * starts one in its checkout, continuing the last conversation there.
 *
 * The Inference and Model fields pick the agent's model backend and model.
 * The same agent on another backend
 * or model is a switch too: it stops and starts again on it.
 */
export function SwitchAgentDialog({ title, current, currentBackend = null, currentModel = null, start, busy, onSwitch, onCancel }: {
  title: string;
  current: string | null;
  /** The backend and model the current agent runs on; null = the defaults. */
  currentBackend?: string | null;
  currentModel?: string | null;
  start?: string;
  busy: boolean;
  onSwitch: (provider: string, backend: string | null, model: string | null) => void;
  onCancel: () => void;
}) {
  const choices = agentChoices(start ? null : current);
  const [picked, setPicked] = useState<string | null>(
    start && choices.some(c => c.id === start) ? start : defaultAgentChoice(start ? null : current),
  );
  const backendChoices = useBackendChoices(picked);
  const [backend, setBackend] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const chosen = offeredChoice(backendChoices, backend, model);
  const isCurrent = (id: string | null) => !start && id === current;
  const unchanged = isCurrent(picked) && chosen.backend === currentBackend && chosen.model === currentModel;
  const currentLabel = choices.find(c => c.current)?.label ?? 'the current agent';
  const pick = (id: string) => {
    setPicked(id);
    setBackend(isCurrent(id) ? currentBackend : null);
    setModel(isCurrent(id) ? currentModel : null);
  };

  return (
    <Dialog title={<>{start ? 'Start agent' : 'Switch agent'} · {title}</>} className="np-dialog" onClose={onCancel} closeDisabled={busy}>
      <form className="npf" onSubmit={e => { e.preventDefault(); if (picked && !busy && !unchanged) onSwitch(picked, chosen.backend, chosen.model); }}>
        <div className="npf-field">
          <label htmlFor="switch-agent-select">Agent</label>
          <select
            id="switch-agent-select"
            value={picked ?? ''}
            onChange={e => pick(e.target.value)}
            disabled={busy}
            autoFocus
          >
            {choices.map(c => (
              <option key={c.id} value={c.id}>
                {c.label}{c.current ? ' (running now)' : ''}
              </option>
            ))}
          </select>
        </div>
        <BackendModelFields
          idPrefix="switch"
          choices={backendChoices}
          backend={chosen.backend}
          model={chosen.model}
          onBackend={setBackend}
          onModel={setModel}
          running={isCurrent(picked) ? { backend: currentBackend, model: currentModel } : null}
          disabled={busy}
        />
        <div className="npf-field">
          <div className="npf-note usage-dim">
            {start
              ? <>This workstream has no agent. This starts one in its checkout, continuing the last conversation
                there if it has one. An agent already running in the pane is kept.</>
              : <>This stops {currentLabel} in the agent pane, mid-task if it is working, and starts the new agent
                there fresh. The ctrl pane and any Review pane keep running.</>}
          </div>
        </div>
        <div className="npf-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !picked || unchanged}>
            {start ? (busy ? 'Starting…' : 'Start') : (busy ? 'Switching…' : 'Switch')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
