'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createScanner, encodeClaudeDir, makeUnremap, parseClaudeFile, dedupeKey } = require('./usage-scanner');

const T = (iso) => iso;
function usageLine({ req = 'r1', mid = 'm1', ts = '2026-09-18T10:00:00Z', cwd = '/home/u/termag/projects/p', branch = 'main', input = 10, output = 5, cr = 100, cc = 20, uuid } = {}) {
  const e = { type: 'assistant', timestamp: T(ts), cwd, gitBranch: branch, message: { id: mid, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cc } } };
  if (req !== null) e.requestId = req;
  if (uuid) e.uuid = uuid;
  return JSON.stringify(e);
}

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-usage-'));
  return home;
}
function writeClaude(home, cwd, file, lines) {
  const dir = path.join(home, '.claude', 'projects', encodeClaudeDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  fs.writeFileSync(full, lines.join('\n') + '\n');
  return full;
}
const tokens = (d) => d.input + d.output + d.cacheRead + d.cacheCreate;

test('dedupe: lines sharing (requestId, message.id) count once; different requestId counts twice', () => {
  const same = [usageLine(), usageLine(), usageLine()].join('\n');
  const r = parseClaudeFile(same);
  assert.equal(r.days['2026-09-18'].calls, 1);
  assert.equal(tokens(r.days['2026-09-18']), 135);
  const diff = [usageLine({ req: 'r1' }), usageLine({ req: 'r2' })].join('\n');
  assert.equal(parseClaudeFile(diff).days['2026-09-18'].calls, 2);
});

test('dedupe key falls back to message.id, then uuid, then null', () => {
  assert.equal(dedupeKey({ requestId: 'r', message: { id: 'm' } }), 'r|m');
  assert.equal(dedupeKey({ message: { id: 'm' } }), 'msg|m');
  assert.equal(dedupeKey({ uuid: 'u', message: {} }), 'uuid|u');
  assert.equal(dedupeKey({ message: {} }), null);
  const r = parseClaudeFile([usageLine({ req: null }), usageLine({ req: null })].join('\n'));
  assert.equal(r.days['2026-09-18'].calls, 1, 'missing requestId dedupes on message.id');
});

test('partial trailing line is skipped, then counted once the file is completed', async () => {
  const home = mkHome();
  const full = writeClaude(home, '/home/u/termag/projects/p', 'a.jsonl', [usageLine({ mid: 'm1' })]);
  fs.appendFileSync(full, usageLine({ mid: 'm2' }).slice(0, 40)); // truncated
  const s = createScanner({ home });
  let r = await s.scan();
  assert.equal(r.providers.claude['2026-09-18'].calls, 1);
  fs.appendFileSync(full, usageLine({ mid: 'm2' }).slice(40) + '\n');
  r = await s.scan();
  assert.equal(r.providers.claude['2026-09-18'].calls, 2);
});

test('cache: hit when size+mtime unchanged, reparse on growth, evict on delete', async () => {
  const home = mkHome();
  const full = writeClaude(home, '/home/u/termag/projects/p', 'a.jsonl', [usageLine()]);
  const s = createScanner({ home });
  let r = await s.scan();
  assert.deepEqual([r.sources.claude.stats.files, r.sources.claude.stats.reparsed, r.sources.claude.stats.cached], [1, 1, 0]);
  r = await s.scan();
  assert.deepEqual([r.sources.claude.stats.reparsed, r.sources.claude.stats.cached], [0, 1]);
  fs.appendFileSync(full, usageLine({ mid: 'm2' }) + '\n');
  r = await s.scan();
  assert.equal(r.sources.claude.stats.reparsed, 1);
  assert.equal(r.providers.claude['2026-09-18'].calls, 2);
  fs.unlinkSync(full);
  r = await s.scan();
  assert.equal(s._cache.size, 0);
  assert.deepEqual(r.providers.claude, {});
});

test('cwdHint prefers the cwd that encodes to the dir, even when a drifted cwd is more common', async () => {
  const home = mkHome();
  const origin = '/home/u/termag/projects/p';
  writeClaude(home, origin, 'a.jsonl', [
    usageLine({ mid: 'm1', cwd: `${origin}/backend` }), usageLine({ mid: 'm2', cwd: `${origin}/backend` }),
    usageLine({ mid: 'm3', cwd: origin }),
  ]);
  const r = await createScanner({ home }).scan();
  const [b] = r.sources.claude.buckets;
  assert.equal(b.cwdHint, origin);
  assert.equal(b.dir, encodeClaudeDir(origin));
  assert.equal(b.gitBranch, 'main');
  assert.equal(b.files, 1);
});

test('worktree dirs keep their --worktrees- suffix and hint', async () => {
  const home = mkHome();
  const wt = '/home/u/termag/projects/p/.worktrees/feature';
  writeClaude(home, wt, 'a.jsonl', [usageLine({ cwd: wt })]);
  const r = await createScanner({ home }).scan();
  assert.equal(r.sources.claude.buckets[0].dir, '-home-u-termag-projects-p--worktrees-feature');
  assert.equal(r.sources.claude.buckets[0].cwdHint, wt);
});

test('path_remap inverse: hints come back in backend (/home) form', async () => {
  const { unremapPath, unremapEncodedDir } = makeUnremap({ '/home/u': '/Users/u' });
  assert.equal(unremapPath('/Users/u/termag/projects/x'), '/home/u/termag/projects/x');
  assert.equal(unremapPath('/opt/other'), '/opt/other');
  assert.equal(unremapEncodedDir('-Users-u-termag-projects-x'), '-home-u-termag-projects-x');
  assert.equal(unremapEncodedDir('-Users-u'), '-home-u');
  assert.equal(unremapEncodedDir('-opt-other'), '-opt-other');
  const home = mkHome();
  const local = '/Users/u/termag/projects/x';
  writeClaude(home, local, 'a.jsonl', [usageLine({ cwd: local })]);
  const r = await createScanner({ home, pathRemap: { '/home/u': '/Users/u' } }).scan();
  assert.equal(r.sources.claude.buckets[0].cwdHint, '/home/u/termag/projects/x');
  assert.equal(r.sources.claude.buckets[0].dir, '-home-u-termag-projects-x');
});

test('reconciliation: days == Σ providers == Σ buckets; since prunes the response only', async () => {
  const home = mkHome();
  writeClaude(home, '/home/u/termag/projects/a', 'a.jsonl', [usageLine({ mid: 'a1', ts: '2026-09-17T23:59:59Z' }), usageLine({ mid: 'a2', ts: '2026-09-18T00:00:01Z' })]);
  writeClaude(home, '/home/u/termag/projects/b', 'b.jsonl', [usageLine({ mid: 'b1', ts: '2026-09-18T12:00:00Z', input: 1000 })]);
  const s = createScanner({ home });
  let r = await s.scan();
  assert.equal(r.schema, 2);
  assert.deepEqual(Object.keys(r.days).sort(), ['2026-09-17', '2026-09-18']);
  const sumBuckets = {};
  for (const b of r.sources.claude.buckets) for (const [d, v] of Object.entries(b.days)) sumBuckets[d] = (sumBuckets[d] || 0) + tokens(v);
  for (const [d, v] of Object.entries(r.providers.claude)) assert.equal(tokens(v), sumBuckets[d]);
  for (const [d, v] of Object.entries(r.days)) assert.equal(tokens(v), tokens(r.providers.claude[d]));
  r = await s.scan({ since: '2026-09-18' });
  assert.deepEqual(Object.keys(r.days), ['2026-09-18']);
  assert.equal(r.days['2026-09-18'].calls, 2);
  r = await s.scan();
  assert.equal(r.days['2026-09-17'].calls, 1, 'since did not prune the cache');
});

test('no ~/.claude at all → empty, no errors', async () => {
  const r = await createScanner({ home: mkHome() }).scan();
  assert.deepEqual(r.days, {});
  assert.deepEqual(r.sources.claude.errors, []);
  assert.equal(r.sources.claude.buckets.length, 0);
});
