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
const { askChatCapable, chatOf, createAskChat, failureReason, turnResult, withReadOnlyNotice } = require('./ask-chat');

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
    TERMAG_ASK_THREAD: THREAD,
  });
  assert.deepEqual(askEnv({ threadId: THREAD, gitEmail: '' }), { TERMAG_ASK_THREAD: THREAD });
  const pr = askOfJob({ threadId: THREAD, prBodyFile: '/c/repo/.git/termag-pr-body.md', prDir: 'relative/prs' });
  assert.equal(pr.prDir, undefined, 'a PR path must be absolute');
  assert.deepEqual(askEnv(pr), { TERMAG_ASK_PR_BODY_FILE: '/c/repo/.git/termag-pr-body.md', TERMAG_ASK_THREAD: THREAD });
  assert.equal(askOfJob({ threadId: THREAD, prDir: '/c/repo/.git/x\ny' }).prDir, undefined);
  const env = childEnv({ PATH: '/x', TMUX: 't' }, '/y', null, {
    GIT_AUTHOR_EMAIL: 'a@b', TERMAG_ASK_PR_BODY_FILE: '/c/b.md', TERMAG_ASK_PR_DIR: '/c/prs', TERMAG_ASK_THREAD: THREAD, LD_PRELOAD: '/evil.so',
  });
  assert.equal(env.TERMAG_ASK_THREAD, THREAD, 'termag-pr-body marks a PR the run opens with its thread');
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
    telemetrySettings: async () => null,
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

test('an ask\'s clone that gained an origin it does not track runs read-only, and says why and how to recover', async () => {
  // Thread cmvsovavv0wi0nyiwjj48ugzn: its first turn ran `git remote add origin` to merge
  // origin/main, and every follow-up after it had only Read, Grep and Glob, silently. The tree
  // may hold a fetched PR head, so it keeps the read-only gate (Security Agent, #940): neither
  // bypassPermissions nor auto's shell. What changes is that the turn says so.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  const git = (cwd, ...args) => execFile('git', ['-C', cwd, ...args]);
  const makeClone = async (dir, origin = true) => {
    fs.mkdirSync(dir, { recursive: true });
    await git(dir, 'init', '-q', '-b', 'ask');
    await git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
    if (origin) await git(dir, 'remote', 'add', 'origin', 'https://github.com/example-org/termag.git');
  };
  const clone = path.join(home, '.termag/subagent/threads', THREAD, 'repo');
  const fresh = path.join(home, '.termag/subagent/threads', 'threadbbbb02', 'repo');
  const elsewhere = path.join(home, 'plain/repo');
  await makeClone(clone);
  await makeClone(fresh, false);
  await makeClone(elsewhere);
  const b = box();
  const r = runner(home, b, { readCheckout: null });
  const metaOf = async (job) => { const { turnId } = await r.sendMessage(job); const m = b.procs.get(turnId).meta; b.finish(turnId, []); await r.poll(); return m; };

  const followUp = await metaOf(askJob(RUN, 'follow up', { cwd: clone }));
  assert.equal(followUp.mode, 'dontAsk');
  assert.deepEqual(followUp.args.slice(followUp.args.indexOf('--tools'), followUp.args.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob']);
  // In the ask's clone the reason names the remote and the way back.
  assert.equal(followUp.readOnly, 'the checkout has an origin but branch ask tracks none of its branches (a run added a git remote to the thread\'s clone)');
  // The way back is the turn's fix, so the notice offers it instead of calling the refusal on purpose.
  assert.equal(followUp.readOnlyFix, `remove that remote (\`git -C ${clone} remote remove origin\`)`);
  const reply = withReadOnlyNotice({ type: 'result', result: 'I have no Bash tool.' }, followUp.readOnly, followUp.readOnlyFix).result;
  assert.match(reply, /^\[termag: this turn ran read-only, with only Read, Grep and Glob, because the checkout has an origin but branch ask tracks none of its branches .*To give it its tools back, on the box, remove that remote .*remote remove origin.*\]\n\nI have no Bash tool\.$/);
  assert.equal(withReadOnlyNotice({ result: 'ok' }, undefined).result, 'ok');

  // A clone that never gained an origin is the project's own tree, as before.
  assert.equal((await metaOf(askJob('runaaaa0003', 'first', { cwd: fresh, ask: { threadId: 'threadbbbb02', runId: 'runaaaa0003' } }))).mode, 'bypassPermissions');
  // Any other checkout in that state: read-only, with the plain reason.
  const other = await metaOf(askJob('runaaaa0002', 'elsewhere', { chatKey: 'p1--other', cwd: elsewhere }));
  assert.equal(other.mode, 'dontAsk');
  assert.equal(other.readOnly, 'the checkout has an origin but branch ask tracks none of its branches');
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
    # prepare-push: a push-mode clone (ask-push-v1), which has no PR description files.
    if [ -f "$HOME/prepare-push" ]; then
      printf '{"repoDir":"%s","base":"b","repo":"o/r","fresh":%s,"push":true,"branch":"termag-ada/t"}\\n' "$HOME/threads/$t/repo" "$fresh"
    # prepare-prdir: the prDir this runner names (else it names none, as before the PR paths).
    elif [ -f "$HOME/prepare-prdir" ]; then
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

test('ask-chat: a push-mode clone\'s turn gets the thread, and no PR description files', async () => {
  const { home, b, a } = askBox();
  fs.writeFileSync(path.join(home, 'prepare-push'), '');
  a.startRun(runMsg(RUN, { pushBranch: 'termag-ada/t' }), path.join(home, 'proj'));
  const proc = await until(() => [...b.procs.values()][0]);
  assert.equal(proc.meta.env.TERMAG_ASK_THREAD, THREAD);
  assert.equal(proc.meta.env.TERMAG_ASK_PR_BODY_FILE, undefined);
  assert.equal(proc.meta.env.TERMAG_ASK_PR_DIR, undefined);
  const job = JSON.parse(fs.readFileSync(path.join(home, '.termag/subagent/jobs', `${RUN}.json`), 'utf8'));
  assert.equal(job.pushBranch, 'termag-ada/t', '--prepare reads the branch from the job');
});

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

test('ask-chat: an ask\'s run and a person\'s message in its chat both load the chat\'s own space (Bugbot, #769)', async () => {
  const { home, b, a, chats } = askBox();
  const seen = [];
  const send = chats.sendMessage;
  chats.sendMessage = m => { seen.push(m); return send(m); };
  a.startRun(runMsg(RUN, { spaceMemory: { space: 'design' } }), path.join(home, 'proj'));
  const first = await until(() => [...b.procs.values()][0]);
  b.finish(first.meta.turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-1234-abcd' }, { type: 'result', result: 'a', session_id: 'sess-1234-abcd' }]);
  chats.setSession('p1--wsask', { sessionId: 'sess-1234-abcd', cwd: first.meta.cwd });
  await chats.poll();
  await a.sendMessage({
    chatKey: 'p1--wsask', projectId: 'p1', workstream: `ask-${THREAD}`, workstreamId: 'wsask', text: 'and also this',
    ask: { threadId: THREAD, baseSha: null, gitName: 'Ada', gitEmail: 'ada@example.com' }, spaceMemory: { space: null },
  }, path.join(home, 'proj'));
  assert.deepEqual(seen.map(m => m.spaceMemory), [{ space: 'design' }, { space: null }]);
  // Without one (an older backend), none is passed: the box's default, as before.
  a.startRun(runMsg('runbbbb0001', { chat: { chatKey: 'p2--wsask', projectId: 'p2', workstream: `ask-${THREAD}`, workstreamId: 'wsask2' } }), path.join(home, 'proj'));
  await until(() => seen.length === 3);
  assert.equal(seen[2].spaceMemory, undefined);
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

// ── steering: a follow-up into the running ask turn (ask-steer-v1) ───────────────

const { turnTarget } = require('./ask-chat');
const R2 = 'runaaaa0002';
const R3 = 'runaaaa0003';
const replay = text => ({ type: 'user', isReplay: true, message: { role: 'user', content: text } });
const result = text => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sess-1234-abcd', num_turns: 1 });
// What chat-turn.js does with an inbox file once it has written it to Claude.
const deliver = dir => {
  const inbox = path.join(dir, 'inbox');
  for (const f of fs.readdirSync(inbox).filter(n => /^\d+\.json$/.test(n))) fs.renameSync(path.join(inbox, f), path.join(inbox, f.replace(/\.json$/, '.sent')));
};

test('steer: the reply goes to the last follow-up that reached Claude; one taken out for the next turn supersedes the rest', () => {
  const steered = [{ runId: R2, inbox: '000001.json', text: 'B' }, { runId: R3, inbox: '000002.json', text: 'C' }];
  const facts = (delivered, waiting = []) => ({ delivered: e => delivered.includes(e.runId), waiting: e => waiting.includes(e.runId) });
  assert.deepEqual(turnTarget(RUN, [], facts([])), { runId: RUN, after: null, superseded: [], report: true, lost: [] });
  assert.deepEqual(turnTarget(RUN, steered, facts([R2, R3])), { runId: R3, after: 'C', superseded: [RUN, R2], report: true, lost: [] });
  // C was steered in after Claude's last read: it is the next turn, which reports it.
  assert.deepEqual(turnTarget(RUN, steered, facts([R2])), { runId: R2, after: 'B', superseded: [RUN], report: false, lost: [] });
  assert.deepEqual(turnTarget(RUN, steered.slice(0, 1), facts([])), { runId: RUN, after: null, superseded: [], report: false, lost: [] });
  // A stopped turn leaves its inbox: the follow-up still there never ran.
  assert.deepEqual(turnTarget(RUN, steered, facts([R2], [R3])), { runId: R2, after: 'B', superseded: [RUN], report: false, lost: [R3] });
});

test('steer: the reply is Claude\'s last result after it took the follow-up in, else an error saying so', () => {
  const log = evs => evs.map(e => JSON.stringify(e)).join('\n');
  assert.equal(turnResult(log([result('A'), replay('B'), result('B')]), 'B').result, 'B');
  assert.equal(turnResult(log([replay('B'), result('A and B')]), 'B').result, 'A and B', 'a follow-up taken into the work under way');
  const none = turnResult(log([{ type: 'system', subtype: 'init', session_id: 'sess-1234-abcd' }, result('A'), replay('B'), { type: 'runner-error', message: 'Claude exited 1' }]), 'B');
  assert.equal(none.is_error, true);
  assert.match(none.result, /stopped before Claude answered this follow-up\. Claude exited 1/);
  assert.equal(none.session_id, 'sess-1234-abcd');
  assert.equal(turnResult(log([result('A'), result('B')]), 'B').result, 'B', 'no replay (an older Claude): the last result');
  const blocks = { type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: 'B' }] } };
  assert.equal(turnResult(log([blocks, result('B')]), 'B').result, 'B');
});

test('steer (runner): only the ask a live turn answers now takes a follow-up, through its inbox, and the chain survives on disk', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  const b = box();
  const r = runner(home, b);
  const { turnId } = await r.sendMessage(askJob(RUN, 'please look', { liveInput: true }));
  const { meta, dir } = b.procs.get(turnId);
  assert.equal(meta.live, true, 'an ask run can be a live turn');
  assert.ok(meta.args.includes('--replay-user-messages'));

  // Nothing joins a running ask turn as a send: a person's message, or another ask.
  assert.equal((await r.sendMessage(askJob(null, 'a person', { liveInput: true }))).queued, true);
  assert.equal((await r.sendMessage(askJob('runzzzz0009', 'another ask', { liveInput: true }))).queued, true);
  assert.equal(fs.existsSync(path.join(dir, 'inbox')), false);

  assert.deepEqual(await r.steerAsk({ runId: RUN, newRunId: R2, text: 'actually, B' }), { steered: true, turnId });
  const [file] = fs.readdirSync(path.join(dir, 'inbox'));
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'inbox', file), 'utf8'));
  assert.equal(job.text, 'actually, B');
  assert.equal(job.ask.runId, R2);
  assert.equal(job.ask.systemPrompt, 'RULES', 'the turn\'s own ask settings');
  assert.equal(job.liveInput, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'asks.json'), 'utf8')), [{ runId: R2, inbox: file, text: 'actually, B' }]);
  assert.deepEqual(r.findAsk(R2), { state: 'running', chatKey: 'p1--wsask', turnId });
  assert.deepEqual(await r.steerAsk({ runId: RUN, newRunId: R3, text: 'C' }), { steered: false, reason: 'superseded' }, 'the turn answers R2 now');
  assert.equal((await r.cancelAsk(RUN)).stopped, false, 'nor is it RUN\'s to stop');
  assert.equal((await r.steerAsk({ runId: R2, newRunId: R3, text: 'C' })).steered, true, 'several in a row');

  // An agent restart: a new runner on the same home finds the chain.
  const again = runner(home, b);
  await again.recover();
  assert.equal(again.findAsk(R3)?.state, 'running');

  assert.deepEqual(await r.steerAsk({ runId: 'runzzzz0009', newRunId: 'runzzzz0010', text: 'x' }), { steered: false, reason: 'queued' });
  b.finish(turnId, [result('A')]);
  assert.deepEqual(await r.steerAsk({ runId: R3, newRunId: 'runzzzz0011', text: 'too late' }), { steered: false, reason: 'finished' }, 'exit is there: the inbox may be drained already');
});

test('steer (runner): a turn that is not live takes no follow-up', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  const b = box();
  const r = runner(home, b);
  await r.sendMessage(askJob(RUN));
  assert.deepEqual(await r.steerAsk({ runId: RUN, newRunId: R2, text: 'B' }), { steered: false, reason: 'not_live' });
  assert.deepEqual(await r.steerAsk({ runId: 'runnone0001', newRunId: R2, text: 'B' }), { steered: false, reason: 'gone' });
});

test('steer (runner): a live turn whose wrapper closed stdin takes no follow-up, so it queues as the next turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  const b = box();
  const r = runner(home, b);
  const { turnId } = await r.sendMessage(askJob(RUN, 'please look', { liveInput: true }));
  const { dir } = b.procs.get(turnId);
  // chat-turn.js ended Claude's stdin; Claude may still run on (a background task woke it).
  fs.writeFileSync(path.join(dir, 'stdin-ended'), '');
  assert.deepEqual(await r.steerAsk({ runId: RUN, newRunId: R2, text: 'B' }), { steered: false, reason: 'input_closed' });
  assert.equal(fs.existsSync(path.join(dir, 'inbox')), false, 'nothing in the inbox nobody reads');
  assert.equal(fs.existsSync(path.join(dir, 'asks.json')), false, 'the turn still answers RUN');
  assert.equal(r.findAsk(R2), null);
});

test('steer (ask-chat): a follow-up to a turn that closed its input is refused, and the run reports its own answer', async () => {
  const { home, b, a, chats } = askBox();
  a.startRun(runMsg(RUN, { live: true }), path.join(home, 'proj'));
  const proc = await until(() => [...b.procs.values()][0]);
  fs.writeFileSync(path.join(proc.dir, 'stdin-ended'), '');
  const res = await a.steerRun(steerMsg(R2, 'and B'), path.join(home, 'proj'));
  assert.deepEqual([res.started, res.steered, res.reason], [false, false, 'input_closed']);
  assert.equal(a.status({ runId: RUN }).running, true, 'not superseded');
  b.finish(proc.meta.turnId, [result('the answer to A')]);
  await chats.poll();
  const reported = await until(() => fs.existsSync(path.join(home, 'reported.json')) && JSON.parse(fs.readFileSync(path.join(home, 'reported.json'), 'utf8')));
  assert.deepEqual(reportedRuns(home), [RUN]);
  assert.equal(reported.result, 'the answer to A');
  assert.equal([...b.procs.values()].some(p => p.meta.ask?.runId === R2), false, 'B waits for the orchestrator, not in this box\'s queue');
});

test('steer (runner): a turn on an engine with no live input takes the follow-up as the next turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-chat-'));
  const b = box();
  const r = runner(home, b);
  const { turnId } = await r.sendMessage(askJob(RUN, 'please look', { liveInput: true }));
  // What a pi turn records (the chat runner's pi engine, example-org/termag#720); the runner holds this meta.
  b.procs.get(turnId).meta.engine = 'pi';
  const res = await r.steerAsk({ runId: RUN, newRunId: R2, text: 'B' });
  assert.deepEqual(res, { steered: false, reason: 'engine_no_live_input:pi' });
});

const steerMsg = (runId, prompt, extra = {}) => runMsg(runId, { prompt, steerOf: RUN, live: true, ...extra });
const reportedRuns = home => (fs.existsSync(path.join(home, 'runner-calls')) ? fs.readFileSync(path.join(home, 'runner-calls'), 'utf8') : '')
  .split('\n').filter(l => l.startsWith('--report')).map(l => path.basename(l.split(' ')[1], '.json'));

test('steer (ask-chat): a follow-up joins the live turn, supersedes the run, and the turn reports it with its own answer', async () => {
  const { home, b, a } = askBox();
  a.startRun(runMsg(RUN, { live: true }), path.join(home, 'proj'));
  const proc = await until(() => [...b.procs.values()][0]);
  assert.equal(proc.meta.live, true);
  const res = await a.steerRun(steerMsg(R2, 'no wait, do B'), path.join(home, 'proj'));
  assert.equal(res.steered, true);
  assert.equal(res.turnId, proc.meta.turnId);
  assert.deepEqual(a.status({ runId: RUN }), { running: false, known: true, stage: 'superseded', supersededBy: R2 });
  assert.equal(a.status({ runId: R2 }).running, true);
  assert.deepEqual(await a.cancel({ runId: RUN }), { stopped: false, stage: 'superseded', supersededBy: R2 }, 'canceling the superseded run stops nothing');
  deliver(proc.dir);
  b.finish(proc.meta.turnId, [result('the answer to A'), replay('no wait, do B'), result('the answer to B')]);
  await a.onTurnDone(proc.meta, proc.dir);
  const reported = await until(() => fs.existsSync(path.join(home, 'reported.json')) && JSON.parse(fs.readFileSync(path.join(home, 'reported.json'), 'utf8')));
  assert.equal(reported.result, 'the answer to B');
  assert.deepEqual(reportedRuns(home), [R2], 'reported once, as the follow-up');
  assert.equal(fs.existsSync(path.join(home, '.termag/subagent/jobs', `${RUN}.json`)), false, 'the superseded run\'s tombstone is gone');
});

test('steer (ask-chat): a follow-up that misses Claude\'s last read is the next turn, and only it reports', async () => {
  const { home, b, a, chats } = askBox();
  a.startRun(runMsg(RUN, { live: true }), path.join(home, 'proj'));
  const first = await until(() => [...b.procs.values()][0]);
  assert.equal((await a.steerRun(steerMsg(R2, 'and B'), path.join(home, 'proj'))).steered, true);
  // stdin already closed: the wrapper never wrote it, Claude answered A and exited.
  b.finish(first.meta.turnId, [result('the answer to A')]);
  await chats.poll();
  assert.deepEqual(reportedRuns(home), [], 'A is superseded, so its answer is not the reply');
  const second = await until(() => [...b.procs.values()].find(p => p.meta.turnId !== first.meta.turnId));
  assert.equal(second.meta.text, 'and B');
  assert.equal(second.meta.ask.runId, R2);
  assert.equal(second.meta.live, true, 'the next turn can be steered too');
  b.finish(second.meta.turnId, [result('the answer to B')]);
  await chats.poll();
  const reported = await until(() => fs.existsSync(path.join(home, 'reported.json')) && JSON.parse(fs.readFileSync(path.join(home, 'reported.json'), 'utf8')));
  assert.deepEqual(reportedRuns(home), [R2]);
  assert.equal(reported.result, 'the answer to B');
});

// At most one turn runs in a thread's clone: a follow-up the box can't steer starts nothing here; the orchestrator holds it.
const preparedRuns = home => (fs.existsSync(path.join(home, 'runner-calls')) ? fs.readFileSync(path.join(home, 'runner-calls'), 'utf8') : '')
  .split('\n').filter(l => l.startsWith('--prepare')).map(l => path.basename(l.split(' ')[1], '.json'));

test('steer (ask-chat): a follow-up the turn can\'t take is refused, and nothing starts in the clone', async () => {
  const { home, b, a, chats } = askBox();
  a.startRun(runMsg(RUN, { live: true }), path.join(home, 'proj'));
  const first = await until(() => [...b.procs.values()][0]);
  // The turn has ended and is about to report: its --report still reads the clone.
  b.finish(first.meta.turnId, [result('the answer to A')]);
  const late = await a.steerRun(steerMsg(R2, 'B, late'), path.join(home, 'proj'));
  assert.deepEqual([late.started, late.steered, late.reason], [false, false, 'finished']);
  await chats.poll();
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(preparedRuns(home), [RUN], 'B was never prepared');
  assert.equal(fs.existsSync(path.join(home, '.termag/subagent/jobs', `${R2}.json`)), false);
  assert.equal([...b.procs.values()].some(p => p.meta.ask?.runId === R2), false, 'nor run as a turn');

  // While A's clone is still being prepared there is no turn to join either.
  const c = askBox();
  fs.writeFileSync(path.join(c.home, 'prepare-hangs'), '');
  c.a.startRun(runMsg(RUN, { live: true }), path.join(c.home, 'proj'));
  await until(() => fs.existsSync(path.join(c.home, 'prepare-pid')));
  const early = await c.a.steerRun(steerMsg(R2, 'B, early'), path.join(c.home, 'proj'));
  assert.deepEqual([early.started, early.steered, early.reason], [false, false, 'preparing']);
  assert.deepEqual(preparedRuns(c.home), [RUN]);
  await c.a.cancel({ runId: RUN });
});

test('steer (ask-chat): a follow-up to a headless run is refused, so it never prepares while that run holds the clone', async () => {
  const { home, a } = askBox();
  const jobs = path.join(home, '.termag/subagent/jobs');
  fs.mkdirSync(jobs, { recursive: true });
  // What agent/ask-run.js leaves for a full termag-subagent-run: no chat mode.
  fs.writeFileSync(path.join(jobs, `${RUN}.json`), JSON.stringify({ runId: RUN, threadId: THREAD, cwd: path.join(home, 'proj') }));
  const res = await a.steerRun(steerMsg(R2, 'B'), path.join(home, 'proj'));
  assert.deepEqual([res.started, res.steered, res.reason], [false, false, 'headless']);
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(preparedRuns(home), []);
});

test('steer (ask-chat): ask-run-status says whether a run is a live chat turn, which is all a follow-up can join', async () => {
  const { home, b, a } = askBox();
  a.startRun(runMsg(RUN, { live: true }), path.join(home, 'proj'));
  await until(() => [...b.procs.values()][0]);
  assert.deepEqual(a.status({ runId: RUN }), { running: true, known: true, stage: 'sent', mode: 'chat', live: true });
  a.startRun(runMsg(R3), path.join(home, 'proj'));
  await until(() => a.status({ runId: R3 }).stage === 'sent');
  assert.equal(a.status({ runId: R3 }).live, false);
});

test('steer (ask-chat): canceling the follow-up stops the turn and reports nothing; a stopped turn fails a follow-up it never read', async () => {
  const { home, b, a, chats } = askBox();
  a.startRun(runMsg(RUN, { live: true }), path.join(home, 'proj'));
  const proc = await until(() => [...b.procs.values()][0]);
  await a.steerRun(steerMsg(R2, 'B'), path.join(home, 'proj'));
  const stop = await a.cancel({ runId: R2 });
  assert.equal(stop.stopped, true);
  b.finish(proc.meta.turnId, []);
  await chats.poll();
  assert.deepEqual(reportedRuns(home), []);
  assert.deepEqual(fs.readdirSync(path.join(home, '.termag/subagent/jobs')).filter(f => f.endsWith('.json')), [], 'no tombstone left behind');

  // The chat is cleared under a steered turn: the follow-up still in its inbox is answered as failed.
  const c = askBox();
  c.a.startRun(runMsg(RUN, { live: true }), path.join(c.home, 'proj'));
  const p2 = await until(() => [...c.b.procs.values()][0]);
  await c.a.steerRun(steerMsg(R2, 'B'), path.join(c.home, 'proj'));
  await c.chats.clear('p1--wsask');
  c.b.finish(p2.meta.turnId, []);
  await c.chats.poll();
  const failed = await until(() => fs.existsSync(path.join(c.home, 'failed.txt')) && fs.readFileSync(path.join(c.home, 'failed.txt'), 'utf8'));
  // clear drops what waits in the inbox (onDropped); a turn that stops on its own leaves it to onTurnDone.
  assert.match(failed, /stopped before this (ask ran|follow-up went in)/);
});

test('steer (ask-chat): after an agent restart the follow-up is found in its turn, not reported lost', async () => {
  const { home, b, a } = askBox();
  a.startRun(runMsg(RUN, { live: true }), path.join(home, 'proj'));
  await until(() => [...b.procs.values()][0]);
  await a.steerRun(steerMsg(R2, 'B'), path.join(home, 'proj'));
  let a2 = null;
  const chats2 = runner(home, b, { onTurnDone: (m, d) => a2.onTurnDone(m, d), onDropped: j => a2.onDropped(j) });
  a2 = createAskChat({ home, chats: chats2, spawn: (cmd, args, opts) => spawn(cmd, args, { ...opts, env: { ...process.env, HOME: home } }) });
  await chats2.recover();
  await a2.reconcile();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fs.existsSync(path.join(home, 'failed.txt')), false);
  assert.equal(chats2.findAsk(R2)?.state, 'running');
  assert.equal(a2.status({ runId: RUN }).supersededBy, R2);
});

test('ask-chat: an ask\'s run and a person\'s message in its chat both export as kind ask, saying who asked', async () => {
  const { home, b } = askBox();
  const asked = [];
  const ask = { thread: THREAD, hop: 2, parent: { box: 'devbox', project: 'termag', workstream: 'main', session: '0b7c2f7e-1c1d-4c55-9a43-2f0e6d1b8a10' } };
  const r = runner(home, b, { telemetrySettings: async o => { asked.push(o); return null; } });
  const a2 = createAskChat({ home, chats: r, spawn: (cmd, args, opts) => spawn(cmd, args, { ...opts, env: { ...process.env, HOME: home } }) });
  a2.startRun(runMsg(RUN, { telemetry: ask }), path.join(home, 'proj'));
  const first = await until(() => [...b.procs.values()][0]);
  assert.deepEqual(asked.at(-1), { project: undefined, workstream: `ask-${THREAD}`, kind: 'ask', ask });
  assert.equal(first.meta.env.TERMAG_SESSION_KIND, 'ask', 'the run\'s environment names its kind too');
  b.finish(first.meta.turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-1234-abcd' }, { type: 'result', result: 'a', session_id: 'sess-1234-abcd' }]);
  r.setSession('p1--wsask', { sessionId: 'sess-1234-abcd', cwd: first.meta.cwd });
  await r.poll();
  const person = { thread: THREAD, parent: ask.parent };
  await a2.sendMessage({
    chatKey: 'p1--wsask', projectId: 'p1', project: 'webapp', workstream: `ask-${THREAD}`, workstreamId: 'wsask', text: 'and also this',
    ask: { threadId: THREAD, baseSha: null, gitName: 'Ada', gitEmail: 'ada@example.com', telemetry: person },
  }, path.join(home, 'proj'));
  assert.deepEqual(asked.at(-1), { project: 'webapp', workstream: `ask-${THREAD}`, kind: 'ask', ask: person });
  assert.equal([...b.procs.values()].at(-1).meta.env.TERMAG_SESSION_KIND, 'ask', 'a person\'s turn in the thread\'s chat is the same session');
  // An older orchestrator's message names no one: the thread alone, still kind ask.
  b.finish([...b.procs.values()].at(-1).meta.turnId, [{ type: 'result', result: 'b', session_id: 'sess-1234-abcd' }]);
  await r.poll();
  await a2.sendMessage({
    chatKey: 'p1--wsask', projectId: 'p1', workstream: `ask-${THREAD}`, workstreamId: 'wsask', text: 'one more',
    ask: { threadId: THREAD, baseSha: null, gitName: 'Ada', gitEmail: 'ada@example.com' },
  }, path.join(home, 'proj'));
  assert.deepEqual(asked.at(-1), { project: undefined, workstream: `ask-${THREAD}`, kind: 'ask', ask: { thread: THREAD } });
});

test('ask-chat: the chat keeps the project\'s name for its telemetry, and an older orchestrator\'s chat has none', () => {
  const chat = { chatKey: 'p1--wsask', projectId: 'p1', workstream: 'ask-x', workstreamId: 'wsask' };
  assert.equal(chatOf({ chat: { ...chat, project: 'webapp' } }).project, 'webapp');
  assert.equal('project' in chatOf({ chat }), false);
  assert.equal('project' in chatOf({ chat: { ...chat, project: 7 } }), false);
});
