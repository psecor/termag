// The termag bot's Slack DMs before and after termag stops one of your boxes
// on its own.
// One switch, on until turned off here or with a DM's Stop these messages.
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { DocsLink } from './DocsLink';

export function BoxNoticesSection() {
  const { user, updatePreferences } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // An older backend sends no value: on, as the server defaults it.
  const on = user?.boxIdleNotify !== false;

  const save = async (next: boolean) => {
    setBusy(true); setError('');
    try { await updatePreferences({ boxIdleNotify: next }); } catch { setError('Could not save that.'); } finally { setBusy(false); }
  };

  return (
    <section className="dash-section" id="box-notices" aria-labelledby="box-notices-h">
      <div className="dash-section-title" id="box-notices-h">
        Box notices <DocsLink anchor="box-notices" topic="Box notices" />
      </div>
      <div className="dash-card">
        <p className="settings-hint">
          termag stops a box nobody has used for a while, and one that started but never connected. Its disks,
          projects and checkouts are kept. The termag bot can message you in Slack before it stops one, with a
          Keep running button, and again once it has.
        </p>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        <div className="settings-form">
          <label className="briefing-schedule-row">
            <input
              type="checkbox"
              checked={on}
              disabled={busy}
              onChange={e => { void save(e.target.checked); }}
            />
            <span>Message me in Slack when termag stops one of my boxes</span>
          </label>
          <p className="settings-hint" role="status">
            {on
              ? 'On: a message before each stop and one after.'
              : 'Off: boxes still stop, and the box list in termag shows when and keeps Keep running. You still hear about automations paused by a terminate.'}
          </p>
        </div>
      </div>
    </section>
  );
}
