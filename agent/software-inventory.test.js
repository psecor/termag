'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PROBES, ORCHESTRATOR_PROBES, probeScript, parseProbeOutput, osEntries, kernelEntries, readKernelState, compareReleases } = require('./software-inventory');

// First lines as the real tools print them (2026-10-15).
const OUTPUT = [
  '@@claude\t/home/u/.nvm/versions/node/v24.21.0/bin/claude\t2.1.300 (Claude Code)',
  '@@codex\t/home/u/.nvm/versions/node/v24.21.0/bin/codex\tcodex-cli 0.157.0',
  '@@cursor-agent\t/home/u/.local/bin/cursor-agent\t2026.10.01-e373342',
  '@@devin\t/home/u/.local/bin/devin\tdevin 3000.11.92 (7f4e64980e22)',
  '@@pi\t/home/u/.nvm/versions/node/v24.21.0/bin/pi\t1.0.2',
  '@@node\t/home/u/.nvm/versions/node/v24.21.0/bin/node\tv24.21.0',
  '@@npm\t/home/u/.nvm/versions/node/v24.21.0/bin/npm\t11.19.0',
  '@@gh\t/usr/bin/gh\tgh version 2.101.0 (2026-09-15)',
  '@@aws\t/usr/local/bin/aws\taws-cli/2.37.4 Python/3.14.6 Linux/7.0.0-1013-aws exe/aarch64.ubuntu.24',
  '@@tmux\t/usr/bin/tmux\ttmux 3.4',
  '@@git\t/usr/bin/git\tgit version 2.43.0',
  '@@docker\t\t',
  '@@python\t/home/u/.pyenv/shims/python3\tPython 3.13.15',
].join('\n');

test('parses every probe from real first lines', () => {
  const out = Object.fromEntries(parseProbeOutput(OUTPUT, PROBES).map(e => [e.name, e.version]));
  assert.deepStrictEqual(out, {
    claude: '2.1.300', codex: '0.157.0', 'cursor-agent': '2026.10.01-e373342', devin: '3000.11.92', pi: '1.0.2',
    node: '24.21.0', npm: '11.19.0', gh: '2.101.0', aws: '2.37.4', tmux: '3.4', git: '2.43.0', docker: null, python: '3.13.15',
  });
});

test('marks missing tools and unparseable output not ok, and keeps the raw line', () => {
  const entries = parseProbeOutput('@@claude\t/bin/claude\tsomething odd\n', PROBES);
  const claude = entries.find(e => e.name === 'claude');
  assert.deepStrictEqual(claude, { name: 'claude', ok: false, version: null, raw: 'something odd', path: '/bin/claude' });
  assert.deepStrictEqual(entries.find(e => e.name === 'git'), { name: 'git', ok: false, version: null, raw: null, path: null });
});

test('orchestrator probes parse nginx, envoy and otelcol', () => {
  const out = parseProbeOutput('@@nginx\t/usr/sbin/nginx\tnginx version: nginx/1.24.0 (Ubuntu)\n@@envoy\t/usr/local/bin/envoy\tenvoy  version: 1b2c3d/1.32.1/Clean/RELEASE/BoringSSL\n@@otelcol\t/usr/local/bin/otelcol-contrib\totelcol-contrib version 0.161.0\n', ORCHESTRATOR_PROBES);
  assert.deepStrictEqual(out.map(e => e.version), ['1.24.0', '1.32.1', '0.161.0']);
});

test('reads the version from the first line that has one, so a notice ahead of it is no longer unknown', () => {
  const out = parseProbeOutput('@@cursor-agent\t/home/u/.local/bin/cursor-agent\tUpdating Cursor Agent, please wait\x1f2026.10.22-27dcf5f\n@@node\t/usr/bin/node\t(node:12) Warning: something\x1fv24.22.1\n', PROBES);
  const byName = Object.fromEntries(out.map(e => [e.name, e]));
  assert.deepStrictEqual([byName['cursor-agent'].ok, byName['cursor-agent'].version, byName['cursor-agent'].raw], [true, '2026.10.22-27dcf5f', '2026.10.22-27dcf5f']);
  assert.deepStrictEqual([byName.node.version, byName.node.raw], ['24.22.1', 'v24.22.1']);
  // No line has one: unknown as before, with the first line to hover.
  const odd = parseProbeOutput('@@cursor-agent\t/x/cursor-agent\tPress any key\x1fto log in\n', PROBES).find(e => e.name === 'cursor-agent');
  assert.deepStrictEqual([odd.ok, odd.version, odd.raw], [false, null, 'Press any key']);
});

test('the probe keeps five lines of each tool\'s output, one record per tool', () => {
  const s = probeScript(PROBES);
  assert.match(s, /head -n 5 \| tr -d '\\r\\t' \| tr '\\n' '\\037'/);
});

test('a notice that mentions a date or another build never takes the version line\'s place', () => {
  const out = parseProbeOutput('@@cursor-agent\t/x/cursor-agent\tUpdate available: 2026.10.30-1a2b3c4 (run cursor-agent update)\x1fMigrating config from 2026.09.01\x1f2026.10.22-27dcf5f\n@@gh\t/usr/bin/gh\tgh version 2.103.3 (2026-10-26)\x1fhttps://github.com/cli/cli/releases/tag/v2.103.3\n', PROBES);
  const by = Object.fromEntries(out.map(e => [e.name, e]));
  assert.equal(by['cursor-agent'].version, '2026.10.22-27dcf5f');
  assert.equal(by['cursor-agent'].raw, '2026.10.22-27dcf5f');
  assert.equal(by.gh.version, '2.103.3');
});

test('the real probe reads a tool that prints a notice ahead of its version', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  const bin = path.join(home, '.local/bin/cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\necho "Finishing the switch to the new agent host" >&2\necho "2026.10.22-27dcf5f"\n', { mode: 0o755 });
  const probes = PROBES.filter(p => p.name === 'cursor-agent');
  const out = execFileSync('bash', ['-c', probeScript(probes)], { env: { HOME: home, PATH: '/usr/bin:/bin' } }).toString();
  assert.deepStrictEqual(parseProbeOutput(out, probes).map(e => [e.ok, e.version, e.path]), [[true, '2026.10.22-27dcf5f', bin]]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the script only ever contains the fixed probes', () => {
  const s = probeScript(PROBES);
  for (const p of PROBES) assert.ok(s.includes(`probe ${p.name} ${p.cmd}`));
  assert.throws(() => probeScript([{ name: 'x', cmd: 'rm -rf /; echo', re: /x/ }]));
  assert.throws(() => probeScript([{ name: 'x;y', cmd: 'ls', re: /x/ }]));
});

test('reads the OS and kernel', () => {
  assert.deepStrictEqual(osEntries('NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\n', '7.0.0-1013-aws'), [
    { name: 'os', ok: true, version: '24.04', raw: 'Ubuntu 24.04.5 LTS', path: null },
    { name: 'kernel', ok: true, version: '7.0.0-1013-aws', raw: '7.0.0-1013-aws', path: null },
  ]);
});

test('keeps the kernel hover line when one is given', () => {
  const [, kernel] = osEntries('', '6.8.0-1067-aws', '6.8.0-1067-aws · #70-Ubuntu SMP · booted 2026-11-03T15:47:32Z');
  assert.deepStrictEqual(kernel, { name: 'kernel', ok: true, version: '6.8.0-1067-aws', raw: '6.8.0-1067-aws · #70-Ubuntu SMP · booted 2026-11-03T15:47:32Z', path: null });
});

const T = s => Date.parse(s);
const booted = T('2026-11-01T08:00:00Z');

test('no reboot pending: the newest installed kernel is the running one', () => {
  assert.deepStrictEqual(kernelEntries({ running: '6.8.0-1067-aws', bootedAt: booted, installed: [{ release: '6.8.0-1067-aws', at: booted }], rebootRequired: null }), [
    { name: 'kernel-installed', ok: true, version: '6.8.0-1067-aws', raw: '6.8.0-1067-aws', path: '/boot' },
    { name: 'reboot', ok: true, version: 'no', raw: 'booted 2026-11-01T08:00:00Z', path: null },
  ]);
});

test('a newer kernel installed than the running one is a pending reboot, since its install', () => {
  const [installed, reboot] = kernelEntries({
    running: '6.8.0-1067-aws', bootedAt: booted,
    // Unsorted, and 1067 < 1068 < 1070 by number, not by string.
    installed: [{ release: '6.8.0-1068-aws', at: T('2026-11-02T06:10:00Z') }, { release: '6.8.0-1067-aws', at: T('2026-10-01T00:00:00Z') }],
    rebootRequired: null,
  });
  assert.deepStrictEqual(installed, { name: 'kernel-installed', ok: true, version: '6.8.0-1068-aws', raw: '6.8.0-1068-aws, 6.8.0-1067-aws', path: '/boot' });
  assert.deepStrictEqual(reboot, { name: 'reboot', ok: true, version: 'pending', raw: 'since 2026-11-02T06:10:00Z · kernel 6.8.0-1068-aws installed', path: null });
});

test('reboot-required with its packages, and the older signal sets since', () => {
  const [, reboot] = kernelEntries({
    running: '6.8.0-1067-aws', bootedAt: booted,
    installed: [{ release: '6.8.0-1068-aws', at: T('2026-11-02T06:10:00Z') }, { release: '6.8.0-1067-aws', at: booted }],
    rebootRequired: { at: T('2026-11-02T06:09:00Z'), pkgs: ['linux-image-6.8.0-1068-aws', 'linux-base', 'linux-base'] },
  });
  assert.strictEqual(reboot.version, 'pending');
  assert.strictEqual(reboot.raw, 'since 2026-11-02T06:09:00Z · kernel 6.8.0-1068-aws installed · packages: linux-image-6.8.0-1068-aws, linux-base');
});

test('a reboot asked for by a package alone, and since never before the boot', () => {
  const [, reboot] = kernelEntries({ running: '6.8.0-1067-aws', bootedAt: booted, installed: [{ release: '6.8.0-1067-aws', at: T('2026-10-01T00:00:00Z') }], rebootRequired: { at: T('2026-10-31T00:00:00Z'), pkgs: [] } });
  assert.deepStrictEqual(reboot, { name: 'reboot', ok: true, version: 'pending', raw: 'since 2026-11-01T08:00:00Z · reboot-required', path: null });
});

test('an older kernel left in /boot is not a pending reboot', () => {
  const [installed, reboot] = kernelEntries({ running: '7.0.0-1014-aws', bootedAt: booted, installed: [{ release: '6.8.0-1067-aws', at: booted }, { release: '7.0.0-1014-aws', at: booted }] });
  assert.strictEqual(installed.version, '7.0.0-1014-aws');
  assert.strictEqual(reboot.version, 'no');
});

test('no /boot, or an empty one (a container): kernel-installed missing and reboot unknown, both written over old rows', () => {
  const none = [
    { name: 'kernel-installed', ok: false, version: null, raw: null, path: null },
    { name: 'reboot', ok: true, version: 'unknown', raw: 'no kernel in /boot', path: null },
  ];
  assert.deepStrictEqual(kernelEntries({ running: '7.0.0-1014-aws', bootedAt: booted, installed: null }), none);
  assert.deepStrictEqual(kernelEntries({ running: '7.0.0-1014-aws', bootedAt: booted, installed: [] }), none);
  // Nor does a /boot with only an image that isn't a kernel release.
  assert.deepStrictEqual(kernelEntries({ running: '7.0.0-1014-aws', installed: [{ release: 'old', at: 1 }] }), none);
  // Neither row is transient (ok false with a path), so a stale kernel and "pending" are replaced (Devin on #1218).
  for (const e of none) assert.ok(e.ok || !e.path);
  // A reboot-required file still says pending without /boot.
  assert.strictEqual(kernelEntries({ running: '7.0.0-1014-aws', bootedAt: booted, installed: null, rebootRequired: { at: T('2026-11-02T00:00:00Z'), pkgs: ['libc6'] } })[1].version, 'pending');
});

test('readKernelState reads /proc/stat, /boot and /run/reboot-required through fs', () => {
  const files = {
    '/proc/stat': 'cpu  1 2 3\nbtime 1793726865\nprocesses 9\n',
    '/run/reboot-required.pkgs': 'linux-image-6.8.0-1068-aws\nlinux-base\n$(evil)\n',
  };
  const stats = {
    '/boot/vmlinuz-6.8.0-1068-aws': { birthtimeMs: 2000, ctimeMs: 3000, mtimeMs: 1 },
    '/run/reboot-required': { mtimeMs: 5000 },
    '/run/reboot-required.pkgs': { birthtimeMs: 0, ctimeMs: 4000 },
  };
  const fake = {
    readFileSync: p => { if (p in files) return files[p]; throw new Error('ENOENT'); },
    readdirSync: p => { if (p === '/boot') return ['vmlinuz-6.8.0-1068-aws', 'vmlinuz', 'initrd.img-6.8.0-1068-aws']; throw new Error('ENOENT'); },
    statSync: p => { if (p in stats) return stats[p]; throw new Error('ENOENT'); },
  };
  assert.deepStrictEqual(readKernelState(fake), {
    bootedAt: 1793726865000,
    installed: [{ release: '6.8.0-1068-aws', at: 2000 }],
    rebootRequired: { at: 4000, pkgs: ['linux-image-6.8.0-1068-aws', 'linux-base'] },
  });
  const none = { readFileSync: () => { throw new Error('ENOENT'); }, readdirSync: () => { throw new Error('ENOENT'); }, statSync: () => { throw new Error('ENOENT'); } };
  assert.deepStrictEqual(readKernelState(none), { bootedAt: null, installed: null, rebootRequired: null });
});

test('kernel releases order by number', () => {
  assert.ok(compareReleases('6.8.0-1067-aws', '6.8.0-1068-aws') < 0);
  assert.ok(compareReleases('6.8.0-1070-aws', '6.8.0-1068-aws') > 0);
  assert.ok(compareReleases('7.0.0-1014-aws', '6.8.0-1067-aws') > 0);
  assert.strictEqual(compareReleases('6.8.0-1067-aws', '6.8.0-1067-aws'), 0);
});
