import React, { useEffect, useState } from 'react';
import { briefingsApi, BriefingSchedule } from '../../services/api';
import { browserTz } from '../../components/briefing';
import { DAY_NAMES, enableSchedule, scheduleEqual, toggleDay } from './briefingSchedule';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

/**
 * Daily briefing schedule. Opt-in: off until the user
 * turns it on. "Run now" on the dashboard works whether or not it is on.
 */
export function BriefingSection() {
  const [saved, setSaved] = useState<BriefingSchedule | null>(null);
  const [draft, setDraft] = useState<BriefingSchedule | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    briefingsApi.schedule()
      .then(s => { setSaved(s); setDraft(s); })
      .catch(err => setError(apiError(err, 'Could not load the briefing schedule')));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const s = await briefingsApi.saveSchedule(draft);
      setSaved(s);
      setDraft(s);
      setNotice(s.enabled ? `Scheduled at ${s.time} (${s.timezone}).` : 'The scheduled briefing is off.');
    } catch (err) {
      setError(apiError(err, 'Could not save the briefing schedule'));
    } finally {
      setBusy(false);
    }
  }

  const dirty = !!draft && !!saved && !scheduleEqual(draft, saved);

  return (
    <section className="dash-section" id="briefing" aria-labelledby="briefing-settings-h">
      <div className="dash-section-title" id="briefing-settings-h">Daily briefing</div>
      <div className="dash-card">
        <p className="settings-hint">
          A briefing reviews your sessions since the last one, lists what was left open and suggests what to pick
          up next. It runs a short, read-only headless Claude on one of your boxes and appears at the top of the
          dashboard. Scheduling is off until you turn it on; a box that is stopped is never started for it.
        </p>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        {notice && (
          <div className="settings-notice" role="status">
            {notice}<button onClick={() => setNotice('')}>×</button>
          </div>
        )}
        {draft && (
          <form className="settings-form briefing-schedule-form" onSubmit={submit}>
            <label className="briefing-schedule-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={e => setDraft(e.target.checked ? enableSchedule(draft, browserTz()) : { ...draft, enabled: false })}
              />
              <span>Run a briefing on a schedule</span>
            </label>
            <fieldset className="briefing-schedule-fields" disabled={!draft.enabled}>
              <label className="briefing-schedule-row">
                <span className="briefing-schedule-label">Time</span>
                <input
                  type="time"
                  value={draft.time}
                  onChange={e => setDraft({ ...draft, time: e.target.value })}
                  aria-label="Briefing time"
                  required
                />
              </label>
              <div className="briefing-schedule-row" role="group" aria-label="Days">
                <span className="briefing-schedule-label">Days</span>
                {DAY_NAMES.map((name, d) => (
                  <label key={d} className="briefing-day">
                    <input type="checkbox" checked={draft.days.includes(d)} onChange={() => setDraft(toggleDay(draft, d))} />
                    {name}
                  </label>
                ))}
              </div>
              <label className="briefing-schedule-row">
                <span className="briefing-schedule-label">Timezone</span>
                <input
                  value={draft.timezone ?? ''}
                  placeholder={browserTz()}
                  onChange={e => setDraft({ ...draft, timezone: e.target.value.trim() || null })}
                  aria-label="Timezone"
                  spellCheck={false}
                />
                {draft.timezone !== browserTz() && (
                  <button type="button" className="btn-ghost" onClick={() => setDraft({ ...draft, timezone: browserTz() })}>
                    Use {browserTz()}
                  </button>
                )}
              </label>
              <label className="briefing-schedule-row">
                <input type="checkbox" checked={draft.slackDm} onChange={e => setDraft({ ...draft, slackDm: e.target.checked })} />
                <span>Also send it to me as a Slack DM</span>
              </label>
            </fieldset>
            <div>
              <button type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
