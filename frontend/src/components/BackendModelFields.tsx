import React from 'react';
import type { BackendChoice } from '../providers/useBackendChoices';

/**
 * The model backend and model fields of an agent picker,
 * under its Agent field: Inference when the harness has more than its default
 * backend for this viewer, Model when the chosen backend offers models. Both
 * start at Default (null). `running` marks the backend and model the agent
 * runs on now, for Switch agent.
 */
export function BackendModelFields({ idPrefix, choices, backend, model, onBackend, onModel, running, disabled }: {
  idPrefix: string;
  choices: BackendChoice[];
  backend: string | null;
  model: string | null;
  onBackend: (backend: string | null) => void;
  onModel: (model: string | null) => void;
  running?: { backend: string | null; model: string | null } | null;
  disabled?: boolean;
}) {
  const chosen = choices.find(c => c.id === backend) ?? choices[0];
  const now = ' (running now)';
  return (
    <>
      {choices.length > 1 && (
        <div className="npf-field">
          <label htmlFor={`${idPrefix}-backend`}>Inference</label>
          <select
            id={`${idPrefix}-backend`}
            value={chosen.id ?? ''}
            disabled={disabled}
            onChange={e => { onBackend(e.target.value || null); onModel(null); }}
          >
            {choices.map(c => (
              <option key={c.id ?? ''} value={c.id ?? ''}>{c.label}{running && running.backend === c.id ? now : ''}</option>
            ))}
          </select>
        </div>
      )}
      {chosen.models.length > 0 && (
        <div className="npf-field">
          <label htmlFor={`${idPrefix}-model`}>Model</label>
          <select id={`${idPrefix}-model`} value={model ?? ''} disabled={disabled} onChange={e => onModel(e.target.value || null)}>
            <option value="">Default{running && running.backend === chosen.id && running.model === null ? now : ''}</option>
            {chosen.models.map(m => (
              <option key={m.id} value={m.id}>
                {m.label}{m.context ? ` · ${contextLabel(m.context)} context` : ''}
                {running && running.backend === chosen.id && running.model === m.id ? now : ''}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

/** 1048576 → 1M, 512000 → 512k. */
function contextLabel(tokens: number): string {
  return tokens % 1048576 === 0 ? `${tokens / 1048576}M` : `${Math.round(tokens / 1000)}k`;
}

/** The backend and model a picker should send: each only if the menus still offer it. */
export function offeredChoice(choices: BackendChoice[], backend: string | null, model: string | null): { backend: string | null; model: string | null } {
  const b = choices.find(c => c.id === backend) ? backend : null;
  const models = (choices.find(c => c.id === b) ?? choices[0]).models;
  return { backend: b, model: model && models.some(m => m.id === model) ? model : null };
}
