import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, parseScheduleBody, readSchedule, scheduleDue, scheduleKey } from './schedule';
import { extractJson, parseBriefingContent, prUrl, scrubProjectIds, upgradeContent } from './content';

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
    headline: 'Two agents are waiting on you.',
    workedOn: [{ projectId: 'p1', workstream: 'main', text: 'Shipped SDK chat', prs: ['o/termag#400', 'not a pr', 7] }],
    leftOpen: [{ projectId: 'p1', workstream: 'feat-x', kind: 'question', title: 'Answer the agent', detail: 'It asked which pane to keep.', evidence: 'transcript', pr: null }],
    workBetter: [{ patternId: 'big-context:p1:main', text: 'Start a fresh workstream', why: 'main peaked at 388k tokens.' }],
  };
  const patterns = [{ id: 'big-context:p1:main', kind: 'big-context' as const, finding: 'f', projectId: 'p1', workstream: 'main' }];

  it('finds JSON in fenced or bare text', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('prefix {"a":{"b":2}} suffix')).toEqual({ a: { b: 2 } });
    expect(extractJson('no json here')).toBeNull();
  });

  it('validates, clamps bullets short, and keys the items', () => {
    const r = parseBriefingContent(JSON.stringify({ ...good, headline: 'x'.repeat(5000) }), patterns);
    if (!r.ok) throw new Error(r.error);
    expect(r.content.version).toBe(2);
    expect(r.content.headline.length).toBe(200);
    expect(r.content.workedOn[0].prs).toEqual(['o/termag#400']);
    expect(r.content.leftOpen[0].key).toBe('open:p1:feat-x');
    expect(r.content.workBetter[0]).toMatchObject({ key: 'pattern:big-context:p1:main', projectId: 'p1', workstream: 'main' });
  });

  it('drops Work better items that name no known pattern', () => {
    const r = parseBriefingContent(JSON.stringify({ ...good, workBetter: [{ patternId: 'made-up', text: 'Do yoga' }, good.workBetter[0]] }), patterns);
    expect(r.ok && r.content.workBetter.map(w => w.key)).toEqual(['pattern:big-context:p1:main']);
    const free = parseBriefingContent(JSON.stringify({ ...good, workBetter: [{ patternId: 'made-up', text: 'Do yoga' }] }), null);
    expect(free.ok && free.content.workBetter.map(w => w.key)).toEqual(['pattern:made-up']);
  });

  it('keeps pattern ids that carry a branch-like workstream', () => {
    const slashed = [{ id: 'big-context:p1:feat/x', kind: 'big-context' as const, finding: 'f', projectId: 'p1', workstream: 'feat/x' }];
    const r = parseBriefingContent(JSON.stringify({ ...good, workBetter: [{ patternId: 'big-context:p1:feat/x', text: 'Split it' }] }), slashed);
    expect(r.ok && r.content.workBetter.map(w => w.key)).toEqual(['pattern:big-context:p1:feat/x']);
    const spaced = parseBriefingContent(JSON.stringify({ ...good, workBetter: [{ patternId: 'a b', text: 'x' }] }), null);
    expect(spaced.ok && spaced.content.workBetter).toEqual([]);
  });

  it('keys a Left open PR with no session by the PR', () => {
    const r = parseBriefingContent(JSON.stringify({ ...good, leftOpen: [{ ...good.leftOpen[0], projectId: null, workstream: null, pr: 'o/termag#12' }] }));
    expect(r.ok && r.content.leftOpen[0].key).toBe('open:pr:o/termag#12');
  });

  it('coerces unknown kinds and evidence instead of failing the run', () => {
    const r = parseBriefingContent(JSON.stringify({ ...good, leftOpen: [{ ...good.leftOpen[0], kind: 'urgent', evidence: 'vibes' }] }));
    expect(r.ok && r.content.leftOpen[0]).toMatchObject({ kind: 'action', evidence: 'status' });
  });

  it('fails clearly on missing JSON or headline', () => {
    expect(parseBriefingContent('I could not do it')).toEqual({ ok: false, error: 'The review did not return JSON' });
    expect(parseBriefingContent('{"headline": ""}').ok).toBe(false);
  });

  it('drops links to projects the user cannot see', () => {
    const r = parseBriefingContent(JSON.stringify(good), patterns);
    if (!r.ok) throw new Error('parse');
    const scrubbed = scrubProjectIds(r.content, new Set(['other']));
    expect(scrubbed.leftOpen[0]).toMatchObject({ projectId: null, workstream: null, key: null });
    expect(scrubbed.workedOn[0].projectId).toBeNull();
    expect(scrubbed.workBetter[0].projectId).toBeNull();
  });

  it('takes a version 1 answer from a run that fetched its prompt before the deploy', () => {
    const r = parseBriefingContent(JSON.stringify({
      summary: 'You did things.',
      carryovers: [{ projectId: 'p1', workstream: 'main', kind: 'question', title: 'Answer it', detail: 'd', evidence: 'transcript' }],
      suggestions: [{ projectId: null, workstream: null, text: 'Review PRs', why: 'w' }],
    }), patterns);
    if (!r.ok) throw new Error(r.error);
    expect(r.content).toMatchObject({ version: 2, headline: 'You did things.', workedOn: [], workBetter: [] });
    expect(r.content.leftOpen.map(x => [x.key, x.kind, x.title])).toEqual([['open:p1:main', 'question', 'Answer it'], [null, 'action', 'Review PRs']]);
  });

  it('reads a version 1 row as version 2', () => {
    const v1 = {
      summary: 'You did things.',
      carryovers: [{ projectId: 'p1', workstream: 'main', kind: 'question', title: 'Answer it', detail: 'd', evidence: 'transcript' }],
      suggestions: [{ projectId: null, workstream: null, text: 'Review PRs', why: 'w' }],
    };
    expect(upgradeContent(v1)).toEqual({
      version: 2, headline: 'You did things.', workedOn: [], workBetter: [],
      leftOpen: [
        { ...v1.carryovers[0], pr: null, key: 'open:p1:main' },
        { key: null, projectId: null, workstream: null, kind: 'action', title: 'Review PRs', detail: 'w', evidence: 'status', pr: null },
      ],
    });
    expect(upgradeContent(null)).toBeNull();
  });

  it('links a PR ref to GitHub', () => {
    expect(prUrl('o/termag#12')).toBe('https://github.com/o/termag/pull/12');
    expect(prUrl('nope')).toBeNull();
  });
});
