import { describe, expect, it, vi } from 'vitest';
import { schedulerTick, type TickDeps } from './scheduler';
import { briefingBlocks, sessionLink, slackEscape, webBase } from './slack';
import { briefingLaunch, briefingSessionName, noBoxReason, parseResultBody, type BriefingBox } from './runner';
import { briefingJob, briefingPrompt } from './prompt';
import type { BriefingView } from './types';
import { BRIEFING_ALLOWED_TOOLS } from './types';

const on = { enabled: true, time: '07:00', timezone: 'UTC', days: [1, 2, 3, 4, 5], slackDm: true };
const monday0800 = new Date('2026-10-12T08:00:00Z');

function deps(over: Partial<TickDeps> = {}): TickDeps {
  return {
    enabledUsers: async () => [{ id: 'u1', briefingSchedule: on }],
    existing: async () => null,
    dropSkipped: async () => true,
    start: vi.fn(async () => ({ kind: 'started' as const, id: 'b1' })),
    deliver: vi.fn(async () => {}),
    undelivered: async () => [],
    sweep: vi.fn(async () => 0),
    ...over,
  };
}

describe('schedulerTick', () => {
  it('starts a due briefing with the day key, the zone and the DM choice', async () => {
    const d = deps();
    expect(await schedulerTick(monday0800, d)).toEqual({ started: 1 });
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({
      user: { id: 'u1' }, trigger: 'schedule', tz: 'UTC', deliverSlack: true, scheduleKey: 'u1:2026-10-12',
    }));
    expect(d.sweep).toHaveBeenCalled();
  });

  it('does nothing before the slot, on an off day, or when off', async () => {
    const d = deps();
    await schedulerTick(new Date('2026-10-12T06:59:00Z'), d);
    await schedulerTick(new Date('2026-10-11T09:00:00Z'), d);
    await schedulerTick(monday0800, { ...d, enabledUsers: async () => [{ id: 'u1', briefingSchedule: { ...on, enabled: false } }] });
    await schedulerTick(monday0800, { ...d, enabledUsers: async () => [{ id: 'u1', briefingSchedule: {} }] });
    expect(d.start).not.toHaveBeenCalled();
  });

  it('runs once per day, and retries only a skipped one', async () => {
    const done = deps({ existing: async () => ({ id: 'b0', status: 'done' }) });
    await schedulerTick(monday0800, done);
    expect(done.start).not.toHaveBeenCalled();

    const failed = deps({ existing: async () => ({ id: 'b0', status: 'failed' }) });
    await schedulerTick(monday0800, failed);
    expect(failed.start).not.toHaveBeenCalled();

    const dropSkipped = vi.fn(async () => true);
    const skipped = deps({ existing: async () => ({ id: 'b0', status: 'skipped' }), dropSkipped });
    await schedulerTick(monday0800, skipped);
    expect(dropSkipped).toHaveBeenCalledWith('b0');
    expect(skipped.start).toHaveBeenCalledTimes(1);

    // Another process got to the skipped row first.
    const raced = deps({ existing: async () => ({ id: 'b0', status: 'skipped' }), dropSkipped: async () => false });
    await schedulerTick(monday0800, raced);
    expect(raced.start).not.toHaveBeenCalled();
  });

  it('DMs a launch that failed, but not a skip', async () => {
    const failed = deps({ start: vi.fn(async () => ({ kind: 'failed' as const, id: 'b9' })) });
    await schedulerTick(monday0800, failed);
    expect(failed.deliver).toHaveBeenCalledWith('b9');
    const skipped = deps({ start: vi.fn(async () => ({ kind: 'skipped' as const, id: 'b8' })) });
    await schedulerTick(monday0800, skipped);
    expect(skipped.deliver).not.toHaveBeenCalled();
  });

  it('retries DMs that did not go out, and a failing one does not stop the tick', async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error('slack down')).mockResolvedValue(undefined);
    const d = deps({ undelivered: async () => ['b7', 'b8'], deliver });
    expect(await schedulerTick(monday0800, d)).toEqual({ started: 1 });
    expect(deliver.mock.calls.map(c => c[0])).toEqual(['b7', 'b8']);
  });

  it('keeps going when one user fails', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ kind: 'started', id: 'b2' });
    const d = deps({ enabledUsers: async () => [{ id: 'u1', briefingSchedule: on }, { id: 'u2', briefingSchedule: on }], start });
    expect(await schedulerTick(monday0800, d)).toEqual({ started: 1 });
  });
});

const view: BriefingView = {
  id: 'b1', trigger: 'schedule', status: 'done', error: null,
  window: { since: '', until: '', tz: 'UTC', label: 'Fri 9 Oct 16:00 to Mon 12 Oct 07:00 (2 days 15 hours)', basis: 'since_last' },
  boxName: 'devbox',
  content: {
    version: 2,
    headline: 'You left <two> things & a PR.',
    workedOn: [{ projectId: 'p1', workstream: 'main', text: 'Shipped SDK chat', prs: ['o/termag#400'] }],
    leftOpen: [
      { key: 'open:p1:feat', projectId: 'p1', workstream: 'feat', kind: 'question', title: 'Answer the agent', detail: 'It asked about panes.', evidence: 'transcript', pr: null },
      { key: 'open:gone:main', projectId: 'gone', workstream: null, kind: 'action', title: 'Orphan', detail: '', evidence: 'git', pr: 'o/termag#12' },
    ],
    workBetter: [{ key: 'pattern:many-switches', projectId: null, workstream: null, text: 'Batch your reviews', why: 'You switched 40 times a day.' }],
  },
  stats: { agentMs: 3_600_000, humanMs: 7_200_000, tokens: 1, sessionsTouched: 3, switches: 4, waitingNow: 1, prsNeedingAttention: 2, keptCheckouts: 0, offlineBoxes: 0 },
  charts: null,
  projects: { p1: { name: 'termag', archived: false } },
  createdAt: '', finishedAt: null,
};

describe('Slack briefing', () => {
  it('escapes mrkdwn and builds session links', () => {
    expect(slackEscape('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
    expect(sessionLink('https://x/termag', 'p1', 'feat')).toBe('https://x/termag/?project=p1&ws=feat');
    expect(sessionLink('https://x/termag', 'p1', 'main')).toBe('https://x/termag/?project=p1');
    expect(sessionLink(null, 'p1', 'main')).toBeNull();
    expect(webBase({ FRONTEND_URL: 'https://x/', BASE_PATH: '/termag' } as NodeJS.ProcessEnv)).toBe('https://x/termag');
    expect(webBase({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('leads with the window, links known projects and offers Run again', () => {
    const { text, blocks } = briefingBlocks(view, 'https://x/termag');
    const json = JSON.stringify(blocks);
    expect(json.indexOf('Since your last briefing')).toBeLessThan(json.indexOf('You left'));
    expect(json).toContain('Fri 9 Oct 16:00 to Mon 12 Oct 07:00');
    expect(json).toContain('&lt;two&gt; things &amp; a PR');
    expect(json).toContain('<https://x/termag/?project=p1&ws=feat|termag · feat>');
    expect(json).toContain('Orphan');
    expect(json.indexOf('Worked on')).toBeLessThan(json.indexOf('Left open'));
    expect(json.indexOf('Left open')).toBeLessThan(json.indexOf('Work better'));
    expect(json).toContain('<https://github.com/o/termag/pull/400|#400>');
    expect(json).toContain('<https://github.com/o/termag/pull/12|#12>');
    expect(json).toContain('You 2 hours · agents 1 hour · 3 sessions · 1 waiting · 2 PRs need you');
    expect(json).toContain('Batch your reviews');
    expect(json).toContain('briefing_run_again');
    expect(json).toContain('https://x/termag/dashboard');
    expect(text).toMatch(/^Your termag briefing: /);
  });

  it('says why when the briefing did not finish', () => {
    const { blocks } = briefingBlocks({ ...view, status: 'failed', content: null, error: 'Box asleep.' }, null);
    expect(JSON.stringify(blocks)).toContain('Box asleep.');
    expect(JSON.stringify(blocks)).not.toContain('Open dashboard');
  });
});

describe('runner helpers', () => {
  it('names the one-shot session so it never parses as a project pane', () => {
    expect(briefingSessionName('pat.s', 'cmabc_1')).toBe('pat_ds-briefing-cmabc__1-r');
    expect(briefingLaunch('/home/pat/', 'pat', 'b1')).toEqual({
      sessionName: 'pat-briefing-b1-r',
      command: ['/home/pat/.local/bin/termag-briefing', 'b1'],
      cwd: '/home/pat/.termag/briefing',
      gitInit: false,
    });
  });

  it('explains why no box could take the run', () => {
    const box = (over: Partial<BriefingBox>): BriefingBox => ({
      id: 'i', kind: 'ec2', status: 'ready', name: 'b', hostHome: '/home/p', hostUnixUser: 'p', lastConnectedAt: null, connected: true, capable: false, ...over,
    });
    expect(noBoxReason([])).toMatch(/no box/);
    expect(noBoxReason([box({ connected: false })])).toMatch(/agent connected/);
    expect(noBoxReason([box({})])).toMatch(/older termag/);
  });

  it('validates the box result body', () => {
    expect(parseResultBody({ result: '{}', exitStatus: 0, usage: { input_tokens: 3 } })).toMatchObject({ result: '{}', exitStatus: 0, isError: false });
    expect(parseResultBody({ exitStatus: 0 })).toHaveProperty('error');
    expect(parseResultBody({ result: 'x', exitStatus: 'no' })).toMatchObject({ exitStatus: -1 });
    expect(parseResultBody(null)).toHaveProperty('error');
  });

  it('tells the review to use this briefing and read tools only', () => {
    const job = briefingJob('b42', null);
    expect(job.prompt).toContain('{"briefing": "b42"}');
    expect(job.prompt).toMatch(/UNTRUSTED/);
    expect(job.allowedTools).toEqual(BRIEFING_ALLOWED_TOOLS);
    expect(job.allowedTools.some(t => t.includes('send_keys'))).toBe(false);
    expect(briefingPrompt('x')).toContain('"leftOpen"');
    expect(briefingPrompt('x')).toContain('"workBetter"');
    expect(briefingPrompt('x')).toMatch(/dismissed true/);
  });
});
