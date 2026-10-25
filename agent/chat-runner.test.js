'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CAPABILITIES, checkoutOwnTree, checkoutReady, completeLines, createChatRunner, entriesBeforeTurn, findTranscript, githubSlug, historyEntries, isChatKey,
  isPullRef, mcpVersionFile, parseEvent, parseTurnRecords, permissionArgs, permissionModeFor, prepareChatConfigDir, readCheckoutFacts, rehomeTranscript, resolveClaude, resumeLaunch, slugForCwd, splitLines, turnArgs,
  backendOf, backendSettings,
  turnEnv, turnModeFor, turnRecord, turnSessionName, userPromptUuid, PANE_START_GRACE_MS, nextPaneClaim,
} = require('./chat-runner');

test('capabilities: a trusted mode is its own capability, beside the runner', () => {
  assert.ok(CAPABILITIES.includes('chat-runner-v1'));
  assert.ok(CAPABILITIES.includes('chat-trust-v1'));
  assert.ok(CAPABILITIES.includes('chat-auto-v1'));
});

test('turn argv: headless stream-json with partial messages, dontAsk unless trusted; resume once there is a session', () => {
  const first = turnArgs(null);
  assert.deepEqual(first.slice(0, 1), ['-p']);
  for (const want of ['stream-json', '--include-partial-messages', '--verbose']) assert.ok(first.includes(want), want);
  assert.equal(first[first.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!first.join(' ').includes('bypassPermissions'));
  assert.ok(!first.includes('--resume'));
  assert.deepEqual(turnArgs('abc-12345678').slice(-2), ['--resume', 'abc-12345678']);
});

test('untrusted turn argv: read-only built-ins only, no MCP server, no hooks, no project or local settings', () => {
  const args = turnArgs('abc-12345678', 'dontAsk');
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.equal(value('--tools'), 'Read,Grep,Glob');
  for (const tool of ['Bash', 'Edit', 'Write', 'Skill', 'WebFetch', 'Task']) assert.ok(!value('--tools').split(',').includes(tool), tool);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(value('--settings')), { disableAllHooks: true });
  // Only the box user's settings (termag's gateway helper): the checkout's
  // .claude/settings*.json would run its apiKeyHelper and apply its env.
  assert.equal(value('--setting-sources'), 'user');
  assert.equal(args.filter(a => a === '--setting-sources').length, 1);
  // Every flag that takes a value has one, and the session comes last.
  for (const flag of ['--permission-mode', '--tools', '--mcp-config', '--setting-sources', '--settings']) assert.ok(!value(flag).startsWith('--'), flag);
  assert.deepEqual(args.slice(-2), ['--resume', 'abc-12345678']);
});

test('trusted turn argv: bypassPermissions with the normal tool surface, the only path that may run tools', () => {
  const args = turnArgs('abc-12345678', 'bypassPermissions');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  for (const flag of ['--tools', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--settings']) assert.ok(!args.includes(flag), flag);
  assert.deepEqual(args.slice(-2), ['--resume', 'abc-12345678']);
});

test('turn argv: a chosen Claude model, and a missing or invalid one omits --model; the session stays last', () => {
  const sonnet = turnArgs(null, 'dontAsk', { model: 'sonnet' });
  assert.deepEqual(sonnet.slice(-2), ['--model', 'sonnet']);
  assert.equal(sonnet[sonnet.indexOf('--permission-mode') + 1], 'dontAsk');
  const pinned = turnArgs('abc-12345678', 'dontAsk', { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
  assert.deepEqual(pinned.slice(-4), ['--model', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', '--resume', 'abc-12345678']);
  assert.ok(!turnArgs(null, 'dontAsk', { model: null }).includes('--model'));
  assert.ok(!turnArgs(null, 'dontAsk', { model: 'auto' }).includes('--model'));
  assert.ok(!turnArgs(null, 'dontAsk', { model: 'global.anthropic.claude-sonnet-5-5' }).includes('--model'));
  assert.ok(!turnArgs(null, 'dontAsk', { model: 'opus;rm' }).includes('--model'));
});

test('auto turn argv: the normal tool surface in Claude Code\'s auto mode (an automation run), but none of the checkout\'s startup config', () => {
  const args = turnArgs('abc-12345678', 'auto');
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('--permission-mode'), 'auto');
  assert.ok(!args.includes('--tools'));
  // Unattended, from whatever origin's default branch holds: the checkout's
  // .mcp.json commands, hooks and settings (apiKeyHelper, env, allow rules)
  // would run at start, before the classifier judges any tool call.
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(value('--settings')), { disableAllHooks: true });
  assert.equal(value('--setting-sources'), 'user');
  assert.deepEqual(args.slice(-2), ['--resume', 'abc-12345678']);
});

test('resume launch: the same permission flags as a turn, typed only as a fixed launcher', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-resume-launch-'));
  const session = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
  const key = 'p1--main';
  const own = { repo: true, branch: 'main', checkout: 'own', mainWorktree: true, originUrl: 'git@github.com:org/repo.git', upstreamUrl: 'git@github.com:org/repo.git', upstreamRef: 'origin/main', upstreamMerge: 'refs/heads/main', fork: false };
  for (const mode of ['dontAsk', 'auto']) {
    const launch = resumeLaunch({ home, chatKey: key, sessionId: session, mode, bin: '/bin/claude' });
    assert.equal(launch.confined, true);
    assert.equal(launch.line, `"$HOME/.termag/chat-resume/${key}"`);
    assert.ok(!launch.line.startsWith('exec '));
    assert.ok(!launch.line.includes(session));
    assert.ok(!launch.line.includes('permission-mode'));
    assert.ok(!launch.line.includes('mcp'));
    const script = fs.readFileSync(path.join(home, '.termag/chat-resume', key), 'utf8');
    const flags = permissionArgs(mode).concat(['--resume', session]);
    assert.deepEqual(launch.argv, flags);
    assert.deepEqual(turnArgs(session, mode).slice(turnArgs(session, mode).indexOf('--permission-mode')), flags);
    assert.ok(script.startsWith('#!/bin/sh\n'));
    assert.ok(script.includes(`export CLAUDE_CONFIG_DIR='${launch.configDir}'`));
    assert.ok(!script.includes('\ncd '), 'no cwd, so the confined launcher does not cd');
    assert.ok(script.includes(`exec ${['/bin/claude', ...flags].map(w => `'${w}'`).join(' ')}`));
    const withCwd = resumeLaunch({ home, chatKey: key, sessionId: session, mode, bin: '/bin/claude', cwd: '/w/p1' });
    assert.equal(withCwd.confined, true);
    assert.equal(withCwd.cwd, '/w/p1');
    const withCwdScript = fs.readFileSync(path.join(home, '.termag/chat-resume', key), 'utf8');
    assert.ok(withCwdScript.includes(`export CLAUDE_CONFIG_DIR='${withCwd.configDir}'`));
    assert.ok(withCwdScript.includes("cd '/w/p1' || exit 1"));
    assert.equal(script.includes("'--tools'"), mode === 'dontAsk');
  }
  const trustedCwd = '/w/p1';
  const full = resumeLaunch({ home, chatKey: key, sessionId: session, mode: 'bypassPermissions', bin: '/bin/claude', cwd: trustedCwd });
  assert.equal(full.confined, false);
  assert.equal(full.configDir, null);
  assert.equal(full.cwd, trustedCwd);
  assert.equal(full.line, `"$HOME/.termag/chat-resume/${key}"`);
  assert.ok(!full.line.includes('claude'));
  assert.ok(!full.line.startsWith('exec '));
  const flags = permissionArgs('bypassPermissions').concat(['--resume', session]);
  assert.deepEqual(full.argv, flags);
  const script = fs.readFileSync(path.join(home, '.termag/chat-resume', key), 'utf8');
  assert.equal(script, [
    '#!/bin/sh',
    `cd '${trustedCwd}' || exit 1`,
    `exec ${['/bin/claude', ...flags].map(w => `'${w}'`).join(' ')}`,
    '',
  ].join('\n'));
  for (const flag of ['--tools', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--settings', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(!script.includes(flag), flag);
  }
  // The pane's cwd is not the directory that was judged. A quote in that path stays inside the script.
  const quoted = resumeLaunch({
    home, chatKey: key, sessionId: session, mode: 'bypassPermissions', bin: '/bin/claude', cwd: "/w/p1/it's",
  });
  assert.equal(quoted.line, full.line);
  const quotedScript = fs.readFileSync(path.join(home, '.termag/chat-resume', key), 'utf8');
  assert.ok(quotedScript.includes(`cd '/w/p1/it'\\''s' || exit 1`));
  assert.ok(quotedScript.includes(`exec '/bin/claude'`));
  assert.equal(resumeLaunch({ home, chatKey: key, sessionId: session, mode: 'bypassPermissions', bin: '/bin/claude' }), null);
  assert.equal(resumeLaunch({ home, chatKey: key, sessionId: session, mode: 'bypassPermissions', bin: '/bin/claude', cwd: 'relative' }), null);
  assert.equal(resumeLaunch({ home, chatKey: key, sessionId: session, mode: 'bypassPermissions', bin: '/bin/claude', cwd: '/w/p1\n/evil' }), null);
  assert.equal(resumeLaunch({ home, chatKey: key, sessionId: session, mode: 'bypassPermissions', bin: 'claude', cwd: trustedCwd }), null);
  assert.equal(resumeLaunch({ home, chatKey: key, sessionId: 'x; rm -rf ~', mode: 'dontAsk', bin: '/bin/claude' }), null);
  assert.equal(resumeLaunch({ home, chatKey: '../x', sessionId: session, mode: 'dontAsk', bin: '/bin/claude' }), null);

  const pr = resumeLaunch({
    home, chatKey: key, sessionId: session,
    mode: turnModeFor('bypassPermissions', { ...own, checkout: 'pr' }),
    bin: '/bin/claude',
    cwd: '/w/p1/.worktrees/pr',
  });
  assert.equal(pr.confined, true);
  assert.ok(pr.argv.includes('dontAsk'));
  assert.ok(pr.argv.includes('--tools'));
  const prScript = fs.readFileSync(path.join(home, '.termag/chat-resume', key), 'utf8');
  assert.ok(prScript.includes("cd '/w/p1/.worktrees/pr' || exit 1"), 'a confined resume cds to the inspected checkout, not the pane cwd');
  assert.ok(prScript.includes('CLAUDE_CONFIG_DIR'));
  const unattended = resumeLaunch({
    home, chatKey: key, sessionId: session,
    mode: turnModeFor('bypassPermissions', { ...own, unattended: true, mainWorktree: false }),
    bin: '/bin/claude',
  });
  assert.equal(unattended.confined, true);
  assert.ok(unattended.argv.includes('auto'));
  assert.ok(!unattended.argv.includes('--tools'));
  assert.ok(unattended.argv.includes('--strict-mcp-config'));
  const trusted = resumeLaunch({
    home, chatKey: key, sessionId: session,
    mode: turnModeFor('bypassPermissions', own),
    bin: '/bin/claude',
    cwd: trustedCwd,
  });
  assert.equal(trusted.confined, false);
  assert.equal(trusted.line, full.line);
  const trustedScript = fs.readFileSync(path.join(home, '.termag/chat-resume', key), 'utf8');
  assert.ok(trustedScript.startsWith(`#!/bin/sh\ncd '${trustedCwd}' || exit 1\n`));
});

test('turn mode: an unattended run worktree caps a trusted follow-up at auto; a tree that is not its own drops to dontAsk', () => {
  const own = { repo: true, branch: 'run-20261020-0900', checkout: 'own', mainWorktree: false, originUrl: 'git@github.com:org/repo.git', upstreamUrl: 'git@github.com:org/repo.git', upstreamRef: 'origin/run-20261020-0900', upstreamMerge: 'refs/heads/run-20261020-0900', fork: false };
  assert.equal(turnModeFor('bypassPermissions', own), 'bypassPermissions');
  assert.equal(turnModeFor('bypassPermissions', { ...own, unattended: true }), 'auto');
  assert.equal(turnModeFor('auto', { ...own, unattended: true }), 'auto');
  assert.equal(turnModeFor('dontAsk', { ...own, unattended: true }), 'dontAsk');
  assert.equal(turnModeFor('bypassPermissions', { ...own, checkout: 'pr' }), 'dontAsk');
  assert.equal(turnModeFor('auto', { repo: true, unreadable: true }), 'dontAsk');
  assert.equal(turnModeFor('acceptEdits', { ...own, unattended: true }), 'dontAsk');
});

test('permission mode: bypass, auto or dontAsk as asked, dontAsk (read-only) for anything else or nothing', () => {
  assert.equal(permissionModeFor('bypassPermissions'), 'bypassPermissions');
  assert.equal(permissionModeFor('auto'), 'auto');
  assert.equal(permissionModeFor('dontAsk'), 'dontAsk');
  assert.equal(permissionModeFor(undefined), 'dontAsk');
  assert.equal(permissionModeFor('acceptEdits'), 'dontAsk');
  for (const asked of [undefined, 'acceptEdits', 'default', 'bypassPermissions --x']) {
    const args = turnArgs(null, asked);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk', String(asked));
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob', String(asked));
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'user', String(asked));
  }
});

test('turn argv: an orchestrator chat appends its system prompt, an ask keeps its own', () => {
  assert.ok(CAPABILITIES.includes('chat-orchestrator-v1'));
  const args = turnArgs('abc-12345678', 'bypassPermissions', { orchestrator: true });
  const prompt = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /agent-orchestrator skill/);
  assert.deepEqual(args.slice(-2), ['--resume', 'abc-12345678']);
  assert.ok(!turnArgs(null, 'bypassPermissions').includes('--append-system-prompt'));
  const ask = turnArgs(null, 'bypassPermissions', { orchestrator: true, ask: { systemPrompt: 'ask prompt' } });
  assert.deepEqual(ask.filter(a => a === '--append-system-prompt').length, 1);
  assert.equal(ask[ask.indexOf('--append-system-prompt') + 1], 'ask prompt');
});

test('runner: a send marked orchestrator carries it to its turn; others do not', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const r = runner(home, b, []);
  const orch = await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'plan it', permissionMode: 'bypassPermissions', orchestrator: true });
  assert.ok(b.procs.get(orch.turnId).meta.args.includes('--append-system-prompt'));
  assert.equal(b.procs.get(orch.turnId).meta.text, 'plan it');
  const plain = await r.sendMessage({ chatKey: 'k2', cwd: '/w', text: 'x', permissionMode: 'bypassPermissions', orchestrator: 'yes' });
  assert.ok(!b.procs.get(plain.turnId).meta.args.includes('--append-system-prompt'));
});

function modeOf(proc) {
  return proc.meta.args[proc.meta.args.indexOf('--permission-mode') + 1];
}

test('runner: a trusted turn bypasses and loads the checkout; anything else stays read-only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const r = runner(home, b, []);
  const trusted = await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'x', permissionMode: 'bypassPermissions' });
  const t1 = b.procs.get(trusted.turnId);
  assert.equal(modeOf(t1), 'bypassPermissions');
  assert.ok(!t1.meta.args.includes('--tools'));
  assert.ok(!t1.meta.args.includes('--setting-sources'));
  assert.equal(t1.meta.configDir, undefined);

  const auto = await r.sendMessage({ chatKey: 'k4', cwd: '/w', text: 'scheduled', permissionMode: 'auto' });
  const t4 = b.procs.get(auto.turnId);
  assert.equal(modeOf(t4), 'auto');
  assert.ok(!t4.meta.args.includes('--tools'));
  // Every tool, but the scratch config dir: the owner's gateway credential, not the checkout's or the owner's rules.
  assert.equal(t4.meta.configDir, path.join(home, '.termag/chat-config'));
  assert.equal(t4.meta.args[t4.meta.args.indexOf('--setting-sources') + 1], 'user');

  await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'y', permissionMode: 'dontAsk' });
  const other = await r.sendMessage({ chatKey: 'k2', cwd: '/w', text: 'z', permissionMode: 'acceptEdits' });
  const plain = await r.sendMessage({ chatKey: 'k3', cwd: '/w', text: 'w' });
  for (const id of [other.turnId, plain.turnId]) {
    const p = b.procs.get(id);
    assert.equal(modeOf(p), 'dontAsk');
    assert.equal(p.meta.args[p.meta.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
    assert.equal(p.meta.args[p.meta.args.indexOf('--setting-sources') + 1], 'user');
    assert.equal(p.meta.configDir, path.join(home, '.termag/chat-config'));
  }
  assert.equal(b.procs.size, 4, 'the queued message has not started');

  const chosen = await r.sendMessage({ chatKey: 'k5', cwd: '/w', text: 'model', permissionMode: 'dontAsk', model: 'sonnet' });
  const dropped = await r.sendMessage({ chatKey: 'k6', cwd: '/w', text: 'nope', permissionMode: 'dontAsk', model: 'not a model' });
  assert.deepEqual(b.procs.get(chosen.turnId).meta.args.slice(-2), ['--model', 'sonnet']);
  assert.ok(!b.procs.get(dropped.turnId).meta.args.includes('--model'));
  assert.ok(!b.procs.get(plain.turnId).meta.args.includes('--model'));
});

test('durable: a queued turn keeps the mode it was sent with across an agent restart', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('running', { permissionMode: 'dontAsk' }));
  await r1.sendMessage(job('later', { permissionMode: 'bypassPermissions' }));
  const running = b.procs.get(turnId);
  assert.equal(modeOf(running), 'dontAsk');
  assert.equal(running.meta.args[running.meta.args.indexOf('--setting-sources') + 1], 'user');

  const r2 = runner(home, b, []);
  await r2.recover();
  b.finish(turnId);
  await r2.poll();
  assert.equal((await r2.history('p1--main')).parked, true, 'a queue from before this agent waits for the backend');
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'later'));
  await r2.resumeQueue('p1--main');
  const next = [...b.procs.values()].find(p => p.meta.text === 'later');
  assert.equal(modeOf(next), 'bypassPermissions');
  assert.ok(!next.meta.args.includes('--tools'));
  assert.ok(!next.meta.args.includes('--setting-sources'));
  assert.equal(next.meta.configDir, undefined);
});

const WEBAPP_URL = 'https://github.com/example-org/webapp.git';

function assertReadOnly(proc, home) {
  assert.equal(modeOf(proc), 'dontAsk');
  assert.equal(proc.meta.args[proc.meta.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.ok(proc.meta.args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(proc.meta.args[proc.meta.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.equal(proc.meta.args[proc.meta.args.indexOf('--setting-sources') + 1], 'user');
  assert.deepEqual(JSON.parse(proc.meta.args[proc.meta.args.indexOf('--settings') + 1]), { disableAllHooks: true });
  assert.equal(proc.meta.configDir, path.join(home, '.termag/chat-config'));
}

test('checkout: a pull-request head or a fork is not the repository own tree', () => {
  assert.equal(githubSlug('https://github.com/Example-Org/webapp.git'), 'example-org/webapp');
  assert.equal(githubSlug('git@github.com:example-team/termag.git'), 'example-team/termag');
  assert.equal(githubSlug('ssh://git@github.com/example-org/webapp'), 'example-org/webapp');
  assert.equal(githubSlug('https://git@github.com/example-org/webapp.git'), 'example-org/webapp');
  assert.equal(githubSlug('https://gitlab.com/example-org/x'), null);
  assert.equal(isPullRef('refs/pull/4/head'), true);
  assert.equal(isPullRef('refs/remotes/origin/pr/359'), true);
  assert.equal(isPullRef('refs/remotes/origin/pull/12/head'), true);
  assert.equal(isPullRef('origin/pr/359'), true);
  assert.equal(isPullRef('origin/pull/12/head'), true);
  assert.equal(isPullRef('refs/remotes/origin/main'), false);
  assert.equal(isPullRef('origin/main'), false);
  assert.equal(isPullRef('refs/heads/main'), false);

  const own = {
    repo: true,
    branch: 'main',
    checkout: null,
    mainWorktree: true,
    originUrl: WEBAPP_URL,
    upstreamUrl: 'git@github.com:example-org/webapp.git',
    upstreamMerge: 'refs/heads/main',
  };
  assert.equal(checkoutOwnTree(own), true);
  assert.equal(checkoutOwnTree({ ...own, upstreamUrl: null, upstreamMerge: null }), false);
  assert.equal(checkoutOwnTree({ ...own, upstreamMerge: null }), false);
  // `git fetch origin pull/<n>/head:<local>` then checkout: main worktree, no marker, no upstream.
  assert.equal(checkoutOwnTree({
    repo: true, branch: 'fetched-pr', checkout: null, mainWorktree: true,
    originUrl: WEBAPP_URL, upstreamUrl: null, upstreamMerge: null,
  }), false);
  assert.equal(checkoutOwnTree({ repo: false }), true);
  assert.equal(checkoutOwnTree(null), true);
  assert.equal(checkoutOwnTree({ repo: true, unreadable: true }), false);
  // The branch's creation marker, not a pull ref that happens to share the commit.
  assert.equal(checkoutOwnTree({ ...own, checkout: 'pr' }), false);
  assert.equal(checkoutOwnTree({ ...own, branch: 'fork-branch', checkout: 'fork', upstreamUrl: null }), false);
  assert.equal(checkoutOwnTree({ ...own, refsAtHead: ['refs/remotes/origin/pr/12', 'refs/heads/main'] }), true);
  assert.equal(checkoutOwnTree({ ...own, upstreamUrl: 'git@github.com:contributor/webapp.git' }), false);
  assert.equal(checkoutOwnTree({ ...own, fork: true }), false);
  // A missing marker is not the project's own tree, and neither is a detached HEAD.
  assert.equal(checkoutOwnTree({
    repo: true, branch: 'wip', checkout: null, mainWorktree: false, originUrl: WEBAPP_URL, upstreamUrl: null,
  }), false);
  assert.equal(checkoutOwnTree({
    repo: true, branch: 'feat/x', checkout: null, originUrl: WEBAPP_URL, upstreamUrl: WEBAPP_URL, upstreamRef: 'origin/feat/x',
  }), false);
  assert.equal(checkoutOwnTree({ ...own, branch: null }), false);
  assert.equal(checkoutOwnTree({ ...own, mainWorktree: false }), false);
  // A branch-off is the own marker plus an upstream in this repository that is not a pull ref.
  const branchOff = {
    repo: true, branch: 'topic', checkout: 'own', mainWorktree: false,
    originUrl: WEBAPP_URL, upstreamUrl: 'git@github.com:example-org/webapp.git',
    upstreamRef: 'origin/topic', upstreamMerge: 'refs/heads/topic',
  };
  assert.equal(checkoutOwnTree(branchOff), true);
  assert.equal(checkoutOwnTree({ ...branchOff, upstreamRef: 'origin/pr/4' }), false);
  assert.equal(checkoutOwnTree({ ...branchOff, upstreamUrl: null, upstreamRef: null }), false);
  assert.equal(checkoutOwnTree({ ...branchOff, upstreamUrl: 'git@github.com:contributor/webapp.git' }), false);
  // A project with no repository is a git init, often with a commit and no origin.
  // The owner's tick is enough. A pull-request or fork workstream still refuses.
  const noRepo = {
    repo: true, branch: 'main', checkout: null, mainWorktree: true, fork: false,
    originUrl: null, upstreamUrl: null, upstreamRef: null, upstreamMerge: null,
  };
  assert.equal(checkoutOwnTree(noRepo), true);
  assert.equal(checkoutOwnTree({ ...noRepo, mainWorktree: false, checkout: 'own' }), true);
  assert.equal(checkoutOwnTree({ ...noRepo, checkout: 'pr' }), false);
  assert.equal(checkoutOwnTree({ ...noRepo, checkout: 'fork' }), false);
  assert.equal(checkoutOwnTree({ ...noRepo, fork: true }), false);
  assert.equal(checkoutOwnTree({
    ...noRepo, upstreamRef: 'origin/pr/1', upstreamMerge: 'refs/pull/1/head',
  }), false);
  assert.equal(checkoutOwnTree({ ...noRepo, branch: null }), false);
});

test('runner: a pull-request checkout stays read-only when the send asked for bypass, including a queued turn after restart', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const pull = {
    repo: true,
    branch: 'feat/x',
    checkout: 'pr',
    originUrl: WEBAPP_URL,
    upstreamUrl: WEBAPP_URL,
  };
  const readCheckout = async () => pull;
  const r1 = runner(home, b, [], { readCheckout });
  const { turnId } = await r1.sendMessage(job('running', { permissionMode: 'bypassPermissions' }));
  assertReadOnly(b.procs.get(turnId), home);

  await r1.sendMessage(job('later', { permissionMode: 'bypassPermissions' }));
  const queued = JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), 'utf8'));
  assert.equal(queued[0].permissionMode, 'bypassPermissions');

  const r2 = runner(home, b, [], { readCheckout });
  await r2.recover();
  b.finish(turnId);
  await r2.poll();
  await r2.resumeQueue('p1--main');
  const next = [...b.procs.values()].find(p => p.meta.text === 'later');
  assertReadOnly(next, home);
});

test('runner: a project with no repository gets the trusted surface when the send asked for bypass', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const noRepo = {
    repo: true,
    branch: 'main',
    checkout: null,
    mainWorktree: true,
    originUrl: null,
    upstreamUrl: null,
    upstreamMerge: null,
    fork: false,
  };
  const r = runner(home, b, [], { readCheckout: async () => noRepo });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  const t = b.procs.get(turnId);
  assert.equal(modeOf(t), 'bypassPermissions');
  assert.ok(!t.meta.args.includes('--tools'));
  assert.equal(t.meta.configDir, undefined);
});

test('runner: a pull-request marker on a project with no repository stays read-only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const marked = {
    repo: true,
    branch: 'feat/x',
    checkout: 'pr',
    mainWorktree: false,
    originUrl: null,
    upstreamUrl: null,
    fork: false,
  };
  const r = runner(home, b, [], { readCheckout: async () => marked });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  assertReadOnly(b.procs.get(turnId), home);
});

test('runner: a fork checkout stays read-only when the send asked for bypass', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const fork = {
    repo: true,
    branch: 'fork-branch',
    checkout: 'fork',
    originUrl: WEBAPP_URL,
    upstreamUrl: null,
    fork: true,
  };
  const r = runner(home, b, [], { readCheckout: async () => fork });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  assertReadOnly(b.procs.get(turnId), home);
});

test('runner: the repository own tree still gets the trusted surface', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const own = {
    repo: true,
    branch: 'main',
    checkout: null,
    mainWorktree: true,
    refsAtHead: ['refs/heads/main', 'refs/remotes/origin/main'],
    originUrl: WEBAPP_URL,
    upstreamUrl: 'git@github.com:example-org/webapp.git',
    upstreamMerge: 'refs/heads/main',
  };
  const r = runner(home, b, [], { readCheckout: async () => own });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  const t = b.procs.get(turnId);
  assert.equal(modeOf(t), 'bypassPermissions');
  assert.ok(!t.meta.args.includes('--tools'));
  assert.ok(!t.meta.args.includes('--strict-mcp-config'));
  assert.ok(!t.meta.args.includes('--setting-sources'));
  assert.equal(t.meta.configDir, undefined);
});

test('runner: a branch-off of the same repository gets the trusted surface', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const branchOff = {
    repo: true,
    branch: 'topic',
    checkout: 'own',
    mainWorktree: false,
    originUrl: WEBAPP_URL,
    upstreamUrl: WEBAPP_URL,
    upstreamRef: 'origin/topic',
    upstreamMerge: 'refs/heads/topic',
    fork: false,
  };
  const r = runner(home, b, [], { readCheckout: async () => branchOff });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  const t = b.procs.get(turnId);
  assert.equal(modeOf(t), 'bypassPermissions');
  assert.ok(!t.meta.args.includes('--tools'));
  assert.ok(!t.meta.args.includes('--strict-mcp-config'));
  assert.ok(!t.meta.args.includes('--setting-sources'));
  assert.equal(t.meta.configDir, undefined);
});

test('runner: the main worktree on a local branch with no upstream stays read-only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const fetched = {
    repo: true,
    branch: 'fetched-pr',
    checkout: null,
    mainWorktree: true,
    originUrl: WEBAPP_URL,
    upstreamUrl: null,
    upstreamMerge: null,
    fork: false,
  };
  const r = runner(home, b, [], { readCheckout: async () => fetched });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  assertReadOnly(b.procs.get(turnId), home);
});

test('runner: a linked worktree with no marker stays read-only when the send asked for bypass', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const unmarked = {
    repo: true,
    branch: 'feat/x',
    checkout: null,
    mainWorktree: false,
    originUrl: WEBAPP_URL,
    upstreamUrl: WEBAPP_URL,
    fork: false,
  };
  const r = runner(home, b, [], { readCheckout: async () => unmarked });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  assertReadOnly(b.procs.get(turnId), home);
});

test('runner: a detached HEAD stays read-only when the send asked for bypass', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const detached = {
    repo: true,
    branch: null,
    checkout: null,
    mainWorktree: true,
    originUrl: WEBAPP_URL,
    upstreamUrl: WEBAPP_URL,
    fork: false,
  };
  const r = runner(home, b, [], { readCheckout: async () => detached });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  assertReadOnly(b.procs.get(turnId), home);
});

test('runner: a checkout that cannot be read does not get bypass', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const r = runner(home, b, [], { readCheckout: async () => { throw new Error('git failed'); } });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  assertReadOnly(b.procs.get(turnId), home);
});

test('lines: complete lines out, the unfinished tail carried', () => {
  const a = splitLines('', '{"type":"a"}\n{"type":"b"');
  assert.deepEqual(a.lines, ['{"type":"a"}']);
  const b = splitLines(a.rest, '}\n\n');
  assert.deepEqual(b.lines, ['{"type":"b"}']);
  assert.equal(b.rest, '');
});

test('events: JSON objects with a type, nothing else', () => {
  assert.deepEqual(parseEvent('{"type":"result","is_error":false}'), { type: 'result', is_error: false });
  assert.equal(parseEvent('not json'), null);
  assert.equal(parseEvent('[1,2]'), null);
  assert.equal(parseEvent('{"no":"type"}'), null);
});

test('chat keys: a flat file name, never a path', () => {
  assert.ok(isChatKey('cmva5ktbm000cjuwdffqdnfnm--main'));
  assert.ok(!isChatKey('../x'));
  assert.ok(!isChatKey('a/b'));
  assert.ok(!isChatKey(''));
});

test('claude binary: native install, then PATH, then the newest nvm global', () => {
  const have = new Set(['/h/.nvm/versions/node/v20.1.0/bin/claude', '/h/.nvm/versions/node/v22.3.0/bin/claude']);
  const exists = p => have.has(p);
  const readdir = () => ['v20.1.0', 'v22.3.0'];
  assert.equal(resolveClaude({ home: '/h', env: { PATH: '/usr/bin' }, exists, readdir }), '/h/.nvm/versions/node/v22.3.0/bin/claude');
  have.add('/usr/bin/claude');
  assert.equal(resolveClaude({ home: '/h', env: { PATH: '/usr/bin' }, exists, readdir }), '/usr/bin/claude');
  have.add('/h/.local/bin/claude');
  assert.equal(resolveClaude({ home: '/h', env: { PATH: '/usr/bin' }, exists, readdir }), '/h/.local/bin/claude');
  assert.equal(resolveClaude({ home: '/h', env: { TERMAG_CHAT_CLAUDE: '/x/claude' }, exists, readdir }), '/x/claude');
});

test('turn env: no tmux variables, the binary\'s directory on PATH', () => {
  const env = turnEnv({ TMUX: '/tmp/s,1,0', TMUX_PANE: '%1', PATH: '/usr/bin', HOME: '/h' }, '/h/.nvm/versions/node/v22/bin/claude');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.PATH, '/h/.nvm/versions/node/v22/bin:/usr/bin');
  assert.equal(turnEnv({ PATH: '/usr/bin' }, 'claude').PATH, '/usr/bin');
});

test('history: main-thread user and assistant messages from the transcript, meta and sidechains left out', () => {
  const jsonl = [
    { type: 'summary', summary: 'x' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
    { type: 'assistant', isSidechain: true, message: { id: 'msg_2', role: 'assistant', content: [] } },
    'not json',
  ].map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
  const out = historyEntries(jsonl);
  assert.deepEqual(out.map(e => e.uuid), ['u1', 'a1']);
  assert.deepEqual(out[1].message, { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] });
  assert.equal(historyEntries(jsonl, 1).length, 1);
});

test('history: an assistant entry keeps its model, so a synthetic refusal reads as one', () => {
  const content = [{ type: 'text', text: "/reload-plugins isn't available over a remote connection in this session." }];
  const jsonl = JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'msg_1', model: '<synthetic>', role: 'assistant', content } });
  assert.deepEqual(historyEntries(jsonl)[0].message, { id: 'msg_1', role: 'assistant', model: '<synthetic>', content });
});

test('history: a skill\'s SKILL.md, the meta entry its Skill call added, is kept with the call id', () => {
  const body = [{ type: 'text', text: 'Base directory for this skill: /h/.claude/skills/x\n\n# x' }];
  const jsonl = [
    { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'x' } }] } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: x' }] } },
    { type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'toolu_1', message: { role: 'user', content: body } },
    { type: 'user', uuid: 'u3', isMeta: true, message: { role: 'user', content: 'caveat' } },
  ].map(e => JSON.stringify(e)).join('\n');
  const out = historyEntries(jsonl);
  assert.deepEqual(out.map(e => e.uuid), ['a1', 'u1', 'u2']);
  assert.equal(out[1].isMeta, undefined);
  assert.equal(out[2].isMeta, true);
  assert.equal(out[2].sourceToolUseID, 'toolu_1');
  assert.deepEqual(out[2].message.content, body);
});

test('transcript: found under any project dir by session id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const dir = path.join(home, '.claude/projects/-home-u-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-12345678.jsonl'), '');
  assert.equal(findTranscript(home, 'sess-12345678'), path.join(dir, 'sess-12345678.jsonl'));
  assert.equal(findTranscript(home, 'missing-1234'), null);
  assert.equal(findTranscript(home, '../etc'), null);
});

test('checkout: ready once HEAD is a commit', async () => {
  const calls = [];
  const ok = (cmd, args) => { calls.push([cmd, ...args]); return Promise.resolve({ stdout: 'abc\n' }); };
  assert.equal(await checkoutReady('/w/p', ok), true);
  assert.deepEqual(calls[0].slice(0, 4), ['git', '-C', '/w/p', 'rev-parse']);
  const none = () => Promise.reject(Object.assign(new Error('fatal: Needed a single revision'), { code: 1 }));
  assert.equal(await checkoutReady('/w/p', none), false);
});

test('checkout: a real fresh repo has none until its first commit', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-checkout-'));
  await run('git', ['init', '-q', dir]);
  assert.equal(await checkoutReady(dir, run), false);
  fs.writeFileSync(path.join(dir, 'a'), 'x');
  await run('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first']);
  assert.equal(await checkoutReady(dir, run), true);
});

test('checkout facts: a PR branch stays read-only after it leaves the fetched pull ref, and main does not inherit that ref', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const { addPrWorktree } = require('./git-worktree-pr');
  const run = promisify(execFile);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const commit = (cwd, msg) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-facts-'));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  await run('git', ['init', '-q', '-b', 'main', seed], { env });
  await commit(seed, 'init');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main');
  await git(seed, 'checkout', '-q', '-b', 'feat/x');
  await commit(seed, 'pr');
  await git(seed, 'push', '-q', 'origin', 'feat/x', 'feat/x:refs/pull/7/head');
  await git(seed, 'checkout', '-q', '-b', 'fork-branch', 'main');
  await commit(seed, 'fork');
  await git(seed, 'push', '-q', 'origin', 'fork-branch:refs/pull/8/head');
  const project = path.join(dir, 'project');
  await run('git', ['clone', '-q', origin, project], { env });
  const oid = async (ref) => (await git(seed, 'rev-parse', ref)).stdout.trim();
  const exec = (cmd, args, opts) => run(cmd, args, { ...opts, env });

  await addPrWorktree({
    projectDir: project, worktreeName: 'proj-x', branch: 'feat/x', number: 7, sameRepo: true, headOid: await oid('feat/x'),
  }, { execFile: exec });
  const prWt = path.join(project, '.worktrees', 'proj-x');
  await commit(prWt, 'kept locally');
  await git(project, 'update-ref', 'refs/remotes/origin/pr/7', 'origin/main');
  let facts = await readCheckoutFacts(prWt, run);
  assert.equal(facts.checkout, 'pr');
  assert.equal(facts.branch, 'feat/x');
  assert.equal(checkoutOwnTree(facts), false);

  await addPrWorktree({
    projectDir: project, worktreeName: 'proj-fork', branch: 'fork-branch', number: 8, sameRepo: false, headOid: await oid('fork-branch'),
  }, { execFile: exec });
  const forkWt = path.join(project, '.worktrees', 'proj-fork');
  await assert.rejects(git(forkWt, 'rev-parse', '--abbrev-ref', '@{upstream}'));
  await commit(forkWt, 'fork moved on');
  await git(project, 'update-ref', 'refs/remotes/origin/pr/8', 'origin/main');
  facts = await readCheckoutFacts(forkWt, run);
  assert.equal(facts.checkout, 'fork');
  assert.equal(facts.upstreamUrl, null);
  assert.equal(checkoutOwnTree(facts), false);

  await git(project, 'update-ref', 'refs/remotes/origin/pr/9', 'HEAD');
  facts = await readCheckoutFacts(project, run);
  assert.equal(facts.branch, 'main');
  assert.equal(facts.checkout, null);
  assert.equal(facts.mainWorktree, true);
  assert.equal(checkoutOwnTree(facts), true);

  // An existing PR worktree from before the marker, and one whose marker was
  // removed: still a linked worktree, so still read-only. No points-at scan.
  await git(prWt, 'config', '--local', '--unset', 'branch.feat/x.termagCheckout');
  facts = await readCheckoutFacts(prWt, run);
  assert.equal(facts.checkout, null);
  assert.equal(facts.mainWorktree, false);
  assert.equal(checkoutOwnTree(facts), false);
  const plain = path.join(project, '.worktrees', 'plain');
  await git(project, 'worktree', 'add', '-q', '-b', 'plain', plain, 'HEAD');
  facts = await readCheckoutFacts(plain, run);
  assert.equal(facts.branch, 'plain');
  assert.equal(facts.checkout, null);
  assert.equal(facts.mainWorktree, false);
  assert.equal(checkoutOwnTree(facts), false);
  const { markOwnCheckout } = require('./git-worktree-own');
  await markOwnCheckout({ worktreePath: plain, branch: 'plain', repoPath: project, startPoint: 'HEAD' }, { execFile: exec });
  facts = await readCheckoutFacts(plain, run);
  assert.equal(facts.checkout, 'own');
  assert.equal(facts.upstreamRef, 'origin/plain');
  assert.equal(checkoutOwnTree(facts), true);
  const raw = (await git(project, 'rev-parse', 'origin/feat/x')).stdout.trim();
  const fromOid = path.join(project, '.worktrees', 'from-oid');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-oid', fromOid, raw);
  await markOwnCheckout({ worktreePath: fromOid, branch: 'from-oid', repoPath: project, startPoint: raw }, { execFile: exec });
  facts = await readCheckoutFacts(fromOid, run);
  assert.equal(facts.checkout, null);
  assert.equal(facts.upstreamUrl, null);
  assert.equal(checkoutOwnTree(facts), false);
  await git(plain, 'config', '--local', 'branch.plain.merge', 'refs/pull/3/head');
  facts = await readCheckoutFacts(plain, run);
  assert.equal(checkoutOwnTree(facts), false);

  const detached = path.join(dir, 'detached');
  await run('git', ['clone', '-q', origin, detached], { env });
  await git(detached, 'checkout', '-q', '--detach');
  facts = await readCheckoutFacts(detached, run);
  assert.equal(facts.branch, null);
  assert.equal(facts.mainWorktree, true);
  assert.equal(checkoutOwnTree(facts), false);

  // A fetched pull head checked out in the main worktree has no marker and no
  // upstream. The main worktree alone does not make that the project's tree.
  await git(project, 'fetch', '-q', 'origin', 'refs/pull/7/head:fetched-pr');
  await git(project, 'checkout', '-q', 'fetched-pr');
  facts = await readCheckoutFacts(project, run);
  assert.equal(facts.branch, 'fetched-pr');
  assert.equal(facts.checkout, null);
  assert.equal(facts.mainWorktree, true);
  assert.equal(facts.upstreamUrl, null);
  assert.equal(facts.upstreamMerge, null);
  assert.equal(checkoutOwnTree(facts), false);

  await git(project, 'checkout', '-q', '-b', 'no-upstream', 'main');
  facts = await readCheckoutFacts(project, run);
  assert.equal(facts.branch, 'no-upstream');
  assert.equal(facts.mainWorktree, true);
  assert.equal(facts.upstreamMerge, null);
  assert.equal(checkoutOwnTree(facts), false);

  await git(project, 'remote', 'add', 'contributor', 'git@github.com:contributor/webapp.git');
  await git(project, 'checkout', '-q', '-b', 'fork-local', 'main');
  await git(project, 'config', '--local', 'branch.fork-local.remote', 'contributor');
  await git(project, 'config', '--local', 'branch.fork-local.merge', 'refs/heads/main');
  facts = await readCheckoutFacts(project, run);
  assert.equal(facts.mainWorktree, true);
  assert.equal(facts.upstreamMerge, 'refs/heads/main');
  assert.equal(checkoutOwnTree(facts), false);

  await git(project, 'checkout', '-q', 'main');
  facts = await readCheckoutFacts(project, run);
  assert.equal(facts.branch, 'main');
  assert.equal(facts.upstreamMerge, 'refs/heads/main');
  assert.equal(facts.mainWorktree, true);
  assert.equal(checkoutOwnTree(facts), true);

  // Another remote's same-named ref is not this branch. main still tracks origin.
  await git(project, 'remote', 'set-url', 'origin', 'https://github.com/example-org/webapp.git');
  await git(project, 'remote', 'add', 'colleague', 'git@github.com:colleague/webapp.git');
  await git(project, 'update-ref', 'refs/remotes/colleague/main', 'HEAD');
  facts = await readCheckoutFacts(project, run);
  assert.equal(facts.branch, 'main');
  assert.equal(facts.fork, false);
  assert.equal(facts.upstreamMerge, 'refs/heads/main');
  assert.match(facts.upstreamUrl, /example-org\/webapp/);
  assert.equal(checkoutOwnTree(facts), true);
  // This branch's own upstream is the colleague remote: that is a fork.
  await git(project, 'config', '--local', 'branch.main.remote', 'colleague');
  await git(project, 'config', '--local', 'branch.main.merge', 'refs/heads/main');
  facts = await readCheckoutFacts(project, run);
  assert.equal(facts.fork, true);
  assert.match(facts.upstreamUrl, /colleague\/webapp/);
  assert.equal(checkoutOwnTree(facts), false);
});

test('checkout facts: a git init with no origin is the project own tree until it is marked a pull request or a fork', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-norepo-'));
  await run('git', ['init', '-q', '-b', 'main', dir], { env });
  await git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  let facts = await readCheckoutFacts(dir, run);
  assert.equal(facts.repo, true);
  assert.equal(facts.branch, 'main');
  assert.equal(facts.originUrl, null);
  assert.equal(facts.upstreamUrl, null);
  assert.equal(facts.fork, false);
  assert.equal(facts.mainWorktree, true);
  assert.equal(checkoutOwnTree(facts), true);

  await git(dir, 'config', '--local', 'branch.main.termagCheckout', 'pr');
  facts = await readCheckoutFacts(dir, run);
  assert.equal(facts.checkout, 'pr');
  assert.equal(facts.originUrl, null);
  assert.equal(checkoutOwnTree(facts), false);

  await git(dir, 'config', '--local', 'branch.main.termagCheckout', 'fork');
  facts = await readCheckoutFacts(dir, run);
  assert.equal(facts.checkout, 'fork');
  assert.equal(facts.fork, true);
  assert.equal(checkoutOwnTree(facts), false);
});

test('slugForCwd: every non-alphanumeric becomes a dash, matching Claude Code', () => {
  assert.equal(slugForCwd('/home/u/termag/projects/my-proj'), '-home-u-termag-projects-my-proj');
  assert.equal(slugForCwd('/tmp/a.b_c'), '-tmp-a-b-c');
});

test('turnEnv: the chat turn runs with the scratch config dir, and without the tmux vars', () => {
  const env = turnEnv({ TMUX: '/x', TMUX_PANE: '%1', PATH: '/usr/bin' }, '/opt/node/bin/claude', '/home/u/.termag/chat-config');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/u/.termag/chat-config');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.ok(env.PATH.startsWith('/opt/node/bin:'));
});

test('prepareChatConfigDir: only the gateway credential, with projects and credentials symlinked', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
    apiKeyHelper: 'termag-claude-token /c', env: { ANTHROPIC_BASE_URL: 'http://gw' },
    permissions: { allow: ['Read(//**)'] }, model: 'x',
  }));
  fs.writeFileSync(path.join(home, '.claude/.credentials.json'), '{"t":1}');
  const dir = prepareChatConfigDir(home);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings, { apiKeyHelper: 'termag-claude-token /c', env: { ANTHROPIC_BASE_URL: 'http://gw' } });
  assert.equal(settings.permissions, undefined, 'the owner permission rules must not reach the chat turn');
  assert.equal(fs.readlinkSync(path.join(dir, 'projects')), path.join(home, '.claude/projects'));
  assert.equal(fs.readlinkSync(path.join(dir, '.credentials.json')), path.join(home, '.claude/.credentials.json'));
});

test('prepareChatConfigDir: a box with no owner settings still gets a confining empty settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cfg-'));
  const dir = prepareChatConfigDir(home);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), {});
  assert.ok(fs.existsSync(path.join(dir, 'projects')));
});

test('rehomeTranscript: a rename moves the session transcript to the new cwd slug dir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rehome-'));
  const id = 'abcdef12-3456-7890-abcd-ef1234567890';
  const oldDir = path.join(home, '.claude/projects', slugForCwd('/home/u/proj'));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, `${id}.jsonl`), '{"type":"user"}\n');
  rehomeTranscript(home, id, '/home/u/renamed');
  const newDir = path.join(home, '.claude/projects', slugForCwd('/home/u/renamed'));
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)), 'moved to the new slug dir');
  assert.ok(!fs.existsSync(path.join(oldDir, `${id}.jsonl`)), 'gone from the old one');
  // A no-op when already there.
  assert.doesNotThrow(() => rehomeTranscript(home, id, '/home/u/renamed'));
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)));
});


// ── durable turns ──────────────────────────────────────────────────────────

test('turn sessions: named after the user and turn, never a cloud runner session (no box-update deferral)', () => {
  const name = turnSessionName('first.last', 'mva9-ab12');
  assert.equal(name, 'first_dlast-chat-mva9-ab12-r');
  const { isRunnerSessionName } = require('./runner-sessions');
  assert.equal(isRunnerSessionName(name, 'first.last'), false);
  assert.ok(!/-claude-runner-s[0-9]+-[A-Za-z0-9][A-Za-z0-9_-]*-r$/.test(name), 'termag-box-update live_runner_sessions pattern');
});

test('log lines: only complete lines, with the bytes they took', () => {
  assert.deepEqual(completeLines(Buffer.from('{"a":1}\n{"b":')), { lines: ['{"a":1}'], bytes: 8 });
  assert.deepEqual(completeLines(Buffer.from('partial')), { lines: [], bytes: 0 });
});

test('history cut: the running turn\'s prompt and what follows it leave the transcript', () => {
  const entries = [
    { type: 'user', message: { content: 'first' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'two (partial)' }] } },
  ];
  assert.deepEqual(entriesBeforeTurn(entries, 'second').length, 2);
  assert.deepEqual(entriesBeforeTurn(entries, 'not written yet').length, 4);
});

// A box: turns "run" by a test-controlled stand-in for chat-turn.js that
// writes the log lines the test hands it; tmux sessions are a Set.
function box(home) {
  const sessions = new Set();
  const signals = [];
  const procs = new Map();
  return {
    sessions, signals, procs,
    startProcess: async (meta, dir) => {
      sessions.add(meta.session);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: meta.text, resumed: meta.resumed })}\n`);
      fs.writeFileSync(path.join(dir, 'claude.pid'), '4242');
      procs.set(meta.turnId, { meta, dir });
    },
    write: (turnId, events) => {
      const { dir } = procs.get(turnId);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), events.map(e => `${JSON.stringify(e)}\n`).join(''));
    },
    finish: (turnId, sessionId) => {
      const { meta, dir } = procs.get(turnId);
      if (sessionId) fs.writeFileSync(meta.stateFile, JSON.stringify({ sessionId, cwd: meta.cwd }));
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-end', exitCode: 0 })}\n`);
      fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 0 }));
      sessions.delete(meta.session);
    },
    crash: (turnId) => { sessions.delete(procs.get(turnId).meta.session); },
    sessionAlive: async (name) => sessions.has(name),
    signalPid: (pid, sig) => signals.push([pid, sig]),
  };
}

function runner(home, b, frames, opts = {}) {
  return createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', env: { PATH: '/usr/bin', TMUX: 'x' },
    send: f => { if (opts.down?.()) return false; frames.push(f); return true; },
    isOpen: () => !opts.down?.(),
    startProcess: b.startProcess, sessionAlive: opts.sessionAlive || b.sessionAlive, signalPid: b.signalPid,
    stopSession: opts.stopSession, pidAlive: opts.pidAlive, interruptGraceMs: opts.interruptGraceMs, turnInterruptMs: opts.turnInterruptMs,
    now: opts.now, readCheckout: opts.readCheckout, launchSettings: opts.launchSettings,
  });
}

const job = (text, extra = {}) => ({ chatKey: 'p1--main', cwd: '/w/p1', text, projectId: 'p1', workstream: 'main', ...extra });

test('runner: a turn still inspecting its checkout is running, and a resume claim is refused', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-claim-'));
  const b = box(home);
  let resolveCheckout;
  const readCheckout = () => new Promise(resolve => { resolveCheckout = resolve; });
  const r = runner(home, b, [], { readCheckout });
  const pending = r.sendMessage(job('hello', { permissionMode: 'bypassPermissions' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.procs.size, 0, 'the process does not exist until the checkout inspect returns');
  assert.equal((await r.history('p1--main')).running, true);
  assert.deepEqual(await r.claimResume('p1--main'), { claimed: false, running: true });
  resolveCheckout({ repo: false });
  const { turnId } = await pending;
  assert.ok(b.procs.has(turnId));
});

test('pane claim: a miss or a shell does not free a session until Claude was seen and then left', () => {
  assert.equal(nextPaneClaim(null, 'unknown'), null);
  assert.equal(nextPaneClaim(null, 'shell'), null);
  assert.equal(nextPaneClaim(null, 'claude'), 'seen');
  assert.equal(nextPaneClaim('owns', 'unknown', PANE_START_GRACE_MS), 'owns');
  assert.equal(nextPaneClaim('owns', 'unknown', PANE_START_GRACE_MS * 10), 'owns');
  assert.equal(nextPaneClaim('owns', 'shell', PANE_START_GRACE_MS - 1), 'owns');
  assert.equal(nextPaneClaim('owns', 'other', PANE_START_GRACE_MS - 1), 'owns');
  // A named program that is not Claude means the launcher returned.
  assert.equal(nextPaneClaim('owns', 'other', PANE_START_GRACE_MS), null);
  assert.equal(nextPaneClaim('owns', 'shell', PANE_START_GRACE_MS), null);
  assert.equal(nextPaneClaim('owns', 'claude', 0), 'seen');
  assert.equal(nextPaneClaim('seen', 'unknown', PANE_START_GRACE_MS), 'seen');
  // vim is not Claude having exited. A failed probe is not either.
  assert.equal(nextPaneClaim('seen', 'other', PANE_START_GRACE_MS), 'seen');
  assert.equal(nextPaneClaim('seen', 'shell', 0), null);
});

test('runner: a resume claim cds a trusted tree to the inspected cwd and confines every other tree', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-claim-line-'));
  const b = box(home);
  const own = { repo: true, branch: 'main', checkout: 'own', mainWorktree: true, originUrl: 'git@github.com:org/repo.git', upstreamUrl: 'git@github.com:org/repo.git', upstreamRef: 'origin/main', upstreamMerge: 'refs/heads/main', fork: false };
  const session = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
  const prRunner = runner(home, b, [], { readCheckout: async () => ({ ...own, checkout: 'pr' }) });
  const started = await prRunner.sendMessage(job('hello'));
  b.finish(started.turnId, session);
  const pr = await prRunner.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'bypassPermissions' });
  assert.equal(pr.claimed, true);
  assert.equal(pr.line, '"$HOME/.termag/chat-resume/p1--main"');
  const script = fs.readFileSync(path.join(home, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(script.includes("'dontAsk'"));
  assert.ok(script.includes("'--tools'"));
  assert.ok(script.includes("'--strict-mcp-config'"));
  assert.ok(script.includes('exec '));
  assert.ok(!pr.line.includes(session));
  assert.ok(!pr.line.startsWith('exec '));

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-claim-full-'));
  const b2 = box(home2);
  const ownRunner = runner(home2, b2, [], { readCheckout: async () => own });
  const started2 = await ownRunner.sendMessage(job('hello', { permissionMode: 'bypassPermissions' }));
  b2.finish(started2.turnId, session);
  const full = await ownRunner.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'bypassPermissions' });
  assert.equal(full.line, '"$HOME/.termag/chat-resume/p1--main"');
  assert.ok(!full.line.includes('claude'));
  const fullScript = fs.readFileSync(path.join(home2, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(fullScript.includes("cd '/w/p1' || exit 1"));
  assert.ok(fullScript.includes(`exec '/bin/claude' '--permission-mode' 'bypassPermissions' '--resume' '${session}'`));
  assert.ok(!fullScript.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(!fullScript.includes('--strict-mcp-config'));
  // The first resume was typed and Claude has not been seen. A second claim
  // must not type the launcher again. `seen` is not that refusal.
  assert.deepEqual(await ownRunner.claimResume('p1--main', { cwd: '/w/p1-other', permissionMode: 'bypassPermissions' }), { claimed: false, running: true });
  await ownRunner.releaseResume('p1--main', { park: true, seen: true });
  // The inspected directory is the one in the script, not some other tree the pane may be sitting in.
  const elsewhere = await ownRunner.claimResume('p1--main', { cwd: '/w/p1-other', permissionMode: 'bypassPermissions' });
  assert.equal(elsewhere.line, full.line);
  const elsewhereScript = fs.readFileSync(path.join(home2, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(elsewhereScript.includes("cd '/w/p1-other' || exit 1"));
  assert.ok(!elsewhereScript.includes("cd '/w/p1' "));

  await ownRunner.releaseResume('p1--main');
  const heldBack = await ownRunner.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'dontAsk' });
  assert.equal(heldBack.line, '"$HOME/.termag/chat-resume/p1--main"');
  const heldScript = fs.readFileSync(path.join(home2, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(heldScript.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(heldScript.includes("cd '/w/p1' || exit 1"));
  await ownRunner.releaseResume('p1--main');
  const noCwd = await ownRunner.claimResume('p1--main', { permissionMode: 'bypassPermissions' });
  assert.equal(noCwd.line, '"$HOME/.termag/chat-resume/p1--main"');
  const noCwdScript = fs.readFileSync(path.join(home2, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(noCwdScript.includes("'dontAsk'"));
  assert.ok(!noCwdScript.includes('\ncd '));
});

test('runner: a trusted resume rehomes the transcript to the checkout it cds into', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-claim-rehome-'));
  const b = box(home);
  const own = { repo: true, branch: 'main', checkout: 'own', mainWorktree: true, originUrl: 'git@github.com:org/repo.git', upstreamUrl: 'git@github.com:org/repo.git', upstreamRef: 'origin/main', upstreamMerge: 'refs/heads/main', fork: false };
  const id = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
  const r = runner(home, b, [], { readCheckout: async () => own });
  const first = await r.sendMessage(job('hello', { permissionMode: 'bypassPermissions', cwd: '/home/u/proj' }));
  b.finish(first.turnId, id);
  await r.poll();
  const oldDir = path.join(home, '.claude/projects', slugForCwd('/home/u/proj'));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, `${id}.jsonl`), '{"type":"user"}\n');
  const claim = await r.claimResume('p1--main', { cwd: '/home/u/renamed', permissionMode: 'bypassPermissions' });
  assert.equal(claim.claimed, true);
  const newDir = path.join(home, '.claude/projects', slugForCwd('/home/u/renamed'));
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)), 'transcript followed the cwd the launcher cds to');
  assert.ok(!fs.existsSync(path.join(oldDir, `${id}.jsonl`)));
  const stateFile = path.join(home, '.termag/chats/p1--main.json');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).cwd, '/home/u/renamed');
  const script = fs.readFileSync(path.join(home, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(script.includes("cd '/home/u/renamed' || exit 1"));
  // The same cwd again leaves the file where it is.
  await r.releaseResume('p1--main');
  await r.claimResume('p1--main', { cwd: '/home/u/renamed', permissionMode: 'bypassPermissions' });
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)));
  // A confined resume cds to the same directory, so the transcript follows it.
  await r.releaseResume('p1--main');
  await r.claimResume('p1--main', { cwd: '/home/u/elsewhere', permissionMode: 'dontAsk' });
  const confinedDir = path.join(home, '.claude/projects', slugForCwd('/home/u/elsewhere'));
  assert.ok(fs.existsSync(path.join(confinedDir, `${id}.jsonl`)));
  assert.ok(!fs.existsSync(path.join(newDir, `${id}.jsonl`)));
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).cwd, '/home/u/elsewhere');
  const confinedScript = fs.readFileSync(path.join(home, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(confinedScript.includes("cd '/home/u/elsewhere' || exit 1"));
  assert.ok(confinedScript.includes('CLAUDE_CONFIG_DIR'));
});

test('runner: a claim inspect and a send cannot interleave, and the send queues once the hold is taken', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-claim-slow-'));
  const b = box(home);
  const waiting = [];
  let delayNext = 0;
  const readCheckout = () => {
    if (delayNext > 0) {
      delayNext -= 1;
      return new Promise(resolve => waiting.push(resolve));
    }
    return Promise.resolve({ repo: true, unreadable: true });
  };
  const r = runner(home, b, [], { readCheckout });
  const { turnId } = await r.sendMessage(job('hello'));
  b.finish(turnId, 'sess-aaaa-1111');
  await r.poll();
  delayNext = 1;
  const pending = r.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'dontAsk' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting.length, 1, 'the claim is waiting on inspect');
  // The claim is on the send chain. A send waits it out instead of starting
  // a turn on the session the resume is about to take.
  let sent = false;
  const mid = r.sendMessage(job('during')).then(result => { sent = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, false);
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'during'), 'the send does not start while the claim is inspecting');
  waiting.shift()({ repo: true, unreadable: true });
  const claim = await pending;
  assert.equal(claim.claimed, true);
  const queued = await mid;
  assert.equal(queued.queued, true, 'the send lands after the hold, so it queues');
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'during'));
  // Releasing the hold lets the queued message start. The hold did not leak.
  await r.releaseResume('p1--main');
  const after = await r.sendMessage(job('after'));
  assert.equal(after.queued, true, 'after waits behind the message that queued during the claim');
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'during'));
});

test('runner: clear drops a resume hold, and interrupt leaves a parked queue while the pane holds the session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-hold-clear-'));
  const b = box(home);
  const r = runner(home, b, []);
  const first = await r.sendMessage(job('hello'));
  b.finish(first.turnId, 'sess-aaaa-1111');
  await r.poll();
  await r.claimResume('p1--main');
  assert.equal((await r.sendMessage(job('while held'))).queued, true);
  assert.equal(b.procs.size, 1, 'the hold keeps that send from starting a turn');
  await r.clear('p1--main');
  const again = await r.sendMessage(job('after clear'));
  assert.equal(again.queued, false, 'clear dropped the hold, so a new send starts');
  assert.ok(b.procs.has(again.turnId));

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-hold-interrupt-'));
  const b2 = box(home2);
  const r2 = runner(home2, b2, []);
  const running = await r2.sendMessage(job('hello'));
  await r2.sendMessage(job('next'));
  b2.finish(running.turnId, 'sess-bbbb-2222');
  await r2.claimResume('p1--main');
  await r2.releaseResume('p1--main', { park: true });
  await r2.poll();
  assert.deepEqual(await r2.interrupt('p1--main'), { interrupted: false, held: true, dropped: [] });
  assert.equal((await r2.history('p1--main')).queued, 1, 'the pane still holds the session, so the queue stays');
  assert.equal((await r2.history('p1--main')).parked, true);

  // A runner turn that is actually going is stopped even if the pane also has a claim.
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-hold-interrupt-live-'));
  const b3 = box(home3);
  const r3 = runner(home3, b3, [], { interruptGraceMs: 5, stopSession: async () => {} });
  const live = await r3.sendMessage(job('hello'));
  await r3.sendMessage(job('queued behind it'));
  await r3.notePane('p1--main', 'claude');
  assert.deepEqual(await r3.interrupt('p1--main'), { interrupted: true, scope: 'all', dropped: ['queued behind it'] });
  b3.finish(live.turnId);
  await r3.poll();
  assert.equal(b3.procs.size, 1);
});

test('runner: Claude still in the pane queues a send and does not start a second writer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-held-'));
  const b = box(home);
  const r = runner(home, b, []);
  const first = await r.sendMessage(job('hello'));
  b.finish(first.turnId, 'sess-held-1111');
  await r.poll();
  await r.claimResume('p1--main');
  await r.releaseResume('p1--main', { park: true, seen: true });
  const sent = await r.sendMessage(job('describe', { paneProbe: 'claude' }));
  assert.equal(sent.queued, true);
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'describe'), 'a live Claude is not joined by a runner turn');
});

test('runner: a settled resume marks the pane seen, so leaving Claude starts the chat without the start grace', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-seen-'));
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(job('hello'));
  assert.deepEqual(await r.sendMessage(job('next')), { queued: true, position: 1 });
  b.finish(turnId, 'sess-aaaa-1111');
  await r.claimResume('p1--main');
  await r.releaseResume('p1--main', { park: true, seen: true });
  assert.equal((await r.notePane('p1--main', 'unknown')).resume, false);
  await r.resumeQueue('p1--main');
  await r.poll();
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'next'), 'a miss after Claude was seen is not an exit');
  assert.equal((await r.notePane('p1--main', 'shell')).resume, true);
  assert.equal((await r.resumeQueue('p1--main')).resumed, true);
  await r.poll();
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'next'));

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-seen-send-'));
  const b2 = box(home2);
  const r2 = runner(home2, b2, []);
  const first = await r2.sendMessage(job('hello'));
  b2.finish(first.turnId, 'sess-bbbb-2222');
  await r2.poll();
  await r2.claimResume('p1--main');
  await r2.releaseResume('p1--main', { park: true, seen: true });
  const sent = await r2.sendMessage(job('after', { paneProbe: 'shell' }));
  assert.equal(sent.queued, false);
  assert.ok([...b2.procs.values()].some(p => p.meta.text === 'after'));
});

test('runner: a resume claim keeps a queued turn from starting, and parks it once the pane takes the session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-claim-'));
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(job('hello'));
  assert.deepEqual(await r.sendMessage(job('next')), { queued: true, position: 1 });
  b.finish(turnId, 'sess-aaaa-1111');
  const claim = await r.claimResume('p1--main');
  assert.equal(claim.claimed, true);
  await r.resumeQueue('p1--main');
  await r.poll();
  assert.equal(b.procs.size, 1, 'the queued turn does not start while the claim is held');
  await r.releaseResume('p1--main', { park: true });
  await r.poll();
  assert.equal(b.procs.size, 1);
  assert.equal((await r.history('p1--main')).parked, true);
  assert.equal((await r.history('p1--main')).queued, 1);
});

test('runner: a probe miss or a shell does not start a parked queue, and neither does a send, until Claude was seen and left', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pane-'));
  const b = box(home);
  let t = 1_000;
  const r = runner(home, b, [], { now: () => t });
  const { turnId } = await r.sendMessage(job('hello'));
  assert.deepEqual(await r.sendMessage(job('next')), { queued: true, position: 1 });
  b.finish(turnId, 'sess-aaaa-1111');
  await r.claimResume('p1--main');
  await r.releaseResume('p1--main', { park: true });
  assert.equal(b.procs.size, 1);

  // The history poll: Claude has not appeared, and the probe missed or still
  // shows the shell the resume was typed into.
  assert.equal((await r.notePane('p1--main', 'unknown')).resume, false);
  assert.equal((await r.resumeQueue('p1--main')).resumed, false);
  assert.equal((await r.notePane('p1--main', 'shell')).resume, false);
  await r.resumeQueue('p1--main');
  await r.poll();
  assert.equal(b.procs.size, 1, 'a miss or a shell does not unpark while Claude is still coming up');

  // The send that was waiting on the pane lock and runs once the settle gives up.
  assert.deepEqual(await r.sendMessage(job('also', { paneProbe: 'shell' })), { queued: true, position: 2 });
  assert.equal(b.procs.size, 1, 'that send queues behind the pane instead of starting a turn');
  assert.deepEqual(await r.sendMessage(job('missed', { paneProbe: 'unknown' })), { queued: true, position: 3 });
  assert.equal(b.procs.size, 1);

  // An agent restart keeps the claim. A missed probe still must not start it.
  const restarted = runner(home, b, [], { now: () => t });
  assert.equal((await restarted.notePane('p1--main', 'unknown')).resume, false);
  assert.equal((await restarted.resumeQueue('p1--main')).resumed, false);
  assert.equal(b.procs.size, 1);

  // Claude appears, then the probe misses, then vim: still held.
  assert.equal((await restarted.notePane('p1--main', 'claude')).resume, false);
  assert.equal((await restarted.notePane('p1--main', 'unknown')).resume, false);
  assert.equal((await restarted.notePane('p1--main', 'other')).resume, false);
  await restarted.resumeQueue('p1--main');
  assert.equal(b.procs.size, 1, 'a miss after Claude was seen is not Claude having exited');

  // Claude has left for a shell. The parked queue may start. The new process
  // did not see the in-memory park bit; the queue file is what starts.
  assert.equal((await restarted.notePane('p1--main', 'shell')).resume, true);
  await restarted.resumeQueue('p1--main');
  await restarted.poll();
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'next'));

  // Long after the resume, a shell and no Claude means it never came up.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pane-grace-'));
  const b2 = box(home2);
  let t2 = 5_000;
  const late = runner(home2, b2, [], { now: () => t2 });
  const first = await late.sendMessage(job('hello'));
  await late.sendMessage(job('next'));
  b2.finish(first.turnId, 'sess-bbbb-2222');
  await late.claimResume('p1--main');
  await late.releaseResume('p1--main', { park: true });
  await late.poll();
  assert.ok(![...b2.procs.values()].some(p => p.meta.text === 'next'), 'polling the finished turn does not unpark it');
  t2 += PANE_START_GRACE_MS;
  assert.equal((await late.notePane('p1--main', 'shell')).resume, true);
  assert.equal((await late.resumeQueue('p1--main')).resumed, true);
  assert.ok([...b2.procs.values()].some(p => p.meta.text === 'next'));
});

test('durable: a turn runs in its own tmux session; its log goes out numbered, and a queued message starts after it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  const { turnId } = await r.sendMessage(job('hello'));
  assert.ok(b.sessions.has(`alice-chat-${turnId}-r`));
  const started = b.procs.get(turnId);
  assert.equal(started.meta.args[started.meta.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(started.meta.path, '/bin:/usr/bin');
  assert.equal(started.meta.configDir, path.join(home, '.termag/chat-config'));
  assert.deepEqual(await r.sendMessage(job('and then?')), { queued: true, position: 1 });

  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-aaaa-1111' }, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } }]);
  await r.poll();
  assert.deepEqual(frames.map(f => [f.seq, f.event.type]), [[1, 'turn-start'], [2, 'system'], [3, 'assistant']]);
  assert.ok(frames.every(f => f.turnId === turnId && f.chatKey === 'p1--main' && f.projectId === 'p1'));

  b.finish(turnId, 'sess-aaaa-1111');
  await r.poll();
  assert.equal(frames.at(-1).event.type, 'turn-end');
  const next = [...b.procs.values()].find(p => p.meta.turnId !== turnId);
  assert.equal(next.meta.text, 'and then?');
  assert.deepEqual(next.meta.args.slice(-2), ['--resume', 'sess-aaaa-1111']);
  assert.equal((await r.history('p1--main')).queued, 0);
});

test('durable: a new agent takes the turn up where the old one stopped, without sending anything twice', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const before = [];
  const r1 = runner(home, b, before);
  const { turnId } = await r1.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-bbbb-2222' }]);
  await r1.poll();
  assert.equal(before.length, 2);

  b.write(turnId, [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'while you were away' }] } }]);
  const after = [];
  const r2 = runner(home, b, after);
  await r2.recover();
  await r2.poll();
  assert.deepEqual(after.map(f => [f.seq, f.event.type]), [[3, 'assistant']]);
  assert.equal((await r2.history('p1--main')).running, true);
  b.finish(turnId, 'sess-bbbb-2222');
  await r2.poll();
  assert.deepEqual(after.map(f => f.event.type), ['assistant', 'turn-end']);
  const finished = await r2.history('p1--main');
  assert.equal(finished.running, false);
  assert.equal(finished.turn, null);
});

test('durable: a turn that died while the agent was down is reported; its queue parks until the backend resumes the chat', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  await r1.sendMessage(job('queued behind it'));
  await r1.poll();
  b.crash(turnId);

  const frames = [];
  const r2 = runner(home, b, frames);
  await r2.recover();
  await r2.poll();
  const err = frames.find(f => f.event.type === 'runner-error');
  assert.match(err.event.message, /stopped before Claude finished/);
  const died = frames.filter(f => f.turnId === turnId && f.seq != null).at(-1).event;
  assert.equal(died.type, 'turn-end');
  assert.equal(died.exitCode, null);
  assert.equal(died.signal, null);
  assert.equal(died.lost, true);
  assert.equal(died.costUsd, null);
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'queued behind it'), 'the queued message did not start');
  assert.deepEqual(frames.at(-1).event, { type: 'queue-parked', queued: 1 });
  assert.equal((await r2.history('p1--main')).parked, true);
  await r2.poll();
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'queued behind it'));

  assert.deepEqual(await r2.resumeQueue('p1--main'), { resumed: true });
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'queued behind it'), 'it starts once the backend resumes the chat');
});

test('durable: a queue found after a restart parks; a send from the backend starts it oldest first', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), JSON.stringify([job('left behind')]));
  const b = box(home);
  const r = runner(home, b, []);
  await r.recover();
  await r.poll();
  assert.equal(b.procs.size, 0, 'nothing starts after a restart');
  assert.equal((await r.history('p1--main')).parked, true);

  assert.deepEqual(await r.sendMessage(job('new one')), { queued: true, position: 1 });
  const started = [...b.procs.values()].map(p => p.meta.text);
  assert.deepEqual(started, ['left behind']);
  assert.equal((await r.history('p1--main')).parked, false);
});

test('durable: chat-clear drops the queue and stops the running turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const stopped = [];
  const r = runner(home, b, [], {
    stopSession: async (name) => {
      stopped.push(name);
      b.sessions.delete(name);
      for (const p of b.procs.values()) {
        if (p.meta.session === name) fs.writeFileSync(path.join(p.dir, 'exit'), JSON.stringify({ code: null, signal: 'SIGTERM' }));
      }
    },
  });
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: true });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'bypassPermissions' }));
  await r.sendMessage(job('y', { permissionMode: 'bypassPermissions' }));
  await r.sendMessage(job('z'));
  assert.deepEqual(await r.clear('p1--main'), { cleared: 2, stopped: true });
  assert.deepEqual(b.signals[0], [4242, 'SIGINT']);
  assert.equal((await r.history('p1--main')).queued, 0);
  assert.deepEqual(stopped, [`alice-chat-${turnId}-r`]);
  assert.ok(fs.existsSync(path.join(b.procs.get(turnId).dir, 'exit')));
  await assert.rejects(r.clear('../x'), /chatKey/);
});

test('durable: chat-clear reports stopped false while the process is still alive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-alive-'));
  const b = box(home);
  const r = runner(home, b, [], {
    interruptGraceMs: 15,
    pidAlive: () => true,
    stopSession: async (name) => { b.sessions.delete(name); },
  });
  const { turnId } = await r.sendMessage(job('x'));
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: false });
  const dir = b.procs.get(turnId).dir;
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false);
  assert.ok(b.signals.some(s => s[0] === 4242 && s[1] === 'SIGKILL'));
});

test('durable: chat-clear during start waits for the kill and does not invent an exit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-start-clear-'));
  const b = box(home);
  let release;
  const held = new Promise(res => { release = res; });
  const real = b.startProcess;
  b.startProcess = async (meta, dir) => { await held; return real(meta, dir); };
  const stopped = [];
  const r = runner(home, b, [], {
    interruptGraceMs: 15,
    pidAlive: () => true,
    stopSession: async (name) => { stopped.push(name); b.sessions.delete(name); },
  });
  const pendingSend = r.sendMessage(job('x'));
  await new Promise(res => setImmediate(res));
  let done = false;
  const pendingClear = r.clear('p1--main').then(res => { done = true; return res; });
  await new Promise(res => setImmediate(res));
  assert.equal(done, false);
  assert.equal(stopped.length, 0);
  release();
  const result = await pendingClear;
  assert.equal(result.stopped, false);
  assert.equal(stopped.length, 1);
  const { turnId } = await pendingSend;
  assert.equal(fs.existsSync(path.join(b.procs.get(turnId).dir, 'exit')), false);
  assert.ok(b.signals.some(s => s[1] === 'SIGKILL'));
});

test('durable: the alive check during chat-clear does not fake an exit while Claude is still alive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-clear-poll-'));
  const b = box(home);
  let t = 1_000_000;
  const r = runner(home, b, [], {
    now: () => t,
    interruptGraceMs: 40,
    pidAlive: () => true,
    stopSession: async (name) => { b.sessions.delete(name); },
  });
  const { turnId } = await r.sendMessage(job('x'));
  const dir = b.procs.get(turnId).dir;
  const pendingClear = r.clear('p1--main');
  await new Promise(res => setImmediate(res));
  assert.equal(b.sessions.size, 0, 'kill-session removed the session');
  t += 11_000;
  await r.poll();
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false, 'no synthetic exit while the wrapper is still killing Claude');
  // Even an exit file is not death while the recorded pid lives.
  fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: null, signal: null, lost: true }));
  assert.deepEqual(await pendingClear, { cleared: 0, stopped: false });
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: false }, 'a later clear with an exit but a live pid still refuses');
});

test('durable: a send during chat-clear is refused and nothing queued starts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-clear-send-'));
  const b = box(home);
  let t = 1_000_000;
  let alive = true;
  const r = runner(home, b, [], {
    now: () => t,
    interruptGraceMs: 60,
    pidAlive: () => alive,
    stopSession: async (name) => { b.sessions.delete(name); },
  });
  const { turnId } = await r.sendMessage(job('x'));
  await r.sendMessage(job('y'));
  const pendingClear = r.clear('p1--main');
  await new Promise(res => setImmediate(res));
  await assert.rejects(r.sendMessage(job('z')), /chat-clearing/);
  assert.equal((await r.history('p1--main')).queued, 0);

  // A job that reached the queue anyway, and the turn ending mid-clear: the poll must not start it.
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), JSON.stringify([job('sneaked in')]));
  b.finish(turnId);
  t += 11_000;
  await r.poll();
  assert.equal(b.procs.size, 1, 'no new turn starts while the chat is being cleared');

  alive = false;
  assert.deepEqual(await pendingClear, { cleared: 1, stopped: true });
  await r.poll();
  assert.equal(b.procs.size, 1);
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), '[]');
  assert.equal((await r.sendMessage(job('after'))).queued, false, 'sends are accepted again once the clear returns');
});

test('durable: a crash noticed while the agent runs is closed on the next alive check', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  let t = 1_000_000;
  const r = runner(home, b, frames, { now: () => t });
  const { turnId } = await r.sendMessage(job('hello'));
  await r.poll();
  b.crash(turnId);
  t += 11_000;
  await r.poll();
  await r.poll();
  assert.ok(frames.some(f => f.event.type === 'runner-error'));
  assert.equal(frames.at(-1).event.type, 'turn-end');
});

test('durable: nothing is lost while the socket is down', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  let down = true;
  const r = runner(home, b, frames, { down: () => down });
  const { turnId } = await r.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-cccc-3333' }]);
  await r.poll();
  assert.equal(frames.length, 0);
  down = false;
  await r.poll();
  assert.deepEqual(frames.map(f => f.seq), [1, 2]);
});

test('durable: history replays the running turn from its log and cuts it from the transcript', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.json'), JSON.stringify({ sessionId: 'sess-dddd-4444' }));
  const tdir = path.join(home, '.claude/projects/-w-p1');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 'sess-dddd-4444.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'first' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(job('second'));
  fs.appendFileSync(path.join(tdir, 'sess-dddd-4444.jsonl'), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } })}\n`);
  b.write(turnId, [{ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } }]);
  const h = await r.history('p1--main');
  assert.equal(h.running, true);
  assert.equal(h.entries.length, 2);
  assert.deepEqual(h.turn.events.map(e => [e.seq, e.event.type]), [[1, 'turn-start'], [2, 'stream_event']]);
});

test('durable: interrupt signals Claude and drops the queue, saying which messages; bad input is refused', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  assert.deepEqual(await r.interrupt('p1--main'), { interrupted: false, dropped: [] });
  await r.sendMessage(job('x'));
  await r.sendMessage(job('y'));
  assert.deepEqual(await r.interrupt('p1--main'), { interrupted: true, scope: 'all', dropped: ['y'] });
  assert.deepEqual(frames.at(-1).event, { type: 'queue-dropped', texts: ['y'] });
  assert.deepEqual(b.signals[0], [4242, 'SIGINT']);
  assert.equal((await r.history('p1--main')).queued, 0);
  const dir = [...b.procs.values()][0].dir;
  assert.ok(fs.existsSync(path.join(dir, 'interrupted')), 'the wrapper must not report a deliberate stop as a failure');
  await assert.rejects(r.sendMessage(job('x', { chatKey: '../k' })), /chatKey/);
  await assert.rejects(r.sendMessage(job('x', { cwd: 'rel' })), /absolute/);
  await assert.rejects(r.sendMessage(job('  ')), /text/);
});

test('startTurn: a cwd change re-homes the transcript before --resume, and passes the config dir', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-'));
  const b = box(home);
  const r = runner(home, b, []);
  const id = 'sessio01-2345-6789-abcd-ef0123456789';
  const first = await r.sendMessage({ chatKey: 'p--w1', cwd: '/home/u/proj', text: 'hi', projectId: 'p', workstream: 'main', workstreamId: 'w1' });
  b.finish(first.turnId, id);
  await r.poll();
  const oldDir = path.join(home, '.claude/projects', slugForCwd('/home/u/proj'));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, `${id}.jsonl`), '{"type":"user"}\n');
  const second = await r.sendMessage({ chatKey: 'p--w1', cwd: '/home/u/renamed', text: 'again', projectId: 'p', workstream: 'main', workstreamId: 'w1' });
  const newDir = path.join(home, '.claude/projects', slugForCwd('/home/u/renamed'));
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)), 'transcript followed the rename');
  const meta = b.procs.get(second.turnId).meta;
  assert.equal(meta.args[meta.args.indexOf('--resume') + 1], id, 'resumes the same session');
  assert.equal(meta.configDir, path.join(home, '.termag/chat-config'));
});

test('frames carry the workstream id, so the relay keys the chat by id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-wsid-'));
  const b = box(home);
  const sent = [];
  const r = runner(home, b, sent);
  const { turnId } = await r.sendMessage({ chatKey: 'p--w9', cwd: '/w', text: 'hi', projectId: 'p', workstream: 'feature', workstreamId: 'w9' });
  await r.poll();
  const start = sent.find(f => f.event?.type === 'turn-start');
  assert.equal(start.workstreamId, 'w9');
  assert.equal(start.workstream, 'feature');
  assert.equal(start.turnId, turnId);
});

test('sendMessage: the queue is capped, so a stuck chat cannot pile up billed turns', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cap-'));
  const b = box(home);
  const r = runner(home, b, []);
  await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'first' });
  for (let i = 0; i < 20; i++) await r.sendMessage({ chatKey: 'k', cwd: '/w', text: `q${i}` });
  await assert.rejects(r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'over' }), /queue-full/);
});

test('startTurn: a failed start ends the turn and the queued message runs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-spawn-'));
  const b = box(home);
  let calls = 0;
  const real = b.startProcess;
  b.startProcess = async (meta, dir) => {
    calls++;
    if (calls === 1) throw new Error('ENOENT');
    return real(meta, dir);
  };
  const sent = [];
  const r = runner(home, b, sent);
  await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'first' });
  await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'queued' });
  await r.poll();
  const types = sent.map(f => f.event?.type);
  assert.ok(types.includes('runner-error'), 'forwards the start failure');
  assert.ok(types.includes('turn-end'), 'ends the turn so the chat is not left busy');
  assert.equal([...b.procs.values()].map(p => p.meta.text).at(-1), 'queued');
});

test('durable: a died turn keeps the session id from its init line, and history still shows the error', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-died-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-ffff-6666' }]);
  b.crash(turnId);

  const frames = [];
  const r2 = runner(home, b, frames);
  await r2.recover();
  const state = JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.json'), 'utf8'));
  assert.equal(state.sessionId, 'sess-ffff-6666');
  await r2.poll();
  const h = await r2.history('p1--main');
  assert.equal(h.running, false);
  assert.match(h.turn.events.find(e => e.event.type === 'runner-error').event.message, /Send the message again/);
  const next = await r2.sendMessage(job('again'));
  assert.deepEqual(b.procs.get(next.turnId).meta.args.slice(-2), ['--resume', 'sess-ffff-6666']);
});

test('durable: a died turn with no init does not wipe a session id already recorded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-died-keep-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.json'), JSON.stringify({ sessionId: 'sess-keep-7777', cwd: '/w/p1' }));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  b.crash(turnId);
  const r2 = runner(home, b, []);
  await r2.recover();
  const state = JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.json'), 'utf8'));
  assert.equal(state.sessionId, 'sess-keep-7777');
});

test('durable: turn-end that lands while a poll is forwarding is sent on the next poll', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-end-'));
  const b = box(home);
  const frames = [];
  let finishDuring = null;
  const r = createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', env: { PATH: '/usr/bin' },
    send: f => {
      frames.push(f);
      if (f.event.type === 'assistant' && finishDuring) finishDuring();
      return true;
    },
    startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid,
  });
  const { turnId } = await r.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } }]);
  finishDuring = () => b.finish(turnId, 'sess-eeee-5555');
  await r.poll();
  assert.ok(!frames.some(f => f.event.type === 'turn-end'));
  await r.poll();
  assert.ok(frames.some(f => f.event.type === 'turn-end'));
});

test('durable: a liveness check does not kill a turn that is still starting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-starting-'));
  const b = box(home);
  let release;
  const held = new Promise(res => { release = res; });
  const real = b.startProcess;
  b.startProcess = async (meta, dir) => { await held; return real(meta, dir); };
  let t = 1_000_000;
  const r = runner(home, b, [], { now: () => t });
  const pending = r.sendMessage(job('hello'));
  await new Promise(res => setImmediate(res));
  t += 11_000;
  await r.poll();
  release();
  const { turnId } = await pending;
  assert.ok(!fs.existsSync(path.join(b.procs.get(turnId).dir, 'exit')));
});

test('durable: a hello does not park a queue this process already accepted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rehello-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  const { turnId } = await r.sendMessage(job('hello'));
  await r.sendMessage(job('follow-up'));
  await r.recover();
  b.finish(turnId, 'sess-rehello-1111');
  await r.poll();
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'follow-up'), 'the follow-up starts');
  assert.ok(!frames.some(f => f.event.type === 'queue-parked'));
});

test('durable: a send clears recovered, so a queue behind a taken-up turn starts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-reaccept-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  await r1.sendMessage(job('left behind'));
  const frames = [];
  const r2 = runner(home, b, frames);
  await r2.recover();
  assert.deepEqual(await r2.sendMessage(job('and this')), { queued: true, position: 2 });
  b.finish(turnId, 'sess-reaccept-2222');
  await r2.poll();
  const started = [...b.procs.values()].filter(p => p.meta.turnId !== turnId).map(p => p.meta.text);
  assert.deepEqual(started, ['left behind']);
  assert.ok(!frames.some(f => f.event.type === 'queue-parked'));
});

test('durable: a disconnect during recover keeps the gate shut until the next recover', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rearm-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  await r1.sendMessage(job('hello'));
  let releaseAlive;
  const alive = new Promise(res => { releaseAlive = res; });
  const r2 = runner(home, b, [], { sessionAlive: () => alive });
  r2.holdRecover();
  const recovering = r2.recover();
  await new Promise(res => setImmediate(res));
  r2.holdRecover();
  releaseAlive(true);
  await recovering;
  let started = false;
  const pending = r2.sendMessage(job('next')).then(res => { started = true; return res; });
  await new Promise(res => setImmediate(res));
  assert.equal(started, false);
  await r2.recover();
  await pending;
  assert.equal(started, true);
});

test('durable: send waits until recover finishes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-gate-'));
  const b = box(home);
  const r = runner(home, b, []);
  r.holdRecover();
  let started = false;
  const pending = r.sendMessage(job('hello')).then(res => { started = true; return res; });
  await new Promise(res => setImmediate(res));
  assert.equal(started, false);
  assert.equal(b.procs.size, 0);
  await r.recover();
  await pending;
  assert.equal(b.procs.size, 1);
});

test('durable: recover refuses a dead chat and does not forward it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-dead-'));
  const b = box(home);
  const stopped = [];
  const stopSession = async (name) => { stopped.push(name); b.sessions.delete(name); };
  const r1 = runner(home, b, [], { stopSession });
  const { turnId } = await r1.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'secret' }] } }]);
  await r1.sendMessage(job('queued'));
  const frames = [];
  const r2 = runner(home, b, frames, { stopSession });
  await r2.recover({ deadKeys: ['p1--main'] });
  await r2.poll();
  assert.equal(frames.length, 0);
  assert.ok(stopped.includes(`alice-chat-${turnId}-r`));
  const h = await r2.history('p1--main');
  assert.equal(h.running, false);
  assert.equal(h.queued, 0);
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'queued'));
});

test('durable: a dead queue with no turn is dropped instead of parked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-dead-q-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  const queue = path.join(home, '.termag/chats/p1--main.queue.json');
  fs.writeFileSync(queue, JSON.stringify([job('left behind', { workstreamId: 'main' })]));
  const b = box(home);
  const r = runner(home, b, []);
  assert.ok(r.keysOnDisk().some(k => k.chatKey === 'p1--main' && k.projectId === 'p1' && k.workstreamId === 'main'));
  await r.recover({ deadKeys: ['p1--main'] });
  assert.equal(fs.existsSync(queue), false);
  assert.equal((await r.history('p1--main')).parked, false);
  assert.equal(b.procs.size, 0);
});

test('durable: an earlier identical prompt does not cut history; the cut is the transcript size at start', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bytes-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.json'), JSON.stringify({ sessionId: 'sess-hhhh-9999', cwd: '/w/p1' }));
  const file = path.join(home, '.claude/projects/-w-p1/sess-hhhh-9999.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prior = [
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, prior);
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(job('go'));
  assert.equal(b.procs.get(turnId).meta.transcriptBytes, Buffer.byteLength(prior));
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`);
  const h = await r.history('p1--main');
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[0].message.content, 'go');
});

test('durable: a finished turn directory older than an hour is removed on the alive check', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-prune-'));
  const b = box(home);
  let t = 1_000_000;
  const r = runner(home, b, [], { now: () => t });
  const { turnId } = await r.sendMessage(job('hello'));
  b.finish(turnId, 'sess-gggg-8888');
  await r.poll();
  const dir = b.procs.get(turnId).dir;
  const old = new Date(t - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'done'), old, old);
  t += 11_000;
  await r.poll();
  assert.equal(fs.existsSync(dir), false);
});

test('durable: an interrupt whose wrapper never writes exit is not reported as a died turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-int-'));
  const b = box(home);
  const frames = [];
  let t = 1_000_000;
  const r = runner(home, b, frames, { now: () => t });
  const { turnId } = await r.sendMessage(job('hello'));
  await r.interrupt('p1--main');
  b.crash(turnId);
  t += 11_000;
  await r.poll();
  await r.poll();
  assert.ok(!frames.some(f => f.event.type === 'runner-error'));
  assert.equal(frames.filter(f => f.event.type === 'turn-end').at(-1).event.lost, false);
});

test('turn records: Claude\'s cost when it printed one, the clock and the exit otherwise', () => {
  const withResult = turnRecord({
    turnId: 't1', prompt: '  hello  ', sessionId: 'sess-aaaa-1111',
    result: { type: 'result', total_cost_usd: 0.04, duration_ms: 12000, is_error: false },
    startedAt: 0, endedAt: 99_000, exitCode: 0,
  });
  assert.equal(withResult.costUsd, 0.04);
  assert.equal(withResult.durationMs, 12000);
  assert.equal(withResult.prompt, 'hello');
  assert.equal(withResult.isError, false);
  assert.equal(withResult.userUuid, null);
  const noResult = turnRecord({ turnId: 't2', prompt: 'x'.repeat(250), sessionId: null, result: null, startedAt: 1000, endedAt: 1800, exitCode: 1 });
  assert.equal(noResult.costUsd, null);
  assert.equal(noResult.durationMs, 800);
  assert.equal(noResult.prompt.length, 200);
  assert.equal(noResult.isError, true);
  assert.equal(turnRecord({ turnId: 't3', prompt: '', result: null, startedAt: 0, endedAt: 0, exitCode: null }).isError, true);
  const parsed = parseTurnRecords(`not json\n{"turnId":"t1","prompt":"hi","costUsd":0.04,"durationMs":12,"isError":false}\n{"nope":true}\n`);
  assert.deepEqual(parsed, [{ turnId: 't1', at: null, prompt: 'hi', userUuid: null, costUsd: 0.04, durationMs: 12, isError: false }]);
  const tagged = parseTurnRecords('{"turnId":"t4","prompt":"go","userUuid":"chat-1","costUsd":0.02,"durationMs":5,"isError":false}\n');
  assert.equal(tagged[0].userUuid, 'chat-1');
});

test('user prompt uuid: the first prompt after the turn started, not a tool result or a later repeat', () => {
  const jsonl = [
    { type: 'user', uuid: 'tool-only', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'go' }] } },
    { type: 'user', uuid: 'chat-1', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', uuid: 'term-2', message: { role: 'user', content: 'go' } },
  ].map(e => JSON.stringify(e)).join('\n');
  assert.equal(userPromptUuid(jsonl), 'chat-1');
  assert.equal(userPromptUuid(''), null);
});

test('cost: a turn-end carries Claude\'s cost, and a new runner reads the same records', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cost-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  const { turnId } = await r.sendMessage(job('how do I run the tests?'));
  b.write(turnId, [
    { type: 'system', subtype: 'init', session_id: 'sess-cost-1111' },
    { type: 'result', is_error: false, total_cost_usd: 0.04, duration_ms: 12000, session_id: 'sess-cost-1111' },
  ]);
  b.finish(turnId, 'sess-cost-1111');
  const transcript = path.join(home, '.claude/projects/-w-p1/sess-cost-1111.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'chat-1', message: { role: 'user', content: 'how do I run the tests?' } },
    { type: 'user', uuid: 'term-repeat', message: { role: 'user', content: 'how do I run the tests?' } },
  ].map(e => `${JSON.stringify(e)}\n`).join(''));
  await r.poll();
  const end = frames.at(-1).event;
  assert.equal(end.type, 'turn-end');
  assert.equal(end.costUsd, 0.04);
  assert.equal(end.durationMs, 12000);
  const first = await r.history('p1--main');
  assert.equal(first.turns.length, 1);
  assert.equal(first.turns[0].prompt, 'how do I run the tests?');
  assert.equal(first.turns[0].userUuid, 'chat-1');
  assert.equal(first.turns[0].costUsd, 0.04);
  assert.equal(first.turns[0].isError, false);
  await r.poll();
  assert.equal((await r.history('p1--main')).turns.length, 1, 'forwarding the turn again does not record it twice');

  const { turnId: turn2 } = await r.sendMessage(job('again'));
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'chat-2', message: { role: 'user', content: 'again' } })}\n`);
  const dir = b.procs.get(turn2).dir;
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-end', exitCode: 1 })}\n`);
  fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 1 }));
  b.sessions.delete(b.procs.get(turn2).meta.session);
  await r.poll();
  const second = (await r.history('p1--main')).turns;
  assert.equal(second.length, 2);
  assert.equal(second[1].turnId, turn2);
  assert.equal(second[1].userUuid, 'chat-2');
  assert.equal(second[1].costUsd, null);
  assert.equal(second[1].isError, true);
  assert.equal(typeof second[1].durationMs, 'number');
  assert.ok(second[1].durationMs >= 0);

  const again = await runner(home, b, []).history('p1--main');
  assert.equal(again.turns.length, 2);
  assert.equal(again.turns[0].costUsd, 0.04);
  assert.equal(again.turns[1].turnId, turn2);
});

test('titles: a send that asks for them gets Claude\'s title for the session on each turn-end', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-title-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  const transcript = path.join(home, '.claude/projects/-w-p1/sess-title-1111.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const line = e => `${JSON.stringify(e)}\n`;

  const { turnId } = await r.sendMessage(job('add rate limiting to login', { titles: true }));
  assert.equal(b.procs.get(turnId).meta.titles, true);
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'chat-1', message: { role: 'user', content: 'add rate limiting to login' } },
    { type: 'ai-title', aiTitle: 'Login rate limiting', sessionId: 'sess-title-1111' },
  ].map(line).join(''));
  b.finish(turnId, 'sess-title-1111');
  await r.poll();
  assert.equal(frames.at(-1).event.type, 'turn-end');
  assert.equal(frames.at(-1).event.title, 'Login rate limiting');

  // The next turn reads only what it wrote: a /rename there wins.
  const { turnId: turn2 } = await r.sendMessage(job('call it the auth fix', { titles: true }));
  assert.equal(b.procs.get(turn2).meta.transcriptBytes, fs.statSync(transcript).size);
  fs.appendFileSync(transcript, line({ type: 'custom-title', customTitle: 'Auth fix', sessionId: 'sess-title-1111' }));
  b.finish(turn2, 'sess-title-1111');
  await r.poll();
  assert.equal(frames.at(-1).event.title, 'Auth fix');

  // A turn that wrote no title line says nothing, and the backend keeps the last one.
  const { turnId: turn3 } = await r.sendMessage(job('thanks', { titles: true }));
  fs.appendFileSync(transcript, line({ type: 'user', uuid: 'chat-3', message: { role: 'user', content: 'thanks' } }));
  b.finish(turn3, 'sess-title-1111');
  await r.poll();
  assert.equal(frames.at(-1).event.type, 'turn-end');
  assert.equal('title' in frames.at(-1).event, false);
});

test('titles: a send that does not ask (the flag off, an older backend) gets a turn-end without one', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-title-off-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  const transcript = path.join(home, '.claude/projects/-w-p1/sess-title-2222.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Login rate limiting', sessionId: 'sess-title-2222' })}\n`);
  const { turnId } = await r.sendMessage(job('add rate limiting to login', { titles: 'yes' }));
  assert.equal(b.procs.get(turnId).meta.titles, undefined);
  b.finish(turnId, 'sess-title-2222');
  await r.poll();
  assert.equal(frames.at(-1).event.type, 'turn-end');
  assert.equal('title' in frames.at(-1).event, false);
});

// The live tests send the way the backend does with chat-live-input-enabled on.
const liveJob = (text, extra = {}) => job(text, { liveInput: true, ...extra });

test('turn argv: a live turn reads stream-json messages and replays each one it takes in', () => {
  const live = turnArgs(null, 'dontAsk', { live: true });
  assert.equal(live[live.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(live.includes('--replay-user-messages'));
  const plain = turnArgs(null, 'dontAsk');
  assert.equal(plain[plain.indexOf('--input-format') + 1], 'text');
  assert.ok(!plain.includes('--replay-user-messages'));
  assert.ok(CAPABILITIES.includes('chat-live-v1'));
});

test('live: a send while a turn runs goes into its inbox, and one it took in is not sent again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-'));
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(liveJob('start the ask'));
  const { meta, dir } = b.procs.get(turnId);
  assert.equal(meta.live, true);
  assert.equal(meta.args[meta.args.indexOf('--input-format') + 1], 'stream-json');
  assert.deepEqual(await r.sendMessage(liveJob('are you there?')), { queued: false, live: true, turnId });
  assert.deepEqual(await r.sendMessage(liveJob('and this?')), { queued: false, live: true, turnId });
  const inbox = path.join(dir, 'inbox');
  assert.deepEqual(fs.readdirSync(inbox).sort(), ['000001.json', '000002.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox, '000002.json'), 'utf8')).text, 'and this?');
  // chat-turn.js claims a message by renaming it before it writes it to Claude.
  fs.renameSync(path.join(inbox, '000001.json'), path.join(inbox, '000001.sent'));
  assert.equal((await r.history('p1--main')).queued, 1);
  assert.equal((await r.history('p1--main')).liveInput, true);
  b.finish(turnId, 'sess-live-1111');
  await r.poll();
  const next = [...b.procs.values()].filter(p => p.meta.turnId !== turnId).map(p => p.meta.text);
  assert.deepEqual(next, ['and this?']);
});

test('live: a send for another mode or checkout, or to a turn without an inbox, waits in the queue', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-q-'));
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(liveJob('one'));
  assert.equal((await r.sendMessage(liveJob('trusted now', { permissionMode: 'bypassPermissions' }))).queued, true);
  // A queue already waiting goes first, so a later send keeps its place behind it.
  assert.equal((await r.sendMessage(liveJob('same mode'))).queued, true);
  b.finish(turnId);
  await r.poll();

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-q2-'));
  const b2 = box(home2);
  const r2 = runner(home2, b2, []);
  const first = await r2.sendMessage(liveJob('one'));
  assert.equal((await r2.sendMessage(liveJob('elsewhere', { cwd: '/w/other' }))).queued, true);

  // A turn an older agent started has no inbox reader.
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-q3-'));
  const b3 = box(home3);
  const r3 = runner(home3, b3, []);
  const old = await r3.sendMessage(liveJob('one'));
  const metaFile = path.join(home3, '.termag/chats/turns', old.turnId, 'meta.json');
  const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  delete m.live;
  fs.writeFileSync(metaFile, JSON.stringify(m));
  const r3b = runner(home3, b3, []);
  await r3b.recover();
  assert.equal((await r3b.sendMessage(liveJob('two'))).queued, true);
  assert.ok(first.turnId);
});

test('live: a send on another model waits for its own turn, which runs on that model', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-model-'));
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(liveJob('one', { model: 'opus' }));
  assert.equal(b.procs.get(turnId).meta.model, 'opus');
  assert.deepEqual(await r.sendMessage(liveJob('same model', { model: 'opus' })), { queued: false, live: true, turnId });
  assert.equal((await r.sendMessage(liveJob('switched', { model: 'haiku' }))).queued, true);
  b.finish(turnId);
  await r.poll();
  for (let i = 0; i < 3 && ![...b.procs.values()].some(p => p.meta.text === 'switched'); i++) {
    for (const p of [...b.procs.values()]) if (p.meta.turnId !== turnId) b.finish(p.meta.turnId);
    await r.poll();
  }
  const next = [...b.procs.values()].find(p => p.meta.text === 'switched');
  assert.ok(next);
  assert.equal(next.meta.args[next.meta.args.indexOf('--model') + 1], 'haiku');
  assert.equal(b.procs.get(turnId).meta.args[b.procs.get(turnId).meta.args.indexOf('--model') + 1], 'opus');
});

test('live: stop drops what the turn never took in, and clear does too; neither runs afterwards', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-stop-'));
  const b = box(home);
  const r = runner(home, b, [], { interruptGraceMs: 5, stopSession: async () => {} });
  const { turnId } = await r.sendMessage(liveJob('one'));
  await r.sendMessage(liveJob('waiting'));
  assert.deepEqual(await r.interrupt('p1--main'), { interrupted: true, scope: 'all', dropped: ['waiting'] });
  b.finish(turnId);
  await r.poll();
  assert.equal(b.procs.size, 1);

  const second = await r.sendMessage(liveJob('again'));
  await r.sendMessage(liveJob('also waiting'));
  const { cleared } = await r.clear('p1--main');
  assert.equal(cleared, 1);
  b.finish(second.turnId);
  await r.poll();
  assert.equal(b.procs.size, 2);
});

test('live: the inbox is capped like the queue', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-cap-'));
  const b = box(home);
  const r = runner(home, b, []);
  await r.sendMessage(liveJob('first'));
  for (let i = 0; i < 20; i++) assert.equal((await r.sendMessage(liveJob(`m${i}`))).live, true);
  await assert.rejects(r.sendMessage(liveJob('over')), /queue-full/);
});

test('live: off unless the send says so; a turn started without it stays plain and a live send waits behind it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-off-'));
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(job('plain'));
  const { meta } = b.procs.get(turnId);
  assert.equal(meta.live, false);
  assert.equal(meta.args[meta.args.indexOf('--input-format') + 1], 'text');
  assert.equal((await r.history('p1--main')).liveInput, false);
  assert.deepEqual(await r.sendMessage(liveJob('later')), { queued: true, position: 1 });
  b.finish(turnId);
  await r.poll();
  const next = [...b.procs.values()].find(p => p.meta.turnId !== turnId);
  assert.equal(next.meta.live, true, 'the next turn starts live from its own send');
});

test('live: a trusted turn takes no live message once its tree stops being the repository own; the message waits and runs read-only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-tree-'));
  const b = box(home);
  const own = {
    repo: true, branch: 'main', checkout: null, mainWorktree: true,
    refsAtHead: ['refs/heads/main', 'refs/remotes/origin/main'],
    originUrl: WEBAPP_URL, upstreamUrl: 'git@github.com:example-org/webapp.git', upstreamMerge: 'refs/heads/main',
  };
  let facts = own;
  const r = runner(home, b, [], { readCheckout: async () => facts });
  const trusted = (text) => liveJob(text, { permissionMode: 'bypassPermissions' });
  const { turnId } = await r.sendMessage(trusted('start the ask'));
  const { meta, dir } = b.procs.get(turnId);
  assert.equal(meta.mode, 'bypassPermissions');
  assert.deepEqual(await r.sendMessage(trusted('still ours')), { queued: false, live: true, turnId });

  // The workstream now holds a pull request's head.
  facts = { ...own, checkout: 'pr', branch: 'pr-123' };
  assert.deepEqual(await r.sendMessage(trusted('after the checkout')), { queued: true, position: 1 });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'inbox')), ['000001.json']);
  const queued = JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), 'utf8'));
  assert.deepEqual(queued.map(j => j.text), ['after the checkout']);

  b.finish(turnId);
  await r.poll();
  const next = [...b.procs.values()].find(p => p.meta.text === 'still ours');
  assert.ok(next, 'the message the turn never took in runs next');
  const after = [...b.procs.values()].find(p => p.meta.text === 'after the checkout');
  assert.equal(after, undefined, 'the queued message waits behind it');
  assert.equal(modeOf(next), 'dontAsk', 'and it settles against the tree as it is now');
  assertReadOnly(next, home);
});

test('live: a turn that settled to dontAsk takes no live message the tree would now run trusted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-tree2-'));
  const b = box(home);
  const own = {
    repo: true, branch: 'main', checkout: null, mainWorktree: true,
    refsAtHead: ['refs/heads/main', 'refs/remotes/origin/main'],
    originUrl: WEBAPP_URL, upstreamUrl: 'git@github.com:example-org/webapp.git', upstreamMerge: 'refs/heads/main',
  };
  let read = async () => { throw new Error('git failed'); };
  const r = runner(home, b, [], { readCheckout: (cwd) => read(cwd) });
  const trusted = (text) => liveJob(text, { permissionMode: 'bypassPermissions' });
  const { turnId } = await r.sendMessage(trusted('one'));
  // An unreadable tree is not the repository's own.
  assert.equal(b.procs.get(turnId).meta.mode, 'dontAsk');
  assert.deepEqual(await r.sendMessage(trusted('unreadable still')), { queued: false, live: true, turnId });
  read = async () => own;
  assert.equal((await r.sendMessage(trusted('own again'))).queued, true);
});

test('live: a running turn without a recorded mode takes no live message', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-nomode-'));
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(liveJob('one'));
  const metaFile = path.join(home, '.termag/chats/turns', turnId, 'meta.json');
  const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  delete m.mode;
  fs.writeFileSync(metaFile, JSON.stringify(m));
  const r2 = runner(home, b, []);
  await r2.recover();
  assert.equal((await r2.sendMessage(liveJob('two'))).queued, true);
});

test('live: a resume hold queues a live send, and one send\'s pane probe waits out another send\'s settle', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-hold-'));
  const b = box(home);
  const own = {
    repo: true, branch: 'main', checkout: null, mainWorktree: true,
    refsAtHead: ['refs/heads/main', 'refs/remotes/origin/main'],
    originUrl: WEBAPP_URL, upstreamUrl: 'git@github.com:example-org/webapp.git', upstreamMerge: 'refs/heads/main',
  };
  const r = runner(home, b, [], { readCheckout: async () => own });
  const trusted = (text, extra = {}) => liveJob(text, { permissionMode: 'bypassPermissions', ...extra });
  const { turnId } = await r.sendMessage(trusted('start'));
  b.finish(turnId, 'sess-live-hold1');
  await r.poll();
  await r.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'bypassPermissions' });
  const held = await r.sendMessage(trusted('during the resume'));
  assert.equal(held.queued, true);
  assert.equal(held.live, undefined);
  assert.ok(!fs.existsSync(path.join(b.procs.get(turnId).dir, 'inbox')));

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-probe-'));
  const b2 = box(home2);
  let reads = 0;
  const pending = [];
  const readCheckout = () => {
    reads += 1;
    if (reads === 1) return Promise.resolve(own);
    return new Promise(resolve => pending.push(resolve));
  };
  const r2 = runner(home2, b2, [], { readCheckout });
  const started = await r2.sendMessage(trusted('start'));
  await r2.notePane('p1--main', 'claude');
  const stateFile = path.join(home2, '.termag/chats/p1--main.json');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pane, 'seen');
  const first = r2.sendMessage(trusted('first', { paneProbe: 'shell' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1, 'the first live send is settling');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pane, undefined, 'its probe ran before the settle');
  let secondDone = false;
  const second = r2.sendMessage(trusted('second', { paneProbe: 'claude' })).then(result => { secondDone = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondDone, false);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pane, undefined, 'the second probe waits until the first send settles');
  pending[0](own);
  assert.deepEqual(await first, { queued: false, live: true, turnId: started.turnId });
  // The second probe runs only now. It sees Claude, so this send queues
  // instead of joining the live turn: the pane holds the session.
  const secondResult = await second;
  assert.equal(secondResult.queued, true);
  assert.equal(secondResult.live, undefined);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pane, 'seen');
});

test('live: overlapping live sends each get their own inbox file, in the order they were sent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-race-'));
  const b = box(home);
  const own = {
    repo: true, branch: 'main', checkout: null, mainWorktree: true,
    refsAtHead: ['refs/heads/main', 'refs/remotes/origin/main'],
    originUrl: WEBAPP_URL, upstreamUrl: 'git@github.com:example-org/webapp.git', upstreamMerge: 'refs/heads/main',
  };
  // The checkout read takes longer for the first send than for the second.
  let reads = 0;
  const readCheckout = () => { reads += 1; const wait = reads === 2 ? 30 : 1; return new Promise(resolve => setTimeout(() => resolve(own), wait)); };
  const r = runner(home, b, [], { readCheckout });
  const trusted = (text) => liveJob(text, { permissionMode: 'bypassPermissions' });
  const { turnId } = await r.sendMessage(trusted('start'));
  const results = await Promise.all([r.sendMessage(trusted('first')), r.sendMessage(trusted('second'))]);
  assert.deepEqual(results, [{ queued: false, live: true, turnId }, { queued: false, live: true, turnId }]);
  const inbox = path.join(b.procs.get(turnId).dir, 'inbox');
  const files = fs.readdirSync(inbox).sort();
  assert.deepEqual(files.map(f => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')).text), ['first', 'second']);
});

test('live: a send still waiting its turn when Stop or clear drains the chat never lands', async () => {
  const own = {
    repo: true, branch: 'main', checkout: null, mainWorktree: true,
    refsAtHead: ['refs/heads/main', 'refs/remotes/origin/main'],
    originUrl: WEBAPP_URL, upstreamUrl: 'git@github.com:example-org/webapp.git', upstreamMerge: 'refs/heads/main',
  };
  const slow = () => new Promise(resolve => setTimeout(() => resolve(own), 20));
  const trusted = (text) => liveJob(text, { permissionMode: 'bypassPermissions' });

  for (const [name, stop, code] of [['interrupt', r => r.interrupt('p1--main'), /chat-stopped\b/], ['clear', r => r.clear('p1--main'), /chat-(stopped|clearing)\b/]]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `chat-live-${name}-`));
    const b = box(home);
    const r = runner(home, b, [], { readCheckout: slow });
    const { turnId } = await r.sendMessage(trusted('start'));
    const outcome = p => p.then(() => null, err => err);
    const first = outcome(r.sendMessage(trusted('first')));
    const second = outcome(r.sendMessage(trusted('second')));
    await new Promise(resolve => setTimeout(resolve, 5));
    await stop(r);
    assert.match(String(await first), code, `${name}: the send mid-checkout is refused`);
    assert.match(String(await second), code, `${name}: the waiting send is refused`);
    const inbox = path.join(b.procs.get(turnId).dir, 'inbox');
    const texts = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')).text) : [];
    assert.deepEqual(texts, [], `${name}: nothing lands after the drain`);
    assert.equal(fs.existsSync(path.join(home, '.termag/chats/p1--main.queue.json')) ? JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), 'utf8')).length : 0, 0);
  }
});

test('live: a turn-only stop asks the wrapper to interrupt, keeps the turn and sends no signal once Claude answers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-turnstop-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames, { interruptGraceMs: 5, turnInterruptMs: 30, stopSession: async () => { throw new Error('the session must stay'); } });
  const { turnId } = await r.sendMessage(liveJob('one'));
  await r.sendMessage(liveJob('waiting'));
  assert.deepEqual(await r.interrupt('p1--main', { scope: 'turn' }), { interrupted: true, scope: 'turn', dropped: ['waiting'] });
  const inbox = path.join(b.procs.get(turnId).dir, 'inbox');
  assert.deepEqual(fs.readdirSync(inbox).filter(n => n.startsWith('interrupt-')).length, 1);
  assert.ok(frames.some(f => f.event?.type === 'user-stop' && f.event.scope === 'turn'), 'every open view hears it was the user');
  b.write(turnId, [{ type: 'result', subtype: 'error_during_execution', is_error: true }]);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(b.signals, [], 'Claude answered, so nothing is signalled');
  assert.ok(!fs.existsSync(path.join(b.procs.get(turnId).dir, 'interrupted')));
  b.finish(turnId);
  await r.poll();
});

test('live: a turn-only stop with no result in time falls back to stopping the turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-turnstop-fb-'));
  const b = box(home);
  let stopped = 0;
  const r = runner(home, b, [], { interruptGraceMs: 5, turnInterruptMs: 20, stopSession: async () => { stopped++; } });
  const { turnId } = await r.sendMessage(liveJob('one'));
  // A result from before the stop does not count as its answer: Claude has taken a message since.
  b.write(turnId, [{ type: 'result', subtype: 'success' }, { type: 'user', isReplay: true, message: { role: 'user', content: 'next' } }]);
  assert.equal((await r.interrupt('p1--main', { scope: 'turn' })).scope, 'turn');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(b.signals[0], [4242, 'SIGINT']);
  assert.equal(stopped, 1);
  b.finish(turnId);
  await r.poll();
});

test('live: a turn-only stop after Claude answered leaves its background work alone', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-turnstop-idle-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames, { interruptGraceMs: 5, turnInterruptMs: 20, stopSession: async () => { throw new Error('the session must stay'); } });
  const { turnId } = await r.sendMessage(liveJob('one'));
  b.write(turnId, [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, { type: 'result', subtype: 'success' }]);
  assert.deepEqual(await r.interrupt('p1--main', { scope: 'turn' }), { interrupted: false, scope: 'turn', dropped: [] });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(b.signals, [], 'no fallback: an interrupt would not have been answered');
  assert.ok(!fs.existsSync(path.join(b.procs.get(turnId).dir, 'inbox')) || !fs.readdirSync(path.join(b.procs.get(turnId).dir, 'inbox')).some(n => n.startsWith('interrupt-')));
  assert.ok(!frames.some(f => f.event?.type === 'user-stop'));
  b.finish(turnId);
  await r.poll();
});

test('a turn-only stop on a turn that is not live is a whole stop', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turnstop-notlive-'));
  const b = box(home);
  const r = runner(home, b, [], { interruptGraceMs: 5, stopSession: async () => {} });
  const { turnId } = await r.sendMessage(job('one'));
  assert.deepEqual(await r.interrupt('p1--main', { scope: 'turn' }), { interrupted: true, scope: 'all', dropped: [] });
  assert.deepEqual(b.signals[0], [4242, 'SIGINT']);
  assert.ok(!fs.existsSync(path.join(b.procs.get(turnId).dir, 'inbox')));
  b.finish(turnId);
  await r.poll();
});

test('mcp: only a live turn that loads the box\'s MCP servers watches the version file', () => {
  assert.equal(mcpVersionFile('/home/u', 'bypassPermissions', true), '/home/u/.config/termag/mcp-connectors.version');
  assert.equal(mcpVersionFile('/home/u', 'bypassPermissions', false), null, 'a one-message turn reads ~/.claude.json when it starts');
  for (const mode of ['dontAsk', 'auto']) assert.equal(mcpVersionFile('/home/u', mode, true), null, `${mode} runs with --strict-mcp-config`);
});

test('mcp: a trusted live turn names the version file, a read-only one does not, and a reload\'s answer is not forwarded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-mcp-'));
  const b = box(home);
  const frames = [];
  const own = {
    repo: true, branch: 'main', checkout: null, mainWorktree: true,
    refsAtHead: ['refs/heads/main', 'refs/remotes/origin/main'],
    originUrl: WEBAPP_URL, upstreamUrl: 'git@github.com:example-org/webapp.git', upstreamMerge: 'refs/heads/main',
  };
  const r = runner(home, b, frames, { readCheckout: async () => own });
  const { turnId } = await r.sendMessage(liveJob('start the ask', { permissionMode: 'bypassPermissions' }));
  const { meta } = b.procs.get(turnId);
  assert.equal(meta.mode, 'bypassPermissions');
  assert.equal(meta.mcpVersionFile, path.join(home, '.config/termag/mcp-connectors.version'));
  b.write(turnId, [
    { type: 'system', subtype: 'init', session_id: 'sess-mcp-1111' },
    { type: 'control_response', response: { subtype: 'success', request_id: 'termag-mcp-reload-1', response: { commands: [{ name: 'x' }] } } },
    { type: 'control_response', response: { subtype: 'success', request_id: 'termag-interrupt-1' } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } },
  ]);
  await r.poll();
  assert.deepEqual(frames.map(f => [f.seq, f.event.type, f.event.response?.request_id]),
    [[1, 'turn-start', undefined], [2, 'system', undefined], [4, 'control_response', 'termag-interrupt-1'], [5, 'assistant', undefined]]);
  b.finish(turnId, 'sess-mcp-1111');
  await r.poll();

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-nomcp-'));
  const b2 = box(plain);
  const r2 = runner(plain, b2, []);
  const second = await r2.sendMessage(liveJob('read only'));
  assert.equal(b2.procs.get(second.turnId).meta.mcpVersionFile, undefined);
});

// ── Model backends ───────────────────────────────────────
const KIMI = 'accounts/fireworks/models/kimi-k3';
const FW_SETTINGS = { apiKeyHelper: "'/h/termag-claude-token' '/h/agent.json'", env: { ANTHROPIC_BASE_URL: 'https://gw/fireworks/inference', ANTHROPIC_MODEL: KIMI } };
const settingsArg = args => JSON.parse(args[args.lastIndexOf('--settings') + 1]);

test('capabilities: the runner starts a turn on a model backend', () => {
  assert.ok(CAPABILITIES.includes('chat-backend-v1'));
});

test('backendOf: none is the default; only a known backend with a model id it can name', () => {
  assert.equal(backendOf({}), null);
  assert.equal(backendOf({ backend: '', model: 'opus' }), null);
  assert.deepEqual(backendOf({ backend: 'fireworks', model: KIMI, fastModel: 'accounts/fireworks/models/glm-5', context: 131072 }),
    { backend: 'fireworks', model: KIMI, fastModel: 'accounts/fireworks/models/glm-5', context: 131072 });
  assert.deepEqual(backendOf({ backend: 'fireworks', model: KIMI, fastModel: 'opus;rm', context: -1 }), { backend: 'fireworks', model: KIMI });
  assert.throws(() => backendOf({ backend: 'bedrock', model: KIMI }), /bad backend/);
  assert.throws(() => backendOf({ backend: 'fireworks', model: 'sonnet' }), /bad backend/);
  assert.throws(() => backendOf({ backend: 'fireworks' }), /bad backend/);
});

test("turn argv on a backend: its settings as the one --settings, the hooks closure kept on a confined turn, its model", () => {
  const b = { backend: 'fireworks', model: KIMI };
  const confined = turnArgs('abc-12345678', 'dontAsk', { backend: b, settings: FW_SETTINGS, model: 'sonnet' });
  assert.equal(confined.filter(a => a === '--settings').length, 1);
  assert.deepEqual(settingsArg(confined), { ...FW_SETTINGS, disableAllHooks: true });
  assert.ok(confined.includes('--strict-mcp-config'));
  assert.deepEqual(confined.slice(-4), ['--model', KIMI, '--resume', 'abc-12345678']);
  const trusted = turnArgs(null, 'bypassPermissions', { backend: b, settings: FW_SETTINGS });
  assert.equal(trusted.filter(a => a === '--settings').length, 1);
  assert.deepEqual(settingsArg(trusted), FW_SETTINGS);
  // The default backend is as before: no settings on a trusted turn, the closure alone on a confined one.
  assert.ok(!turnArgs(null, 'bypassPermissions').includes('--settings'));
  assert.deepEqual(settingsArg(turnArgs(null, 'dontAsk')), { disableAllHooks: true });
});

test("backendSettings: the box script's launch-settings, and its reason when it refuses", async () => {
  const calls = [];
  const ok = async (file, args) => { calls.push([file, args]); return { stdout: JSON.stringify(FW_SETTINGS) }; };
  assert.deepEqual(await backendSettings({ backend: 'fireworks', model: KIMI, fastModel: 'accounts/fireworks/models/glm-5', context: 131072 }, { execFile: ok, script: '/s' }), FW_SETTINGS);
  assert.deepEqual(calls[0], ['/s', ['launch-settings', '--backend', 'fireworks', '--model', KIMI, '--fast', 'accounts/fireworks/models/glm-5', '--context', '131072', '-']]);
  const refused = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'termag-credentials: Fireworks is not set up on this box; termag-credentials status says more\n' }); };
  await assert.rejects(backendSettings({ backend: 'fireworks', model: KIMI }, { execFile: refused, script: '/s' }),
    /^Error: fireworks is not ready on this box: Fireworks is not set up on this box; termag-credentials status says more$/);
  await assert.rejects(backendSettings({ backend: 'fireworks', model: KIMI }, { execFile: async () => ({ stdout: '[]' }), script: '/s' }), /not an object/);
});

test('backendSettings: only the credential helper and string env, as the scratch config dir carries', async () => {
  const widened = { ...FW_SETTINGS, env: { ...FW_SETTINGS.env, BAD: 1 }, permissions: { allow: ['Read(~/.ssh/**)'] }, statusLine: { type: 'command', command: 'sh -c x' }, hooks: { Stop: [] }, disableAllHooks: false };
  const got = await backendSettings({ backend: 'fireworks', model: KIMI }, { execFile: async () => ({ stdout: JSON.stringify(widened) }), script: '/s' });
  assert.deepEqual(got, FW_SETTINGS);
  // A confined turn still gets the hooks closure on top.
  assert.deepEqual(settingsArg(turnArgs(null, 'dontAsk', { backend: { backend: 'fireworks', model: KIMI }, settings: got })), { ...FW_SETTINGS, disableAllHooks: true });
});

test('runner: a send on a backend starts its turn with that backend\'s settings and model', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-backend-'));
  const b = box(home);
  const asked = [];
  const r = runner(home, b, [], { launchSettings: async x => { asked.push(x); return FW_SETTINGS; } });
  const { turnId } = await r.sendMessage(job('hi', { backend: 'fireworks', model: KIMI, context: 262144 }));
  const { meta } = b.procs.get(turnId);
  assert.deepEqual(asked, [{ backend: 'fireworks', model: KIMI, context: 262144 }]);
  assert.equal(meta.backend, 'fireworks');
  assert.equal(meta.model, KIMI);
  assert.deepEqual(settingsArg(meta.args), { ...FW_SETTINGS, disableAllHooks: true });
  assert.equal(meta.args[meta.args.indexOf('--model') + 1], KIMI);
  await assert.rejects(r.sendMessage(job('hi', { chatKey: 'k2', backend: 'fireworks', model: 'opus' })), /bad backend/);
});

test('runner: a backend that is not ready on the box ends the turn with its reason, not a turn on the default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-backend-off-'));
  const b = box(home);
  const r = runner(home, b, [], { launchSettings: async () => { throw new Error('fireworks is not ready on this box: skipped on this box'); } });
  const { turnId } = await r.sendMessage(job('hi', { backend: 'fireworks', model: KIMI }));
  assert.equal(b.procs.size, 0, 'no Claude was started');
  const events = fs.readFileSync(path.join(home, '.termag/chats/turns', turnId, 'events.jsonl'), 'utf8');
  assert.match(events, /could not start the turn: fireworks is not ready on this box: skipped on this box/);
  assert.equal((await r.history('p1--main')).running, false);
});

test('runner: a resume claim on a backend continues there, and a backend that is not ready refuses it without a hold', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-backend-resume-'));
  const b = box(home);
  let ready = true;
  const r = runner(home, b, [], { launchSettings: async () => { if (!ready) throw new Error('fireworks is not ready on this box: removed'); return FW_SETTINGS; } });
  const session = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
  const started = await r.sendMessage(job('hello'));
  b.finish(started.turnId, session);
  ready = false;
  await assert.rejects(r.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'dontAsk', backend: 'fireworks', model: KIMI }), /not ready on this box: removed/);
  ready = true;
  const claim = await r.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'dontAsk', backend: 'fireworks', model: KIMI });
  assert.equal(claim.claimed, true);
  const script = fs.readFileSync(path.join(home, '.termag/chat-resume/p1--main'), 'utf8');
  assert.ok(script.includes(`'--model' '${KIMI}' '--resume' '${session}'`));
  assert.ok(script.includes('ANTHROPIC_BASE_URL'));
  assert.ok(script.includes('disableAllHooks'));
});
