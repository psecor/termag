'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMeminfo, parseLoadavg, parseDf, countKept, sampleHostSync } = require('./host-sample');

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
