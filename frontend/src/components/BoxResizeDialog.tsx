// The full UI's Resize box dialog, from a box's ⋮ in the Boxes list: the sizes in
// the full UI's standard select (an npf-field, as the New project form's Box
// size), the current one marked, one downtime warning (also the
// confirmation: Resize goes ahead whatever is running), then the progress. The simple UI's is pages/chat/BoxResizeLaunchPad.tsx, and the
// Fleet tab's pages/admin/AdminBoxResize.tsx; the state is hooks/useBoxResize.
import React from 'react';
import type { Instance } from '../types';
import { instancesApi } from '../services/api';
import { useBoxResize, type BoxResizeState } from '../hooks/useBoxResize';
import { sizeOptionLabel, type BoxSize } from '../utils/boxSize';
import { losesHibernation, phaseLabel, resizeOptionLabel, resizeOutcome, resizeSteps, resizeWarning } from '../utils/boxResize';
import { Dialog } from './Dialog';

/** The progress list and the outcome, shared with the Fleet tab's form. */
export function ResizeProgress({ state }: { state: BoxResizeState }) {
  const { resize, info, fromStatus } = state;
  if (!resize || !info) return null;
  const outcome = resizeOutcome(resize, info.sizes);
  return (
    <div className="box-resize-progress" role="status" aria-live="polite">
      <ol className="box-resize-steps">
        {resizeSteps(resize, fromStatus ?? info.box.status).map(s => (
          <li key={s.phase} data-state={s.state}>{s.label}{s.state === 'current' ? '…' : ''}</li>
        ))}
      </ol>
      {resize.running && <div className="npf-note usage-dim">{phaseLabel(resize.phase)}. You can close this; the resize carries on.</div>}
      {outcome && <div className={resize.phase === 'failed' ? 'error-text' : 'npf-note'}>{outcome}</div>}
    </div>
  );
}

export function BoxResizeDialog({ box, onClose, onChanged }: { box: Instance; onClose: () => void; onChanged: () => void }) {
  const state = useBoxResize({ load: () => instancesApi.resizeInfo(box.id), send: (size, force) => instancesApi.resize(box.id, size, force) }, onChanged);
  const { info, loadError, picked, setPicked, submitting, error, fromStatus } = state;
  const current = info?.box.size ?? null;
  const showProgress = fromStatus !== null && !!state.resize;
  const refusal = info?.refusal ?? null;
  const currentChoice = info?.sizes.find(s => s.size === current);

  return (
    <Dialog title={`Resize “${box.name}”`} onClose={onClose} closeDisabled={submitting} className="np-dialog box-resize-dialog">
      <div className="npf">
        {!info && <div className="npf-note usage-dim">{loadError ?? 'Loading…'}</div>}
        {info && showProgress && <ResizeProgress state={state} />}
        {info && !showProgress && (
          <>
            <div className="npf-note">
              Now: {currentChoice ? sizeOptionLabel(currentChoice) : info.box.instanceType ?? 'not recorded'}
            </div>
            <div className="npf-field">
              <label htmlFor="box-resize-size">New size</label>
              <select
                id="box-resize-size"
                value={picked ?? ''}
                disabled={submitting || !!refusal}
                onChange={e => setPicked(e.target.value as BoxSize)}
              >
                {info.sizes.map(s => <option key={s.size} value={s.size}>{resizeOptionLabel(s, current)}</option>)}
              </select>
            </div>
            {refusal
              ? <div className="box-lifecycle-warning" role="status">{refusal.error}</div>
              : <div className="box-lifecycle-warning" role="note">{resizeWarning(info.box.status, !!picked && losesHibernation(info, picked))}</div>}
            {error && <div className="error-text">{error}</div>}
          </>
        )}
        <div className="npf-actions">
          {showProgress || !info ? (
            <button type="button" className="btn-primary" onClick={onClose}>Close</button>
          ) : (
            <>
              <button type="button" className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void state.submit()}
                disabled={submitting || !!refusal || !picked || picked === current}
              >{submitting ? 'Resizing…' : 'Resize'}</button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
