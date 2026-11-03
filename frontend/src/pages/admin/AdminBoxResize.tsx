// The Fleet tab's Resize, in a box's detail card (AdminFleet.tsx): the same
// sizes and confirmation as the owners' Size… dialogs, plus the reason the
// admin audit log keeps and the box's owner sees. The state is
// hooks/useBoxResize; the progress list is BoxResizeDialog's.
import React, { useState } from 'react';
import { adminApi } from '../../services/adminApi';
import { useBoxResize } from '../../hooks/useBoxResize';
import { ResizeProgress } from '../../components/BoxResizeDialog';
import type { BoxSize } from '../../utils/boxSize';
import { losesHibernation, resizeOptionLabel, resizeOutcome, resizeWarning } from '../../utils/boxResize';

export function AdminBoxResize({ boxId, onChanged }: { boxId: string; onChanged?: () => void }) {
  const [reason, setReason] = useState('');
  const state = useBoxResize({
    load: () => adminApi.boxResizeInfo(boxId),
    send: (size, force) => adminApi.resizeBox(boxId, size, reason.trim(), force),
  }, onChanged);
  const { info, loadError, picked, setPicked, submitting, error, fromStatus, resize } = state;
  if (!info) return <span className="usage-dim">{loadError ? `could not load: ${loadError}` : 'loading…'}</span>;
  // The progress only while it runs: once it ends (done or failed) the form
  // comes back, with how it ended, for a retry or another size (Bugbot on #877).
  if (fromStatus !== null && resize?.running) return <ResizeProgress state={state} />;
  const ended = fromStatus !== null && resize && !resize.running && resize.phase !== 'failed' ? resizeOutcome(resize, info.sizes) : null;
  const current = info.box.size;

  // One confirmation, as in the owners' dialogs: what is running on the box
  // is in it, and saying yes resizes anyway (the request is sent with force).
  const go = () => {
    if (!picked) return;
    const running = info.blockers.length ? `\n\nRunning on it now: ${info.blockers.map(b => b.reason).join('; ')}.` : '';
    const question = `Resize ${info.box.name} to ${picked}?\n\n${resizeWarning(info.box.status, losesHibernation(info, picked))}${running}\n\nThe owner sees your reason.`;
    if (window.confirm(question)) void state.submit();
  };

  return (
    <div>
      {resize && !resize.running && resize.phase === 'failed' && <div className="admin-bad">last resize failed: {resize.error}</div>}
      {ended && <div className="usage-dim">{ended}</div>}
      {info.refusal
        ? <div className="usage-dim">can't resize: {info.refusal.error}</div>
        : (
          <form className="admin-form" onSubmit={e => { e.preventDefault(); go(); }}>
            <select value={picked ?? ''} onChange={e => setPicked(e.target.value as BoxSize)} aria-label="new size" disabled={submitting}>
              {info.sizes.map(s => <option key={s.size} value={s.size}>{resizeOptionLabel(s, current)}</option>)}
            </select>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="reason (the owner sees it)" aria-label="reason" style={{ minWidth: 200 }} />
            <button type="submit" className="btn-ghost btn-tiny" disabled={submitting || !picked || picked === current || reason.trim().length < 3}>Resize</button>
          </form>
        )}
      {info.blockers.length > 0 && <div className="usage-dim">right now {info.blockers.map(b => b.reason).join('; ')}</div>}
      {error && <div className="admin-error">{error}</div>}
    </div>
  );
}
