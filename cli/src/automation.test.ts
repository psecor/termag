import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { scheduleFrom } from './automation.js';
import { parseCommandLine } from './args.js';
import { helpText } from './args.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

let home: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];
let questions: string[];

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host },
    home,
    hostname: 'zane-mbp.local',
    interactive: true,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: (url) => { void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 5000,
    confirm: async (q) => { questions.push(q); return true; },
    ...overrides,
  };
}

const stdout = () => out.join('\n');
const stderr = () => err.join('\n');
const lastJson = () => JSON.parse(out.at(-1)!);
const calls = () => orch.automations.calls.map(c => c.route);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-automation-'));
  orch = await startFakeOrchestrator();
  questions = [];
  out = [];
  err = [];
  expect(await run(['login'], ctx())).toBe(0);
  out = [];
  err = [];
});

afterEach(async () => {
  await orch.close();
  rmSync(home, { recursive: true, force: true });
});

describe('scheduleFrom', () => {
  it('turns --every into cron, for intervals that divide an hour or a day', () => {
    expect(scheduleFrom({ every: '15m' })).toBe('*/15 * * * *');
    expect(scheduleFrom({ every: '30min' })).toBe('*/30 * * * *');
    expect(scheduleFrom({ every: '60m' })).toBe('0 * * * *');
    expect(scheduleFrom({ every: '1h' })).toBe('0 * * * *');
    expect(scheduleFrom({ every: '6h' })).toBe('0 */6 * * *');
    expect(scheduleFrom({ every: '24h' })).toBe('0 0 * * *');
    expect(scheduleFrom({ every: '1d' })).toBe('0 0 * * *');
    expect(scheduleFrom({ every: '1d', at: '07:30' })).toBe('30 7 * * *');
    expect(scheduleFrom({ every: '1w', at: '9:05' })).toBe('5 9 * * 1');
  });

  it('takes a time of day alone as daily, and --weekdays as Monday to Friday', () => {
    expect(scheduleFrom({ at: '07:00' })).toBe('0 7 * * *');
    expect(scheduleFrom({ at: '23:59', weekdays: true })).toBe('59 23 * * 1-5');
  });

  it('passes --cron through and leaves the minimum interval to the orchestrator', () => {
    expect(scheduleFrom({ cron: ' 0 7 * * 1-5 ' })).toBe('0 7 * * 1-5');
    expect(scheduleFrom({ every: '5m' })).toBe('*/5 * * * *');
    expect(scheduleFrom({})).toBeNull();
  });

  it('refuses what it cannot say evenly, and contradictions', () => {
    for (const bad of [
      { every: '45m' }, { every: '7h' }, { every: '2d' }, { every: 'hourly' }, { every: '1h', at: '07:00' },
      { at: '7am' }, { at: '24:00' }, { weekdays: true }, { every: '1d', weekdays: true }, { cron: '0 * * * *', every: '1h' }, { cron: ' ' },
    ]) {
      expect(() => scheduleFrom(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('the command line', () => {
  it('knows the group, its aliases and its options', () => {
    expect(parseCommandLine(['automation', 'ls'])).toMatchObject({ command: 'automation list' });
    expect(parseCommandLine(['automation', 'new', 'devbox/x', '--every', '15m', '-'])).toMatchObject({ command: 'automation create', args: ['devbox/x', '-'], options: { every: '15m' } });
    expect(parseCommandLine(['automation', 'delete', 'x', '--yes'])).toMatchObject({ command: 'automation rm', yes: true });
    expect(() => parseCommandLine(['automation', 'run', 'x', '--every', '1h'])).toThrow(/not an option/);
  });

  it('`termag automation` alone names the subcommands', async () => {
    expect(await run(['automation'], ctx())).toBe(2);
    expect(stderr()).toContain('list, create, show, edit, pause, resume, run, stop, rm');
  });
});

describe('termag automation create', () => {
  it('reads the prompt from stdin and sends the schedule, box and settings', async () => {
    const code = await run(
      ['automation', 'create', 'devbox/babysit', '--every', '15m', '--tz', 'America/New_York', '--tier', 'read', '--no-pr', '--max-minutes', '30', '-'],
      ctx({ readStdin: async () => 'Babysit the open PRs.\n' }),
    );
    expect(code).toBe(0);
    expect(orch.automations.calls).toEqual([{
      route: 'POST /automations',
      body: {
        name: 'babysit', instanceId: 'i1', schedule: '*/15 * * * *', timezone: 'America/New_York', prompt: 'Babysit the open PRs.\n',
        tier: 'read', prOnChange: false, maxRunMinutes: 30,
      },
    }]);
    expect(stdout()).toContain('Created automation devbox/babysit (babysit): */15 * * * * America/New_York, read tier.');
    expect(stdout()).toContain('Next runs: 2026-10-27 13:00 UTC');
  });

  it('sends --from and --paused, and prints JSON', async () => {
    expect(await run(['automation', 'create', 'devbox/n', '--at', '07:00', '--weekdays', '--tz', 'UTC', '--from', 'devbox/webapp-fix', '--paused', '--json', 'do it'], ctx())).toBe(0);
    expect(orch.automations.calls[0].body).toMatchObject({ schedule: '0 7 * * 1-5', from: 'devbox/webapp-fix', enabled: false, prompt: 'do it' });
    expect(lastJson()).toMatchObject({ ref: 'devbox/n', project: { id: 'p-n', name: 'n' }, automation: { enabled: false } });
  });

  it('--preview shows the next runs and creates nothing', async () => {
    expect(await run(['automation', 'create', 'devbox/n', '--every', '15m', '--tz', 'UTC', '--preview'], ctx())).toBe(0);
    expect(calls()).toEqual(['POST /automations/preview']);
    expect(stdout()).toBe('Schedule: */15 * * * * (UTC), at least 15 min apart\nNext runs: 2026-10-27 12:15 UTC, 2026-10-27 12:30 UTC, 2026-10-27 12:45 UTC');
  });

  it('--preview of a schedule below the minimum says create would refuse it (exit 2)', async () => {
    expect(await run(['automation', 'create', 'devbox/n', '--every', '5m', '--tz', 'UTC', '--preview'], ctx())).toBe(2);
    expect(stderr()).toBe('termag: create would refuse this schedule: it runs every 5 minutes; the minimum is 15');
  });

  it("passes the orchestrator's refusal through with its exit code", async () => {
    orch.automations.refuse = { status: 400, error: 'schedule runs every 5 minutes; the minimum is 15' };
    expect(await run(['automation', 'create', 'devbox/n', '--every', '5m', 'x'], ctx())).toBe(2);
    expect(stderr()).toBe('termag: schedule runs every 5 minutes; the minimum is 15');
    orch.automations.refuse = { status: 403, error: 'Automations are not enabled for you on this box', code: 'automations_disabled' };
    expect(await run(['automation', 'create', 'devbox/n', '--every', '1h', 'x', '--json'], ctx())).toBe(1);
    expect(JSON.parse(err.at(-1)!)).toEqual({ error: { code: 'forbidden', message: 'Automations are not enabled for you on this box' } });
  });

  it('needs a schedule, a prompt and a known box', async () => {
    expect(await run(['automation', 'create', 'devbox/n', 'x'], ctx())).toBe(2);
    expect(stderr()).toContain('An automation needs a schedule');
    expect(await run(['automation', 'create', 'devbox/n', '--every', '1h'], ctx())).toBe(2);
    expect(stderr()).toContain('Missing the prompt');
    expect(await run(['automation', 'create', 'devbox/n', '--every', '1h', '-'], ctx({ readStdin: async () => ' \n' }))).toBe(2);
    expect(await run(['automation', 'create', 'nobox/n', '--every', '1h', 'x'], ctx())).toBe(3);
    expect(await run(['automation', 'create', 'n', '--every', '1h', 'x'], ctx())).toBe(2);
    expect(calls()).toEqual([]);
  });
});

describe('termag automation list and show', () => {
  it('lists with box/name, schedule, state and next run', async () => {
    orch.automations.automations[0].pausedReason = 'consecutive_failures';
    expect(await run(['automation', 'list'], ctx())).toBe(0);
    expect(stdout()).toMatch(/^AUTOMATION\s+ID\s+SCHEDULE\s+STATE\s+NEXT\s+LAST RUN\s+SPACE$/m);
    expect(stdout()).toMatch(/^devbox\/nightly\s+nightly\s+0 \* \* \* \* UTC\s+paused: consecutive failures\s+2026-10-27 13:00 UTC\s+-\s+-$/m);
    expect(stdout()).toContain('old box/elsewhere');
  });

  it('filters by box and by box/name', async () => {
    expect(await run(['automation', 'list', 'devbox', '--json'], ctx())).toBe(0);
    expect(lastJson().automations.map((a: { ref: string }) => a.ref)).toEqual(['devbox/nightly']);
    expect(await run(['automation', 'list', 'devbox/nope'], ctx())).toBe(0);
    expect(out.at(-1)).toBe('No automations match devbox/nope.');
  });

  it('shows the schedule, next runs and the last runs with their state', async () => {
    expect(await run(['automation', 'show', 'devbox/nightly'], ctx())).toBe(0);
    const text = stdout();
    expect(text).toContain('devbox/nightly (nightly)');
    expect(text).toMatch(/^Schedule:\s+0 \* \* \* \* \(UTC\)$/m);
    expect(text).toMatch(/^Next runs:\s+2026-10-27 13:00 UTC, 2026-10-27 14:00 UTC, 2026-10-27 15:00 UTC$/m);
    expect(text).toMatch(/^Prompt:\s+Triage new issues\. Be brief\.$/m);
    expect(text).toMatch(/^Web:\s+http:\/\/127\.0\.0\.1:\d+\/termag\/automations\/p-nightly$/m);
    expect(text).toMatch(/^r2\s+schedule\s+2026-10-27 12:00 UTC\s+running\s+4m00s\s+-$/m);
    expect(text).toMatch(/^r1\s+schedule\s+2026-10-27 12:00 UTC\s+done\s+4m00s\s+https:\/\/github\.com\/example\/repo\/pull\/7$/m);
  });

  it('says when its box could not be started, and how often since when', async () => {
    orch.automations.automations[0].boxStartFailures = { count: 6, since: '2026-10-30T00:00:30.000Z', lastError: 'Insufficient capacity.' };
    expect(await run(['automation', 'show', 'devbox/nightly'], ctx())).toBe(0);
    expect(stdout()).toMatch(/^Box:\s+couldn't start its box 6 times since 2026-10-30 00:00 UTC \(Insufficient capacity\.\)$/m);
  });

  it('takes an id as well, and 404 is exit 3', async () => {
    expect(await run(['automation', 'show', 'nightly', '--json', '--runs', '1'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ ref: 'devbox/nightly', id: 'nightly', runs: [{ id: 'r2' }] });
    expect(await run(['automation', 'show', 'missing'], ctx())).toBe(3);
    expect(await run(['automation', 'show', 'devbox/missing'], ctx())).toBe(3);
    expect(stderr()).toContain('No automation "missing" on devbox');
  });
});

describe('termag automation edit, pause and resume', () => {
  it('edits the schedule and the prompt from stdin', async () => {
    expect(await run(['automation', 'edit', 'devbox/nightly', '--every', '30m', '--prompt', '-'], ctx({ readStdin: async () => 'new prompt' }))).toBe(0);
    expect(orch.automations.calls).toEqual([{ route: 'PATCH /automations/nightly', body: { schedule: '*/30 * * * *', prompt: 'new prompt' } }]);
    expect(stdout()).toContain('Updated devbox/nightly: */30 * * * * UTC, enabled.');
  });

  it('--name renames the project the automation is', async () => {
    expect(await run(['automation', 'edit', 'devbox/nightly', '--name', 'hourly'], ctx())).toBe(0);
    expect(calls()).toEqual(['POST /projects/p-nightly/rename']);
    expect(stdout()).toContain('Updated devbox/hourly (was devbox/nightly)');
  });

  it('refuses an edit with nothing to change', async () => {
    expect(await run(['automation', 'edit', 'devbox/nightly'], ctx())).toBe(2);
    expect(await run(['automation', 'edit', 'devbox/nightly', '--pr', '--no-pr'], ctx())).toBe(2);
    expect(calls()).toEqual([]);
  });

  it('pause and resume are the Enabled switch', async () => {
    expect(await run(['automation', 'pause', 'devbox/nightly'], ctx())).toBe(0);
    expect(stdout()).toBe('Paused devbox/nightly; `termag automation resume devbox/nightly` turns it back on.');
    expect(await run(['automation', 'resume', 'devbox/nightly'], ctx())).toBe(0);
    expect(out.at(-1)).toBe('Resumed devbox/nightly. Next run 2026-10-27 13:00 UTC.');
    expect(orch.automations.calls.map(c => c.body)).toEqual([{ enabled: false }, { enabled: true }]);
  });
});

describe('termag automation run, stop and rm', () => {
  it('runs now and says how to follow and stop it', async () => {
    expect(await run(['automation', 'run', 'devbox/nightly'], ctx())).toBe(0);
    expect(stdout()).toBe('Started run r3 of devbox/nightly in run-20261027-1200-manual.\n'
      + 'Follow it with `termag automation show devbox/nightly`; stop it with `termag automation stop devbox/nightly r3`.');
  });

  it('a skipped run is a conflict (exit 1) with the reason', async () => {
    orch.automations.refuse = { status: 409, error: 'The run was skipped: the previous run is still going', code: 'run_skipped' };
    expect(await run(['automation', 'run', 'nightly'], ctx())).toBe(1);
    expect(stderr()).toBe('termag: The run was skipped: the previous run is still going');
  });

  it('stops a live run, and a finished one is a conflict', async () => {
    expect(await run(['automation', 'stop', 'devbox/nightly', 'r2'], ctx())).toBe(0);
    expect(stdout()).toBe('Stopped run r2 of devbox/nightly.');
    expect(await run(['automation', 'stop', 'devbox/nightly', 'r1'], ctx())).toBe(1);
    expect(stderr()).toBe('termag: This run is not live');
    expect(await run(['automation', 'stop', 'devbox/nightly'], ctx())).toBe(2);
  });

  it('rm asks first, and needs --yes with no terminal', async () => {
    expect(await run(['automation', 'rm', 'devbox/nightly'], ctx({ interactive: false }))).toBe(2);
    expect(stderr()).toContain('pass --yes');
    expect(calls()).toEqual([]);
    expect(await run(['automation', 'rm', 'devbox/nightly'], ctx())).toBe(0);
    expect(questions).toEqual(['Delete automation devbox/nightly (its project is archived, and no more runs start)? [y/N] ']);
    expect(stdout()).toBe('Deleted automation devbox/nightly.');
    expect(orch.automations.automations.map(a => a.id)).toEqual(['elsewhere']);
  });
});

describe("on a box, with the box's own credentials", () => {
  let boxHome: string;
  beforeEach(() => {
    boxHome = join(home, 'box-home');
    orch.boxTokens.add('tmag_box');
    const dir = join(boxHome, 'src', 'termag', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: orch.host.replace(/^http/, 'ws') + '/ws/agent', token: 'tmag_box' }));
  });

  it("creates on its box and sees only that box's automations", async () => {
    const onBox = ctx({ env: {}, home: boxHome, interactive: false, readStdin: async () => 'babysit' });
    expect(await run(['automation', 'create', 'devbox/babysit', '--every', '15m', '--tz', 'UTC', '-'], onBox)).toBe(0);
    expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
    expect(await run(['automation', 'list', '--json'], onBox)).toBe(0);
    expect(lastJson().automations.map((a: { ref: string }) => a.ref)).toEqual(['devbox/nightly', 'devbox/babysit']);
    expect(await run(['automation', 'show', 'elsewhere'], onBox)).toBe(3);
  });
});

describe('automations in a space', () => {
  it('create --space sends spaceName only; the server fixes the folder at .termag/automations/<id>', async () => {
    expect(await run(['automation', 'create', 'devbox/digest', '--every', '1h', '--tz', 'UTC', '--space', 'team-notes', 'x'], ctx())).toBe(0);
    expect(orch.automations.calls[0].body).toMatchObject({ spaceName: 'team-notes' });
    expect(orch.automations.calls[0].body).not.toHaveProperty('spaceFolder');
    expect(stdout()).toContain('Its files live in team-notes:.termag/automations/digest/');
  });

  it('has no --space-folder any more, on create or edit', () => {
    expect(() => parseCommandLine(['automation', 'create', 'devbox/d', '--every', '1h', '--space', 't', '--space-folder', 'jobs/d', 'x'])).toThrow(/Unknown option '--space-folder'/);
    expect(() => parseCommandLine(['automation', 'edit', 'devbox/d', '--space-folder', 'jobs/d'])).toThrow(/Unknown option '--space-folder'/);
    expect(() => parseCommandLine(['automation', 'create', 'devbox/d', '--every', '1h', '--no-space', 'x'])).toThrow(/not an option/);
  });

  it('refuses a malformed space name before calling', async () => {
    expect(await run(['automation', 'create', 'devbox/d', '--every', '1h', '--space', 'Team Notes', 'x'], ctx())).toBe(2);
    expect(stderr()).toContain('--space takes a space\'s name');
    expect(calls()).toEqual([]);
  });

  it('says what to do about the space refusals, with exit codes by what they are', async () => {
    const cases: Array<[string, number, string, number, string]> = [
      ['space_forbidden', 400, 'You can only mirror notes to a space you can write to (editor or owner)', 1,
        'termag: You can\'t write to space "team-notes": an automation needs editor or owner there. An owner can make you an editor with `termag space members team-notes add <your email> editor`.'],
      ['space_read_only', 400, 'That space is read-only', 1, 'termag: Space "team-notes" is read-only, so an automation can\'t keep its files there. Pick another space.'],
      ['space_not_found', 400, 'No such space that you are a member of', 3, 'termag: No space "team-notes" that you are a member of. `termag space ls` lists yours.'],
      ['spaces_off', 400, 'Spaces are not enabled for you', 1, 'termag: Spaces are not enabled for you, so an automation can\'t live in one. Leave out --space.'],
    ];
    for (const [code, status, error, exit, said] of cases) {
      orch.automations.refuse = { status, error, code };
      expect(await run(['automation', 'create', 'devbox/d', '--every', '1h', '--space', 'team-notes', 'x'], ctx()), code).toBe(exit);
      expect(err.at(-1), code).toBe(said);
    }
    orch.automations.refuse = { status: 400, error: 'You can only mirror notes to a space you can write to (editor or owner)', code: 'space_forbidden' };
    expect(await run(['automation', 'edit', 'devbox/nightly', '--space', 'ops'], ctx())).toBe(1);
    expect(err.at(-1)).toContain('You can\'t write to space "ops"');
  });

  it('edit --space attaches it, in its fixed folder', async () => {
    expect(await run(['automation', 'edit', 'devbox/nightly', '--space', 'team-notes'], ctx())).toBe(0);
    expect(orch.automations.calls).toEqual([{ route: 'PATCH /automations/nightly', body: { spaceName: 'team-notes' } }]);
    expect(stdout()).toContain('Its files live in team-notes:.termag/automations/nightly/');
  });

  it('edit --space to another space says the old files stay, and how to copy them', async () => {
    Object.assign(orch.automations.automations[0], { spaceName: 'team-notes', spaceFolder: '.termag/automations/nightly' });
    expect(await run(['automation', 'edit', 'devbox/nightly', '--space', 'ops'], ctx())).toBe(0);
    expect(stdout()).toContain('Its files now live in ops:.termag/automations/nightly/.\n'
      + 'The files in team-notes:.termag/automations/nightly/ stay there: the orchestrator does not copy them. To bring them along:\n'
      + '  termag space get -r team-notes:.termag/automations/nightly/ <dir> && termag space put -r <dir> ops:.termag/automations/nightly/');
  });

  it('edit --space with the space it has says so', async () => {
    Object.assign(orch.automations.automations[0], { spaceName: 'team-notes', spaceFolder: '.termag/automations/nightly' });
    expect(await run(['automation', 'edit', 'devbox/nightly', '--space', 'team-notes'], ctx())).toBe(0);
    expect(out.at(-1)).toBe('Space: team-notes:.termag/automations/nightly/ (unchanged)');
  });

  it('edit --no-space detaches it; the files stay', async () => {
    Object.assign(orch.automations.automations[0], { spaceName: 'team-notes', spaceFolder: '.termag/automations/nightly' });
    expect(await run(['automation', 'edit', 'devbox/nightly', '--no-space'], ctx())).toBe(0);
    expect(orch.automations.calls[0].body).toEqual({ spaceName: null });
    expect(stdout()).toContain('Detached from team-notes. Its files stay in team-notes:.termag/automations/nightly/.');
    expect(await run(['automation', 'edit', 'devbox/nightly', '--no-space', '--space', 'ops'], ctx())).toBe(2);
  });

  it('show and list print the space and folder', async () => {
    Object.assign(orch.automations.automations[0], { spaceName: 'team-notes', spaceFolder: '.termag/automations/nightly' });
    expect(await run(['automation', 'show', 'devbox/nightly'], ctx())).toBe(0);
    expect(stdout()).toMatch(/^Space:\s+team-notes:\.termag\/automations\/nightly\/$/m);
    out = [];
    expect(await run(['automation', 'list'], ctx())).toBe(0);
    expect(stdout()).toMatch(/^devbox\/nightly\s.*\steam-notes:\.termag\/automations\/nightly\/$/m);
    expect(stdout()).toMatch(/^old box\/elsewhere\s.*\s-$/m);
    expect(await run(['automation', 'list', '--json'], ctx())).toBe(0);
    expect(lastJson().automations[0]).toMatchObject({ spaceName: 'team-notes', spaceFolder: '.termag/automations/nightly' });
    out = [];
    expect(await run(['automation', 'show', 'elsewhere'], ctx())).toBe(0);
    expect(stdout()).toMatch(/^Space:\s+-$/m);
  });

  it('the help names the fixed folder and says its files need automation-space-folder-enabled', () => {
    for (const cmd of ['automation create', 'automation edit']) {
      expect(helpText(cmd)).toContain('<space>:.termag/automations/<automation id>/');
      expect(helpText(cmd)).toContain('only while\nautomation-space-folder-enabled is on for the owner');
      expect(helpText(cmd)).toContain('only the notes file\n(memory/MEMORY.md) is mirrored');
      expect(helpText(cmd)).not.toContain('--space-folder');
    }
    expect(helpText('automation edit')).toContain('--no-space detaches it');
  });
});
