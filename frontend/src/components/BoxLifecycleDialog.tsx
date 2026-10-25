import { useState } from 'react';
import type { Instance } from '../types';
import { instancesApi } from '../services/api';
import {
  CANNOT_HIBERNATE_TEXT, idleChoiceLabel, idleChoicesFor, terminateChoiceLabel, terminateChoicesFor,
} from '../utils/boxLifecycle';

export function BoxLifecycleDialog({ box, onClose, onSaved }: {
  box: Instance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = box.lifecycle?.idleHibernateHours ?? null;
  const currentDays = box.lifecycle?.hibernatedTerminateDays ?? null;
  const [hours, setHours] = useState<number | null>(current);
  const [days, setDays] = useState<number | null>(currentDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const unchanged = hours === current && days === currentDays;
  const showCannotHibernate = !!box.lifecycle && !box.lifecycle.canAutoHibernate && (hours !== null || days !== null);
  // The server picks the sentence from box-idle-stop-enabled. The dialog can
  // repeat it while idle hours stay unset; choosing hours keeps the flag-off sentence,
  // which is still true for a box with its own idle setting.
  const cannotText = hours === null && (box.lifecycle?.idleHibernateHours ?? null) === null && box.lifecycle?.warning
    ? box.lifecycle.warning
    : CANNOT_HIBERNATE_TEXT;

  async function save() {
    setSaving(true);
    setError('');
    try {
      await instancesApi.setLifecycle(box.id, { idleHibernateHours: hours, hibernatedTerminateDays: days });
      onSaved();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to save');
      setSaving(false);
    }
  }

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-dialog np-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      >
        <div className="np-dialog-title" id="lc-title">Auto-park “{box.name}”</div>
        <div className="npf">
          <div className="npf-field">
            <label htmlFor="lc-idle">Hibernate when idle</label>
            <select
              id="lc-idle"
              value={hours === null ? '' : String(hours)}
              onChange={e => setHours(e.target.value === '' ? null : Number(e.target.value))}
              disabled={saving}
              autoFocus
            >
              {idleChoicesFor(current).map(h => (
                <option key={h ?? 'off'} value={h === null ? '' : String(h)}>{idleChoiceLabel(h)}</option>
              ))}
            </select>
            <div className="npf-note usage-dim">
              Idle means nobody typing and no agent working; an agent waiting for your answer counts as idle.
              Start the box again to resume where you left off.
            </div>
          </div>
          <div className="npf-field">
            <label htmlFor="lc-terminate">Terminate once hibernated</label>
            <select
              id="lc-terminate"
              value={days === null ? '' : String(days)}
              onChange={e => setDays(e.target.value === '' ? null : Number(e.target.value))}
              disabled={saving}
            >
              {terminateChoicesFor(currentDays).map(d => (
                <option key={d ?? 'never'} value={d === null ? '' : String(d)}>{terminateChoiceLabel(d)}</option>
              ))}
            </select>
            <div className="npf-note usage-dim">
              Counted from when it went to sleep, by hand or on its own. Work that isn't pushed anywhere keeps it
              much longer (90 days by default). Terminating deletes its disk.
            </div>
          </div>
          {showCannotHibernate && <div className="box-lifecycle-warning" role="status">{cannotText}</div>}
          {error && <div className="error-text">{error}</div>}
          <div className="npf-actions">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || unchanged}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
