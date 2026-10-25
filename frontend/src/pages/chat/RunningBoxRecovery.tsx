// An archived chat whose box is still running. The live project list omits
// the row and session access 404s it, so this panel is what a later open
// shows: the same Stop/Hibernate recovery, with no history load.
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '../../components/Dialog';
import {
  announceChatsChanged, archiveBoxNotice, clearRunningBox, dismissRunningBoxNotice, dropLastActiveProject,
  parkedPowerError, saveRunningBox, stillRunningWorkspaceHref, type RunningBoxRecovery,
} from '../../chat/archive';
import { LAST_ACTIVE_PROJECT_KEY } from '../../contexts/ProjectContext';
import { instancesApi } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';

function errorText(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function RunningBoxRecoveryView({ recovery }: { recovery: RunningBoxRecovery }) {
  const navigate = useNavigate();
  const [stopping, setStopping] = useState(false);
  const canRetry = recovery.retry != null && recovery.instanceId != null;

  const openFull = () => {
    dropLastActiveProject(recovery.projectId, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
    navigate(stillRunningWorkspaceHref());
  };

  const stop = async () => {
    if (!recovery.retry || !recovery.instanceId) return;
    setStopping(true);
    try {
      if (recovery.retry === 'hibernate') await instancesApi.hibernate(recovery.instanceId);
      else await instancesApi.stop(recovery.instanceId);
      announceChatsChanged();
      void boxFeed.reload();
      navigate('/chat');
      clearRunningBox(recovery.projectId);
    } catch (err) {
      const text = errorText(err, 'The box did not stop');
      if (parkedPowerError(text)) {
        navigate('/chat');
        clearRunningBox(recovery.projectId);
        return;
      }
      const notice = archiveBoxNotice({ action: recovery.retry, error: text });
      if (!notice.leave) {
        saveRunningBox({ ...recovery, message: notice.message, retry: notice.retry, announced: false });
      }
    } finally {
      setStopping(false);
    }
  };

  const retryLabel = stopping ? 'Stopping…' : recovery.retry === 'hibernate' ? 'Hibernate box' : 'Stop box';

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header">
          <div className="chat-title">
            <span className="chat-glyph" data-status="idle" aria-hidden="true">○</span>
            <span className="chat-title-name">{recovery.projectName}</span>
          </div>
          <div className="chat-header-actions">
            <button type="button" className="btn-ghost" onClick={openFull}>Open in full UI</button>
          </div>
          {recovery.announced && createPortal(
            <Dialog ariaLabel="Box still running" onClose={() => dismissRunningBoxNotice(recovery.projectId)} closeDisabled={stopping}>
              <div className="confirm-message" role="alert">{recovery.message}</div>
              <div className="confirm-actions">
                <button type="button" className="confirm-btn confirm-btn-cancel" disabled={stopping} onClick={() => dismissRunningBoxNotice(recovery.projectId)}>Keep this session open</button>
                {canRetry
                  ? <button type="button" className="confirm-btn confirm-btn-primary" disabled={stopping} onClick={() => { void stop(); }}>{retryLabel}</button>
                  : <button type="button" className="confirm-btn confirm-btn-primary" onClick={openFull}>Open in full UI</button>}
              </div>
            </Dialog>,
            document.body,
          )}
        </header>
        <div className="chat-transcript">
          <div className="chat-transcript-inner">
            <div className="chat-archived-error" role="alert">
              <div>{recovery.message}</div>
              <div className="chat-setup-actions">
                {canRetry && (
                  <button type="button" className="btn-tiny" disabled={stopping} onClick={() => { void stop(); }}>{retryLabel}</button>
                )}
                <button type="button" className="btn-tiny" disabled={stopping} onClick={openFull}>Open in full UI</button>
                <button type="button" className="btn-tiny" disabled={stopping} onClick={() => navigate('/chat')}>Back to sessions</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
