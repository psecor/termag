import React, { useEffect, useMemo, useState } from 'react';
import { automationsApi, spacesApi, type SchedulePreview, type SpaceView } from '../services/api';
import { FLAGS, useFlag } from '../flags';
import {
  PRESETS, WEEKDAYS, browserTimezone, cronToPreset, occurrenceShort, presetToCron, type PresetInput,
} from '../utils/automationSchedule';

/**
 * The fields that make a project an automation: the
 * schedule (a preset or a cron, in a timezone, with the next occurrences in
 * words from the server before Save), the prompt, and under Advanced the
 * tier, PR-on-change, wake-the-box with its estimate, time limit, runs to
 * keep and enabled. Shared by the New automation dialog (NewProjectForm in
 * automation mode) and the automation page's edit form, so the two cannot
 * drift.
 */

export interface AutomationDraft {
  schedule: PresetInput;
  timezone: string;
  prompt: string;
  tier: 'full' | 'read';
  prOnChange: boolean;
  wakeBox: boolean;
  maxRunMinutes: number;
  keepRuns: number;
  enabled: boolean;
  /** A space the notes file is mirrored to between runs; null = the box only. */
  spaceName: string | null;
  /** Post each finished run's report to the project's Slack channel. */
  notifySlack: boolean;
}

export function emptyDraft(): AutomationDraft {
  return {
    schedule: { preset: 'weekdays', time: '09:00', weekday: 1, cron: '' },
    timezone: browserTimezone(), prompt: '', tier: 'full', prOnChange: true, wakeBox: false, maxRunMinutes: 60, keepRuns: 20, enabled: true, spaceName: null, notifySlack: false,
  };
}

export function draftFrom(a: { schedule: string; timezone: string; prompt: string; tier: string; prOnChange: boolean; wakeBox: boolean; maxRunMinutes: number; keepRuns: number; enabled: boolean; spaceName?: string | null; notifySlack?: boolean }): AutomationDraft {
  return {
    schedule: cronToPreset(a.schedule), timezone: a.timezone, prompt: a.prompt, tier: a.tier === 'read' ? 'read' : 'full',
    prOnChange: a.prOnChange, wakeBox: a.wakeBox, maxRunMinutes: a.maxRunMinutes, keepRuns: a.keepRuns, enabled: a.enabled, spaceName: a.spaceName ?? null, notifySlack: a.notifySlack ?? false,
  };
}

/** The cron a draft means, or null while its schedule fields are incomplete. */
export function draftCron(d: AutomationDraft): string | null {
  return presetToCron(d.schedule);
}

/** What the create and PATCH bodies carry for a draft. */
export function draftBody(d: AutomationDraft) {
  return {
    schedule: draftCron(d) ?? '', timezone: d.timezone, prompt: d.prompt, tier: d.tier, prOnChange: d.prOnChange,
    wakeBox: d.wakeBox, maxRunMinutes: d.maxRunMinutes, keepRuns: d.keepRuns, enabled: d.enabled, spaceName: d.spaceName, notifySlack: d.notifySlack,
  };
}

const TIMEZONES: string[] = (() => {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return sv ? sv('timeZone') : [];
  } catch { return []; }
})();

export const TIER_HELP: Record<'full' | 'read', string> = {
  full: 'Claude runs with every tool in auto mode: its classifier denies a risky call instead of asking. It can commit, push and open PRs with your GitHub access, on text nobody vetted.',
  read: 'Read-only: Claude can read the repository and report, nothing else.',
};

export function AutomationFields({ draft, onChange, showEnabled = true, idPrefix = 'af', onValidity, onFullTierTick }: {
  draft: AutomationDraft;
  onChange: (next: AutomationDraft) => void;
  /** The create form has no "enabled" switch beside the create button; the page does. */
  showEnabled?: boolean;
  idPrefix?: string;
  /** Whether the schedule as previewed can be saved: a preview came back and it is not too frequent. Lets a parent's submit wait for it. */
  onValidity?: (ok: boolean) => void;
  /**
   * A create form passes this: the full tier is the owner's trust tick (it
   * sets the project's chatTrustedAt), so it is an explicit checkbox in the
   * default view, and Create waits for it. Reports the box's state; false
   * again when the tier changes.
   */
  onFullTierTick?: (ticked: boolean) => void;
}) {
  const [fullTick, setFullTick] = useState(false);
  useEffect(() => { setFullTick(false); }, [draft.tier]);
  useEffect(() => { onFullTierTick?.(draft.tier === 'full' && fullTick); }, [draft.tier, fullTick, onFullTierTick]);
  const set = <K extends keyof AutomationDraft>(k: K, v: AutomationDraft[K]) => onChange({ ...draft, [k]: v });
  const setSchedule = (patch: Partial<PresetInput>) => onChange({ ...draft, schedule: { ...draft.schedule, ...patch } });
  const cron = draftCron(draft);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewKey = `${cron}|${draft.timezone}|${draft.wakeBox}|${draft.maxRunMinutes}`;
  useEffect(() => {
    if (!cron || !draft.timezone) { setPreview(null); setPreviewError(cron ? null : 'Fill in the time'); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      automationsApi.preview({ schedule: cron, timezone: draft.timezone, wakeBox: draft.wakeBox, maxRunMinutes: draft.maxRunMinutes })
        .then(p => { if (!cancelled) { setPreview(p); setPreviewError(null); } })
        .catch(err => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not read that schedule');
        });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  const scheduleValid = !!preview && !previewError && preview.tooFrequent === null;
  useEffect(() => { onValidity?.(scheduleValid); }, [scheduleValid, onValidity]);
  const tzOptions = useMemo(() => (TIMEZONES.length && !TIMEZONES.includes(draft.timezone) ? [draft.timezone, ...TIMEZONES] : TIMEZONES), [draft.timezone]);
  // The spaces the owner can write to, for mirroring the notes file (only with spaces on).
  const spacesOn = useFlag(FLAGS.spaces, false);
  const [spaces, setSpaces] = useState<SpaceView[] | null>(null);
  useEffect(() => {
    if (!spacesOn) return;
    let cancelled = false;
    spacesApi.list().then(r => { if (!cancelled) setSpaces(r.spaces.filter(s => (s.role === 'owner' || s.role === 'editor') && !s.readOnly)); }).catch(() => { if (!cancelled) setSpaces([]); });
    return () => { cancelled = true; };
  }, [spacesOn]);
  const id = (s: string) => `${idPrefix}-${s}`;

  return (
    <>
      <fieldset className="npf-fieldset af-schedule">
        <legend>Schedule</legend>
        <div className="npf-field">
          <label htmlFor={id('preset')}>Runs</label>
          <select id={id('preset')} value={draft.schedule.preset} onChange={e => setSchedule({ preset: e.target.value as PresetInput['preset'] })}>
            {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        {draft.schedule.preset === 'weekly' && (
          <div className="npf-field">
            <label htmlFor={id('weekday')}>On</label>
            <select id={id('weekday')} value={draft.schedule.weekday} onChange={e => setSchedule({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
        )}
        {(draft.schedule.preset === 'daily' || draft.schedule.preset === 'weekdays' || draft.schedule.preset === 'weekly') && (
          <div className="npf-field">
            <label htmlFor={id('time')}>At</label>
            <input id={id('time')} type="time" value={draft.schedule.time} onChange={e => setSchedule({ time: e.target.value })} />
          </div>
        )}
        {draft.schedule.preset === 'custom' && (
          <div className="npf-field">
            <label htmlFor={id('cron')}>Cron</label>
            <input id={id('cron')} value={draft.schedule.cron} onChange={e => setSchedule({ cron: e.target.value })} placeholder="minute hour day month weekday, e.g. 0 9 * * 1-5" spellCheck={false} />
          </div>
        )}
        <div className="npf-field">
          <label htmlFor={id('tz')}>Timezone</label>
          {tzOptions.length ? (
            <select id={id('tz')} value={draft.timezone} onChange={e => set('timezone', e.target.value)}>
              {tzOptions.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          ) : (
            <input id={id('tz')} value={draft.timezone} onChange={e => set('timezone', e.target.value)} placeholder="America/New_York" />
          )}
        </div>
        <div className="af-preview usage-dim" aria-live="polite">
          {previewError ? <span className="error-text">{previewError}</span>
            : preview ? (
              <>
                {preview.tooFrequent !== null && <span className="error-text">Runs every {preview.minGapMinutes} minutes; the minimum is {preview.tooFrequent}. </span>}
                Next: {preview.next.slice(0, 3).map(n => occurrenceShort(n, draft.timezone)).join(', ')}
                {preview.keepsBoxUpMinutesPerDay !== null && <> · would keep the box up about {preview.keepsBoxUpMinutesPerDay >= 60 ? `${Math.round(preview.keepsBoxUpMinutesPerDay / 60)} h` : `${preview.keepsBoxUpMinutesPerDay} min`} a day</>}
              </>
            ) : cron ? 'Checking the schedule…' : null}
        </div>
      </fieldset>
      <div className="npf-field af-prompt">
        <label htmlFor={id('prompt')}>Prompt</label>
        <textarea
          id={id('prompt')} value={draft.prompt} onChange={e => set('prompt', e.target.value)} rows={6}
          placeholder="What each run should do. It starts on a fresh branch from the default branch, with notes from earlier runs."
        />
      </div>
      {/* The tier is the one choice with a security consequence: it and its warning stay in view, never behind Run settings. */}
      <div className="npf-field">
        <label htmlFor={id('tier')}>Permissions</label>
        <select id={id('tier')} value={draft.tier} onChange={e => set('tier', e.target.value as 'full' | 'read')}>
          <option value="full">Full: Claude in auto mode</option>
          <option value="read">Read-only</option>
        </select>
      </div>
      <div className={`npf-note ${draft.tier === 'full' ? 'af-warn' : 'usage-dim'}`}>{TIER_HELP[draft.tier]}</div>
      {draft.tier === 'full' && onFullTierTick && (
        <label className="npf-check af-warn"><input type="checkbox" checked={fullTick} onChange={e => setFullTick(e.target.checked)} /> <strong>I trust this repository.</strong> Runs get the full tier with nobody watching; this is the project's trust tick.</label>
      )}
      {draft.tier === 'full' && (
        <label className="npf-check"><input type="checkbox" checked={draft.prOnChange} onChange={e => set('prOnChange', e.target.checked)} /> Push the branch and open a draft PR when a run committed</label>
      )}
      <details className="npf-advanced af-advanced">
        <summary>Run settings</summary>
        <div className="npf-advanced-body">
          <label className="npf-check"><input type="checkbox" checked={draft.wakeBox} onChange={e => set('wakeBox', e.target.checked)} /> Start the box for a run when it is stopped or hibernated</label>
          <label className="npf-check"><input type="checkbox" checked={draft.notifySlack} onChange={e => set('notifySlack', e.target.checked)} /> Post each run's result to the project's Slack channel</label>
          <div className="npf-field npf-inline">
            <label htmlFor={id('max')}>Time limit (minutes)</label>
            <input id={id('max')} type="number" min={1} max={240} value={draft.maxRunMinutes} onChange={e => set('maxRunMinutes', Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <div className="npf-field npf-inline">
            <label htmlFor={id('keep')}>Runs to keep</label>
            <input id={id('keep')} type="number" min={1} max={50} value={draft.keepRuns} onChange={e => set('keepRuns', Math.max(1, Number(e.target.value) || 1))} />
          </div>
          {spacesOn && (
            <div className="npf-field">
              <label htmlFor={id('space')}>Mirror notes to a space</label>
              <select id={id('space')} value={draft.spaceName ?? ''} onChange={e => set('spaceName', e.target.value || null)}>
                <option value="">the box only</option>
                {draft.spaceName && !spaces?.some(s => s.name === draft.spaceName) && <option value={draft.spaceName}>{draft.spaceName}</option>}
                {(spaces ?? []).map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
              <span className="npf-note usage-dim">The notes file is pulled from the space before each run and pushed after it, so it outlives the box.</span>
            </div>
          )}
          {showEnabled && (
            <label className="npf-check"><input type="checkbox" checked={draft.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled</label>
          )}
        </div>
      </details>
    </>
  );
}
