import { describe, expect, it } from 'vitest';
import { draftBody, draftCron, draftFrom, emptyDraft, type AutomationDraftSource } from './automationDraft';

const view: AutomationDraftSource = {
  schedule: '30 7 * * 1-5', timezone: 'Europe/Berlin', prompt: 'Triage the issues', tier: 'read',
  prOnChange: false, wakeBox: true, maxRunMinutes: 30, keepRuns: 5, enabled: false,
  spaceName: 'team', notifySlack: true,
};

describe('emptyDraft', () => {
  it('starts weekdays at 09:00 in the browser timezone, full tier, enabled, no space', () => {
    const d = emptyDraft();
    expect(draftCron(d)).toBe('0 9 * * 1-5');
    expect(d.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(d).toMatchObject({ prompt: '', tier: 'full', prOnChange: true, wakeBox: false, maxRunMinutes: 60, keepRuns: 20, enabled: true, spaceName: null, notifySlack: false });
  });

  it('is a fresh object each time', () => {
    const a = emptyDraft();
    a.schedule.time = '10:00';
    expect(emptyDraft().schedule.time).toBe('09:00');
  });
});

describe('draftFrom', () => {
  it('reads a view into a draft, the cron back into a preset', () => {
    const d = draftFrom(view);
    expect(d.schedule).toMatchObject({ preset: 'weekdays', time: '07:30' });
    expect(d).toMatchObject({ timezone: 'Europe/Berlin', prompt: 'Triage the issues', tier: 'read', prOnChange: false, wakeBox: true, maxRunMinutes: 30, keepRuns: 5, enabled: false, spaceName: 'team', notifySlack: true });
  });

  it('treats any tier but read as full', () => {
    expect(draftFrom({ ...view, tier: 'full' }).tier).toBe('full');
    expect(draftFrom({ ...view, tier: 'something-new' }).tier).toBe('full');
  });

  it('tolerates a view without the space or Slack fields', () => {
    const { spaceName: _s, notifySlack: _n, ...older } = view;
    const d = draftFrom(older);
    expect(d.spaceName).toBeNull();
    expect(d.notifySlack).toBe(false);
  });

  it('keeps a cron no preset matches as custom', () => {
    const d = draftFrom({ ...view, schedule: '*/20 * * * *' });
    expect(d.schedule).toMatchObject({ preset: 'custom', cron: '*/20 * * * *' });
    expect(draftCron(d)).toBe('*/20 * * * *');
  });
});

describe('draftCron', () => {
  it('is null while the schedule is incomplete', () => {
    const d = emptyDraft();
    expect(draftCron({ ...d, schedule: { ...d.schedule, time: '' } })).toBeNull();
  });
});

describe('draftBody', () => {
  it('round-trips a view', () => {
    expect(draftBody(draftFrom(view))).toEqual(view);
  });

  it('sends an empty schedule while incomplete, so the server refuses it with its own message', () => {
    const d = emptyDraft();
    expect(draftBody({ ...d, schedule: { ...d.schedule, preset: 'custom', cron: '' } }).schedule).toBe('');
  });

  it('carries exactly the fields the routes take today', () => {
    expect(Object.keys(draftBody(emptyDraft())).sort()).toEqual(
      ['enabled', 'keepRuns', 'maxRunMinutes', 'notifySlack', 'prOnChange', 'prompt', 'schedule', 'spaceName', 'tier', 'timezone', 'wakeBox'],
    );
  });
});
