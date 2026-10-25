// Push notifications for this device. Turning them on must
// start from the tap on "Turn on" — iOS refuses a permission prompt without
// it — and on iOS only works in the installed app.
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { pushApi, type PushConfig } from '../../services/api';
import { currentPushSupport, currentSubscription, disablePush, enablePush, EnableResult } from '../../mobile/push';
import { Sheet, apiError } from './Sheet';

type DeviceState = 'loading' | 'on' | 'off';

const FAILURE: Record<Exclude<EnableResult, { ok: true }>['reason'], string> = {
  denied: 'Notifications are blocked for termag. Allow them in the system settings, then try again.',
  unsupported: 'This browser cannot receive push notifications.',
  disabled: 'Push is not set up on this termag server.',
  failed: 'Could not turn notifications on.',
};

export function NotificationsSheet({ onClose, onInstall }: { onClose: () => void; onInstall: () => void }) {
  const { user, updatePreferences } = useAuth();
  const support = currentPushSupport();
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [device, setDevice] = useState<DeviceState>('loading');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    pushApi.config().then(c => { if (live) setConfig(c); }).catch(() => { if (live) setConfig({ enabled: false, publicKey: null }); });
    if (support === 'supported') {
      currentSubscription()
        .then(s => { if (live) setDevice(s && typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'on' : 'off'); })
        .catch(() => { if (live) setDevice('off'); });
    } else {
      setDevice('off');
    }
    return () => { live = false; };
  }, [support]);

  const turnOn = async () => {
    setBusy(true); setError(null); setNote(null);
    const r = await enablePush();
    setBusy(false);
    if (r.ok) { setDevice('on'); setNote('Notifications are on for this device.'); return; }
    setError(r.detail && r.reason === 'failed' ? `${FAILURE.failed} (${r.detail})` : FAILURE[r.reason]);
  };
  const turnOff = async () => {
    setBusy(true); setError(null); setNote(null);
    const off = await disablePush();
    setBusy(false);
    if (!off) { setError('Could not turn notifications off for this device. Try again.'); return; }
    setDevice('off'); setNote('Notifications are off for this device.');
  };
  const test = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await pushApi.test();
      setNote(r.sent > 0 ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed)` : ''}.` : 'No device received it.');
    } catch (err) {
      setError(apiError(err, 'Could not send a test notification.'));
    } finally { setBusy(false); }
  };
  const toggleMute = async (on: boolean) => {
    setError(null);
    try { await updatePreferences({ pushMutesChat: on }); } catch (err) { setError(apiError(err, 'Could not save that.')); }
  };

  let body: React.ReactNode;
  if (support === 'needs-install') {
    body = (
      <>
        <div className="m-sheet-message">On iPhone and iPad, notifications work only in termag opened from the Home Screen.</div>
        <div className="m-sheet-actions">
          <button className="m-sheet-action" onClick={onInstall}>How to add it…</button>
        </div>
      </>
    );
  } else if (support === 'unsupported') {
    body = <div className="m-sheet-message">This browser cannot receive push notifications.</div>;
  } else if (config && !config.enabled) {
    body = <div className="m-sheet-message">Push is not set up on this termag server.</div>;
  } else {
    body = (
      <>
        <div className="m-sheet-message">
          {device === 'on'
            ? 'This device gets a notification when one of your agents needs you.'
            : 'Get a notification on this device when one of your agents needs approval or asks you something.'}
        </div>
        <div className="m-sheet-actions">
          {/* Safari can take seconds to activate the worker the first time; say so rather than show nothing. */}
          {device === 'loading' && <button className="m-sheet-action" disabled>Checking this device…</button>}
          {device === 'off' && <button className="m-sheet-action" disabled={busy || !config} onClick={turnOn}>Turn on</button>}
          {device === 'on' && <button className="m-sheet-action" disabled={busy} onClick={test}>Send a test</button>}
          {device === 'on' && <button className="m-sheet-action danger" disabled={busy} onClick={turnOff}>Turn off on this device</button>}
        </div>
        {/* Account-wide, so it stays reachable while on even when this device is off. */}
        {(device === 'on' || !!user?.pushMutesChat) && (
          <label className="m-check">
            <input type="checkbox" checked={!!user?.pushMutesChat} onChange={e => { void toggleMute(e.target.checked); }} />
            <span>Skip the Slack and Discord “needs you” posts while push is on</span>
          </label>
        )}
      </>
    );
  }

  return (
    <Sheet title="Notifications" onClose={onClose}>
      {body}
      {note && <div className="m-form-note" role="status">{note}</div>}
      {error && <div className="m-form-error" role="alert">{error}</div>}
      <div className="m-sheet-actions">
        <button className="m-sheet-action m-sheet-cancel" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}
