// New automation from the phone:
// name, repository, box, schedule, prompt and permissions. Same payload as
// the desktop dialog's automation mode (POST /api/automations); on success
// the automation's page opens, where Run now tries it before the first
// occurrence. Behind automations-enabled, like the inbox button that leads here.
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { automationsApi, instancesApi, projectsApi, ProjectTemplateInfo, type SchedulePreview } from '../../services/api';
import type { Instance } from '../../types';
import { nameFromRepo } from '../../utils/repoName';
import { boxLabel, pickDefaultBox, usableBoxes } from '../../mobile/newProject';
import { PRESETS, WEEKDAYS, browserTimezone, occurrenceShort, presetToCron, type PresetInput } from '../../utils/automationSchedule';
import { TIER_HELP } from '../../components/AutomationFields';
import { apiError } from './Sheet';
import { replaySessionId } from '../../observability';

const NONE = '__none__';
const CUSTOM = '__custom__';

export function NewAutomation() {
  const navigate = useNavigate();
  const { reloadProjects } = useProjects();

  const [boxes, setBoxes] = useState<Instance[] | null>(null);
  const [boxId, setBoxId] = useState('');
  useEffect(() => {
    instancesApi.list().then(list => {
      setBoxes(list);
      const pick = pickDefaultBox(list);
      if (pick) setBoxId(pick.id);
    }).catch(() => setBoxes([]));
  }, []);
  const box = boxes?.find(b => b.id === boxId) ?? null;
  // A box that is still coming up: poll so Create enables itself (as New
  // project does); createProjectFor refuses a box in a parked power state.
  useEffect(() => {
    if (!box || box.status === 'ready') return;
    const t = setInterval(() => { instancesApi.list().then(setBoxes).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [box?.id, box?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = box?.status === 'ready';

  const [templates, setTemplates] = useState<ProjectTemplateInfo[]>([]);
  const [templateId, setTemplateId] = useState(NONE);
  const [customUrl, setCustomUrl] = useState('');
  useEffect(() => { projectsApi.templates().then(setTemplates).catch(() => {}); }, []);
  const repoUrl = useMemo(
    () => templateId === CUSTOM ? customUrl.trim() : templateId === NONE ? '' : (templates.find(t => t.id === templateId)?.repoUrl ?? ''),
    [templateId, customUrl, templates],
  );

  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => { if (!nameTouched) setName(repoUrl ? nameFromRepo(repoUrl) : ''); }, [repoUrl, nameTouched]);

  const [schedule, setSchedule] = useState<PresetInput>({ preset: 'weekdays', time: '09:00', weekday: 1, cron: '' });
  const [timezone, setTimezone] = useState(browserTimezone());
  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState<'full' | 'read'>('full');
  // The full tier is the owner's trust tick (it sets the project's chatTrustedAt): an explicit checkbox, as on the desktop.
  const [trustTicked, setTrustTicked] = useState(false);
  useEffect(() => { setTrustTicked(false); }, [tier]);
  const cron = presetToCron(schedule);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    if (!cron) { setPreview(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      automationsApi.preview({ schedule: cron, timezone })
        .then(p => { if (!cancelled) { setPreview(p); setPreviewError(''); } })
        .catch(err => { if (!cancelled) { setPreview(null); setPreviewError(apiError(err, 'Could not read that schedule')); } });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [cron, timezone]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canCreate = Boolean(name.trim()) && ready && !busy && !!cron && !!prompt.trim() && (templateId !== CUSTOM || customUrl.trim().length > 0) && !!preview && !previewError && preview.tooFrequent === null && (tier !== 'full' || trustTicked);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !box || !cron) return;
    setBusy(true); setError('');
    try {
      const created = await automationsApi.create({
        name: name.trim(), instanceId: box.id, repoUrl: repoUrl || null, schedule: cron, timezone, prompt, tier,
        replaySessionId: await replaySessionId(),
      });
      await reloadProjects().catch(() => {});
      navigate(`/automations/${encodeURIComponent(created.project.id)}`, { replace: true });
    } catch (err) {
      setError(apiError(err, 'Could not create the automation'));
      setBusy(false);
    }
  }

  const usable = usableBoxes(boxes ?? []);
  const needsTime = schedule.preset === 'daily' || schedule.preset === 'weekdays' || schedule.preset === 'weekly';

  return (
    <div className="m-screen">
      <header className="m-header m-header-conv">
        <Link className="m-link m-back" to="/m" aria-label="Back to inbox">‹</Link>
        <div className="m-conv-title"><span className="m-conv-name">New automation</span></div>
      </header>
      <form className="m-form m-scroll" onSubmit={create}>
        <label className="m-field">
          <span className="m-field-label">Repository</span>
          <select className="m-select" value={templateId} onChange={e => setTemplateId(e.target.value)}>
            <option value={NONE}>none: start empty</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.label}: {t.blurb}</option>)}
            <option value={CUSTOM}>custom: a GitHub repo URL</option>
          </select>
        </label>
        {templateId === CUSTOM && (
          <label className="m-field">
            <span className="m-field-label">Repo URL</span>
            <input className="m-text" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              placeholder="https://github.com/org/repo" value={customUrl} onChange={e => setCustomUrl(e.target.value)} />
          </label>
        )}
        <label className="m-field">
          <span className="m-field-label">Name</span>
          <input className="m-text" type="text" autoCapitalize="off" autoCorrect="off" spellCheck={false} required
            placeholder="nightly-triage" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} />
        </label>
        <label className="m-field">
          <span className="m-field-label">Box</span>
          <select className="m-select" value={boxId} onChange={e => setBoxId(e.target.value)} disabled={boxes == null}>
            {boxes == null && <option value="">Loading…</option>}
            {boxes != null && usable.length === 0 && <option value="">No usable box; add one from the full UI</option>}
            {usable.map(b => <option key={b.id} value={b.id}>{boxLabel(b)}</option>)}
          </select>
          {box && !ready && <span className="m-field-hint">This box is {box.status.replace(/-/g, ' ')}; Create enables when it is ready.</span>}
        </label>
        <label className="m-field">
          <span className="m-field-label">Runs</span>
          <select className="m-select" value={schedule.preset} onChange={e => setSchedule(s => ({ ...s, preset: e.target.value as PresetInput['preset'] }))}>
            {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {schedule.preset === 'weekly' && (
          <label className="m-field">
            <span className="m-field-label">On</span>
            <select className="m-select" value={schedule.weekday} onChange={e => setSchedule(s => ({ ...s, weekday: Number(e.target.value) }))}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </label>
        )}
        {needsTime && (
          <label className="m-field">
            <span className="m-field-label">At</span>
            <input className="m-text" type="time" value={schedule.time} onChange={e => setSchedule(s => ({ ...s, time: e.target.value }))} />
          </label>
        )}
        {schedule.preset === 'custom' && (
          <label className="m-field">
            <span className="m-field-label">Cron</span>
            <input className="m-text" type="text" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              placeholder="0 9 * * 1-5" value={schedule.cron} onChange={e => setSchedule(s => ({ ...s, cron: e.target.value }))} />
          </label>
        )}
        <label className="m-field">
          <span className="m-field-label">Timezone</span>
          <input className="m-text" type="text" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={timezone} onChange={e => setTimezone(e.target.value)} />
          {previewError ? <span className="m-field-hint">{previewError}</span>
            : preview?.tooFrequent ? <span className="m-field-hint">Runs every {preview.minGapMinutes} minutes; the minimum is {preview.tooFrequent}.</span>
              : preview ? <span className="m-form-note">Next: {preview.next.slice(0, 3).map(n => occurrenceShort(n, timezone)).join(', ')}</span> : null}
        </label>
        <label className="m-field">
          <span className="m-field-label">Prompt</span>
          <textarea className="m-text" rows={5} value={prompt} onChange={e => setPrompt(e.target.value)}
            placeholder="What each run should do. It starts on a fresh branch from the default branch, with notes from earlier runs." />
        </label>
        <label className="m-field">
          <span className="m-field-label">Permissions</span>
          <select className="m-select" value={tier} onChange={e => setTier(e.target.value as 'full' | 'read')}>
            <option value="full">Full: Claude in auto mode</option>
            <option value="read">Read-only</option>
          </select>
          <span className={tier === 'full' ? 'm-field-hint' : 'm-form-note'}>{TIER_HELP[tier]}</span>
        </label>
        {tier === 'full' && (
          <label className="m-field m-check">
            <input type="checkbox" checked={trustTicked} onChange={e => setTrustTicked(e.target.checked)} />
            <span><strong>I trust this repository.</strong> Runs get the full tier with nobody watching; this is the project's trust tick.</span>
          </label>
        )}
        {error && <div className="m-form-error">{error}</div>}
        <button type="submit" className="m-primary" disabled={!canCreate}>{busy ? 'Creating…' : 'Create automation'}</button>
        <p className="m-form-note">
          Each run gets its own branch under the project and shows up as a conversation. Nothing runs until the first occurrence; the automation's page has Run now.
        </p>
      </form>
    </div>
  );
}
