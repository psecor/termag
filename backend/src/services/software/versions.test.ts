import { describe, it, expect } from 'vitest';
import { behindReference, compareToReference } from '../toolUpdate/fleet';
import { fleetNewest } from './queries';
import { termagReference, parseVersion, compareVersions, newestVersion, toolState, commitState, hooksFromDetail, hooksState, clientFromHeaders, desktopFromUserAgent, sortComponents, clientReference, clientState, isCleanBuild, kernelTrack, kernelGroup, kernelReferences, kernelState, kernelReferenceText, rebootState, rebootPendingSince, SOFTWARE_STATES, type KernelSighting } from './versions';

describe('parseVersion and compareVersions', () => {
  it('reads semver, date-hash, three-thousand-series and two-part versions', () => {
    expect(parseVersion('2.1.300')).toEqual([2, 1, 300]);
    expect(parseVersion('v24.21.0')).toEqual([24, 21, 0]);
    expect(parseVersion('2026.10.01-e373342')).toEqual([2026, 10, 1]);
    expect(parseVersion('3000.11.92')).toEqual([3000, 11, 92]);
    expect(parseVersion('3.5a')).toEqual([3, 5]);
    expect(parseVersion('7.0.0-1013-aws')).toEqual([7, 0, 0, 1013]);
    expect(parseVersion('beta')).toBeNull();
  });
  it('orders numerically, not as text', () => {
    expect(compareVersions('2.1.300', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2026.09.30-aaa', '2026.10.01-bbb')).toBeLessThan(0);
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
    expect(compareVersions('x', 'y')).toBeNull();
    expect(compareVersions('x', 'x')).toBe(0);
  });
  it('picks the newest of a fleet', () => {
    expect(newestVersion(['2.1.290', null, '2.1.300', 'garbage', '2.0.9'])).toBe('2.1.300');
    expect(newestVersion([null, undefined])).toBeNull();
  });
});

describe('toolState', () => {
  it('grades against the fleet reference', () => {
    expect(toolState({ version: '2.1.300', ok: true }, '2.1.300')).toBe('current');
    expect(toolState({ version: '2.1.290', ok: true }, '2.1.300')).toBe('behind');
    expect(toolState({ version: '2.0.9', ok: true }, '2.1.300')).toBe('outdated');
    expect(toolState({ version: '2.2.0', ok: true }, '2.1.300')).toBe('ahead');
  });
  it('separates not installed, unreadable and never reported', () => {
    expect(toolState({ version: null, ok: false, path: null }, '1.0.0')).toBe('missing');
    expect(toolState({ version: null, ok: false, path: '/usr/bin/x' }, '1.0.0')).toBe('unknown');
    expect(toolState(null, '1.0.0')).toBe('unknown');
  });
});

describe('toolState for the Cursor agent\'s dated builds (as the fleet update grades them)', () => {
  // The matrix's reference and comparison (queries.ts): behindReference with no exact target, then
  // compareToReference. compareVersions alone read a build hash's leading digits (27dcf5f as 27).
  const grade = (version: string, fleet: string[]) => toolState({ version, ok: true }, fleetNewest(fleet), compareToReference);
  it('never orders two builds of one day by their hashes', () => {
    const fleet = ['2026.10.22-27dcf5f', '2026.10.22-9abcdef'];
    expect(behindReference('', fleet)).toBe('2026.10.22');
    expect(grade('2026.10.22-27dcf5f', fleet)).toBe('behind');
    expect(grade('2026.10.22-9abcdef', fleet)).toBe('behind');
    // Before: 9abcdef read as 9 and 27dcf5f as 27, so one was current and the other behind.
    expect(toolState({ version: '2026.10.22-9abcdef', ok: true }, '2026.10.22-27dcf5f')).toBe('behind');
    expect(toolState({ version: '2026.10.22-27dcf5f', ok: true }, '2026.10.22-abcdef1')).toBe('ahead');
  });
  it('grades a lone newest build, and older days, by the date', () => {
    const fleet = ['2026.10.22-abcdef1', '2026.10.20-27dcf5f', '2026.09.30-1111111'];
    expect(behindReference('', fleet)).toBe('2026.10.22-abcdef1');
    expect(grade('2026.10.22-abcdef1', fleet)).toBe('current');
    expect(grade('2026.10.20-27dcf5f', fleet)).toBe('behind');
    expect(grade('2026.09.30-1111111', fleet)).toBe('outdated');
  });
  it('takes a newer bare day (a build without its hash) as the reference, and orders it against hashed builds', () => {
    // Devin on #1606: behindReference saw only hashed builds, so 2026.10.22-27dcf5f beat a newer 2026.11.03.
    const fleet = ['2026.11.03', '2026.10.22-27dcf5f'];
    expect(fleetNewest(fleet)).toBe('2026.11.03');
    const g = (v: string) => toolState({ version: v, ok: true }, fleetNewest(fleet), compareToReference);
    expect(g('2026.11.03')).toBe('current');
    expect(g('2026.10.22-27dcf5f')).toBe('outdated');
    // A newer hashed build still wins over an older bare day.
    expect(fleetNewest(['2026.10.01', '2026.10.22-27dcf5f'])).toBe('2026.10.22-27dcf5f');
    // A bare day and a build of that same day don't order: the day alone, the build behind it.
    const same = ['2026.11.03', '2026.11.03-abcdef1'];
    expect(fleetNewest(same)).toBe('2026.11.03');
    expect(toolState({ version: '2026.11.03-abcdef1', ok: true }, fleetNewest(same), compareToReference)).toBe('behind');
    expect(toolState({ version: '2026.11.03', ok: true }, fleetNewest(same), compareToReference)).toBe('current');
    // Several bare reports of the newest day: that day, current.
    expect(fleetNewest(['2026.11.03', '2026.11.03', '2026.10.22-27dcf5f'])).toBe('2026.11.03');
  });
  it('leaves other tools as they were', () => {
    expect(behindReference('', ['2.1.290', '2.1.300', null])).toBe('2.1.300');
    expect(toolState({ version: '2.1.290', ok: true }, '2.1.300', compareToReference)).toBe('behind');
    expect(toolState({ version: '2.0.9', ok: true }, '2.1.300', compareToReference)).toBe('outdated');
  });
});

describe('commitState, hooks and clients', () => {
  it('compares commits by prefix', () => {
    expect(commitState('abcdef1234567890', 'abcdef123456ffff')).toBe('current');
    expect(commitState('abcdef1234567890', '1111111111111111')).toBe('behind');
    expect(commitState(null, 'abc')).toBe('unknown');
    expect(commitState('abc', null)).toBe('unknown');
  });
  it('reads the hooks step of a box update', () => {
    expect(hooksFromDetail('pull=pulled:3 reconcile=clean deps=installed agent=restarted hooks=would-update')).toBe('would-update');
    expect(hooksFromDetail('pull=none')).toBeNull();
    expect(hooksState('updated')).toBe('current');
    expect(hooksState('failed')).toBe('outdated');
    expect(hooksState('absent')).toBe('missing');
  });
  it('recognises each client and ignores everything else', () => {
    expect(clientFromHeaders('web/0123456789ab', undefined)).toEqual({ kind: 'web', version: '0123456789ab' });
    expect(clientFromHeaders('mobile/unknown', undefined)).toEqual({ kind: 'mobile', version: 'unknown' });
    expect(clientFromHeaders(undefined, 'termag-cli/0.1.0')).toEqual({ kind: 'cli', version: '0.1.0' });
    expect(clientFromHeaders(undefined, 'termag-tui/0.1.0 node/24')).toEqual({ kind: 'tui', version: '0.1.0' });
    expect(clientFromHeaders(undefined, 'metaterm/0.2.0')).toEqual({ kind: 'metaterm', version: '0.2.0' });
    expect(clientFromHeaders('web/<script>', 'Mozilla/5.0')).toBeNull();
    expect(clientFromHeaders(undefined, 'termag-cli/$(rm)')).toBeNull();
  });

  // Chromium's User-Agent as Electron.net.fetch sends it from the desktop app's main process.
  const electron = (os: string, app: string) => `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) ${app} Chrome/152.0.0.0 Electron/44.0.0 Safari/537.36`;
  const MAC = 'Macintosh; Intel Mac OS X 10_15_7';

  it('recognises the desktop app by its name and Electron, in each stage', () => {
    expect(clientFromHeaders(undefined, electron(MAC, 'termagBeta/0.1.252'))).toEqual({ kind: 'desktop', version: '0.1.252' });
    expect(desktopFromUserAgent(electron(MAC, 'termagBeta/0.1.252'))).toEqual({ version: '0.1.252', channel: 'beta', platform: 'darwin' });
    expect(desktopFromUserAgent(electron(MAC, 'termagDev/0.1.253'))).toEqual({ version: '0.1.253', channel: 'dev', platform: 'darwin' });
    expect(desktopFromUserAgent(electron('Windows NT 10.0; Win64; x64', 'termagNightly/0.0.43-nightly.20260929.2428')))
      .toEqual({ version: '0.0.43-nightly.20260929.2428', channel: 'nightly', platform: 'win32' });
    expect(desktopFromUserAgent(electron('X11; Linux x86_64', 'termag/1.0.0'))).toEqual({ version: '1.0.0', channel: 'release', platform: 'linux' });
    // The forward socket's own User-Agent says only the version.
    expect(clientFromHeaders(undefined, 'termag-desktop/0.1.252')).toEqual({ kind: 'desktop', version: '0.1.252' });
    expect(desktopFromUserAgent('termag-desktop/0.1.252')).toEqual({ version: '0.1.252', channel: null, platform: null });
  });

  it('leaves the desktop out without Electron, and anything else named like termag', () => {
    // A browser, or the web bundle inside the desktop, which says what it is itself.
    expect(clientFromHeaders(undefined, 'Mozilla/5.0 (Macintosh) termagBeta/0.1.252 Chrome/152.0.0.0 Safari/537.36')).toBeNull();
    expect(clientFromHeaders('web/0123456789ab', electron(MAC, 'termagBeta/0.1.252'))).toEqual({ kind: 'web', version: '0123456789ab' });
    // Other Electron apps, and a termag name that isn't a stage.
    expect(clientFromHeaders(undefined, electron(MAC, 'atrium/1.2.3'))).toBeNull();
    expect(clientFromHeaders(undefined, electron(MAC, 'termagbeta/0.1.252'))).toBeNull();
    expect(clientFromHeaders(undefined, electron(MAC, 'xtermagBeta/0.1.252'))).toBeNull();
    expect(clientFromHeaders(undefined, electron(MAC, 'termagBeta/$(rm)'))).toBeNull();
    expect(clientFromHeaders(undefined, 'termag-desktop/$(rm)')).toBeNull();
  });

  it('reads and grades a CLI version built from git (cli/buildVersion.mjs)', () => {
    expect(clientFromHeaders(undefined, 'termag-cli/0.1.157+c4b6b803')).toEqual({ kind: 'cli', version: '0.1.157+c4b6b803' });
    expect(clientFromHeaders(undefined, 'termag-cli/0.1.157+c4b6b803.dirty')).toEqual({ kind: 'cli', version: '0.1.157+c4b6b803.dirty' });
    expect(clientFromHeaders(undefined, 'termag-tui/0.1.18+d57cf6f2')).toEqual({ kind: 'tui', version: '0.1.18+d57cf6f2' });
    const fleet = ['0.1.0', '0.1.0+unknown', '0.1.155+cf6212f6', '0.1.157+c4b6b803'];
    const ref = clientReference(fleet);
    expect(ref).toBe('0.1.157+c4b6b803');
    expect(clientState('0.1.157+c4b6b803', ref)).toBe('current');
    // An older commit, and a build from before versions came from git (0.1.0), are behind.
    expect(clientState('0.1.155+cf6212f6', ref)).toBe('behind');
    expect(clientState('0.1.0', ref)).toBe('behind');
    expect(clientState('0.1.0+unknown', ref)).toBe('behind');
  });

  it('never grades a different build with the same number current', () => {
    // A branch with as many cli/ commits as main, and the reference with local changes, can't be ordered against it.
    expect(clientState('0.1.158+aaaaaaaa', '0.1.158+bbbbbbbb')).toBe('unknown');
    expect(clientState('0.1.158+bbbbbbbb.dirty', '0.1.158+bbbbbbbb')).toBe('unknown');
    expect(clientState('0.1.158+bbbbbbbb', '0.1.158+bbbbbbbb')).toBe('current');
    expect(clientState('0.1.159+cccccccc', '0.1.158+bbbbbbbb')).toBe('ahead');
    // A sha that starts with digits is metadata, never a fourth number (Bugbot on #1203).
    expect(clientState('0.1.158+1a2b3c4d', '0.1.158+bbbbbbbb')).toBe('unknown');
    expect(clientState('0.1.158+bbbbbbbb', '0.1.158+1a2b3c4d')).toBe('unknown');
    expect(clientState('0.1.158+12345678', '0.1.158+87654321')).toBe('unknown');
    expect(clientState('0.1.157+99999999', '0.1.158+aaaaaaaa')).toBe('behind');
    // Versions with no build metadata grade as before.
    expect(clientState('0.2.0', '0.2.0')).toBe('current');
    expect(clientState('0.1.9', '0.2.0')).toBe('outdated');
  });

  it('takes the newest clean build as the reference', () => {
    expect(isCleanBuild('0.1.158+bbbbbbbb')).toBe(true);
    expect(isCleanBuild('0.2.0')).toBe(true);
    expect(isCleanBuild('0.1.158+bbbbbbbb.dirty')).toBe(false);
    expect(isCleanBuild('0.1.0+unknown')).toBe(false);
    // A local build ahead of everyone doesn't become the reference.
    expect(clientReference(['0.1.158+bbbbbbbb', '0.1.160+dddddddd.dirty', '0.1.0+unknown'])).toBe('0.1.158+bbbbbbbb');
    expect(clientReference(['0.1.160+dddddddd.dirty', '0.1.0+unknown'])).toBe('0.1.160+dddddddd.dirty');
    expect(clientReference([])).toBeNull();
    // Builds with the same number tie, whatever their shas: the first seen stays the reference.
    expect(clientReference(['0.1.158+bbbbbbbb', '0.1.158+9fffffff'])).toBe('0.1.158+bbbbbbbb');
    expect(clientReference(['0.1.158+9fffffff', '0.1.158+bbbbbbbb'])).toBe('0.1.158+9fffffff');
    expect(clientReference(['0.1.157+99999999', '0.1.158+aaaaaaaa'])).toBe('0.1.158+aaaaaaaa');
  });
  it('sorts components in display order', () => {
    expect(sortComponents(['kernel', 'zzz', 'claude', 'termag'])).toEqual(['termag', 'claude', 'kernel', 'zzz']);
  });
});

describe('termagReference', () => {
  const t = { boxImageCommit: 'box', orchestratorImageCommit: 'orch', runningCommit: 'run' };
  it('grades boxes against the box image and orchestrator agents against the orchestrator', () => {
    expect(termagReference('box', t)).toBe('box');
    expect(termagReference('orchestrator', t)).toBe('orch');
    expect(termagReference('agent', t)).toBe('orch');
  });
  it('falls back to the running commit with no image', () => {
    const none = { boxImageCommit: null, orchestratorImageCommit: null, runningCommit: 'run' };
    expect(termagReference('box', none)).toBe('run');
    expect(termagReference('agent', none)).toBe('run');
  });
});

describe('kernels: graded per track and host kind', () => {
  it('reads the track from the release', () => {
    expect(kernelTrack('6.8.0-1067-aws')).toBe('6.8-aws');
    expect(kernelTrack('7.0.0-1014-aws')).toBe('7.0-aws');
    expect(kernelTrack('6.8.0-147-generic')).toBe('6.8-generic');
    expect(kernelTrack('6.8.0-1067')).toBe('6.8-generic');
    expect(kernelTrack('23.4.0')).toBeNull();
    expect(kernelTrack(null)).toBeNull();
    expect(kernelGroup('agent', '7.0.0-1014-aws')).toBe('orchestrator:7.0-aws');
    expect(kernelGroup('box', '7.0.0-1014-aws')).toBe('box:7.0-aws');
  });

  // The fleet as it is: boxes pinned to 6.8 GA, one channel box on rolling 7.0, the orchestrator and its agents on 7.0.
  const hosts: KernelSighting[] = [
    { kind: 'box', running: '6.8.0-1067-aws', installed: '6.8.0-1067-aws' },
    { kind: 'box', running: '6.8.0-1066-aws', installed: '6.8.0-1066-aws' },
    { kind: 'box', running: '6.8.0-1061-aws', installed: '6.8.0-1067-aws' },
    { kind: 'box', running: '7.0.0-1013-aws', installed: '7.0.0-1013-aws' },
    { kind: 'orchestrator', running: '7.0.0-1014-aws', installed: null },
    { kind: 'agent', running: '7.0.0-1014-aws', installed: null },
  ];
  const refs = kernelReferences(hosts);

  it('takes the newest build per group, installed kernels included', () => {
    expect(Object.fromEntries(refs)).toEqual({ 'box:6.8-aws': '6.8.0-1067-aws', 'box:7.0-aws': '7.0.0-1013-aws', 'orchestrator:7.0-aws': '7.0.0-1014-aws' });
    expect(kernelReferenceText(refs)).toBe('box 6.8.0-1067-aws · box 7.0.0-1013-aws · orchestrator 7.0.0-1014-aws');
  });

  it('a 6.8 box on the newest 6.8 build is current, not outdated against 7.0', () => {
    expect(kernelState('box', '6.8.0-1067-aws', true, null, refs)).toBe('current');
    expect(kernelState('box', '6.8.0-1066-aws', true, null, refs)).toBe('behind');
  });

  it('a 7.0 box is graded against 7.0 boxes, not the orchestrator', () => {
    expect(kernelState('box', '7.0.0-1013-aws', true, null, refs)).toBe('current');
    expect(kernelState('orchestrator', '7.0.0-1014-aws', true, null, refs)).toBe('current');
    expect(kernelState('agent', '7.0.0-1014-aws', true, null, refs)).toBe('current');
  });

  it('a box that installed a newer kernel than it runs is behind its own install', () => {
    expect(kernelState('box', '6.8.0-1061-aws', true, null, refs, '6.8.0-1067-aws')).toBe('behind');
    // A rolling kernel that moved to a new major is outdated until the reboot, whatever the others run.
    expect(kernelState('box', '6.17.0-1019-aws', true, null, kernelReferences([{ kind: 'box', running: '6.17.0-1019-aws', installed: '7.0.0-1014-aws' }]), '7.0.0-1014-aws')).toBe('outdated');
  });

  it('unknown and missing as for tools', () => {
    expect(kernelState('box', null, false, '/boot', refs)).toBe('unknown');
    expect(kernelState('box', null, false, null, refs)).toBe('missing');
    expect(kernelState('box', '23.4.0', true, null, refs)).toBe('unknown');
  });
});

describe('reboot', () => {
  it('pending, no, unknown', () => {
    expect(rebootState('pending', true, null)).toBe('pending');
    expect(rebootState('no', true, null)).toBe('current');
    expect(rebootState(null, false, '/run/reboot-required')).toBe('unknown');
    expect(rebootState(null, false, null)).toBe('missing');
    expect(rebootState('maybe', true, null)).toBe('unknown');
  });
  it('reads since when from the row', () => {
    expect(rebootPendingSince('since 2026-11-02T06:10:00Z · kernel 6.8.0-1068-aws installed')).toBe('2026-11-02T06:10:00Z');
    expect(rebootPendingSince('reboot-required')).toBeNull();
    expect(rebootPendingSince(null)).toBeNull();
  });
  it('every state is counted', () => {
    expect(SOFTWARE_STATES).toContain('pending');
  });
});
