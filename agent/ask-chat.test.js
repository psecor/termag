'use strict';
// An ask as a chat of its target project (ask-chat.js, chat-runner.js's ask
// hooks), with a stand-in for termag-subagent-run's phases and for tmux.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile: execFileCb } = require('child_process');
const { promisify } = require('util');
const { askEnv, askOfJob, createChatRunner, turnArgs } = require('./chat-runner');
const { childEnv } = require('./chat-turn');
const { askChatCapable, createAskChat, failureReason, turnResult } = require('./ask-chat');

const execFile = promisify(execFileCb);
const RUN = 'runaaaa0001';
const THREAD = 'threadaaaa01';
const PNG64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]).toString('base64');

test('an ask turn denies wakeups and crons and appends the system prompt; a plain turn does neither', () => {
  const ask = turnArgs(null, 'bypassPermissions', { ask: { threadId: THREAD, systemPrompt: 'RULES' } });
  assert.deepEqual(ask.slice(ask.indexOf('--disallowedTools'), ask.indexOf('--disallowedTools') + 2), ['--disallowedTools', 'ScheduleWakeup CronCreate']);
  assert.deepEqual(ask.slice(ask.indexOf('--append-system-prompt'), ask.indexOf('--append-system-prompt') + 2), ['--append-system-prompt', 'RULES']);
  assert.equal(ask[ask.indexOf('--permission-mode') + 1], 'bypassPermissions');
  const plain = turnArgs(null, 'bypassPermissions');
  assert.ok(!plain.includes('--disallowedTools') && !plain.includes('--append-system-prompt'));
  const person = turnArgs('sess-1234-abcd', 'bypassPermissions', { ask: { threadId: THREAD, systemPrompt: '' } });
  assert.ok(person.includes('--disallowedTools') && !person.includes('--append-system-prompt'));
  assert.deepEqual(person.slice(-2), ['--resume', 'sess-1234-abcd']);
});

test('an ask job is checked, and its commits are the asker\'s', () => {
  assert.equal(askOfJob(null), null);
  assert.throws(() => askOfJob({ threadId: '../x' }), /threadId/);
  assert.throws(() => askOfJob({ threadId: THREAD, runId: 'NOPE!' }), /runId/);
  const a = askOfJob({ threadId: THREAD, runId: RUN, gitName: 'Ada\n<x>', gitEmail: ' ada@example.com\n' });
  assert.deepEqual(askEnv(a), {
    GIT_AUTHOR_NAME: 'Ada  x', GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada  x', GIT_COMMITTER_EMAIL: 'ada@example.com',
  });
  assert.deepEqual(askEnv({ threadId: THREAD, gitEmail: '' }), {});
  const pr = askOfJob({ threadId: THREAD, prBodyFile: '/c/repo/.git/termag-pr-body.md', prDir: 'relative/prs' });
  assert.equal(pr.prDir, undefined, 'a PR path must be absolute');
  assert.deepEqual(askEnv(pr), { TERMAG_ASK_PR_BODY_FILE: '/c/repo/.git/termag-pr-body.md' });
  assert.equal(askOfJob({ threadId: THREAD, prDir: '/c/repo/.git/x\ny' }).prDir, undefined);
  const env = childEnv({ PATH: '/x', TMUX: 't' }, '/y', null, {
    GIT_AUTHOR_EMAIL: 'a@b', TERMAG_ASK_PR_BODY_FILE: '/c/b.md', TERMAG_ASK_PR_DIR: '/c/prs', LD_PRELOAD: '/evil.so',
  });
  assert.equal(env.GIT_AUTHOR_EMAIL, 'a@b');
  assert.equal(env.TERMAG_ASK_PR_BODY_FILE, '/c/b.md');
  assert.equal(env.TERMAG_ASK_PR_DIR, '/c/prs');
  assert.equal(env.LD_PRELOAD, undefined, 'only the git identity and the PR paths come from a turn\'s env');
  assert.equal(env.TMUX, undefined);
});

test('the reply of a turn is Claude\'s last result, else an error that keeps the session', () => {
  const ok = turnResult([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1234-abcd' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1234-abcd', num_turns: 2 }),
    JSON.stringify({ type: 'turn-end', exitCode: 0 }),
  ].join('\n'));
  assert.equal(ok.result, 'done');
  const lost = turnResult([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1234-abcd' }),
    JSON.stringify({ type: 'runner-error', message: 'Claude exited 3' }),
  ].join('\n'));
  assert.equal(lost.is_error, true);
  assert.equal(lost.subtype, 'error_turn_stopped');
  assert.equal(lost.session_id, 'sess-1234-abcd');
  assert.match(lost.result, /stopped before Claude answered\. Claude exited 3/);
  assert.equal(failureReason({ stderr: 'x\nt[r]: failed: no checkout\n' }), 'no checkout');
});

// tmux as a Set; a turn "runs" until the test finishes it.
function box() {
  const sessions = new Set();
  const procs = new Map();
  return {
    sessions, procs,
    startProcess: async (meta, dir) => {
      sessions.add(meta.session);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: meta.text })}\n`);
      fs.writeFileSync(path.join(dir, 'claude.pid'), '4242');
      procs.set(meta.turnId, { meta, dir });
    },
    finish(turnId, events = []) {
      const { meta, dir } = procs.get(turnId);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), [...events, { type: 'turn-end', exitCode: 0 }].map(e => `${JSON.stringify(e)}\n`).join(''));
      fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 0 }));
      sessions.delete(meta.session);
    },
    sessionAlive: async name => sessions.has(name),
  };
}

function runner(home, b, hooks = {}) {
  return createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', env: { PATH: '/usr/bin' },
    send: () => true, startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: () => {},
    stopSession: async name => { b.sessions.delete(name); }, pidAlive: () => false, interruptGraceMs: 5,
    readCheckout: async () => ({ repo: true, branch: 'ask', originUrl: null }),
    ...hooks,
  });
}

const askJob = (runId, text = 'please look', extra = {}) => ({
  chatKey: 'p1--wsask', cwd: '/clone/repo', text, projectId: 'p1', workstream: `ask-${THREAD}`, workstreamId: 'wsask',
  permissionMode: 'bypassPermissions', ask: { threadId: THREAD, ...(runId ? { runId } : {}), systemPrompt: 'RULES', gitEmail: 'ada@example.com' }, ...extra,
});

test('the runner hands an ask\'s finished turn to the hook once, before it is done; a person\'s turn has no run to report', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  const b = box();
  const done = [];
  const r = runner(home, b, { onTurnDone: async (meta, dir) => { done.push([meta.ask.runId, fs.existsSync(path.join(dir, 'done'))]); } });
  const { turnId } = await r.sendMessage(askJob(RUN));
  const meta = b.procs.get(turnId).meta;
  assert.equal(meta.mode, 'bypassPermissions', 'a clone with no origin is its own tree: the owner\'s mode stands');
  assert.equal(meta.configDir, undefined, 'and the owner\'s own settings load, as under termag-subagent-run');
  assert.equal(meta.env.GIT_AUTHOR_EMAIL, 'ada@example.com');
  assert.ok(meta.path.split(':').includes(path.join(home, '.local/bin')));
  assert.equal(r.findAsk(RUN).state, 'running');
  await r.sendMessage(askJob(null, 'a person follows up', { liveInput: true }));
  b.finish(turnId, [{ type: 'result', result: 'answer', is_error: false }]);
  await r.poll();
  await r.poll();
  assert.deepEqual(done, [[RUN, false]]);
  assert.equal(r.findAsk(RUN), null);
  const person = [...b.procs.values()].find(p => p.meta.turnId !== turnId);
  assert.equal(person.meta.text, 'a person follows up');
  assert.equal(person.meta.live, false, 'an ask\'s chat never takes messages into a running turn');
  b.finish(person.meta.turnId, []);
  await r.poll();
  assert.equal(done.length, 1);
});

test('cancel takes one ask out of its queue, or stops its turn without reporting, keeping what waits behind it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  const b = box();
  const done = [];
  const drops = [];
  const r = runner(home, b, { onTurnDone: async meta => { done.push(meta.ask.runId); }, onDropped: jobs => drops.push(...jobs.map(j => j.ask.runId)) });
  const { turnId } = await r.sendMessage(askJob(RUN));
  await r.sendMessage(askJob('runaaaa0002', 'second'));
  await r.sendMessage(askJob('runaaaa0003', 'third'));
  assert.deepEqual(r.findAsk('runaaaa0002'), { state: 'queued', chatKey: 'p1--wsask' });
  assert.deepEqual(await r.cancelAsk('runaaaa0002'), { stopped: true, queued: true });
  assert.equal(r.findAsk('runaaaa0002'), null);
  const stop = await r.cancelAsk(RUN);
  assert.equal(stop.stopped, true);
  b.finish(turnId, []);
  await r.poll();
  await r.poll();
  assert.deepEqual(done, [], 'a canceled turn is not reported');
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'third'), 'the ask behind it runs');
  await r.clear('p1--wsask');
  assert.deepEqual(drops, []);
  await r.sendMessage(askJob('runaaaa0004', 'fourth'));
  await r.sendMessage(askJob('runaaaa0005', 'fifth'));
  await r.clear('p1--wsask');
  assert.deepEqual(drops, ['runaaaa0004', 'runaaaa0005'], 'a cleared chat\'s queued asks go to the drop hook');
});

// ── ask-chat.js with a stand-in termag-subagent-run ─────────────────────────────

const FAKE_RUNNER = `#!/bin/sh
# Phases: ask-chat-v1
mode=$1; job=$2
echo "$*" >> "$HOME/runner-calls"
case $mode in
  --prepare)
    if [ -f "$HOME/prepare-fails" ]; then echo "x: failed: $(cat "$HOME/prepare-fails")" >&2; exit 1; fi
    # prepare-hangs: a clone that takes its time, with git as a child (as the real one, it holds the lock).
    if [ -f "$HOME/prepare-hangs" ]; then
      trap 'exit 143' TERM
      sleep 60 & echo $! > "$HOME/prepare-child"; echo $$ > "$HOME/prepare-pid"
      wait; exit 1
    fi
    t=$(sed -n 's/.*"threadId":"\\([a-z0-9]*\\)".*/\\1/p' "$job")
    fresh=false; [ -d "$HOME/threads/$t/repo" ] || fresh=true
    mkdir -p "$HOME/threads/$t/repo"
    # prepare-prdir: the prDir this runner names (else it names none, as before the PR paths).
    if [ -f "$HOME/prepare-prdir" ]; then
      printf '{"repoDir":"%s","base":"b","repo":"o/r","fresh":%s,"prBodyFile":"%s","prDir":"%s"}\\n' "$HOME/threads/$t/repo" "$fresh" "$HOME/threads/$t/repo/.git/termag-pr-body.md" "$(cat "$HOME/prepare-prdir")"
    else
      printf '{"repoDir":"%s","base":"b","repo":"o/r","fresh":%s}\\n' "$HOME/threads/$t/repo" "$fresh"
    fi ;;
  --report) cp "$3" "$HOME/reported.json"; rm -f "$job" ;;
  --fail) printf '%s' "$3" > "$HOME/failed.txt"; rm -f "$job" ;;
esac
`;

function askBox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/bin/termag-subagent-run'), FAKE_RUNNER, { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'proj'));
  const b = box();
  let a = null;
  const chats = runner(home, b, { onTurnDone: (m, d) => a.onTurnDone(m, d), onDropped: j => a.onDropped(j) });
  const env = { ...process.env, HOME: home };
  a = createAskChat({
    home, chats,
    spawn: (cmd, args, opts) => spawn(cmd, args, { ...opts, env }),
  });
  return { home, b, chats, a };
}

const runMsg = (runId, extra = {}) => ({
  runId, threadId: THREAD, prompt: 'please look', systemPrompt: 'RULES', gitName: 'Ada', gitEmail: 'ada@example.com',
  resumeSessionId: null, baseSha: null,
  chat: { chatKey: 'p1--wsask', projectId: 'p1', workstream: `ask-${THREAD}`, workstreamId: 'wsask' }, ...extra,
});

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

test('ask-chat: the capability needs a runner with the phases', () => {
  const { home } = askBox();
  assert.equal(askChatCapable(home), true);
  fs.writeFileSync(path.join(home, '.local/bin/termag-subagent-run'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(askChatCapable(home), false);
});

test('ask-chat: a run is prepared, runs as a turn in the thread\'s clone and is reported from its result', async () => {
  const { home, b, a } = askBox();
  const res = a.startRun(runMsg(RUN), path.join(home, 'proj'));
  assert.deepEqual(res, { ok: true, started: true, chat: 'p1--wsask' });
  assert.equal(a.status({ runId: RUN }).running, true);
  const proc = await until(() => [...b.procs.values()][0]);
  const repo = path.join(home, 'threads', THREAD, 'repo');
  assert.equal(proc.meta.cwd, repo);
  assert.equal(proc.meta.text, 'please look');
  assert.equal(proc.meta.ask.runId, RUN);
  assert.equal(proc.meta.env.TERMAG_ASK_PR_BODY_FILE, path.join(repo, '.git/termag-pr-body.md'), 'where --report reads the PR description');
  assert.equal(proc.meta.env.TERMAG_ASK_PR_DIR, path.join(repo, '.git/termag-prs'));
  assert.equal(fs.readFileSync(path.join(home, 'threads', THREAD, 'system-prompt.txt'), 'utf8'), 'RULES');
  assert.equal(a.status({ runId: RUN }).stage, 'sent');
  b.finish(proc.meta.turnId, [{ type: 'result', subtype: 'success', is_error: false, result: 'the answer', session_id: 'sess-1234-abcd', num_turns: 1 }]);
  await a.onTurnDone(proc.meta, proc.dir);
  const reported = await until(() => fs.existsSync(path.join(home, 'reported.json')) && JSON.parse(fs.readFileSync(path.join(home, 'reported.json'), 'utf8')));
  assert.equal(reported.result, 'the answer');
  await until(() => !fs.existsSync(path.join(home, '.termag/subagent/jobs', `${RUN}.json`)));
  await a.onTurnDone(proc.meta, proc.dir);
  assert.equal(fs.readFileSync(path.join(home, 'runner-calls'), 'utf8').match(/--report/g).length, 1, 'reported once');
});

test('ask-chat: a person\'s message runs in the clone with the thread\'s prompt and no run', async () => {
  const { home, b, a, chats } = askBox();
  a.startRun(runMsg(RUN), path.join(home, 'proj'));
  const first = await until(() => [...b.procs.values()][0]);
  b.finish(first.meta.turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-1234-abcd' }, { type: 'result', result: 'a', session_id: 'sess-1234-abcd' }]);
  chats.setSession('p1--wsask', { sessionId: 'sess-1234-abcd', cwd: first.meta.cwd });
  await chats.poll();
  const sent = await a.sendMessage({
    chatKey: 'p1--wsask', projectId: 'p1', workstream: `ask-${THREAD}`, workstreamId: 'wsask', text: 'and also this',
    model: 'opus', images: [{ data: PNG64 }],
    ask: { threadId: THREAD, baseSha: null, gitName: 'Ada', gitEmail: 'ada@example.com' },
  }, path.join(home, 'proj'));
  const second = b.procs.get(sent.turnId);
  assert.deepEqual(second.meta.args.slice(second.meta.args.indexOf('--model'), second.meta.args.indexOf('--model') + 2), ['--model', 'opus'], 'the project\'s model');
  assert.equal(second.meta.images.length, 1, 'the attached image goes to Claude');
  assert.equal(second.meta.cwd, first.meta.cwd);
  assert.equal(second.meta.ask.runId, undefined);
  assert.deepEqual(second.meta.args.slice(-2), ['--resume', 'sess-1234-abcd'], 'the same session, so the asker\'s next ask sees it');
  assert.ok(second.meta.args.includes('RULES'));
  assert.equal(second.meta.env.TERMAG_ASK_PR_DIR, path.join(first.meta.cwd, '.git/termag-prs'), 'a person\'s turn can describe the thread\'s PRs too');
  assert.deepEqual(fs.readdirSync(path.join(home, '.termag/subagent/jobs')).filter(f => f.startsWith('msg-')), [], 'its prepare job is gone');
});

test('ask-chat: the PR paths are the ones --prepare names, and only inside the clone\'s .git', async () => {
  for (const [named, want] of [['repo/.git/termag-prs', 'repo/.git/termag-prs'], ['elsewhere/prs', 'repo/.git/termag-prs']]) {
    const { home, b, a } = askBox();
    const base = path.join(home, 'threads', THREAD);
    fs.writeFileSync(path.join(home, 'prepare-prdir'), path.join(base, named));
    a.startRun(runMsg(RUN), path.join(home, 'proj'));
    const proc = await until(() => [...b.procs.values()][0]);
    assert.equal(proc.meta.env.TERMAG_ASK_PR_DIR, path.join(base, want), named);
    assert.equal(proc.meta.env.TERMAG_ASK_PR_BODY_FILE, path.join(base, 'repo/.git/termag-pr-body.md'));
  }
});

test('ask-chat: cancel during --prepare stops it and the clone under it, and nothing is reported', async () => {
  const { home, a } = askBox();
  fs.writeFileSync(path.join(home, 'prepare-hangs'), '');
  a.startRun(runMsg(RUN), path.join(home, 'proj'));
  const pidOf = f => Number(fs.readFileSync(path.join(home, f), 'utf8'));
  await until(() => fs.existsSync(path.join(home, 'prepare-child')) && fs.existsSync(path.join(home, 'prepare-pid')));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const script = pidOf('prepare-pid'); const git = pidOf('prepare-child');
  const res = await a.cancel({ runId: RUN });
  assert.equal(res.stopped, true);
  assert.equal(res.stage, 'preparing');
  await until(() => !alive(script) && !alive(git));
  assert.ok(!alive(git), 'the clone stops with the script, so it lets go of the thread lock');
  assert.ok(!fs.existsSync(path.join(home, 'failed.txt')) && !fs.existsSync(path.join(home, 'reported.json')), 'a canceled run reports nothing');
  assert.equal(a.status({ runId: RUN }).running, false);
});

test('ask-chat: a reconnect while a run is prepared does not prepare it twice', async () => {
  const { home, a } = askBox();
  fs.writeFileSync(path.join(home, 'prepare-hangs'), '');
  a.startRun(runMsg(RUN), path.join(home, 'proj'));
  await until(() => fs.existsSync(path.join(home, 'prepare-pid')));
  await a.reconcile();
  await a.reconcile();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fs.readFileSync(path.join(home, 'runner-calls'), 'utf8').match(/--prepare/g).length, 1);
  await a.cancel({ runId: RUN });
});

test('ask-chat: a clone made again starts a new session; a thread from the headless runner resumes its session', async () => {
  const { home, b, a, chats } = askBox();
  chats.setSession('p1--wsask', { sessionId: 'sess-old0-0000', cwd: '/elsewhere' });
  a.startRun(runMsg(RUN, { resumeSessionId: 'sess-9999-0000' }), path.join(home, 'proj'));
  const first = await until(() => [...b.procs.values()][0]);
  assert.ok(!first.meta.args.includes('--resume'), 'fresh clone, fresh session');
  b.finish(first.meta.turnId, []);
  await chats.poll();
  chats.setSession('p1--wsask', { sessionId: null, cwd: null });
  a.startRun(runMsg('runaaaa0002', { resumeSessionId: 'sess-9999-0000' }), path.join(home, 'proj'));
  const second = await until(() => [...b.procs.values()].find(p => p.meta.turnId !== first.meta.turnId));
  assert.deepEqual(second.meta.args.slice(-2), ['--resume', 'sess-9999-0000']);
});

test('ask-chat: cancel drops the job and the queued turn; a failed prepare and a lost turn still answer', async () => {
  const { home, b, a, chats } = askBox();
  a.startRun(runMsg(RUN), path.join(home, 'proj'));
  await until(() => [...b.procs.values()][0]);
  a.startRun(runMsg('runaaaa0002'), path.join(home, 'proj'));
  await until(() => chats.findAsk('runaaaa0002')?.state === 'queued');
  const c = await a.cancel({ runId: 'runaaaa0002' });
  assert.equal(c.stopped, true);
  assert.equal(chats.findAsk('runaaaa0002'), null);
  assert.equal(a.status({ runId: 'runaaaa0002' }).known, false);

  fs.writeFileSync(path.join(home, 'prepare-fails'), 'no checkout');
  a.startRun(runMsg('runaaaa0003'), path.join(home, 'proj'));
  await until(() => !fs.existsSync(path.join(home, '.termag/subagent/jobs/runaaaa0003.json')));
  fs.rmSync(path.join(home, 'prepare-fails'));

  const jobs = path.join(home, '.termag/subagent/jobs');
  fs.writeFileSync(path.join(jobs, 'runaaaa0004.json'), JSON.stringify({ ...runMsg('runaaaa0004'), mode: 'chat', stage: 'sent' }));
  await a.reconcile();
  await until(() => fs.existsSync(path.join(home, 'failed.txt')));
  assert.match(fs.readFileSync(path.join(home, 'failed.txt'), 'utf8'), /lost when the box agent restarted/);
});
