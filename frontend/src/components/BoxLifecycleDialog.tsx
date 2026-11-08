import { useState } from 'react';
import type { Instance } from '../types';
import { instancesApi } from '../services/api';
import { idleChoiceLabel, idleChoicesFor, terminateChoiceLabel, terminateChoicesFor } from '../utils/boxLifecycle';

export function BoxLifecycleDialog({ box, onClose, onSaved }: {
  box: Instance;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Auto-park only ever stops the box, so there is no Include RAM, and both
  // settings apply to any box.
  const current = box.lifecycle?.idleHibernateHours ?? null;
  const currentDays = box.lifecycle?.hibernatedTerminateDays ?? null;
  const [stopHours, setStopHours] = useState<number | null>(current);
  const [days, setDays] = useState<number | null>(currentDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const unchanged = stopHours === current && days === currentDays;

  async function save() {
    setSaving(true);
    setError('');
    try {
      await instancesApi.setLifecycle(box.id, { idleHibernateHours: stopHours, hibernatedTerminateDays: days });
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
          {/* The default window's hours are server-only, so this cannot say the box stops after two hours. */}
          <div className="npf-note">
            A stop does not keep memory, and starting the box again takes about 10–20 seconds.
          </div>
          <div className="npf-field">
            <label htmlFor="lc-stop">Stop when idle</label>
            <select
              id="lc-stop"
              value={stopHours === null ? '' : String(stopHours)}
              onChange={e => setStopHours(e.target.value === '' ? null : Number(e.target.value))}
              disabled={saving}
            >
              {idleChoicesFor(stopHours).map(h => (
                <option key={h ?? 'default'} value={h === null ? '' : String(h)}>{h === null ? 'Default' : idleChoiceLabel(h)}</option>
              ))}
            </select>
            <div className="npf-note usage-dim">
              Idle means nobody typing and no agent working; an agent waiting for your answer counts as idle.
              Default leaves it to termag&apos;s own idle stop, when that is on for you.
            </div>
          </div>
          <div className="npf-field">
            <label htmlFor="lc-terminate">Terminate once parked</label>
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
              Counted from when auto-park stopped it. Work that isn&apos;t pushed anywhere keeps it much longer
              (90 days by default). Terminating deletes its disk.
            </div>
          </div>
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
