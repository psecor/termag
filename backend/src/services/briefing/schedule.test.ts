import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, parseScheduleBody, readSchedule, scheduleDue, scheduleKey } from './schedule';
import { extractJson, parseBriefingContent, scrubProjectIds } from './content';

describe('readSchedule', () => {
  it('is off for a user who never set it', () => {
    expect(readSchedule({})).toEqual(DEFAULT_SCHEDULE);
    expect(readSchedule(null).enabled).toBe(false);
    expect(readSchedule('garbage').enabled).toBe(false);
  });

  it('cannot be on without a valid timezone', () => {
    expect(readSchedule({ enabled: true, timezone: null }).enabled).toBe(false);
    expect(readSchedule({ enabled: true, timezone: 'Nope/Nope' }).enabled).toBe(false);
    expect(readSchedule({ enabled: true, timezone: 'Europe/London' }).enabled).toBe(true);
  });

  it('defaults malformed fields', () => {
    const s = readSchedule({ enabled: true, timezone: 'UTC', time: '25:00', days: [9, 1, 1, 'x'], slackDm: 'yes' });
    expect(s).toMatchObject({ time: '08:00', days: [1], slackDm: false });
  });
});

describe('parseScheduleBody', () => {
  const ok = { enabled: true, time: '07:30', timezone: 'America/Chicago', days: [5, 1, 1], slackDm: true };

  it('accepts a full body and normalizes days', () => {
    expect(parseScheduleBody(ok)).toEqual({ ...ok, days: [1, 5] });
  });

  it('rejects bad input with a reason', () => {
    expect(parseScheduleBody({ ...ok, time: '7:30' })).toHaveProperty('error');
    expect(parseScheduleBody({ ...ok, timezone: 'Bad/Zone' })).toHaveProperty('error');
    expect(parseScheduleBody({ ...ok, timezone: null })).toHaveProperty('error');
    expect(parseScheduleBody({ ...ok, days: [] })).toHaveProperty('error');
    expect(parseScheduleBody({ ...ok, days: [7] })).toHaveProperty('error');
    expect(parseScheduleBody([])).toHaveProperty('error');
  });

  it('allows saving it off without a timezone', () => {
    expect(parseScheduleBody({ ...ok, enabled: false, timezone: null, days: [] })).not.toHaveProperty('error');
  });
});

describe('scheduleDue', () => {
  const s = { enabled: true, time: '07:00', timezone: 'America/New_York', days: [1, 2, 3, 4, 5], slackDm: true };

  it('is due from the slot to the end of the local day, on chosen days', () => {
    expect(scheduleDue(s, new Date('2026-10-12T10:59:00Z'))).toEqual({ due: false }); // Mon 06:59 EDT
    expect(scheduleDue(s, new Date('2026-10-12T11:00:00Z'))).toEqual({ due: true, day: '2026-10-12' });
    expect(scheduleDue(s, new Date('2026-10-13T03:59:00Z'))).toEqual({ due: true, day: '2026-10-12' }); // Mon 23:59
    expect(scheduleDue(s, new Date('2026-10-11T15:00:00Z'))).toEqual({ due: false }); // Sunday
  });

  it('is never due when off', () => {
    expect(scheduleDue({ ...s, enabled: false }, new Date('2026-10-12T15:00:00Z'))).toEqual({ due: false });
  });

  it('keys one scheduled run per user per local day', () => {
    expect(scheduleKey('u1', '2026-10-12')).toBe('u1:2026-10-12');
  });
});

describe('briefing content', () => {
  const good = {
    summary: 'Two things are waiting on you.',
    carryovers: [{ projectId: 'p1', workstream: 'main', kind: 'question', title: 'Answer the agent', detail: 'It asked which pane to keep.', evidence: 'transcript' }],
    suggestions: [{ projectId: 'p1', workstream: 'main', text: 'Answer it first', why: 'It blocks the PR.' }],
  };

  it('finds JSON in fenced or bare text', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('prefix {"a":{"b":2}} suffix')).toEqual({ a: { b: 2 } });
    expect(extractJson('no json here')).toBeNull();
  });

  it('validates and clamps', () => {
    const r = parseBriefingContent(JSON.stringify({ ...good, summary: 'x'.repeat(5000) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content.summary.length).toBe(1200);
  });

  it('coerces unknown kinds and evidence instead of failing the run', () => {
    const r = parseBriefingContent(JSON.stringify({ ...good, carryovers: [{ ...good.carryovers[0], kind: 'urgent', evidence: 'vibes' }] }));
    expect(r.ok && r.content.carryovers[0]).toMatchObject({ kind: 'action', evidence: 'status' });
  });

  it('fails clearly on missing JSON or summary', () => {
    expect(parseBriefingContent('I could not do it')).toEqual({ ok: false, error: 'The review did not return JSON' });
    expect(parseBriefingContent('{"summary": ""}').ok).toBe(false);
  });

  it('drops links to projects the user cannot see', () => {
    const r = parseBriefingContent(JSON.stringify(good));
    if (!r.ok) throw new Error('parse');
    const scrubbed = scrubProjectIds(r.content, new Set(['other']));
    expect(scrubbed.carryovers[0]).toMatchObject({ projectId: null, workstream: null });
    expect(scrubbed.suggestions[0].projectId).toBeNull();
  });
});
