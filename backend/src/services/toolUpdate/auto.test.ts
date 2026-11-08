import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { autoUpdateDecision, backoffUntil, belowFloor, failedFloorRun, resumeHold, RESUME_MARKER_MAX_MS, breachAfter, isCurrent, nightlyClockStart, byPriority, liveBreachSince, isNight, localHour, nightlyDueAt, reasonText, resumePending, parseNightlySchedule, inWindow, isQuiet, DEFAULT_NIGHTLY_SCHEDULE, NIGHT_FROM_HOUR, NIGHT_TO_HOUR, NIGHTLY_EVERY_MS, QUIET_AFTER_MS, type AutoFacts, type NightlySchedule } from './auto';

// No fake timers: they fake Intl too (docs/agents/gotchas.md, test-fake-timers-fake-intl). Every case passes `now`.
const H = 3600_000;
// 2026-11-02 03:00 in Berlin (CET, UTC+1), 21:00 the evening before in New York.
const NIGHT_BERLIN = Date.parse('2026-11-02T02:00:00Z');
// 2026-11-02 15:00 in Berlin.
const DAY_BERLIN = Date.parse('2026-11-02T14:00:00Z');
const ago = (now: number, h: number) => new Date(now - h * H);
const miss = (trigger: string, now: number, h: number) => ({ trigger, at: ago(now, h) });

const facts = (now: number, over: Partial<AutoFacts> = {}): AutoFacts => ({
  autoOn: true, updateOn: true, connected: true, settling: false, capable: true, inFlight: false,
  version: '2.1.316', floor: '2.1.308', reference: null, policyRestart: 'idle', sessionless: false, mayForce: true, forceAfterHours: 24, breachSince: null,
  resumed: false, lastRunAt: ago(now, 30), unreached: [], failedFloorRuns: [], firstSeenAt: ago(now, 24 * 10),
  lastActivityAt: ago(now, 2), timeZone: 'Europe/Berlin',
  ...over,
});

describe('autoUpdateDecision', () => {
  const cases: Array<[string, number, Partial<AutoFacts>, ReturnType<typeof autoUpdateDecision>]> = [
    // the skips, in fleet.ts hostRefusal's order
    ['the auto flag off', NIGHT_BERLIN, { autoOn: false, version: '2.1.290' }, { run: false, skip: 'auto-off' }],
    ['the update flag off (the prerequisite)', NIGHT_BERLIN, { updateOn: false, version: '2.1.290' }, { run: false, skip: 'update-off' }],
    ['offline', NIGHT_BERLIN, { connected: false, version: '2.1.290' }, { run: false, skip: 'offline' }],
    ['connected under a minute ago: left for its hello pass', NIGHT_BERLIN, { settling: true, version: '2.1.290' }, { run: false, skip: 'settling' }],
    ['no capability', NIGHT_BERLIN, { capable: false, version: '2.1.290' }, { run: false, skip: 'not-capable' }],
    ['a run in flight', NIGHT_BERLIN, { inFlight: true, version: '2.1.290' }, { run: false, skip: 'run-in-flight' }],
    // below the floor
    ['below the floor, a new breach: idle, now, whatever the hour or activity', DAY_BERLIN,
      { version: '2.1.290', lastActivityAt: ago(DAY_BERLIN, 0) }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['below the floor for 23 h: still idle', DAY_BERLIN,
      { version: '2.1.290', breachSince: ago(DAY_BERLIN, 23) }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['below the floor for forceAfterHours: force', DAY_BERLIN,
      { version: '2.1.290', breachSince: ago(DAY_BERLIN, 24) }, { run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' }],
    ['the policy\'s own force age', DAY_BERLIN,
      { version: '2.1.290', breachSince: ago(DAY_BERLIN, 7), forceAfterHours: 6 }, { run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' }],
    ['below the floor, a run less than an hour ago: wait for its report', DAY_BERLIN,
      { version: '2.1.290', lastRunAt: ago(DAY_BERLIN, 0.5) }, { run: false, skip: 'floor-just-ran' }],
    ['below the floor wins over a resume', DAY_BERLIN,
      { version: '2.1.290', resumed: true }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['an unreadable version is never below the floor: the nightly rules', DAY_BERLIN,
      { version: null }, { run: false, skip: 'not-quiet' }],
    // resume
    ['resumed from hibernation: installs only (restart none), even right after a run and in the day (#1163)', DAY_BERLIN,
      { resumed: true, lastRunAt: ago(DAY_BERLIN, 2), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: true, trigger: 'resume', restart: 'none', reason: 'resumed' }],
    ['resumed, but below the floor: the floor run, as before', DAY_BERLIN,
      { resumed: true, version: '2.1.290', lastActivityAt: ago(DAY_BERLIN, 0) }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    // nightly
    ['ran 23 h ago: not due', NIGHT_BERLIN, { lastRunAt: ago(NIGHT_BERLIN, 23) }, { run: false, skip: 'ran-recently' }],
    ['due, quiet, the owner\'s night', NIGHT_BERLIN, {}, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['due, quiet, the owner\'s day', DAY_BERLIN, {}, { run: false, skip: 'not-quiet' }],
    ['due, the owner\'s night, active 30 min ago', NIGHT_BERLIN, { lastActivityAt: ago(NIGHT_BERLIN, 0.5) }, { run: false, skip: 'not-quiet' }],
    ['due, no activity clock at all, the owner\'s night', NIGHT_BERLIN, { lastActivityAt: null }, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['due, quiet, no time zone: any hour', DAY_BERLIN, { timeZone: null }, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['due, no time zone, active: not quiet', DAY_BERLIN, { timeZone: null, lastActivityAt: ago(DAY_BERLIN, 0.2) }, { run: false, skip: 'not-quiet' }],
    ['another zone\'s night: 21:00 in New York is not it', NIGHT_BERLIN, { timeZone: 'America/New_York' }, { run: false, skip: 'not-quiet' }],
    // the never-quiet fallback keeps the owner's night and installs only (#1163)
    ['never quiet for 24 h, at 15:00 in Berlin: the fallback waits for the owner\'s night', DAY_BERLIN,
      { lastRunAt: ago(DAY_BERLIN, 48), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: false, skip: 'not-quiet' }],
    ['never quiet for 24 h, at 03:00 in Berlin, active: the run goes, restart none', NIGHT_BERLIN,
      { lastRunAt: ago(NIGHT_BERLIN, 48), lastActivityAt: ago(NIGHT_BERLIN, 0) }, { run: true, trigger: 'nightly', restart: 'none', reason: 'never-quiet' }],
    ['never quiet for 24 h, no time zone: any hour is the night, restart none', DAY_BERLIN,
      { timeZone: null, lastRunAt: ago(DAY_BERLIN, 48), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: true, trigger: 'nightly', restart: 'none', reason: 'never-quiet' }],
    ['never quiet, a tool whose run restarts the agent (Node), no time zone: no daytime fallback', DAY_BERLIN,
      { restartsAgent: true, timeZone: null, lastRunAt: ago(DAY_BERLIN, 48), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: false, skip: 'not-quiet' }],
    ['never quiet, Node, at 15:00 in Berlin: waits', DAY_BERLIN,
      { restartsAgent: true, lastRunAt: ago(DAY_BERLIN, 48), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: false, skip: 'not-quiet' }],
    ['never quiet, Node, at 03:00 in Berlin: the run goes, restart none', NIGHT_BERLIN,
      { restartsAgent: true, lastRunAt: ago(NIGHT_BERLIN, 48), lastActivityAt: ago(NIGHT_BERLIN, 0) }, { run: true, trigger: 'nightly', restart: 'none', reason: 'never-quiet' }],
    ['due for 23 h and never quiet: not yet', DAY_BERLIN,
      { lastRunAt: ago(DAY_BERLIN, 47), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: false, skip: 'not-quiet' }],
    ['no run ever: due from when the sweep first saw it', NIGHT_BERLIN, { lastRunAt: null, firstSeenAt: ago(NIGHT_BERLIN, 0.25) }, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['no run ever, first seen today, active: not quiet, and not overdue', DAY_BERLIN,
      { lastRunAt: null, firstSeenAt: ago(DAY_BERLIN, 5), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: false, skip: 'not-quiet' }],
    ['no run ever, first seen 24 h ago, never quiet, in the owner\'s night: restart none', NIGHT_BERLIN,
      { lastRunAt: null, firstSeenAt: ago(NIGHT_BERLIN, 24), lastActivityAt: ago(NIGHT_BERLIN, 0) }, { run: true, trigger: 'nightly', restart: 'none', reason: 'never-quiet' }],
    // a known reference (an exact target, or a pinned latest: the Cursor agent's)
    ['due and quiet, but on the reference already: nothing to gain', NIGHT_BERLIN, { reference: '2.1.316' }, { run: false, skip: 'current' }],
    ['due and quiet, ahead of the reference', NIGHT_BERLIN, { reference: '2.1.312' }, { run: false, skip: 'current' }],
    ['due and quiet, behind the reference', NIGHT_BERLIN, { reference: '2.1.320' }, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['never quiet, but current: still nothing to gain', DAY_BERLIN, { reference: '2.1.316', lastRunAt: ago(DAY_BERLIN, 48), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: false, skip: 'current' }],
    ['below the floor runs whatever the reference says', DAY_BERLIN, { version: '2.1.290', reference: '2.1.290' }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['the Cursor agent on the newest pin: current', NIGHT_BERLIN,
      { version: '2026.10.22-27dcf5f', floor: '2025.09.17-25b418f', reference: '2026.10.22-27dcf5f' }, { run: false, skip: 'current' }],
    ['the Cursor agent ahead of every pin: current, not behind', NIGHT_BERLIN,
      { version: '2026.10.30-abc1234', floor: '2025.09.17-25b418f', reference: '2026.10.22-27dcf5f' }, { run: false, skip: 'current' }],
    ['the Cursor agent on an older pin: its nightly run', NIGHT_BERLIN,
      { version: '2026.09.01-1a2b3c4', floor: '2025.09.17-25b418f', reference: '2026.10.22-27dcf5f' }, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['the Cursor agent below its floor', DAY_BERLIN,
      { version: '2025.08.01-1a2b3c4', floor: '2025.09.17-25b418f', reference: '2026.10.22-27dcf5f' }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    // the policy's restart
    ['a policy with restart none: the run stops nothing', NIGHT_BERLIN, { policyRestart: 'none' }, { run: true, trigger: 'nightly', restart: 'none', reason: 'quiet' }],
    ['restart none caps force too', DAY_BERLIN, { policyRestart: 'none', version: '2.1.290', breachSince: ago(DAY_BERLIN, 30) }, { run: true, trigger: 'floor', restart: 'none', reason: 'below-floor-force' }],
    // runs asked for that never reached the box (expired unsent, or refused): each trigger backs off,
    // 1 h, 2 h, 4 h, … up to a day after its newest; a run that reaches the box starts over (#1163)
    ['one unreached nightly run 30 min ago: backing off its first hour', NIGHT_BERLIN,
      { unreached: [miss('nightly', NIGHT_BERLIN, 0.5)] }, { run: false, skip: 'backing-off' }],
    ['one unreached nightly run an hour ago: the nightly goes again', NIGHT_BERLIN,
      { unreached: [miss('nightly', NIGHT_BERLIN, 1)] }, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['two unreached nightly runs, the newest 1.5 h ago: backing off 2 h', NIGHT_BERLIN,
      { unreached: [miss('nightly', NIGHT_BERLIN, 4), miss('nightly', NIGHT_BERLIN, 1.5)] }, { run: false, skip: 'backing-off' }],
    ['another trigger\'s unreached runs do not hold the nightly', NIGHT_BERLIN,
      { unreached: [miss('floor', NIGHT_BERLIN, 0.5)] }, { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' }],
    ['a resume after unreached nightly runs is its own: it goes, installing only', DAY_BERLIN,
      { resumed: true, resumedAt: ago(DAY_BERLIN, 0.1), unreached: [miss('nightly', DAY_BERLIN, 0.5)] }, { run: true, trigger: 'resume', restart: 'none', reason: 'resumed' }],
    ['the resume run itself went unreached 30 min ago: backing off', DAY_BERLIN,
      { resumed: true, resumedAt: ago(DAY_BERLIN, 1), unreached: [miss('resume', DAY_BERLIN, 0.5)] }, { run: false, skip: 'backing-off' }],
    ['a resume run unreached for an earlier marker does not hold this one', DAY_BERLIN,
      { resumed: true, resumedAt: ago(DAY_BERLIN, 0.1), unreached: [miss('resume', DAY_BERLIN, 0.5)] }, { run: true, trigger: 'resume', restart: 'none', reason: 'resumed' }],
    // a cold start (coldStart.ts): the same resume run, for a tool that is behind
    ['started from stopped, behind its reference: a resume run, installing only, in the day', DAY_BERLIN,
      { resumed: true, resumeKind: 'cold-start', reference: '2.1.320', lastRunAt: ago(DAY_BERLIN, 2), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: true, trigger: 'resume', restart: 'none', reason: 'started' }],
    ['started from stopped, no known reference (npm latest): a resume run', DAY_BERLIN,
      { resumed: true, resumeKind: 'cold-start', lastRunAt: ago(DAY_BERLIN, 2) }, { run: true, trigger: 'resume', restart: 'none', reason: 'started' }],
    ['started from stopped, already at its reference: nothing to install, the nightly rules', DAY_BERLIN,
      { resumed: true, resumeKind: 'cold-start', reference: '2.1.316', lastRunAt: ago(DAY_BERLIN, 2) }, { run: false, skip: 'current' }],
    ['started from stopped, its resume run unreached 30 min ago: backing off', DAY_BERLIN,
      { resumed: true, resumeKind: 'cold-start', resumedAt: ago(DAY_BERLIN, 1), unreached: [miss('resume', DAY_BERLIN, 0.5)] }, { run: false, skip: 'backing-off' }],
    ['started from stopped, but below the floor: the floor run', DAY_BERLIN,
      { resumed: true, resumeKind: 'cold-start', version: '2.1.290' }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['started from stopped, a tool whose run restarts the agent (Node): no resume run, the nightly rules (Bugbot on #1304)', DAY_BERLIN,
      { resumed: true, resumeKind: 'cold-start', restartsAgent: true, lastRunAt: ago(DAY_BERLIN, 2) }, { run: false, skip: 'ran-recently' }],
    ['resumed from hibernation, Node: its resume run as before', DAY_BERLIN,
      { resumed: true, restartsAgent: true, lastRunAt: ago(DAY_BERLIN, 2) }, { run: true, trigger: 'resume', restart: 'none', reason: 'resumed' }],
    ['started from stopped, no sessions (gh): nothing asked of it', DAY_BERLIN,
      { resumed: true, resumeKind: 'cold-start', sessionless: true, lastRunAt: ago(DAY_BERLIN, 5) }, { run: false, skip: 'ran-recently' }],
    ['a run that reached the box 30 min ago, then a resume: the resume run goes, installing only', DAY_BERLIN,
      { resumed: true, resumedAt: ago(DAY_BERLIN, 0.1), lastRunAt: ago(DAY_BERLIN, 0.5) }, { run: true, trigger: 'resume', restart: 'none', reason: 'resumed' }],
    ['a run that reached the box 30 min ago: the nightly rules decide, no backoff', NIGHT_BERLIN,
      { lastRunAt: ago(NIGHT_BERLIN, 0.5) }, { run: false, skip: 'ran-recently' }],
    ['below the floor, a run that reached the box 30 min ago: wait for its report', DAY_BERLIN,
      { version: '2.1.290', lastRunAt: ago(DAY_BERLIN, 0.5) }, { run: false, skip: 'floor-just-ran' }],
    ['below the floor, three unreached floor runs, the newest 3 h ago: backing off 4 h', DAY_BERLIN,
      { version: '2.1.290', breachSince: ago(DAY_BERLIN, 10), unreached: [miss('floor', DAY_BERLIN, 10), miss('floor', DAY_BERLIN, 6), miss('floor', DAY_BERLIN, 3)] }, { run: false, skip: 'backing-off' }],
    ['below the floor, the same, 4 h on: the floor run goes', DAY_BERLIN,
      { version: '2.1.290', breachSince: ago(DAY_BERLIN, 11), unreached: [miss('floor', DAY_BERLIN, 11), miss('floor', DAY_BERLIN, 7), miss('floor', DAY_BERLIN, 4)] }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['a raised floor (no force clock for it yet) does not inherit the old floor\'s backoff (Devin on #1163)', DAY_BERLIN,
      { version: '2.1.310', floor: '2.1.320', breachSince: null, unreached: [miss('floor', DAY_BERLIN, 10), miss('floor', DAY_BERLIN, 6), miss('floor', DAY_BERLIN, 1)] }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['floor attempts from before this breach\'s clock started do not count', DAY_BERLIN,
      { version: '2.1.290', breachSince: ago(DAY_BERLIN, 2), unreached: [miss('floor', DAY_BERLIN, 30), miss('floor', DAY_BERLIN, 20), miss('floor', DAY_BERLIN, 2), miss('floor', DAY_BERLIN, 1.5)] }, { run: false, skip: 'backing-off' }],
    ['the same, two hours on: its own two attempts hold 2 h, so the floor run goes', DAY_BERLIN,
      { version: '2.1.290', breachSince: ago(DAY_BERLIN, 4), unreached: [miss('floor', DAY_BERLIN, 30), miss('floor', DAY_BERLIN, 20), miss('floor', DAY_BERLIN, 4), miss('floor', DAY_BERLIN, 3.5)] }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    // a tool whose force would restart everything at once (Node): a floor breach stays idle
    ['may not force: below the floor for three days, still idle', DAY_BERLIN,
      { mayForce: false, version: '2.1.290', breachSince: ago(DAY_BERLIN, 72) }, { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' }],
    ['may not force, but still takes the quiet window', DAY_BERLIN, { mayForce: false }, { run: false, skip: 'not-quiet' }],
    // a tool that runs in no session (gh): no quiet window, no force, no resume run
    ['no sessions: due in the owner\'s busy day, it runs anyway, restarting nothing', DAY_BERLIN,
      { sessionless: true, lastActivityAt: ago(DAY_BERLIN, 0) }, { run: true, trigger: 'nightly', restart: 'none', reason: 'no-sessions' }],
    ['no sessions: still at most one run in 24 h', DAY_BERLIN, { sessionless: true, lastRunAt: ago(DAY_BERLIN, 5) }, { run: false, skip: 'ran-recently' }],
    ['no sessions: below the floor for days, never force', DAY_BERLIN,
      { sessionless: true, version: '2.1.290', breachSince: ago(DAY_BERLIN, 72) }, { run: true, trigger: 'floor', restart: 'none', reason: 'below-floor' }],
    ['no sessions: a resume asks nothing of it; the nightly rules', DAY_BERLIN,
      { sessionless: true, resumed: true, lastRunAt: ago(DAY_BERLIN, 5) }, { run: false, skip: 'ran-recently' }],
    ['no sessions, but current already: nothing to gain', DAY_BERLIN, { sessionless: true, reference: '2.1.316' }, { run: false, skip: 'current' }],
    ['an old run, but the flag turned on an hour ago: the clock starts at first sight', DAY_BERLIN,
      { lastRunAt: ago(DAY_BERLIN, 24 * 30), firstSeenAt: ago(DAY_BERLIN, 1), lastActivityAt: ago(DAY_BERLIN, 0) }, { run: false, skip: 'not-quiet' }],
  ];
  it.each(cases)('%s', (_name, now, over, want) => {
    expect(autoUpdateDecision(facts(now, over), now)).toEqual(want);
  });
});

describe('the clocks', () => {
  it('reads the hour in the owner\'s zone', () => {
    expect(localHour(NIGHT_BERLIN, 'Europe/Berlin')).toBe(3);
    expect(localHour(NIGHT_BERLIN, 'America/New_York')).toBe(21);
    expect(localHour(NIGHT_BERLIN, 'Not/AZone')).toBeNull();
  });

  it('the night is 00:00 to 06:00 local; no zone is any hour', () => {
    expect(isNight(Date.parse('2026-11-01T23:00:00Z'), 'Europe/Berlin')).toBe(true); // 00:00
    expect(isNight(Date.parse('2026-11-02T04:59:00Z'), 'Europe/Berlin')).toBe(true); // 05:59
    expect(isNight(Date.parse('2026-11-02T05:00:00Z'), 'Europe/Berlin')).toBe(false); // 06:00
    expect(isNight(DAY_BERLIN, null)).toBe(true);
  });

  it('a box is due 24 h after its last run, never before it was first seen', () => {
    const now = DAY_BERLIN;
    expect(nightlyDueAt({ lastRunAt: ago(now, 30), firstSeenAt: ago(now, 100) })).toBe(now - 6 * H);
    expect(nightlyDueAt({ lastRunAt: ago(now, 30), firstSeenAt: ago(now, 1) })).toBe(now - H);
    expect(nightlyDueAt({ lastRunAt: null, firstSeenAt: ago(now, 1) })).toBe(now - H);
  });

  it('compares a dated build by its day against a floor, and calls a build at or past the pin current', () => {
    expect(belowFloor('2025.09.17-0000000', '2025.09.17-25b418f')).toBe(false);
    expect(belowFloor('2025.09.16-25b418f', '2025.09.17-25b418f')).toBe(true);
    expect(isCurrent('2026.10.22-27dcf5f', '2026.10.22-27dcf5f')).toBe(true);
    expect(isCurrent('2026.10.23-0000000', '2026.10.22-27dcf5f')).toBe(true);
    expect(isCurrent('2026.10.22-1111111', '2026.10.22-27dcf5f')).toBe(false);
    expect(isCurrent('2.1.316', null)).toBe(false);
    expect(isCurrent(null, '2.1.316')).toBe(false);
  });

  it('compares versions, and never calls an unreadable one below', () => {
    expect(belowFloor('2.1.290', '2.1.308')).toBe(true);
    expect(belowFloor('2.1.308', '2.1.308')).toBe(false);
    expect(belowFloor(null, '2.1.308')).toBe(false);
    expect(belowFloor('garbage', '2.1.308')).toBe(false);
  });
});

describe('resumePending', () => {
  it('asks for a run only for a marker under a day old with no run after it (Bugbot on #1163)', () => {
    expect(resumePending(ago(DAY_BERLIN, 0.1), ago(DAY_BERLIN, 30), DAY_BERLIN)).toBe(true);
    expect(resumePending(ago(DAY_BERLIN, 0.1), null, DAY_BERLIN)).toBe(true);
    expect(resumePending(ago(DAY_BERLIN, 2), ago(DAY_BERLIN, 1), DAY_BERLIN)).toBe(false);
    expect(resumePending(ago(DAY_BERLIN, 24), null, DAY_BERLIN)).toBe(false);
    expect(resumePending(null, null, DAY_BERLIN)).toBe(false);
  });
});

describe('backoffUntil (#1163)', () => {
  const at = (h: number) => ago(DAY_BERLIN, h);
  it('backs off 1 h, 2 h, 4 h, 8 h, 16 h after the newest unreached attempt, then holds at a day', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8].map(n => {
      const attempts = Array.from({ length: n }, (_, k) => ({ trigger: 'nightly', at: at(n - k) }));
      return (backoffUntil(attempts, 'nightly')! - at(1).getTime()) / H;
    });
    expect(waits).toEqual([1, 2, 4, 8, 16, 24, 24, 24]);
  });

  it('counts only its own trigger, and for a resume only the attempts since its marker; none is no hold', () => {
    const attempts = [{ trigger: 'resume', at: at(5) }, { trigger: 'resume', at: at(3) }, { trigger: 'nightly', at: at(1) }];
    expect(backoffUntil(attempts, 'floor')).toBeNull();
    expect(backoffUntil(attempts, 'nightly')).toBe(at(1).getTime() + H);
    expect(backoffUntil(attempts, 'resume')).toBe(at(3).getTime() + 2 * H);
    expect(backoffUntil(attempts, 'resume', at(4))).toBe(at(3).getTime() + H);
    expect(backoffUntil(attempts, 'resume', at(2))).toBeNull();
    expect(backoffUntil([], 'nightly')).toBeNull();
  });
});

describe('resumeHold (Devin on #1163)', () => {
  const marker = new Date(DAY_BERLIN - 20 * H);
  const after = (h: number) => ({ trigger: 'resume', at: new Date(marker.getTime() + h * H) });
  it('caps a long backoff at the marker\'s last hour, so one attempt still comes before it ends', () => {
    // Failed at hours 0, 1, 3, 7 and 15: the backoff runs to hour 31, past the marker's 24.
    const attempts = [after(0), after(1), after(3), after(7), after(15)];
    expect(backoffUntil(attempts, 'resume', new Date(marker.getTime() - 1))).toBe(marker.getTime() + 31 * H);
    expect(resumeHold(attempts, marker)).toBe(marker.getTime() + RESUME_MARKER_MAX_MS - H);
  });

  it('once that last attempt is made, its own backoff applies; and none is no hold', () => {
    const attempts = [after(0.01), after(1), after(3), after(7), after(15), after(23.2)];
    expect(resumeHold(attempts, marker)).toBe(marker.getTime() + 23.2 * H + 24 * H);
    expect(resumeHold([], marker)).toBeNull();
  });

  it('in the decision: at the marker\'s hour 23, after five unreached resume runs, the resume run goes', () => {
    const now = marker.getTime() + 23.1 * H;
    const f = { ...facts(now, { resumed: true, resumedAt: marker, unreached: [after(0), after(1), after(3), after(7), after(15)].map(a => ({ ...a, at: new Date(a.at.getTime() + 1) })) }) };
    expect(autoUpdateDecision(f, now)).toEqual({ run: true, trigger: 'resume', restart: 'none', reason: 'resumed' });
    expect(autoUpdateDecision(f, marker.getTime() + 22 * H)).toEqual({ run: false, skip: 'backing-off' });
  });
});

describe('a floor run that reaches the box and fails backs off', () => {
  // Python's floor is 3.13.18, and the box's installer can't get it: every floor run reaches the box and fails.
  const py = (now: number, over: Partial<AutoFacts> = {}) => facts(now, { version: '3.13.16', floor: '3.13.18', sessionless: false, policyRestart: 'none', breachSince: ago(now, 12), ...over });
  const run = (h: number, now = DAY_BERLIN) => ago(now, h);

  it('fail, fail, fail: held 1 h, then 2 h, then 4 h after the newest, as floor-failing', () => {
    // One failure 30 min ago: its report and the inventory come first, as before.
    expect(autoUpdateDecision(py(DAY_BERLIN, { lastRunAt: run(0.5), failedFloorRuns: [run(0.5)] }), DAY_BERLIN)).toEqual({ run: false, skip: 'floor-just-ran' });
    // One failure 1.2 h ago: one hour after it, the next run goes.
    expect(autoUpdateDecision(py(DAY_BERLIN, { lastRunAt: run(1.2), failedFloorRuns: [run(1.2)] }), DAY_BERLIN)).toMatchObject({ run: true, trigger: 'floor' });
    // Two: held two hours after the newest.
    expect(autoUpdateDecision(py(DAY_BERLIN, { lastRunAt: run(1.5), failedFloorRuns: [run(3), run(1.5)] }), DAY_BERLIN)).toEqual({ run: false, skip: 'floor-failing' });
    expect(autoUpdateDecision(py(DAY_BERLIN, { lastRunAt: run(2.1), failedFloorRuns: [run(3.6), run(2.1)] }), DAY_BERLIN)).toMatchObject({ run: true, trigger: 'floor' });
    // Three: four hours.
    expect(autoUpdateDecision(py(DAY_BERLIN, { lastRunAt: run(3), failedFloorRuns: [run(6), run(4.5), run(3)] }), DAY_BERLIN)).toEqual({ run: false, skip: 'floor-failing' });
    expect(autoUpdateDecision(py(DAY_BERLIN, { lastRunAt: run(4.1), failedFloorRuns: [run(7), run(5.5), run(4.1)] }), DAY_BERLIN)).toMatchObject({ run: true, trigger: 'floor' });
  });

  it('then a raised floor starts the count over: its first run goes at once', () => {
    const failures = [run(10), run(9), run(7), run(3)];
    expect(autoUpdateDecision(py(DAY_BERLIN, { lastRunAt: run(3), failedFloorRuns: failures }), DAY_BERLIN)).toEqual({ run: false, skip: 'floor-failing' });
    // 3.13.19: a new breach, with no force clock yet.
    expect(autoUpdateDecision(py(DAY_BERLIN, { floor: '3.13.19', breachSince: null, lastRunAt: run(3), failedFloorRuns: failures }), DAY_BERLIN)).toEqual({ run: true, trigger: 'floor', restart: 'none', reason: 'below-floor' });
  });

  it('caps at a day, and counts only this breach\'s runs', () => {
    const many = Array.from({ length: 8 }, (_, k) => run(23 - k * 0.1));
    expect(autoUpdateDecision(py(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(22.3), failedFloorRuns: many }), DAY_BERLIN)).toEqual({ run: false, skip: 'floor-failing' });
    // The newest was 22.3 h ago: held to 24 h after it, so 1.7 h from now.
    expect(autoUpdateDecision(py(DAY_BERLIN + 1.5 * H, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(22.3), failedFloorRuns: many }), DAY_BERLIN + 1.5 * H)).toEqual({ run: false, skip: 'floor-failing' });
    expect(autoUpdateDecision(py(DAY_BERLIN + 2 * H, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(22.3), failedFloorRuns: many }), DAY_BERLIN + 2 * H)).toMatchObject({ run: true, trigger: 'floor' });
    // Failures from before this breach's clock started (an earlier floor, or before the box went away) do not count.
    expect(autoUpdateDecision(py(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 2), lastRunAt: run(2.5), failedFloorRuns: [run(9), run(6), run(2.5)] }), DAY_BERLIN)).toMatchObject({ run: true, trigger: 'floor' });
  });

  it('never brings force sooner: the force clock is the breach\'s, and the backoff only removes runs', () => {
    const session = (now: number, over: Partial<AutoFacts>) => facts(now, { version: '2.1.290', policyRestart: 'idle', ...over });
    // 20 h into the breach, failing hourly before: idle, never force, held or not.
    const failures = [run(6), run(4), run(1.5)];
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 20), lastRunAt: run(1.5), failedFloorRuns: failures }), DAY_BERLIN)).toEqual({ run: false, skip: 'floor-failing' });
    expect(autoUpdateDecision(session(DAY_BERLIN + 3 * H, { breachSince: ago(DAY_BERLIN, 20), lastRunAt: run(1.5), failedFloorRuns: failures }), DAY_BERLIN + 3 * H)).toEqual({ run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' });
    // Past forceAfterHours, a held box stays held: the next run waits for the backoff, it does not jump it.
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(1.5), failedFloorRuns: failures }), DAY_BERLIN)).toEqual({ run: false, skip: 'floor-failing' });
    // And at 30 h with no failures at all it would already be force: the backoff never makes it earlier.
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(3) }), DAY_BERLIN)).toMatchObject({ run: true, restart: 'force' });
  });

  it('never escalates to force while this breach\'s floor runs are failing', () => {
    const session = (now: number, over: Partial<AutoFacts>) => facts(now, { version: '2.1.290', policyRestart: 'idle', ...over });
    // 30 h into the breach, one failed run 3 h ago, the backoff past: the run goes, idle, force held.
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(3), failedFloorRuns: [run(3)] }), DAY_BERLIN))
      .toEqual({ run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor-force-held' });
    // Days in, after a day-long backoff: still idle.
    const many = Array.from({ length: 8 }, (_, k) => run(25 + k * 4));
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 60), lastRunAt: run(25), failedFloorRuns: many }), DAY_BERLIN))
      .toEqual({ run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor-force-held' });
    // The same breach with no failures forces, as before; so do unreached attempts (the box never took the run).
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(3) }), DAY_BERLIN))
      .toEqual({ run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' });
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(40), unreached: [miss('floor', DAY_BERLIN, 3)] }), DAY_BERLIN))
      .toEqual({ run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' });
    // Failures from before this breach's clock (an earlier floor, before the box went away) hold nothing.
    expect(autoUpdateDecision(session(DAY_BERLIN, { breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(3), failedFloorRuns: [run(31)] }), DAY_BERLIN))
      .toEqual({ run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' });
    // A raised floor is a new breach: no force clock, so idle as any new breach, and its force clock starts from scratch.
    expect(autoUpdateDecision(session(DAY_BERLIN, { floor: '2.1.320', breachSince: null, lastRunAt: run(3), failedFloorRuns: [run(3)] }), DAY_BERLIN))
      .toEqual({ run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' });
    expect(autoUpdateDecision(session(DAY_BERLIN, { floor: '2.1.320', breachSince: ago(DAY_BERLIN, 2), lastRunAt: run(3), failedFloorRuns: [run(3)] }), DAY_BERLIN + 23 * H))
      .toEqual({ run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' });
    // A tool that may not force, or has no sessions, gets plain below-floor as before.
    expect(autoUpdateDecision(session(DAY_BERLIN, { mayForce: false, breachSince: ago(DAY_BERLIN, 30), lastRunAt: run(3), failedFloorRuns: [run(3)] }), DAY_BERLIN))
      .toEqual({ run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' });
  });

  it('a simulated breach of a Claude Code floor that always fails, run for three days: never force; with no failures, force', () => {
    const start = Date.parse('2026-11-03T21:55:00Z');
    const restarts = (fails: boolean) => {
      const failed: Date[] = []; const out: string[] = []; let lastRun: Date | null = null;
      for (let t = start; t < start + 72 * H; t += 15 * 60_000) {
        const d = autoUpdateDecision(facts(t, { version: '2.1.290', breachSince: new Date(start), lastRunAt: lastRun, failedFloorRuns: failed }), t);
        if (!d.run) continue;
        lastRun = new Date(t); if (fails) failed.push(lastRun);
        out.push(d.restart);
      }
      return out;
    };
    const failing = restarts(true), clean = restarts(false);
    expect(failing.length).toBe(7);
    expect(failing.every(r => r === 'idle')).toBe(true);
    // No failures: idle for the first 24 h, force from then on, as before.
    expect(clean.slice(0, 24).every(r => r === 'idle')).toBe(true);
    expect(clean.slice(24).every(r => r === 'force')).toBe(true);
  });

  it('a simulated day of a floor run that always fails: 24 runs before, 5 after', () => {
    const start = Date.parse('2026-11-03T21:55:00Z');
    const simulate = (countFailures: boolean) => {
      const failed: Date[] = []; const log: string[] = []; let last: string | null = null;
      for (let t = start; t < start + 24 * H; t += 15 * 60_000) {
        const d = autoUpdateDecision(py(t, { breachSince: new Date(start), lastRunAt: failed.at(-1) ?? null, failedFloorRuns: countFailures ? failed : [] }), t);
        const at = new Date(t).toISOString().slice(11, 16);
        if (d.run) { failed.push(new Date(t)); log.push(`${at}  run floor (restart ${d.restart})  -> failed 3.13.16 -> 3.13.16`); last = null; }
        else if (d.skip !== last) { log.push(`${at}  skip ${d.skip}`); last = d.skip; }
      }
      return { runs: failed.length, log };
    };
    const before = simulate(false), after = simulate(true);
    expect(before.runs).toBe(24);
    // 21:55, then 1 h, 2 h, 4 h and 8 h later; the next, 16 h on, is past the day.
    expect(after.runs).toBe(5);
    if (process.env.FLOOR_BACKOFF_DEMO) {
      writeFileSync(process.env.FLOOR_BACKOFF_DEMO, [
        '# A day of failing floor runs, before and after', '',
        'Python on one box: the floor is 3.13.18, the box is on 3.13.16 and its installer can\'t get 3.13.18, so every floor run reaches the box and fails. The sweep decides every 15 minutes (UTC), from 21:55 on 2026-11-03; each line is a run that fired or a change of skip reason. Generated by `FLOOR_BACKOFF_DEMO=<file> npx vitest run src/services/toolUpdate/auto.test.ts -t "simulated day"` (backend/).', '',
        `## Before: held only an hour after each run (${before.runs} runs in 24 h)`, '', '```', ...before.log, '```', '',
        `## After: failed floor runs back off, 1 h, 2 h, 4 h, … up to a day (${after.runs} runs in 24 h)`, '', '```', ...after.log, '```', '',
      ].join('\n'));
    }
  });

  it('failedFloorRun: what counts as a floor run that left the box below the floor', () => {
    const row = (over: Partial<Parameters<typeof failedFloorRun>[0]>) => ({ requestedAt: run(2), startedAt: run(2), status: 'done', outcome: 'updated', fromVersion: '3.13.16', toVersion: '3.13.18', ...over });
    expect(failedFloorRun(row({ status: 'failed', outcome: 'failed', toVersion: '3.13.16' }), '3.13.18', false)).toBe(true);
    // Reported success, but still below the floor (the target resolved to something older).
    expect(failedFloorRun(row({ outcome: 'updated', toVersion: '3.13.17' }), '3.13.18', false)).toBe(true);
    expect(failedFloorRun(row({ outcome: 'current', toVersion: null, fromVersion: '3.13.16' }), '3.13.18', false)).toBe(true);
    expect(failedFloorRun(row({ outcome: 'partial', toVersion: '3.13.16' }), '3.13.18', false)).toBe(true);
    // Started and never reported, past its stale age.
    expect(failedFloorRun(row({ status: 'running', outcome: null, toVersion: null }), '3.13.18', false)).toBe(true);
    // Not failures: one that reached the floor, one still in flight, one that never reached the box.
    expect(failedFloorRun(row({}), '3.13.18', false)).toBe(false);
    expect(failedFloorRun(row({ status: 'running', outcome: null, toVersion: null }), '3.13.18', true)).toBe(false);
    expect(failedFloorRun(row({ startedAt: null, status: 'expired', outcome: null }), '3.13.18', false)).toBe(false);
  });
});

describe('nightlyClockStart', () => {
  const now = new Date(DAY_BERLIN);
  it('keeps the clock through an unbroken run of passes, and starts it again after a gap, as while the flag was off (Bugbot on #1163)', () => {
    expect(nightlyClockStart(null, now)).toEqual(now);
    expect(nightlyClockStart({ firstSeenAt: ago(DAY_BERLIN, 240), lastSeenAt: ago(DAY_BERLIN, 0.25) }, now)).toEqual(ago(DAY_BERLIN, 240));
    expect(nightlyClockStart({ firstSeenAt: ago(DAY_BERLIN, 240), lastSeenAt: ago(DAY_BERLIN, 48) }, now)).toEqual(now);
    expect(nightlyClockStart({ firstSeenAt: ago(DAY_BERLIN, 240), lastSeenAt: null }, now)).toEqual(now);
  });
});

describe('breachAfter', () => {
  const now = new Date(DAY_BERLIN);
  const since = ago(DAY_BERLIN, 30);
  const seen = ago(DAY_BERLIN, 0.25);
  const b = (over: Partial<{ floor: string; since: Date | null; seenAt: Date | null }> = {}) => ({ floor: '2.1.308', since, seenAt: seen, ...over });
  it('starts the force clock at the first floor run queued, keeps it under the same floor, and stamps the pass', () => {
    expect(breachAfter(null, '2.1.290', '2.1.308', 'other', now)).toEqual({ floor: '2.1.308', since: null, seenAt: now });
    expect(breachAfter(null, '2.1.290', '2.1.308', 'attempted', now)).toEqual({ floor: '2.1.308', since: now, seenAt: now });
    expect(breachAfter(b(), '2.1.300', '2.1.308', 'attempted', now)).toEqual(b({ seenAt: now }));
    expect(breachAfter(b(), '2.1.300', '2.1.308', 'other', now)).toEqual(b({ seenAt: now }));
  });

  it('restarts it while the box cannot take a run, so force needs a day of idle attempts in a row (Bugbot on #1163)', () => {
    expect(breachAfter(b(), '2.1.290', '2.1.308', 'unable', now)).toEqual({ floor: '2.1.308', since: null, seenAt: now });
  });

  it('restarts it after a gap of over an hour with no pass, as while the flag was off (Bugbot on #1163)', () => {
    const stale = b({ seenAt: ago(DAY_BERLIN, 1.5) });
    expect(breachAfter(stale, '2.1.290', '2.1.308', 'other', now)).toEqual({ floor: '2.1.308', since: null, seenAt: now });
    expect(breachAfter(stale, '2.1.290', '2.1.308', 'attempted', now)).toEqual({ floor: '2.1.308', since: now, seenAt: now });
    expect(liveBreachSince(stale, '2.1.308', DAY_BERLIN)).toBeNull();
    expect(liveBreachSince(b({ seenAt: null }), '2.1.308', DAY_BERLIN)).toBeNull();
    expect(liveBreachSince(b(), '2.1.308', DAY_BERLIN)).toEqual(since);
    expect(liveBreachSince(b(), '2.1.320', DAY_BERLIN)).toBeNull();
  });

  it('a raised floor is a new breach; at or above it, or unreadable, there is none', () => {
    expect(breachAfter(b(), '2.1.310', '2.1.320', 'other', now)).toEqual({ floor: '2.1.320', since: null, seenAt: now });
    expect(breachAfter(b(), '2.1.316', '2.1.308', 'other', now)).toBeNull();
    expect(breachAfter(b(), null, '2.1.308', 'attempted', now)).toBeNull();
  });
});

describe('priority and reasons', () => {
  it('sorts a forced floor run first and the plain nightly last', () => {
    const r = (['no-sessions', 'quiet', 'resumed', 'below-floor', 'never-quiet', 'below-floor-force-held', 'below-floor-force'] as const).map(reason => ({ reason }));
    expect([...r].sort(byPriority).map(x => x.reason)).toEqual(['below-floor-force', 'below-floor', 'below-floor-force-held', 'resumed', 'never-quiet', 'quiet', 'no-sessions']);
  });

  it('says why in words', () => {
    const f = { version: '2.1.290', floor: '2.1.308', breachSince: ago(DAY_BERLIN, 26), timeZone: 'Europe/Berlin' };
    expect(reasonText('below-floor-force', f, DAY_BERLIN)).toBe('2.1.290 has been below the floor 2.1.308 for 26 h: force');
    expect(reasonText('below-floor-force-held', f, DAY_BERLIN)).toBe('2.1.290 has been below the floor 2.1.308 for 26 h; force held: its floor runs are failing');
    expect(reasonText('quiet', f, DAY_BERLIN)).toBe("quiet for an hour, the owner's night (Europe/Berlin)");
    expect(reasonText('quiet', { ...f, timeZone: null }, DAY_BERLIN)).toMatch(/no time zone/);
    expect(reasonText('resumed', f, DAY_BERLIN)).toBe('resumed from hibernation: installs only, sessions pick it up when they next start');
  });
});

describe('the nightly schedule (tool-auto-update-schedule)', () => {
  const test1517: NightlySchedule = parseNightlySchedule({ nightFromHour: 15, nightToHour: 17, everyHours: 2, quietMinutes: 10 });
  // 2026-11-02 in Berlin (CET, UTC+1): local hour h is UTC h-1.
  const berlin = (h: number, m = 0) => Date.parse(`2026-11-02T${String(h - 1).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

  it('falls back to exactly today\'s values: flag off, missing, malformed', () => {
    expect(DEFAULT_NIGHTLY_SCHEDULE).toEqual({ nightFromHour: NIGHT_FROM_HOUR, nightToHour: NIGHT_TO_HOUR, everyMs: NIGHTLY_EVERY_MS, quietMs: QUIET_AFTER_MS });
    expect(DEFAULT_NIGHTLY_SCHEDULE).toEqual({ nightFromHour: 0, nightToHour: 6, everyMs: 24 * H, quietMs: H });
    for (const v of [null, undefined, false, true, 0, 'x', [], [1, 2], {}, { unknown: 1 }]) expect(parseNightlySchedule(v)).toEqual(DEFAULT_NIGHTLY_SCHEDULE);
  });

  it('with the fallback schedule, every decision of a day is today\'s, box by box and hour by hour', () => {
    const variants: Array<Partial<AutoFacts>> = [
      {}, { lastActivityAt: ago(NIGHT_BERLIN, 0.5) }, { lastActivityAt: null }, { timeZone: null }, { timeZone: 'America/New_York' },
      { sessionless: true }, { lastRunAt: ago(NIGHT_BERLIN, 23) }, { lastRunAt: ago(NIGHT_BERLIN, 50), lastActivityAt: ago(NIGHT_BERLIN, 0) },
      { restartsAgent: true, timeZone: null, lastRunAt: ago(NIGHT_BERLIN, 50), lastActivityAt: ago(NIGHT_BERLIN, 0) },
      { version: '2.1.290' }, { version: '2.1.290', breachSince: ago(NIGHT_BERLIN, 30) }, { resumed: true },
      { unreached: [miss('nightly', NIGHT_BERLIN, 0.5)] },
    ];
    const start = Date.parse('2026-11-01T23:00:00Z');
    for (let t = start; t < start + 24 * H; t += 15 * 60_000) {
      for (const v of variants) {
        // The facts are pinned to NIGHT_BERLIN's clock; only `now` moves.
        const base = facts(NIGHT_BERLIN, v);
        const today = autoUpdateDecision(base, t);
        expect(autoUpdateDecision({ ...base, schedule: parseNightlySchedule(null) }, t)).toEqual(today);
        expect(autoUpdateDecision({ ...base, schedule: parseNightlySchedule({ nightFromHour: 'x', everyHours: 0.5, quietMinutes: 5 }) }, t)).toEqual(today);
        expect(reasonText('quiet', { ...base, schedule: DEFAULT_NIGHTLY_SCHEDULE }, t)).toBe(reasonText('quiet', base, t));
      }
    }
  });

  it('takes each valid field, and keeps the default for each invalid one', () => {
    expect(test1517).toEqual({ nightFromHour: 15, nightToHour: 17, everyMs: 2 * H, quietMs: 10 * 60_000 });
    expect(parseNightlySchedule({ nightFromHour: 22, nightToHour: 4 })).toEqual({ ...DEFAULT_NIGHTLY_SCHEDULE, nightFromHour: 22, nightToHour: 4 });
    expect(parseNightlySchedule({ nightFromHour: 3 })).toEqual({ ...DEFAULT_NIGHTLY_SCHEDULE, nightFromHour: 3 });
    // Start equal to end is no window: the default one, whichever side filled it in.
    expect(parseNightlySchedule({ nightFromHour: 15, nightToHour: 15, everyHours: 2 })).toEqual({ ...DEFAULT_NIGHTLY_SCHEDULE, everyMs: 2 * H });
    expect(parseNightlySchedule({ nightFromHour: 6 })).toEqual(DEFAULT_NIGHTLY_SCHEDULE);
    // Out of range, not whole, not numbers.
    expect(parseNightlySchedule({ nightFromHour: 24, nightToHour: -1, everyHours: 0.5, quietMinutes: 9 })).toEqual(DEFAULT_NIGHTLY_SCHEDULE);
    expect(parseNightlySchedule({ nightFromHour: 15.5, nightToHour: '17', everyHours: '2', quietMinutes: Number.NaN })).toEqual(DEFAULT_NIGHTLY_SCHEDULE);
    expect(parseNightlySchedule({ everyHours: 169, quietMinutes: 1441 })).toEqual(DEFAULT_NIGHTLY_SCHEDULE);
    expect(parseNightlySchedule({ everyHours: 1, quietMinutes: 10 })).toEqual({ ...DEFAULT_NIGHTLY_SCHEDULE, everyMs: H, quietMs: 10 * 60_000 });
  });

  it('a window may wrap past midnight', () => {
    expect([21, 22, 23, 0, 3, 4, 5, 12].map(h => inWindow(h, 22, 4))).toEqual([false, true, true, true, true, false, false, false]);
    expect([14, 15, 16, 17].map(h => inWindow(h, 15, 17))).toEqual([false, true, true, false]);
    const wrap = parseNightlySchedule({ nightFromHour: 22, nightToHour: 4 });
    expect(isNight(berlin(23), 'Europe/Berlin', wrap)).toBe(true);
    expect(isNight(Date.parse('2026-11-02T02:30:00Z'), 'Europe/Berlin', wrap)).toBe(true); // 03:30
    expect(isNight(Date.parse('2026-11-02T03:00:00Z'), 'Europe/Berlin', wrap)).toBe(false); // 04:00
    expect(isNight(berlin(21, 59), 'Europe/Berlin', wrap)).toBe(false);
    expect(autoUpdateDecision(facts(berlin(23), { schedule: wrap }), berlin(23))).toEqual({ run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' });
    // 05:00 is the default night, not this one's.
    const five = Date.parse('2026-11-02T04:00:00Z');
    expect(autoUpdateDecision(facts(five, { schedule: wrap }), five)).toEqual({ run: false, skip: 'not-quiet' });
  });

  it('a daytime test window makes a quiet box run, with the window in its reason', () => {
    const at = berlin(15, 30);
    expect(autoUpdateDecision(facts(at), at)).toEqual({ run: false, skip: 'not-quiet' });
    expect(autoUpdateDecision(facts(at, { schedule: test1517 }), at)).toEqual({ run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' });
    // The quiet time moves too: active 20 min ago is quiet under 10 min, not under the hour.
    expect(autoUpdateDecision(facts(at, { schedule: test1517, lastActivityAt: ago(at, 20 / 60) }), at)).toMatchObject({ run: true, reason: 'quiet' });
    // (Ran 3 h ago, so due, but not for 24 h: no never-quiet fallback.)
    expect(autoUpdateDecision(facts(at, { schedule: test1517, lastRunAt: ago(at, 3), lastActivityAt: ago(at, 5 / 60) }), at)).toEqual({ run: false, skip: 'not-quiet' });
    expect(isQuiet(at, ago(at, 20 / 60))).toBe(false);
    // Outside the window: not yet, and no more.
    expect(autoUpdateDecision(facts(berlin(14, 45), { schedule: test1517 }), berlin(14, 45))).toEqual({ run: false, skip: 'not-quiet' });
    expect(autoUpdateDecision(facts(berlin(17), { schedule: test1517 }), berlin(17))).toEqual({ run: false, skip: 'not-quiet' });
    const f = { version: '2.1.316', floor: '2.1.308', breachSince: null, timeZone: 'Europe/Berlin', schedule: test1517 };
    expect(reasonText('quiet', f, at)).toBe("quiet for 10 min, the owner's test window 15–17 (Europe/Berlin); test interval 2 h");
    expect(reasonText('quiet', { ...f, schedule: parseNightlySchedule({ nightFromHour: 15, nightToHour: 17 }) }, at)).toBe("quiet for an hour, the owner's test window 15–17 (Europe/Berlin)");
    expect(reasonText('quiet', { ...f, schedule: parseNightlySchedule({ quietMinutes: 10 }) }, at)).toBe("quiet for 10 min, the owner's night (Europe/Berlin)");
    expect(reasonText('quiet', { ...f, timeZone: null }, at)).toBe('quiet for 10 min (no time zone for the owner); test interval 2 h');
    expect(reasonText('never-quiet', f, at)).toBe("due for 24 h and never quiet: in the owner's test window 15–17 (Europe/Berlin), installs only; test interval 2 h");
    expect(reasonText('no-sessions', f, at)).toBe('due, and it runs in no session, so no quiet window to wait for; test interval 2 h');
  });

  it('the never-quiet fallback keeps the test window', () => {
    const at = berlin(16);
    const busy = { lastRunAt: ago(at, 50), lastActivityAt: ago(at, 0), schedule: test1517 };
    expect(autoUpdateDecision(facts(at, busy), at)).toEqual({ run: true, trigger: 'nightly', restart: 'none', reason: 'never-quiet' });
    expect(autoUpdateDecision(facts(berlin(18), busy), berlin(18))).toEqual({ run: false, skip: 'not-quiet' });
  });

  it('a shortened interval makes a box due sooner, session tools and sessionless ones alike', () => {
    const at = berlin(15, 30);
    const ran3h = { lastRunAt: ago(at, 3) };
    expect(nightlyDueAt({ ...ran3h, firstSeenAt: ago(at, 100), schedule: test1517 })).toBe(at - H);
    expect(autoUpdateDecision(facts(at, { ...ran3h, schedule: test1517 }), at)).toMatchObject({ run: true, reason: 'quiet' });
    expect(autoUpdateDecision(facts(at, { ...ran3h, schedule: parseNightlySchedule({ nightFromHour: 15, nightToHour: 17 }) }), at)).toEqual({ run: false, skip: 'ran-recently' });
    expect(autoUpdateDecision(facts(at, { ...ran3h, sessionless: true }), at)).toEqual({ run: false, skip: 'ran-recently' });
    expect(autoUpdateDecision(facts(at, { ...ran3h, sessionless: true, schedule: parseNightlySchedule({ everyHours: 2 }) }), at)).toEqual({ run: true, trigger: 'nightly', restart: 'none', reason: 'no-sessions' });
    // Never before the sweep first saw the box.
    expect(nightlyDueAt({ lastRunAt: ago(at, 3), firstSeenAt: ago(at, 0.5), schedule: test1517 })).toBe(at - 0.5 * H);
  });

  it('leaves floor runs, the force clock, resume runs and the backoffs alone', () => {
    const tight = parseNightlySchedule({ nightFromHour: 15, nightToHour: 17, everyHours: 1, quietMinutes: 10 });
    const same = (at: number, over: Partial<AutoFacts>) => expect(autoUpdateDecision(facts(at, { ...over, schedule: tight }), at)).toEqual(autoUpdateDecision(facts(at, over), at));
    for (const at of [berlin(9), berlin(15, 30), NIGHT_BERLIN]) {
      same(at, { version: '2.1.290' });
      same(at, { version: '2.1.290', breachSince: ago(at, 23) });
      same(at, { version: '2.1.290', breachSince: ago(at, 24) });
      // #1297's force hold: 30 h into a breach whose floor run failed 3 h ago stays idle, below-floor-force-held, under any schedule.
      same(at, { version: '2.1.290', breachSince: ago(at, 30), lastRunAt: ago(at, 3), failedFloorRuns: [ago(at, 3)] });
      same(at, { version: '2.1.290', lastRunAt: ago(at, 0.5) });
      same(at, { version: '2.1.290', breachSince: ago(at, 5), lastRunAt: ago(at, 1.5), failedFloorRuns: [ago(at, 3), ago(at, 1.5)] });
      same(at, { version: '2.1.290', breachSince: ago(at, 5), unreached: [miss('floor', at, 0.5)] });
      same(at, { resumed: true, lastRunAt: ago(at, 2), lastActivityAt: ago(at, 0) });
      same(at, { resumed: true, resumedAt: ago(at, 2), lastRunAt: ago(at, 3), unreached: [miss('resume', at, 0.5)] });
    }
    expect(autoUpdateDecision(facts(berlin(15, 30), { version: '2.1.290', breachSince: ago(berlin(15, 30), 30), lastRunAt: ago(berlin(15, 30), 3), failedFloorRuns: [ago(berlin(15, 30), 3)], schedule: tight }), berlin(15, 30))).toEqual({ run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor-force-held' });
    // A forced floor run is forced at 15:30 either way; the window does not make it nightly.
    expect(autoUpdateDecision(facts(berlin(15, 30), { version: '2.1.290', breachSince: ago(berlin(15, 30), 30), schedule: tight }), berlin(15, 30))).toEqual({ run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' });
    // The nightly backoff after an unreached nightly run is the same hour whatever the interval.
    const at = berlin(15, 30);
    expect(autoUpdateDecision(facts(at, { schedule: tight, unreached: [miss('nightly', at, 0.5)] }), at)).toEqual({ run: false, skip: 'backing-off' });
  });
});
