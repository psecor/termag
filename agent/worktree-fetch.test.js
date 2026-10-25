'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, fetchOriginBranch, headSha, isFetchBranchName } = require('./worktree-fetch');

test('capability', () => {
  assert.deepEqual(CAPABILITIES, ['worktree-fetch-v1']);
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
