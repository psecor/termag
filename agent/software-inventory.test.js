'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PROBES, ORCHESTRATOR_PROBES, probeScript, parseProbeOutput, osEntries } = require('./software-inventory');

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
