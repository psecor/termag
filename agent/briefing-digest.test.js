'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { briefingDigest, digestTranscripts, readTail, parseCommits, encodeCwd, logDirFor, CAPABILITIES } = require('./briefing-digest');

const SINCE = '2026-10-10T00:00:00.000Z';
const UNTIL = '2026-10-11T00:00:00.000Z';
const CWD = '/home/u/termag/projects/foo/.worktrees/bar';
const IN = (h, m = 0) => `2026-10-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

const user = (at, content, extra = {}) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content }, ...extra });
const asst = (at, blocks) => JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const todo = (todos) => ({ type: 'tool_use', name: 'TodoWrite', input: { todos } });

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-digest-'));
}

function writeLog(home, name, lines, mtime = new Date(IN(12))) {
  const dir = logDirFor(home, CWD);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  fs.utimesSync(p, mtime, mtime);
  return p;
}

// git stub: answers by the subcommand, or fails like a non-checkout.
function gitStub({ log = '', branch = 'feat/x', email = 'pat@example.com', fail = false } = {}) {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push(args);
    if (fail) throw new Error('fatal: not a git repository');
    if (args.includes('log')) return { stdout: log };
    if (args.includes('rev-parse')) return { stdout: `${branch}\n` };
    if (args.includes('config')) {
      if (email === null) throw new Error('exit 1');
      return { stdout: `${email}\n` };
    }
    throw new Error('unexpected');
  };
  return { execFile, calls };
}

test('capability and cwd encoding', () => {
  assert.deepEqual(CAPABILITIES, ['briefing-v1']);
  assert.equal(encodeCwd(CWD), '-home-u-termag-projects-foo--worktrees-bar');
});

test('newest TodoWrite list wins, statuses normalized, caps applied', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ content: `item ${i} ${'x'.repeat(300)}`, status: 'pending' }));
  const d = digestTranscripts([[
    asst(IN(1), [todo([{ content: 'old', status: 'pending' }])]),
    asst(IN(2), [todo([{ content: 'a', status: 'completed' }, { content: 'b', status: 'weird' }])]),
  ].join('\n'), asst(IN(3), [todo(many)])], Date.parse(SINCE), Date.parse(UNTIL));
  assert.equal(d.todos.length, 30);
  assert.ok(d.todos[0].content.length <= 200);
  const d2 = digestTranscripts([[
    asst(IN(1), [todo([{ content: 'old', status: 'pending' }])]),
    asst(IN(2), [todo([{ content: 'a', status: 'completed' }, { content: 'b', status: 'weird' }])]),
  ].join('\n')], Date.parse(SINCE), Date.parse(UNTIL));
  assert.deepEqual(d2.todos, [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]);
});

test('trailing assistant question sets endsWithQuestion; a later user prompt clears it', () => {
  const s = Date.parse(SINCE); const u = Date.parse(UNTIL);
  const q = digestTranscripts([[user(IN(1), 'do it'), asst(IN(2), [text('Done.\nShould I also keep the ctrl pane?\n')])].join('\n')], s, u);
  assert.equal(q.endsWithQuestion, true);
  const answered = digestTranscripts([[user(IN(1), 'do it'), asst(IN(2), [text('Keep it?')]), user(IN(3), 'yes')].join('\n')], s, u);
  assert.equal(answered.endsWithQuestion, false);
  const statement = digestTranscripts([[user(IN(1), 'go'), asst(IN(2), [text('All done.')])].join('\n')], s, u);
  assert.equal(statement.endsWithQuestion, false);
  const kept = digestTranscripts([[user(IN(1), 'go'), asst(IN(2), [text('Should I add tests?'), { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }]),
    JSON.stringify({ type: 'user', timestamp: IN(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }] } })].join('\n')], s, u);
  assert.equal(kept.endsWithQuestion, false, 'kept working after asking');
  const ask = digestTranscripts([[user(IN(1), 'go'), asst(IN(2), [{ type: 'tool_use', id: 't8', name: 'AskUserQuestion', input: { questions: [] } }])].join('\n')], s, u);
  assert.equal(ask.endsWithQuestion, true, 'an unanswered AskUserQuestion');
  const answered2 = digestTranscripts([[user(IN(1), 'go'), asst(IN(2), [{ type: 'tool_use', id: 't8', name: 'AskUserQuestion', input: { questions: [] } }]),
    JSON.stringify({ type: 'user', timestamp: IN(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't8', content: 'A' }] } })].join('\n')], s, u);
  assert.equal(answered2.endsWithQuestion, false, 'an answered AskUserQuestion');
  const midParagraph = digestTranscripts([[user(IN(1), 'go'), asst(IN(2), [text('Two tests fail. Give each test its own user, or raise the limit? The first touches 30 files.')])].join('\n')], s, u);
  assert.equal(midParagraph.endsWithQuestion, true);
  for (const t of ['Set `x ?? y` and done.', 'Open /p?project=1 to see it.', 'Ran:\n```\nfoo?\n```\nAll green.', 'Fixed the `?` key.']) {
    assert.equal(digestTranscripts([[user(IN(1), 'go'), asst(IN(2), [text(t)])].join('\n')], s, u).endsWithQuestion, false, t);
  }
});

test('tool results, meta and command lines are not prompts', () => {
  const d = digestTranscripts([[
    user(IN(1), [{ type: 'tool_result', tool_use_id: 't', content: 'output' }]),
    user(IN(2), 'meta line', { isMeta: true }),
    user(IN(3), '<command-name>/model</command-name>'),
    user(IN(4), '<local-command-stdout>x</local-command-stdout>'),
    user(IN(5), 'Caveat: the messages below'),
    user(IN(6), [text('real   prompt\n\nhere')]),
    'not json',
  ].join('\n')], Date.parse(SINCE), Date.parse(UNTIL));
  assert.equal(d.userTurns, 1);
  assert.deepEqual(d.lastUserPrompts, ['real prompt here']);
});

test('entries outside the window are ignored; none in window is null', () => {
  const s = Date.parse(SINCE); const u = Date.parse(UNTIL);
  const d = digestTranscripts([[user('2026-10-09T23:59:00.000Z', 'before'), user(IN(10), 'inside'), user('2026-10-11T00:00:01.000Z', 'after')].join('\n')], s, u);
  assert.deepEqual(d.lastUserPrompts, ['inside']);
  assert.equal(d.firstAt, IN(10));
  assert.equal(d.lastAt, IN(10));
  assert.equal(digestTranscripts([user('2026-10-09T01:00:00.000Z', 'old')], s, u), null);
});

test('prompt and assistant truncation keep the right ends', () => {
  const long = 'q'.repeat(2000) + ' final question?';
  const prompts = Array.from({ length: 8 }, (_, i) => user(IN(1, i), `p${i} ${'y'.repeat(400)}`));
  const d = digestTranscripts([[...prompts, asst(IN(2), [text(long)])].join('\n')], Date.parse(SINCE), Date.parse(UNTIL));
  assert.equal(d.userTurns, 8);
  assert.equal(d.lastUserPrompts.length, 5);
  assert.ok(d.lastUserPrompts[0].startsWith('p3 '));
  assert.ok(d.lastUserPrompts.every(p => p.length <= 300));
  assert.ok(d.lastAssistantText.length <= 1200);
  assert.ok(d.lastAssistantText.endsWith('final question?'));
  assert.equal(d.endsWithQuestion, true);
});

test('readTail drops a cut first line beyond the byte cap', () => {
  const home = tmpHome();
  const p = path.join(home, 'big.jsonl');
  const filler = 'z'.repeat(1000);
  fs.writeFileSync(p, `${filler}\n${user(IN(9), 'kept')}\n`);
  const t = readTail(p, 300);
  assert.ok(!t.includes(filler));
  assert.ok(t.includes('kept'));
  assert.equal(readTail(p), fs.readFileSync(p, 'utf8'));
});

test('briefingDigest: multi-file counting, 4 MB tail, git commits and branch', async () => {
  const home = tmpHome();
  const pad = JSON.stringify({ type: 'progress', timestamp: '2026-10-01T00:00:00.000Z', pad: 'p'.repeat(1024 * 1024) });
  writeLog(home, 'a.jsonl', [user(IN(1), 'lost to the tail'), pad, pad, pad, pad, pad, user(IN(2), 'first file')], new Date(IN(13)));
  writeLog(home, 'b.jsonl', [user(IN(3), 'second file'), asst(IN(4), [text('Merge it?')])], new Date(IN(14)));
  writeLog(home, 'stale.jsonl', [user(IN(5), 'too old by mtime')], new Date('2026-10-01T00:00:00.000Z'));
  const git = gitStub({ log: 'abc1234\t2026-10-10T10:00:00+00:00\tfeat: one\ttab\ndef5678\t2026-10-10T09:00:00+00:00\tfix: two\n' });
  const r = await briefingDigest({ cwd: CWD, since: SINCE, until: UNTIL }, { home, execFile: git.execFile });
  assert.equal(r.transcript.userTurns, 2);
  assert.deepEqual(r.transcript.lastUserPrompts, ['first file', 'second file']);
  assert.equal(r.transcript.endsWithQuestion, true);
  assert.deepEqual(r.commits, [
    { sha: 'abc1234', at: '2026-10-10T10:00:00+00:00', subject: 'feat: one\ttab' },
    { sha: 'def5678', at: '2026-10-10T09:00:00+00:00', subject: 'fix: two' },
  ]);
  assert.equal(r.branch, 'feat/x');
  const logArgs = git.calls.find(a => a.includes('log'));
  assert.deepEqual(logArgs.slice(0, 2), ['-C', CWD]);
  assert.ok(logArgs.includes(`--since=${SINCE}`) && logArgs.includes(`--until=${UNTIL}`));
  assert.ok(logArgs.includes('--no-merges'));
  assert.ok(logArgs.includes('--fixed-strings') && logArgs.includes('--author=<pat@example.com>'));
});

test('briefingDigest: the author filter is exact in a real repository', async (t) => {
  const { execFile: cpExecFile, execFileSync } = require('child_process');
  const { promisify } = require('util');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  git('config', 'user.email', 'pat@example.com');
  git('config', 'user.name', 'Pat');
  const commit = (email, msg) => git('-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', msg);
  commit('pat@example.com', 'mine');
  commit('apat@example.com', 'a longer address');
  commit('pat@example.com.au', 'another domain');
  const r = await briefingDigest(
    { cwd: repo, since: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() + 60_000).toISOString() },
    { home: tmpHome(), execFile: promisify(cpExecFile) },
  );
  assert.deepEqual(r.commits.map(c => c.subject), ['mine']);
});

test('briefingDigest: no git identity lists every author', async () => {
  const git = gitStub({ email: null });
  await briefingDigest({ cwd: CWD, since: SINCE, until: UNTIL }, { home: tmpHome(), execFile: git.execFile });
  const logArgs = git.calls.find(a => a.includes('log'));
  assert.ok(logArgs.includes('--no-merges'));
  assert.ok(!logArgs.some(a => a.startsWith('--author')));
});

test('briefingDigest: missing log dir and non-checkout', async () => {
  const r = await briefingDigest({ cwd: CWD, since: SINCE, until: UNTIL }, { home: tmpHome(), execFile: gitStub({ fail: true }).execFile });
  assert.deepEqual(r, { transcript: null, commits: [], branch: null });
});

test('briefingDigest: detached HEAD is a null branch', async () => {
  const r = await briefingDigest({ cwd: CWD, since: SINCE, until: UNTIL }, { home: tmpHome(), execFile: gitStub({ branch: 'HEAD' }).execFile });
  assert.equal(r.branch, null);
});

test('briefingDigest: bad payloads throw', async () => {
  const deps = { home: tmpHome(), execFile: gitStub().execFile };
  await assert.rejects(briefingDigest({ since: SINCE, until: UNTIL }, deps), /cwd/);
  await assert.rejects(briefingDigest({ cwd: CWD, since: 'nope', until: UNTIL }, deps), /since/);
  await assert.rejects(briefingDigest({ cwd: CWD, since: UNTIL, until: SINCE }, deps), /since/);
});

test('parseCommits caps at 20 and skips junk lines', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `s${i}\t2026-10-10T00:00:00Z\tm${i}`).join('\n');
  assert.equal(parseCommits(`junk\n${lines}`).length, 20);
});
