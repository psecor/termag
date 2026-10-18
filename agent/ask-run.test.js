'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CAPABILITIES, askRunnerInstalled, buildJob, startAskRun, askRunStatus, cancelAskRun, runnerPath } = require('./ask-run');

let home;
let cwd;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-run-test-'));
  cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const msg = (over = {}) => ({
  runId: 'cmsg00000001', threadId: 'cthr00000001', prompt: 'why?', systemPrompt: 'sys',
  gitName: 'Alice\nEvil', gitEmail: 'alice@example.com', resumeSessionId: null, baseSha: null, ...over,
});

function fakeSpawn(pid = 4242) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { pid, unref() { calls.push('unref'); } };
  };
  return { spawn, calls };
}

test('announces ask-v1 only where the runner is installed and executable', () => {
  assert.deepEqual(CAPABILITIES, ['ask-v1', 'ask-cancel-v1']);
  assert.equal(askRunnerInstalled(home), false);
  fs.mkdirSync(path.dirname(runnerPath(home)), { recursive: true });
  fs.writeFileSync(runnerPath(home), '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(askRunnerInstalled(home), false);
  fs.chmodSync(runnerPath(home), 0o755);
  assert.equal(askRunnerInstalled(home), true);
});

test('buildJob checks every field and cleans the git identity', () => {
  assert.throws(() => buildJob(msg({ runId: '../x' }), cwd), /runId/);
  assert.throws(() => buildJob(msg(), 'relative/dir'), /absolute/);
  assert.throws(() => buildJob(msg({ prompt: ' ' }), cwd), /prompt/);
  assert.throws(() => buildJob(msg({ baseSha: 'HEAD' }), cwd), /baseSha/);
  assert.throws(() => buildJob(msg({ resumeSessionId: 'a b' }), cwd), /resumeSessionId/);
  assert.throws(() => buildJob(msg({ gitEmail: '' }), cwd), /gitEmail/);
  const job = buildJob(msg({ baseSha: 'a'.repeat(40), resumeSessionId: 'abc-1' }), cwd);
  assert.equal(job.gitName, 'Alice Evil');
  assert.equal(job.baseSha, 'a'.repeat(40));
  assert.equal(job.resumeSessionId, 'abc-1');
});

test('startAskRun writes a private job file and starts the runner detached', () => {
  const { spawn, calls } = fakeSpawn();
  const result = startAskRun(msg(), cwd, { home, spawn });
  assert.deepEqual(result, { ok: true, started: true, pid: 4242 });
  const jobFile = path.join(home, '.termag', 'subagent', 'jobs', 'cmsg00000001.json');
  assert.equal(fs.statSync(jobFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, 'utf8')).prompt, 'why?');
  assert.equal(calls[0].cmd, runnerPath(home));
  assert.deepEqual(calls[0].args, [jobFile]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[1], 'unref');
  assert.equal(fs.readFileSync(path.join(home, '.termag', 'subagent', 'jobs', 'cmsg00000001.pid'), 'utf8'), '4242');
});

test('startAskRun refuses a checkout that is not there', () => {
  const { spawn, calls } = fakeSpawn();
  assert.throws(() => startAskRun(msg(), path.join(home, 'gone'), { home, spawn }), /does not exist/);
  assert.equal(calls.length, 0);
});

test('askRunStatus reads the pid file and checks the process', () => {
  assert.deepEqual(askRunStatus({ runId: 'cmsg00000001' }, { home }), { running: false, known: false });
  const { spawn } = fakeSpawn(process.pid);
  startAskRun(msg(), cwd, { home, spawn });
  const proc = (cmdline) => ({ readFileSync: (p, enc) => (String(p).startsWith('/proc/') ? cmdline : fs.readFileSync(p, enc)) });
  const job = (id) => path.join(home, '.termag', 'subagent', 'jobs', `${id}.json`);
  const alive = askRunStatus({ runId: 'cmsg00000001' }, {
    home,
    kill: () => {},
    fsImpl: proc(`bash\0${runnerPath(home)}\0${job('cmsg00000001')}\0`),
  });
  assert.equal(alive.running, true);
  const laterRun = askRunStatus({ runId: 'cmsg00000001' }, {
    home,
    kill: () => {},
    fsImpl: proc(`bash\0${runnerPath(home)}\0${job('cmsg00000002')}\0`),
  });
  assert.equal(laterRun.running, false);
  const reused = askRunStatus({ runId: 'cmsg00000001' }, {
    home,
    kill: () => {},
    fsImpl: { readFileSync: (p, enc) => (String(p).startsWith('/proc/') ? 'sshd\0' : fs.readFileSync(p, enc)) },
  });
  assert.equal(reused.running, false);
  const dead = askRunStatus({ runId: 'cmsg00000001' }, { home, kill: () => { throw new Error('ESRCH'); } });
  assert.equal(dead.running, false);
  assert.throws(() => askRunStatus({ runId: '../../etc' }, { home }), /runId/);
});

test('cancelAskRun sends TERM to a live runner only', () => {
  const { spawn } = fakeSpawn(process.pid);
  startAskRun(msg(), cwd, { home, spawn });
  const jobFile = path.join(home, '.termag', 'subagent', 'jobs', 'cmsg00000001.json');
  const runner = { readFileSync: (p, enc) => (String(p).startsWith('/proc/') ? `bash\0${runnerPath(home)}\0${jobFile}\0` : fs.readFileSync(p, enc)) };
  const signals = [];
  const kill = (pid, sig) => { signals.push([pid, sig]); };
  assert.deepEqual(cancelAskRun({ runId: 'cmsg00000001' }, { home, kill, fsImpl: runner }), { stopped: true, pid: process.pid });
  assert.deepEqual(signals, [[process.pid, 0], [process.pid, 'SIGTERM']]);
  signals.length = 0;
  const other = { readFileSync: (p, enc) => (String(p).startsWith('/proc/') ? 'sshd\0' : fs.readFileSync(p, enc)) };
  assert.deepEqual(cancelAskRun({ runId: 'cmsg00000001' }, { home, kill, fsImpl: other }), { stopped: false, running: false });
  assert.deepEqual(signals, [[process.pid, 0]]);
  signals.length = 0;
  const laterRun = { readFileSync: (p, enc) => (String(p).startsWith('/proc/') ? `bash\0${runnerPath(home)}\0${jobFile.replace('cmsg00000001', 'cmsg00000002')}\0` : fs.readFileSync(p, enc)) };
  assert.deepEqual(cancelAskRun({ runId: 'cmsg00000001' }, { home, kill, fsImpl: laterRun }), { stopped: false, running: false });
  assert.deepEqual(signals, [[process.pid, 0]]);
  assert.deepEqual(cancelAskRun({ runId: 'cmsg00000009' }, { home, kill }), { stopped: false, running: false });
  assert.throws(() => cancelAskRun({ runId: '../x' }, { home, kill }), /runId/);
});
