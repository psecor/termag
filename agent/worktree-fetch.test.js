'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ATTENDED_CAPABILITY, CAPABILITIES, clearOwn, fetchOriginBranch, headSha, isFetchBranchName, marksOwn, marksUnattended, startsFromFetch } = require('./worktree-fetch');

test('capability', () => {
  assert.deepEqual(CAPABILITIES, ['worktree-fetch-v1', 'worktree-fetch-attended-v1']);
  assert.equal(ATTENDED_CAPABILITY, 'worktree-fetch-attended-v1');
});

test('a fetched tree is marked unattended unless a person asked for it and it starts from what the fetch refreshed', () => {
  // An automation run's fetch, or an orchestrator from before `attended`, fresh or not.
  assert.equal(marksUnattended(true, undefined, true), true);
  assert.equal(marksUnattended(false, undefined, false), true);
  assert.equal(marksUnattended(true, false, true), true);
  // Only an explicit true leaves it unmarked; anything truthy-ish does not.
  assert.equal(marksUnattended(true, 'true', true), true);
  assert.equal(marksUnattended(true, 1, true), true);
  assert.equal(marksUnattended(true, true, 'true'), true);
  assert.equal(marksUnattended(true, true, true), false);
  // A person's, but the fetch failed, or the start is not what it refreshed: the box's older ref.
  assert.equal(marksUnattended(false, true, false), true);
  assert.equal(marksUnattended(true, true, false), true);
  assert.equal(marksUnattended(true, true, undefined), true);
  // No fetch asked: a plain branch-off.
  assert.equal(marksUnattended(null, undefined, false), false);
});

test('a start is fresh only from the remote-tracking ref of the branch a fetch that worked refreshed', () => {
  assert.equal(startsFromFetch(true, 'main', 'origin/main'), true);
  assert.equal(startsFromFetch(true, 'main', 'refs/remotes/origin/main'), true);
  assert.equal(startsFromFetch(true, 'release/2026.10', 'origin/release/2026.10'), true);
  // The fetch failed: origin/main is whatever the box last saw.
  assert.equal(startsFromFetch(false, 'main', 'origin/main'), false);
  assert.equal(startsFromFetch(null, 'main', 'origin/main'), false);
  // Another start than the branch fetched.
  assert.equal(startsFromFetch(true, 'main', 'origin/feature'), false);
  assert.equal(startsFromFetch(true, 'main', 'main'), false);
  assert.equal(startsFromFetch(true, 'main', 'HEAD'), false);
  assert.equal(startsFromFetch(true, 'main', 'upstream/main'), false);
  assert.equal(startsFromFetch(true, 'main', 'refs/remotes/origin/main~1'), false);
  assert.equal(startsFromFetch(true, 'main', 'origin/main^{commit}'), false);
  // Never for a name the fetch would have refused.
  assert.equal(startsFromFetch(true, '-f', 'origin/-f'), false);
  assert.equal(startsFromFetch(true, undefined, 'origin/undefined'), false);
});

test("a person's Read only fetch is never recorded as the project's own tree; anything else may be", () => {
  assert.equal(marksOwn(true), false);
  // An automation run's add, a Full access fetch, an orchestrator from before readOnly: the usual proof applies.
  assert.equal(marksOwn(undefined), true);
  assert.equal(marksOwn(false), true);
  assert.equal(marksOwn('true'), true);
});

test("clearOwn unsets a tree's own mark as an argument list, and nothing to clear is fine", async () => {
  const calls = [];
  await clearOwn(async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; }, '/p/.worktrees/x', 'x');
  assert.deepEqual(calls, [['git', '-C', '/p/.worktrees/x', 'config', '--local', '--unset-all', 'branch.x.termagCheckout']]);
  // git exits 5 when the key is not set.
  await clearOwn(async () => { throw Object.assign(new Error('not set'), { code: 5 }); }, '/p', 'x');
  // Anything else fails the add rather than leave the mark.
  await assert.rejects(clearOwn(async () => { throw Object.assign(new Error('locked'), { code: 255 }); }, '/p', 'x'), /locked/);
});

test('branch names: plain names and slashes, never options, refspecs or control characters', () => {
  for (const ok of ['main', 'release/2026.10', 'feat_x-1']) assert.ok(isFetchBranchName(ok), ok);
  for (const bad of ['', '-f', 'a:b', 'a..b', 'a b', 'a\nb', 'a~1', 'x/', 'a?', 42, null]) assert.ok(!isFetchBranchName(bad), String(bad));
});

test('fetchOriginBranch runs git as an argument list and reports failure instead of throwing', async () => {
  const calls = [];
  const ok = await fetchOriginBranch(async (bin, args) => { calls.push([bin, args]); return { stdout: '' }; }, '/repo', 'main');
  assert.equal(ok, true);
  assert.deepEqual(calls, [['git', ['-C', '/repo', 'fetch', '--no-tags', '--', 'origin', 'main']]]);
  const failed = await fetchOriginBranch(async () => { throw new Error('offline'); }, '/repo', 'main');
  assert.equal(failed, false);
  const refused = await fetchOriginBranch(async () => { throw new Error('must not run'); }, '/repo', '-f');
  assert.equal(refused, false);
});

test('headSha reads a 40-hex commit or null', async () => {
  assert.equal(await headSha(async () => ({ stdout: 'abcdef0123456789abcdef0123456789abcdef01\n' }), '/w'), 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(await headSha(async () => ({ stdout: 'HEAD' }), '/w'), null);
  assert.equal(await headSha(async () => { throw new Error('no'); }, '/w'), null);
});
