// What termag's telemetry may say about your work. One switch: whether your chat session titles go with it, as the
// session.titled event. On until turned off; everything else the telemetry
// carries is metadata (ids, names, counts) and has no switch here.
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { DocsLink } from './DocsLink';

export function TelemetrySection() {
  const { user, updatePreferences } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // An older backend sends no value: on, as the server defaults it.
  const on = user?.telemetryTitles !== false;

  const save = async (next: boolean) => {
    setBusy(true); setError('');
    try { await updatePreferences({ telemetryTitles: next }); } catch { setError('Could not save that.'); } finally { setBusy(false); }
  };

  return (
    <section className="dash-section" id="telemetry" aria-labelledby="telemetry-h">
      <div className="dash-section-title" id="telemetry-h">
        Telemetry <DocsLink anchor="telemetry" topic="Telemetry" />
      </div>
      <div className="dash-card">
        <p className="settings-hint">
          termag records what happens on your boxes for the people who run it: which projects, repositories and
          branches your agents work in, which directories they edit, what they push and which PRs they open. Never
          your prompts, the agents&apos; answers, file contents or a command&apos;s arguments.
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
            <span>Include my chat titles</span>
          </label>
          <p className="settings-hint" role="status">
            {on
              ? 'On: the few-word title of each chat session, Claude\'s or your rename, goes with it.'
              : 'Off: chat titles stay out of termag\'s telemetry.'}
          </p>
        </div>
      </div>
    </section>
  );
}
