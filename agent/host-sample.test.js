'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMeminfo, parseMemTotalMb, parseLoadavg, parseDf, countKept, isSessionProcess, countSshSessions, sampleHostSync } = require('./host-sample');

test('meminfo: used is total minus available, as a whole percentage; nonsense is null', () => {
  assert.equal(parseMeminfo('MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\n'), 75);
  assert.equal(parseMeminfo('MemTotal:       1000 kB\n'), null);
  assert.equal(parseMeminfo('MemTotal: 10 kB\nMemAvailable: 20 kB\n'), null);
  assert.equal(parseMeminfo(''), null);
  assert.equal(parseMeminfo(null), null);
});

test('loadavg: the first number', () => {
  assert.equal(parseLoadavg('11.76 29.78 23.16 3/1402 3345698\n'), 11.76);
  assert.equal(parseLoadavg('garbage'), null);
});

test('df -Pk: the Use% of the data row, whatever the filesystem name', () => {
  assert.equal(parseDf('Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/root        121000000 110000000   9600000      93% /\n'), 93);
  assert.equal(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\nmy fs with spaces 10 5 5 50% /home\n'), 50);
  assert.equal(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n'), null);
  assert.equal(parseDf(''), null);
});

test('kept checkouts: the entries under ~/ccr/kept, zero without the directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'));
  assert.equal(countKept(home), 0);
  fs.mkdirSync(path.join(home, 'ccr', 'kept', 'ord-1-x'), { recursive: true });
  fs.mkdirSync(path.join(home, 'ccr', 'kept', 'ord-2-y'), { recursive: true });
  assert.equal(countKept(home), 2);
  const s = sampleHostSync(home);
  assert.equal(s.keptCheckouts, 2);
  assert.ok(typeof s.sampledAt === 'string');
  fs.rmSync(home, { recursive: true, force: true });
});

test('parseMemTotalMb reads MemTotal in MB, null when absent', () => {
  assert.equal(parseMemTotalMb('MemTotal:        3884000 kB\nMemAvailable: 1 kB\n'), 3793);
  assert.equal(parseMemTotalMb('MemFree: 1 kB\n'), null);
  assert.equal(parseMemTotalMb(null), null);
});

test('ssh sessions: the per-connection sshd child and SSM session workers, not the listener or the monitor', () => {
  assert.equal(isSessionProcess('sshd: termag@pts/0\0\0\0'), true);
  assert.equal(isSessionProcess('sshd: termag@notty'), true);
  assert.equal(isSessionProcess('sshd-session: termag@pts/1'), true);
  assert.equal(isSessionProcess('/usr/bin/ssm-session-worker\0termag-ab12cd\0i-0abc\0'), true);
  assert.equal(isSessionProcess('sshd: termag [priv]'), false);
  assert.equal(isSessionProcess('sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups'), false);
  assert.equal(isSessionProcess('/usr/sbin/sshd\0-D\0'), false);
  assert.equal(isSessionProcess('/snap/amazon-ssm-agent/13348/ssm-agent-worker'), false);
  assert.equal(isSessionProcess(''), false);
});

test('ssh sessions: counted from a /proc tree, unreadable entries skipped, null without /proc', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  const pid = (n, cmdline) => {
    fs.mkdirSync(path.join(proc, String(n)));
    if (cmdline !== null) fs.writeFileSync(path.join(proc, String(n), 'cmdline'), cmdline);
  };
  pid(1, '/sbin/init\0');
  pid(200, 'sshd: termag [priv]\0');
  pid(201, 'sshd: termag@notty\0');
  pid(300, '/usr/bin/ssm-session-worker\0termag-x\0');
  pid(400, null);
  fs.mkdirSync(path.join(proc, 'self'));
  assert.equal(countSshSessions(proc), 2);
  assert.equal(countSshSessions(path.join(proc, 'missing')), null);
  fs.rmSync(proc, { recursive: true, force: true });
});

test('sampleHostSync carries the open tunnels as { t3, port } when given, and nothing when not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-tunnels-'));
  assert.deepEqual(sampleHostSync(home, { tunnels: { t3: 2, port: 5 } }).tunnels, { t3: 2, port: 5 });
  assert.equal('tunnels' in sampleHostSync(home), false);
});
