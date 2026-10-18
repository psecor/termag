import React, { useEffect, useState } from 'react';
import type { AgentStatus } from '../types';
import { handoffApi } from '../services/api';
import { handoffStateLabel, isHandoffAbortable, isHandoffOpen, showHandoffStrip } from '../utils/handoff';

/**
 * A handoff of this agent pane in progress, as a strip
 * across the top of the pane, where the PR context card sits (the card hides
 * while a handoff is open). State comes from the session's status push; Abort
 * is offered until the pane has been touched.
 */
export function HandoffStrip({ status, canAbort }: { status: AgentStatus | undefined; canAbort: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const h = status?.handoff;
  const visible = showHandoffStrip(h, now);

  useEffect(() => {
    if (!h || isHandoffOpen(h)) return;
    // Re-check so a finished handoff's line goes away on time.
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [h]);
  useEffect(() => { setNow(Date.now()); setBusy(false); }, [h?.id, h?.state]);

  if (!h || !visible) return null;
  const failed = h.state === 'failed' || h.state === 'aborted';
  const abort = async () => {
    if (busy) return;
    setBusy(true);
    try { await handoffApi.abort(h.id); } catch { setBusy(false); }
  };
  return (
    <div className={`pr-prompt handoff-strip${failed ? ' handoff-strip--failed' : ''}`} role="status" aria-live="polite">
      <span className="pr-prompt-text">{handoffStateLabel(h)}</span>
      {canAbort && isHandoffAbortable(h) && (
        <span className="pr-prompt-actions">
          <button className="pr-prompt-btn pr-prompt-btn--ghost" onClick={() => void abort()} disabled={busy} title="Stop the handoff; nothing has been reset yet">
            {busy ? 'Aborting…' : 'Abort'}
          </button>
        </span>
      )}
    </div>
  );
}
