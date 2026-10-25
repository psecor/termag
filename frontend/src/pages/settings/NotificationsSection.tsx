// "Your turn" notifications for simple-UI chats.
// One switch per person: it asks the browser for permission (which must start
// from the click), saves the preference, and subscribes this device to push
// when the server can push, so a closed tab still hears about it. Turning it
// off keeps the device's subscription: the phone's waiting notifications may
// use it.
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { currentPushSupport, enablePush, pushEndpointRemembered, registerServiceWorker } from '../../mobile/push';
import { notifyState, type NotifyState } from '../../chat/turnNotify';
import { currentPermission, pushConfigured, useChatTurnEnabled, usePushAvailable } from '../../chat/useChatTurnNotifications';
import { DocsLink } from './DocsLink';

const STATUS: Record<Exclude<NotifyState, 'hidden'>, string> = {
  unsupported: 'This browser cannot show notifications.',
  blocked: 'Notifications are blocked for termag in this browser. Allow them in the site settings, then try again.',
  off: 'Off.',
  'on-tab': 'On in this browser while termag is open in a tab.',
  'on-push': 'On in this browser, also when termag is closed.',
};

export function NotificationsSection() {
  const { user, updatePreferences } = useAuth();
  const { flag } = useChatTurnEnabled();
  const pushAvailable = usePushAvailable(flag);
  const [permission, setPermission] = useState(currentPermission);
  const [registered, setRegistered] = useState(pushEndpointRemembered);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const state = notifyState({ flag, optedIn: !!user?.chatTurnNotify, permission, pushCovers: pushAvailable && registered });
  if (state === 'hidden') return null;
  const on = state === 'on-tab' || state === 'on-push';

  const turnOn = async () => {
    setBusy(true); setError('');
    try {
      // First, before any await, so the click still counts as the gesture.
      const p = await Notification.requestPermission();
      setPermission(p);
      if (p !== 'granted') return;
      await updatePreferences({ chatTurnNotify: true });
      await registerServiceWorker();
      // Asked again rather than read from state, which is false until the config lands.
      if (currentPushSupport() === 'supported' && await pushConfigured()) {
        const r = await enablePush();
        setRegistered(r.ok || pushEndpointRemembered());
      }
    } catch {
      setError('Could not turn notifications on.');
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true); setError('');
    try { await updatePreferences({ chatTurnNotify: false }); } catch { setError('Could not save that.'); } finally { setBusy(false); }
  };

  return (
    <section className="dash-section" id="notifications" aria-labelledby="notifications-h">
      <div className="dash-section-title" id="notifications-h">
        Notifications <DocsLink anchor="notifications" topic="Notifications" />
      </div>
      <div className="dash-card">
        <p className="settings-hint">
          A browser notification when a chat in the simple UI answers and it is your turn again, never for the
          chat you are looking at. Turning it on asks this browser for permission; where termag can send web
          push, this device also hears about it while termag is closed.
        </p>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        <div className="settings-form">
          <label className="briefing-schedule-row">
            <input
              type="checkbox"
              checked={on}
              disabled={busy || state === 'unsupported'}
              onChange={e => { void (e.target.checked ? turnOn() : turnOff()); }}
            />
            <span>Notify me when a chat is ready</span>
          </label>
          <p className={state === 'blocked' ? 'settings-hint settings-notify-blocked' : 'settings-hint'} role="status">
            {STATUS[state]}
          </p>
        </div>
      </div>
    </section>
  );
}
