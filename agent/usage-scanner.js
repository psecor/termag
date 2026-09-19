'use strict';
/**
 * Token-usage scanner for the termag per-user agent (`usage-scan` RPC).
 *
 * Reads the local agent CLIs' own logs and returns daily token totals:
 *   claude  ~/.claude/projects/<encoded cwd>/*.jsonl   (one dir per session-origin cwd)
 *   codex   ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 *   vibe    ~/.vibe/logs/session/session_YYYYMMDD_<id>/meta.json   (reported as provider `mistral`)
 *
 * Response schema 2 (see scan()):
 *   { schema: 2, scannedAt, host, days, providers, sources }
 * `days` / `providers` keep the schema-1 shape so an older backend keeps working;
 * `sources.<provider>.buckets[]` adds the raw per-directory totals plus the best
 * path hint we have, so the BACKEND can attribute tokens to a project/workstream
 * (the agent knows nothing about projects). Path hints are un-remapped through
 * the inverse of `path_remap` so they compare against the backend's
 * /home/<user>/… layout even on macOS.
 *
 * Two things this fixes over the original inline scanner:
 *  - Dedupe. Claude Code writes one JSONL line per content block of an assistant
 *    message and repeats the identical `message.usage` on each (measured ×2.36
 *    overcount). Lines are deduped per file on (requestId, message.id).
 *  - Cost. Every file's parsed totals are cached by (size, mtime); a rescan only
 *    re-parses files that changed. JSONL is append-only, so an unchanged file
 *    can't have new tokens.
 */
const path = require('path');
const { readdir, readFile, stat } = require('fs/promises');

const SCHEMA = 2;
const MAX_KEYS_PER_FILE = 200_000;   // dedupe set bound; observed max ~1.7k. Overflow → over-count, reported.
const MAX_CACHED_FILES = 10_000;

function emptyDay() { return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 }; }
function ensureDay(days, date) { if (!days[date]) days[date] = emptyDay(); return days[date]; }
function addInto(t, d) { t.input += d.input; t.output += d.output; t.cacheRead += d.cacheRead; t.cacheCreate += d.cacheCreate; t.calls += d.calls; }
function mergeDays(into, from) { for (const [date, d] of Object.entries(from)) addInto(ensureDay(into, date), d); }
function cloneDays(days, since) {
  const out = {};
  for (const [date, d] of Object.entries(days)) if (!since || date >= since) out[date] = { ...d };
  return out;
}
function inc(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function argmax(map, pred) {
  let best = null, n = -1;
  for (const [k, v] of map) if ((!pred || pred(k)) && v > n) { best = k; n = v; }
  return best;
}

/** Claude encodes a cwd into a project-log dir name by replacing '/' and '.' with '-'. */
const encodeClaudeDir = (p) => p.replace(/[/.]/g, '-');

function utcDate(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Inverse of agent.js remapPath(): path_remap maps backend paths (`from`) to
 * local paths (`to`); hints we emit must be in backend form again.
 */
function makeUnremap(pathRemap) {
  const pairs = Object.entries(pathRemap || {});
  return {
    unremapPath(p) {
      if (!p || typeof p !== 'string') return p;
      for (const [from, to] of pairs) if (p === to || p.startsWith(to + '/')) return from + p.slice(to.length);
      return p;
    },
    unremapEncodedDir(dir) {
      if (!dir) return dir;
      for (const [from, to] of pairs) {
        const et = encodeClaudeDir(to);
        if (dir === et || dir.startsWith(et + '-')) return encodeClaudeDir(from) + dir.slice(et.length);
      }
      return dir;
    },
  };
}

/** Stable identity of one API response in Claude's JSONL; null → can't dedupe, count it. */
function dedupeKey(entry) {
  const mid = entry.message && entry.message.id;
  if (entry.requestId && mid) return `${entry.requestId}|${mid}`;
  if (mid) return `msg|${mid}`;
  if (entry.uuid) return `uuid|${entry.uuid}`;
  return null;
}

/** Parse one Claude JSONL file into deduped day totals + path/branch hints. Pure. */
function parseClaudeFile(content) {
  const seen = new Set();
  const days = {};
  const cwdCounts = new Map();
  const branchCounts = new Map();
  let overflow = false;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // partial/truncated last line: picked up next scan
    const msg = entry.message;
    if (!msg || typeof msg !== 'object' || !msg.usage) continue;
    const date = entry.timestamp ? utcDate(entry.timestamp) : null;
    if (!date) continue;
    const k = dedupeKey(entry);
    if (k !== null) {
      if (seen.has(k)) continue;
      if (seen.size < MAX_KEYS_PER_FILE) seen.add(k); else overflow = true;
    }
    const u = msg.usage;
    const d = ensureDay(days, date);
    d.input += u.input_tokens || 0;
    d.output += u.output_tokens || 0;
    d.cacheRead += u.cache_read_input_tokens || 0;
    d.cacheCreate += u.cache_creation_input_tokens || 0;
    d.calls += 1;
    if (typeof entry.cwd === 'string' && entry.cwd) inc(cwdCounts, entry.cwd);
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) inc(branchCounts, entry.gitBranch);
  }
  return { days, cwdCounts, branchCounts, overflow };
}

/** Parse one Codex rollout file (schema-1 arithmetic; cwd from a session_meta header if present). */
function parseCodexFile(content) {
  const days = {};
  let cwdHint = null;
  let first = true;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (first) {
      first = false;
      const p = entry.payload;
      if (entry.type === 'session_meta' && p && typeof p.cwd === 'string') cwdHint = p.cwd;
    }
    if (entry.type !== 'event_msg') continue;
    const payload = entry.payload;
    if (!payload || payload.type !== 'token_count') continue;
    const u = payload.info && payload.info.last_token_usage;
    if (!u) continue;
    const date = entry.timestamp ? utcDate(entry.timestamp) : null;
    if (!date) continue;
    const d = ensureDay(days, date);
    d.input += u.input_tokens || 0;
    d.output += u.output_tokens || 0;
    d.cacheRead += u.cached_input_tokens || 0;
    d.calls += 1;
  }
  return { days, cwdHint };
}

function errInfo(err) { return (err && (err.code || err.message)) || String(err); }

/**
 * A scanner owns the per-file cache. One instance lives for the agent's lifetime.
 *   createScanner({ home, pathRemap }).scan({ since }) → schema-2 response
 */
function createScanner({ home = process.env.HOME || '/home', pathRemap = {}, platform = process.platform } = {}) {
  const cache = new Map(); // absPath → { size, mtimeMs, ...parsed }
  const { unremapPath, unremapEncodedDir } = makeUnremap(pathRemap);

  async function cachedParse(full, parse, stats, onError) {
    let st;
    try { st = await stat(full); } catch (err) { onError(errInfo(err)); return null; }
    stats.files++;
    const c = cache.get(full);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) { stats.cached++; return c; }
    let content;
    try { content = await readFile(full, 'utf8'); } catch (err) { onError(errInfo(err)); return null; }
    const parsed = { ...parse(content), size: st.size, mtimeMs: st.mtimeMs };
    cache.set(full, parsed);
    stats.reparsed++;
    return parsed;
  }

  function evict(live) {
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    if (cache.size > MAX_CACHED_FILES) {
      const byAge = [...cache.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
      for (const [key] of byAge.slice(0, cache.size - MAX_CACHED_FILES)) cache.delete(key);
    }
  }

  async function scanClaude(live) {
    const t0 = Date.now();
    const stats = { files: 0, reparsed: 0, cached: 0, durationMs: 0 };
    const errors = [];
    const perDir = new Map();
    const claudeDir = path.join(home, '.claude', 'projects');
    let dirs = [];
    try { dirs = await readdir(claudeDir); } catch { /* no Claude on this host */ }
    for (const dir of dirs) {
      const dirPath = path.join(claudeDir, dir);
      let files;
      try {
        const s = await stat(dirPath);
        if (!s.isDirectory()) continue;
        files = await readdir(dirPath);
      } catch (err) { errors.push({ dir, file: null, error: errInfo(err) }); continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const full = path.join(dirPath, file);
        live.add(full);
        const parsed = await cachedParse(full, parseClaudeFile, stats, (error) => errors.push({ dir, file, error }));
        if (!parsed) continue;
        if (parsed.overflow) errors.push({ dir, file, error: 'dedupe-overflow' });
        let agg = perDir.get(dir);
        if (!agg) { agg = { files: 0, days: {}, cwdCounts: new Map(), branchCounts: new Map() }; perDir.set(dir, agg); }
        agg.files++;
        mergeDays(agg.days, parsed.days);
        for (const [k, v] of parsed.cwdCounts) agg.cwdCounts.set(k, (agg.cwdCounts.get(k) || 0) + v);
        for (const [k, v] of parsed.branchCounts) agg.branchCounts.set(k, (agg.branchCounts.get(k) || 0) + v);
      }
    }
    const buckets = [];
    for (const [dir, agg] of perDir) {
      // Prefer the inline cwd that actually encodes to this dir (the session's
      // origin); a pane that `cd`s writes other cwds that would mis-attribute.
      const cwd = argmax(agg.cwdCounts, (c) => encodeClaudeDir(c) === dir) ?? argmax(agg.cwdCounts);
      const bucket = {
        dir: unremapEncodedDir(dir),
        cwdHint: cwd ? unremapPath(cwd) : null,
        files: agg.files,
        days: agg.days,
      };
      const branch = argmax(agg.branchCounts);
      if (branch) bucket.gitBranch = branch;
      buckets.push(bucket);
    }
    stats.durationMs = Date.now() - t0;
    return { buckets, errors, stats };
  }

  async function scanCodex(live) {
    const t0 = Date.now();
    const stats = { files: 0, reparsed: 0, cached: 0, durationMs: 0 };
    const errors = [];
    const byCwd = new Map(); // cwdHint|'' → days
    const sessionsDir = path.join(home, '.codex', 'sessions');
    let years = [];
    try { years = await readdir(sessionsDir); } catch { /* no codex */ }
    for (const year of years) {
      let months = [];
      try { months = await readdir(path.join(sessionsDir, year)); } catch { continue; }
      for (const month of months) {
        let dayDirs = [];
        try { dayDirs = await readdir(path.join(sessionsDir, year, month)); } catch { continue; }
        for (const dayDir of dayDirs) {
          const dayPath = path.join(sessionsDir, year, month, dayDir);
          let files;
          try {
            const s = await stat(dayPath);
            if (!s.isDirectory()) continue;
            files = await readdir(dayPath);
          } catch { continue; }
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const full = path.join(dayPath, file);
            live.add(full);
            const rel = path.join(year, month, dayDir, file);
            const parsed = await cachedParse(full, parseCodexFile, stats, (error) => errors.push({ file: rel, error }));
            if (!parsed) continue;
            const key = parsed.cwdHint ? unremapPath(parsed.cwdHint) : '';
            if (!byCwd.has(key)) byCwd.set(key, {});
            mergeDays(byCwd.get(key), parsed.days);
          }
        }
      }
    }
    const buckets = [...byCwd.entries()].map(([cwd, days]) => ({ cwdHint: cwd || null, days }));
    stats.durationMs = Date.now() - t0;
    return { buckets, errors, stats };
  }

  async function scanVibe() {
    const t0 = Date.now();
    const stats = { files: 0, durationMs: 0 };
    const errors = [];
    const days = {};
    const sessionDir = path.join(home, '.vibe', 'logs', 'session');
    let dirs = [];
    try { dirs = await readdir(sessionDir); } catch { /* no vibe */ }
    for (const dir of dirs) {
      // Directory name format: session_YYYYMMDD_HHMMSS_<id>. NOTE: this is the
      // local wall clock at session START, unlike the UTC per-call dates above.
      const m = dir.match(/^session_(\d{4})(\d{2})(\d{2})_/);
      if (!m) continue;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      try {
        const meta = JSON.parse(await readFile(path.join(sessionDir, dir, 'meta.json'), 'utf8'));
        stats.files++;
        const s = meta.stats;
        if (!s) continue;
        const d = ensureDay(days, date);
        d.input += s.session_prompt_tokens || 0;
        d.output += s.session_completion_tokens || 0;
        d.calls += s.steps || 1;
      } catch (err) { errors.push({ file: `${dir}/meta.json`, error: errInfo(err) }); }
    }
    stats.durationMs = Date.now() - t0;
    return { buckets: [{ cwdHint: null, days }], errors, stats };
  }

  async function scan({ since } = {}) {
    const live = new Set();
    const [claude, codex, mistral] = await Promise.all([scanClaude(live), scanCodex(live), scanVibe()]);
    evict(live);

    const sources = { claude, codex, mistral };
    const providers = {};
    const days = {};
    for (const [pid, src] of Object.entries(sources)) {
      const total = {};
      for (const b of src.buckets) mergeDays(total, b.days);
      providers[pid] = cloneDays(total, since);
      mergeDays(days, providers[pid]);
      src.buckets = src.buckets.map(b => ({ ...b, days: cloneDays(b.days, since) }));
    }
    return {
      schema: SCHEMA,
      scannedAt: new Date().toISOString(),
      host: { home, platform, pathRemap },
      days,
      providers,
      sources,
    };
  }

  return { scan, _cache: cache };
}

module.exports = {
  SCHEMA, createScanner, encodeClaudeDir, makeUnremap, dedupeKey, parseClaudeFile, parseCodexFile,
  _internals: { ensureDay, mergeDays, cloneDays, utcDate, MAX_KEYS_PER_FILE, MAX_CACHED_FILES },
};
