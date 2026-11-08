import React, { useState } from 'react';
import { adminApi, type SoftwareUpdateRun, type ToolUpdatePreview } from '../../services/adminApi';
import { hostUpdateAction } from '../../utils/toolUpdate';
import { FollowedRunText, useFollowedRun } from './FollowedRun';
import { floorOnlyText, heldText, orchestratorConfirmText, orchestratorConflictText } from '../../utils/orchestratorClaudeUpdate';
import { errorText } from './shared';

/**
 * The orchestrator row's "Update Claude Code". Like
 * a box's, but with no restart choice: the run try-restarts the runner orchestrator and counts host users'
 * sessions on the old binary without stopping them. Shown only when the preview answers and says the host
 * can, so orchestrator-claude-update-policy's mode off hides it without the browser reading it.
 */
export function OrchestratorClaudeUpdate({ preview, runs = null, onRequested, onPoll = () => {}, onRunEnded = () => {} }: {
  preview: ToolUpdatePreview | 'off' | null;
  /** Claude Code's runs list, which the line under the button follows the run it asked for in (as a box's). */
  runs?: SoftwareUpdateRun[] | null;
  onRequested: () => void; onPoll?: () => void; onRunEnded?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const followed = useFollowedRun(runs, onPoll, onRunEnded);
  const action = hostUpdateAction(preview);
  if (action.kind === 'hidden' || !preview || preview === 'off') return null;
  const submit = async () => {
    if (!window.confirm(orchestratorConfirmText(preview))) return;
    setBusy(true); setErr(null);
    try { followed.follow(await adminApi.updateTool('claude', preview.hostKey, 'none')); onRequested(); }
    catch (e) { setErr(orchestratorConflictText(e) ?? errorText(e)); }
    finally { setBusy(false); }
  };
  // No pin and nothing to bring up to the floor: no button for an update that would install nothing.
  if (preview.nothingToDo) {
    return (
      <div style={{ marginTop: 8 }}>
        <div className="usage-dim">{floorOnlyText(preview)}</div>
        {heldText(preview) && <div className="admin-error">{heldText(preview)}</div>}
        {followed.req && <FollowedRunText req={followed.req} run={followed.run} />}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="admin-form">
        <button type="button" className="btn-ghost btn-tiny" disabled={busy || followed.going || action.kind === 'disabled'} onClick={() => void submit()}>Update Claude Code</button>
        <span className="usage-dim">
          <span className="admin-mono">{preview.current ?? '?'}</span> → <span className="admin-mono">{preview.target ?? preview.floor ?? '?'}</span>
          {preview.floor ? <> · floor <span className="admin-mono">{preview.floor}</span></> : null}
          {' '}· restarts the runner orchestrator; host sessions keep running{action.kind === 'disabled' ? ` · ${action.reason}` : ''}
        </span>
      </div>
      {floorOnlyText(preview) && <div className="usage-dim">{floorOnlyText(preview)}</div>}
      {heldText(preview) && <div className="admin-error">{heldText(preview)}</div>}
      {err && <div className="admin-error">{err}</div>}
      {followed.req && <FollowedRunText req={followed.req} run={followed.run} />}
    </div>
  );
}
