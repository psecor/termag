import React, { useState } from 'react';
import { adminApi, type ToolUpdatePreview } from '../../services/adminApi';
import { hostRequestedText, hostUpdateAction } from '../../utils/toolUpdate';
import { floorOnlyText, heldText, orchestratorConfirmText, orchestratorConflictText } from '../../utils/orchestratorClaudeUpdate';
import { errorText } from './shared';

/**
 * The orchestrator row's "Update Claude Code". Like
 * a box's, but with no restart choice: the run try-restarts the runner orchestrator and counts host users'
 * sessions on the old binary without stopping them. Shown only when the preview answers and says the host
 * can, so orchestrator-claude-update-enabled hides it without the browser reading it.
 */
export function OrchestratorClaudeUpdate({ preview, onRequested }: { preview: ToolUpdatePreview | 'off' | null; onRequested: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; className: string } | null>(null);
  const action = hostUpdateAction(preview);
  if (action.kind === 'hidden' || !preview || preview === 'off') return null;
  const submit = async () => {
    if (!window.confirm(orchestratorConfirmText(preview))) return;
    setBusy(true); setMsg(null);
    try { setMsg(hostRequestedText(await adminApi.updateTool('claude', preview.hostKey, 'none'))); onRequested(); }
    catch (e) { setMsg({ text: orchestratorConflictText(e) ?? errorText(e), className: 'admin-error' }); }
    finally { setBusy(false); }
  };
  // No pin and nothing to bring up to the floor: no button for an update that would install nothing.
  if (preview.nothingToDo) {
    return (
      <div style={{ marginTop: 8 }}>
        <div className="usage-dim">{floorOnlyText(preview)}</div>
        {heldText(preview) && <div className="admin-error">{heldText(preview)}</div>}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="admin-form">
        <button type="button" className="btn-ghost btn-tiny" disabled={busy || action.kind === 'disabled'} onClick={() => void submit()}>Update Claude Code</button>
        <span className="usage-dim">
          <span className="admin-mono">{preview.current ?? '?'}</span> → <span className="admin-mono">{preview.target ?? preview.floor ?? '?'}</span>
          {preview.floor ? <> · floor <span className="admin-mono">{preview.floor}</span></> : null}
          {' '}· restarts the runner orchestrator; host sessions keep running{action.kind === 'disabled' ? ` · ${action.reason}` : ''}
        </span>
      </div>
      {floorOnlyText(preview) && <div className="usage-dim">{floorOnlyText(preview)}</div>}
      {heldText(preview) && <div className="admin-error">{heldText(preview)}</div>}
      {msg && <div className={msg.className || 'usage-dim'}>{msg.text}</div>}
    </div>
  );
}
