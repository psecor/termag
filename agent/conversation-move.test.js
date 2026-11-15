'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLAUDE_SLUG_MAX, carryConversations, mergeInto, moveConversations, movedCheckouts } = require('./conversation-move');
const { renameProject } = require('./project-rename');
const { slugForCwd } = require('./chat-runner');
const { piSessionSlug } = require('./pi-session');

/** A box home with a projects root, spelled as realpath spells it. */
function box() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-move-')));
  const projects = path.join(home, 'termag', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return { home, projects, claude: path.join(home, '.claude', 'projects'), pi: path.join(home, '.pi', 'agent', 'sessions') };
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A Claude conversation of `cwd`: its transcript and its session folder. */
function claudeSession(b, cwd, id, content = `{"cwd":"${cwd}"}\n`) {
  write(path.join(b.claude, slugForCwd(cwd), `${id}.jsonl`), content);
  write(path.join(b.claude, slugForCwd(cwd), id, 'subagents', 'agent-a1.jsonl'));
}

const noExec = { execFile: async () => {} };

test('the folder names are the ones Claude Code and pi give a cwd', () => {
  assert.equal(slugForCwd('/home/u/termag/projects/event-recorder/.worktrees/fix_1'), '-home-u-termag-projects-event-recorder--worktrees-fix-1');
  assert.equal(piSessionSlug('/home/u/termag/projects/event-recorder'), '--home-u-termag-projects-event-recorder--');
});

test('a rename carries the project\'s and each worktree\'s conversations to the new name', async () => {
  const b = box();
  const from = path.join(b.projects, 'event-recorder');
  const to = path.join(b.projects, 'elp-metrics-monitoring');
  fs.mkdirSync(path.join(from, '.worktrees', 'fix'), { recursive: true });
  claudeSession(b, from, 's-main');
  claudeSession(b, path.join(from, '.worktrees', 'fix'), 's-fix');
  write(path.join(b.claude, slugForCwd(from), 'memory', 'MEMORY.md'), 'notes');
  write(path.join(b.pi, piSessionSlug(from), '2026-11-09_p1.jsonl'));

  const result = await renameProject({ sessions: [], fromDir: from, toDir: to, conversations: { home: b.home } }, noExec);

  assert.equal(result.movedDir, true);
  assert.deepEqual(result.conversations, {
    claude: [
      { from: slugForCwd(from), to: slugForCwd(to), moved: 3, kept: 0 },
      { from: slugForCwd(path.join(from, '.worktrees', 'fix')), to: slugForCwd(path.join(to, '.worktrees', 'fix')), moved: 2, kept: 0 },
    ],
    pi: [{ from: piSessionSlug(from), to: piSessionSlug(to), moved: 1, kept: 0 }],
    left: [],
  });
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(to), 's-main.jsonl')), true);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(to), 's-main', 'subagents', 'agent-a1.jsonl')), true);
  assert.equal(fs.readFileSync(path.join(b.claude, slugForCwd(to), 'memory', 'MEMORY.md'), 'utf8'), 'notes');
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(to, '.worktrees', 'fix')), 's-fix.jsonl')), true);
  assert.equal(fs.existsSync(path.join(b.pi, piSessionSlug(to), '2026-11-09_p1.jsonl')), true);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(from))), false);
  assert.equal(fs.existsSync(path.join(b.pi, piSessionSlug(from))), false);
});

test('another project whose folder name starts the same is left alone', async () => {
  const b = box();
  const from = path.join(b.projects, 'event');
  fs.mkdirSync(from);
  fs.mkdirSync(path.join(b.projects, 'event-recorder'));
  claudeSession(b, from, 's-event');
  claudeSession(b, path.join(b.projects, 'event-recorder'), 's-other');

  const result = await renameProject({ sessions: [], fromDir: from, toDir: path.join(b.projects, 'events'), conversations: { home: b.home } }, noExec);

  assert.equal(result.conversations.claude.length, 1);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(b.projects, 'event-recorder')), 's-other.jsonl')), true);
});

test('a folder another project also encodes to is left alone, and said so', () => {
  const b = box();
  const from = path.join(b.projects, 'my_app');
  fs.mkdirSync(path.join(b.projects, 'my-app'));
  claudeSession(b, from, 's1');
  const result = moveConversations({ home: b.home, checkouts: [{ from, to: path.join(b.projects, 'other') }] });
  assert.deepEqual(result.claude, []);
  assert.deepEqual(result.left, [{ store: 'claude', from: slugForCwd(from), reason: 'shared with another directory' }]);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(from), 's1.jsonl')), true);
});

test('merging into an existing folder overwrites nothing', () => {
  const b = box();
  const src = path.join(b.claude, 'old');
  const dst = path.join(b.claude, 'new');
  write(path.join(src, 'same.jsonl'), 'old copy');
  write(path.join(src, 'only-old.jsonl'), 'a');
  write(path.join(src, 'same', 'subagents', 'agent-x.jsonl'), 'x');
  write(path.join(src, 'same', 'tool-results', 'r.txt'), 'old result');
  write(path.join(dst, 'same.jsonl'), 'new copy, longer');
  write(path.join(dst, 'same', 'tool-results', 'r.txt'), 'new result');

  assert.deepEqual(mergeInto(src, dst, fs), { moved: 2, kept: 2 });

  assert.equal(fs.readFileSync(path.join(dst, 'same.jsonl'), 'utf8'), 'new copy, longer');
  assert.equal(fs.readFileSync(path.join(dst, 'only-old.jsonl'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(dst, 'same', 'subagents', 'agent-x.jsonl'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(dst, 'same', 'tool-results', 'r.txt'), 'utf8'), 'new result');
  // What both had stays where it was, so nothing is lost.
  assert.equal(fs.readFileSync(path.join(src, 'same.jsonl'), 'utf8'), 'old copy');
  assert.equal(fs.readFileSync(path.join(src, 'same', 'tool-results', 'r.txt'), 'utf8'), 'old result');
  assert.equal(fs.existsSync(path.join(src, 'only-old.jsonl')), false);
});

test('a second call, and a project where nothing ever ran, move nothing', async () => {
  const b = box();
  const from = path.join(b.projects, 'a');
  const to = path.join(b.projects, 'b');
  fs.mkdirSync(from);
  claudeSession(b, from, 's1');
  const plan = { sessions: [], fromDir: from, toDir: to, conversations: { home: b.home } };
  assert.equal((await renameProject(plan, noExec)).conversations.claude.length, 1);
  assert.deepEqual((await renameProject(plan, noExec)).conversations, { claude: [], pi: [], left: [] });

  const fresh = box();
  fs.mkdirSync(path.join(fresh.projects, 'x'));
  const result = await renameProject({ sessions: [], fromDir: path.join(fresh.projects, 'x'), toDir: path.join(fresh.projects, 'y'), conversations: { home: fresh.home } }, noExec);
  assert.deepEqual(result.conversations, { claude: [], pi: [], left: [] });
});

test('a retry after the folder moved on an earlier call still carries the conversations', async () => {
  const b = box();
  const from = path.join(b.projects, 'a');
  const to = path.join(b.projects, 'b');
  fs.mkdirSync(to);
  claudeSession(b, from, 's1');
  const result = await renameProject({ sessions: [], fromDir: from, toDir: to, conversations: { home: b.home } }, noExec);
  assert.equal(result.movedDir, false);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(to), 's1.jsonl')), true);
});

test('without `conversations` (an older backend) the rename leaves them where they are', async () => {
  const b = box();
  const from = path.join(b.projects, 'a');
  fs.mkdirSync(from);
  claudeSession(b, from, 's1');
  const result = await renameProject({ sessions: [], fromDir: from, toDir: path.join(b.projects, 'b') }, noExec);
  assert.equal('conversations' in result, false);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(from), 's1.jsonl')), true);
});

test('a refused rename moves no conversations', async () => {
  const b = box();
  const from = path.join(b.projects, 'a');
  fs.mkdirSync(from);
  fs.mkdirSync(path.join(b.projects, 'b'));
  claudeSession(b, from, 's1');
  await assert.rejects(renameProject({ sessions: [], fromDir: from, toDir: path.join(b.projects, 'b'), conversations: { home: b.home } }, noExec), /already exists/);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(from), 's1.jsonl')), true);
});

test('a conversation started through a symlinked projects root moves as its realpath names it', async () => {
  const b = box();
  const link = path.join(b.home, 'link');
  fs.symlinkSync(b.projects, link);
  fs.mkdirSync(path.join(b.projects, 'a'));
  claudeSession(b, path.join(b.projects, 'a'), 's-real');
  claudeSession(b, path.join(link, 'a'), 's-link');
  const result = await renameProject({ sessions: [], fromDir: path.join(link, 'a'), toDir: path.join(link, 'b'), conversations: { home: b.home } }, noExec);
  assert.equal(result.conversations.claude.length, 2);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(b.projects, 'b')), 's-real.jsonl')), true);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(link, 'b')), 's-link.jsonl')), true);
});

test('a multi-repo project\'s checkouts are listed in every workstream root', () => {
  const b = box();
  const to = path.join(b.projects, 'new');
  fs.mkdirSync(path.join(to, '.worktrees', 'fix'), { recursive: true });
  const from = path.join(b.projects, 'old');
  assert.deepEqual(movedCheckouts({ fromDir: from, toDir: to, repos: ['web'] }).map(c => [c.from, c.to]), [
    [from, to],
    [path.join(from, '.worktrees', 'fix'), path.join(to, '.worktrees', 'fix')],
    [path.join(from, 'web'), path.join(to, 'web')],
    [path.join(from, '.worktrees', 'fix', 'web'), path.join(to, '.worktrees', 'fix', 'web')],
  ]);
});

test('a path Claude Code would shorten with a hash is left alone', () => {
  const b = box();
  const long = path.join(b.projects, 'x'.repeat(CLAUDE_SLUG_MAX));
  write(path.join(b.claude, slugForCwd(long).slice(0, CLAUDE_SLUG_MAX), 's.jsonl'));
  const result = moveConversations({ home: b.home, checkouts: [{ from: long, to: path.join(b.projects, 'short') }] });
  assert.deepEqual(result, { claude: [], pi: [], left: [] });
});

test('a workstream rename carries that worktree\'s conversations, and no other workstream\'s', () => {
  const b = box();
  const wt = path.join(b.projects, 'p', '.worktrees');
  fs.mkdirSync(path.join(wt, 'renamed'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'fix-2'));
  claudeSession(b, path.join(wt, 'fix'), 's-fix');
  claudeSession(b, path.join(wt, 'fix-2'), 's-other');
  const result = carryConversations({ home: b.home, fromDir: path.join(wt, 'fix'), toDir: path.join(wt, 'renamed') });
  assert.deepEqual(result.claude.map(m => [m.from, m.to]), [[slugForCwd(path.join(wt, 'fix')), slugForCwd(path.join(wt, 'renamed'))]]);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(wt, 'renamed')), 's-fix.jsonl')), true);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(wt, 'fix-2')), 's-other.jsonl')), true);
});

test('a destination another directory also encodes to is left alone, so its conversations are not mixed in', async () => {
  const b = box();
  const from = path.join(b.projects, 'foo');
  fs.mkdirSync(from);
  fs.mkdirSync(path.join(b.projects, 'my-app'));
  claudeSession(b, from, 's-foo');
  claudeSession(b, path.join(b.projects, 'my-app'), 's-my-app');
  const result = await renameProject({ sessions: [], fromDir: from, toDir: path.join(b.projects, 'my_app'), conversations: { home: b.home } }, noExec);
  assert.deepEqual(result.conversations.claude, []);
  assert.deepEqual(result.conversations.left, [{ store: 'claude', from: slugForCwd(from), reason: 'destination shared with another directory' }]);
  assert.deepEqual(fs.readdirSync(path.join(b.claude, slugForCwd(path.join(b.projects, 'my-app')))).sort(), ['s-my-app', 's-my-app.jsonl']);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(from), 's-foo.jsonl')), true);
});

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { renameWorktree } = require('./project-rename');
const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args) => execFileAsync('git', args, { env: gitEnv });

/** A project repository with a `fix` worktree, and a conversation in that worktree. */
async function worktreeFixture() {
  const b = box();
  const p = path.join(b.projects, 'p');
  await git('init', '-q', '-b', 'main', p);
  await git('-C', p, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git('-C', p, 'worktree', 'add', '-q', '-b', 'fix', path.join(p, '.worktrees', 'fix'));
  claudeSession(b, path.join(p, '.worktrees', 'fix'), 's-fix');
  return { b, p };
}

test('git-worktree-move moves the worktree with git, and carries its conversations when asked', async () => {
  const { b, p } = await worktreeFixture();
  const result = await renameWorktree({ projectDir: p, from: 'fix', to: 'feature', conversations: { home: b.home } }, { execFile: execFileAsync });
  assert.equal(result.path, path.join(p, '.worktrees', 'feature'));
  assert.match((await git('-C', p, 'worktree', 'list')).stdout, new RegExp(`${path.join(p, '.worktrees', 'feature')} `));
  assert.equal(result.conversations.claude.length, 1);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(p, '.worktrees', 'feature')), 's-fix.jsonl')), true);
});

test('git-worktree-move onto a folder already there is refused, and carries nothing', async () => {
  const { b, p } = await worktreeFixture();
  fs.mkdirSync(path.join(p, '.worktrees', 'feature'));
  await assert.rejects(renameWorktree({ projectDir: p, from: 'fix', to: 'feature', conversations: { home: b.home } }, { execFile: execFileAsync }), /already exists/);
  assert.equal(fs.existsSync(path.join(p, '.worktrees', 'fix', '.git')), true);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(p, '.worktrees', 'fix')), 's-fix.jsonl')), true);
});

test('git-worktree-move that git refuses moves no conversations, and without `conversations` none are carried', async () => {
  const { b, p } = await worktreeFixture();
  await assert.rejects(renameWorktree({ projectDir: p, from: 'gone', to: 'feature', conversations: { home: b.home } }, { execFile: execFileAsync }));
  const result = await renameWorktree({ projectDir: p, from: 'fix', to: 'feature' }, { execFile: execFileAsync });
  assert.equal('conversations' in result, false);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(p, '.worktrees', 'fix')), 's-fix.jsonl')), true);
});

test('worktrees that share a folder name move with their project, the shared folder too', async () => {
  const b = box();
  const from = path.join(b.projects, 'old');
  const to = path.join(b.projects, 'new');
  fs.mkdirSync(path.join(from, '.worktrees', 'fix_1'), { recursive: true });
  fs.mkdirSync(path.join(from, '.worktrees', 'fix-1'));
  claudeSession(b, path.join(from, '.worktrees', 'fix-1'), 's-shared');
  const result = await renameProject({ sessions: [], fromDir: from, toDir: to, conversations: { home: b.home } }, noExec);
  assert.deepEqual(result.conversations.left, []);
  assert.equal(fs.existsSync(path.join(b.claude, slugForCwd(path.join(to, '.worktrees', 'fix-1')), 's-shared.jsonl')), true);
});
