// The full UI's Resize box dialog, from a box's ⋮ in the Boxes list: the sizes in
// the full UI's standard select (an npf-field, as the New project form's Box
// size), the current one marked, and the disk in the New project form's disk
// field (BoxDiskField, a native number input), from the current disk up to the
// server's cap. Size, disk or both change in one go: the disk first, with the
// box up, then the resize, which waits for it. One warning (also the
// confirmation: Resize goes ahead whatever is running), which mentions the stop
// only when the size changes, then the progress. The simple UI's is
// pages/chat/BoxResizeLaunchPad.tsx, and the Fleet tab's
// pages/admin/AdminBoxResize.tsx; the state is hooks/useBoxResize.
import React from 'react';
import type { Instance } from '../types';
import { instancesApi } from '../services/api';
import { useBoxResize, type BoxResizeState } from '../hooks/useBoxResize';
import { sizeOptionLabel, type BoxSize } from '../utils/boxSize';
import {
  changeWarning, currentDiskLabel, retryNote, growOutcome, growSteps, losesHibernation, phaseLabel, resizeOptionLabel, resizeOutcome, resizeSteps,
} from '../utils/boxResize';
import { BoxDiskField } from './BoxDiskField';
import { Dialog } from './Dialog';

/** The progress lists (the disk's, then the resize's) and their outcomes, shared with the Fleet tab's form. */
export function ResizeProgress({ state }: { state: BoxResizeState }) {
  const { resize, info, fromStatus, grow, growShown, withDisk, error } = state;
  if (!info || (!resize && !growShown)) return null;
  const showResize = !!resize && fromStatus !== null;
  const outcome = showResize ? resizeOutcome(resize, info.sizes) : null;
  const grown = growShown && grow ? growOutcome(grow) : null;
  return (
    <div className="box-resize-progress" role="status" aria-live="polite">
      {growShown && grow && (
        <ol className="box-resize-steps">
          {growSteps(grow).map(s => (
            <li key={s.key} data-state={s.state}>{s.label}{s.state === 'current' ? '…' : ''}</li>
          ))}
        </ol>
      )}
      {grown && <div className={grow?.state === 'failed' ? 'error-text' : 'npf-note'}>{grown}</div>}
      {/* A grow that failed here can be finished here: same size, file system step only (Devin on #1214). */}
      {growShown && !grow?.running && state.retry && (
        <button type="button" className="btn-ghost" onClick={() => void state.retryGrow()} disabled={state.submitting}>Finish growing the disk</button>
      )}
      {showResize && (
        <ol className="box-resize-steps">
          {resizeSteps(resize, fromStatus ?? info.box.status, withDisk).map(s => (
            <li key={s.phase} data-state={s.state}>{s.label}{s.state === 'current' ? '…' : ''}</li>
          ))}
        </ol>
      )}
      {showResize && resize.running && <div className="npf-note usage-dim">{phaseLabel(resize.phase)}. You can close this; the resize carries on.</div>}
      {!showResize && grow?.running && <div className="npf-note usage-dim">The box stays up. You can close this; the disk carries on growing.</div>}
      {outcome && <div className={resize?.phase === 'failed' ? 'error-text' : 'npf-note'}>{outcome}</div>}
      {/* The grow went through and the resize after it was refused: say so here, where the dialog now is. */}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** "Now: Small · 2 vCPU, 8 GB RAM · 120 GB disk". */
export function nowLine(state: BoxResizeState): string {
  const { info } = state;
  if (!info) return '';
  const choice = info.sizes.find(s => s.size === info.box.size);
  const size = choice ? sizeOptionLabel(choice) : info.box.instanceType ?? 'not recorded';
  const disk = currentDiskLabel(info.disk);
  return `Now: ${size}${disk ? ` · ${disk}` : ''}`;
}

export function BoxResizeDialog({ box, onClose, onChanged }: { box: Instance; onClose: () => void; onChanged: () => void }) {
  const state = useBoxResize({
    load: () => instancesApi.resizeInfo(box.id),
    send: (size, force) => instancesApi.resize(box.id, size, force),
    grow: sizeGb => instancesApi.growDisk(box.id, sizeGb),
  }, onChanged);
  const { info, loadError, picked, setPicked, submitting, error, showProgress, diskOptions, diskTyped, setDiskTyped, diskTarget, sizeChanges, canSubmit, retry } = state;
  const current = info?.box.size ?? null;
  const refusal = info?.refusal ?? null;
  const diskRefusal = info?.disk?.refusal ?? null;
  const warning = info ? changeWarning(info.box.status, { size: sizeChanges, disk: diskTarget !== null }, sizeChanges && !!picked && losesHibernation(info, picked)) : null;

  return (
    <Dialog title={`Resize “${box.name}”`} onClose={onClose} closeDisabled={submitting} className="np-dialog box-resize-dialog">
      <div className="npf">
        {!info && <div className="npf-note usage-dim">{loadError ?? 'Loading…'}</div>}
        {info && showProgress && <ResizeProgress state={state} />}
        {info && !showProgress && (
          <>
            <div className="npf-note">{nowLine(state)}</div>
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
            {refusal && <div className="box-lifecycle-warning" role="status">{refusal.error}</div>}
            {diskOptions && (
              <BoxDiskField
                id="box-resize-disk"
                label="New disk (GB)"
                disk={diskOptions}
                typed={diskTyped}
                onType={setDiskTyped}
                disabled={submitting || !!diskRefusal}
              />
            )}
            {retry ? (
              <div className="npf-field npf-inline">
                <span className="error-text">{retryNote(retry)}</span>
                <button type="button" className="btn-ghost" onClick={() => void state.retryGrow()} disabled={submitting}>Finish growing the disk</button>
              </div>
            ) : diskRefusal && <div className="npf-note usage-dim" role="status">{diskRefusal}</div>}
            {warning && <div className="box-lifecycle-warning" role="note">{warning}</div>}
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
                disabled={!canSubmit}
              >{submitting ? 'Resizing…' : 'Resize'}</button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
