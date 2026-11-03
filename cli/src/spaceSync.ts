import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Api } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import { json } from './output.js';
import { SPACE_NAME_RE, api, download, formatBytes, listAll, listSpaces, localTarget, type SpaceView, type TreeFile } from './space.js';
import { defaultSpace } from './spaceMemory.js';
import { checkInSpaces, spacesDir } from './spacesPath.js';
import { rememberVersions, versionOf } from './spaceVersions.js';

/**
 * `termag space sync [space]`: a read-only copy of each space this box (or
 * person) reaches, at ~/termag/spaces/<space>/, so people and agents read a
 * space's files with ordinary tools. The desktop opens it in its Files panel.
 * Writes still go through
 * `termag space put`: the copy is 0444, and the next sync removes anything
 * added to it and puts back a file whose size changed.
 *
 * It updates in place, one file at a time (download beside it, then rename),
 * so the folder a viewer has open stays the same folder. Bytes come from S3
 * on presigned URLs like every other transfer.
 */

export const SYNC_LIMITS = { fileBytes: 50 * 1024 * 1024, totalBytes: 1024 ** 3, files: 5000 };

export const SYNC_COMMANDS: Record<string, CommandSpec> = {
  'space sync': {
    summary: 'Copy the spaces you (or this box) reach to ~/termag/spaces, read-only',
    usage: 'termag space sync [space]',
    details: [
      'With no space, every space you reach; copies of spaces you no longer reach are removed.',
      'Files over 50 MiB, and those past 1 GiB or 5000 files in a space, are not copied (--json lists them).',
    ].join('\n'),
    maxArgs: 1,
  },
};

export function mirrorsDir(home: string): string { return join(home, 'termag', 'spaces'); }

/**
 * `dir`, resolved, if it is ~/termag/spaces or inside it with no symlink from
 * ~/termag down; else a refusal. A link planted there would take a write or an
 * `rm -r` somewhere else. (lstat follows every component but the last, so
 * each one from ~/termag is checked on its own, as checkInSpaces does.)
 */
export function checkInMirrors(home: string, dir: string): string {
  const root = resolve(mirrorsDir(home));
  const target = resolve(dir);
  if (target !== root && !target.startsWith(root + sep)) throw new CliError('failed', `Refusing to touch ${target}: it is outside ${root}`);
  const from = resolve(home, 'termag');
  let at = from;
  for (const part of ['', ...relative(from, target).split(sep).filter(Boolean)]) {
    at = part ? join(at, part) : at;
    let st;
    try { st = lstatSync(at); } catch { break; }
    if (st.isSymbolicLink()) throw new CliError('failed', `Refusing to touch ${target}: ${at} is a symlink; remove it and run again`);
  }
  return target;
}

interface MirrorState {
  version: 1;
  space: string;
  syncedAt: string;
  files: Record<string, { etag: string; size: number }>;
  skipped: Array<{ path: string; reason: string }>;
}

export type MirrorResult =
  | { kind: 'synced'; space: string; dir: string; files: number; bytes: number; downloaded: number; removed: number; skipped: MirrorState['skipped'] }
  | { kind: 'busy'; space: string; dir: string }
  | { kind: 'failed'; space: string; dir: string; error: string };

/** The state lives with the CLI's other space state, not in the copy, so the copy holds the space's files and nothing else. */
function statePath(home: string, space: string): string {
  return checkInSpaces(home, join(spacesDir(home), '.mirrors', `${space}.json`));
}

function readState(home: string, space: string): MirrorState | null {
  try { return JSON.parse(readFileSync(statePath(home, space), 'utf8')) as MirrorState; } catch { return null; }
}

function writeState(home: string, state: MirrorState): void {
  const file = statePath(home, state.space);
  mkdirSync(join(spacesDir(home), '.mirrors'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
}

/** What is copied: by path, each file under the per-file cap, until the file count or the byte total runs out. */
export function planMirror(files: TreeFile[]): { copy: TreeFile[]; skipped: MirrorState['skipped'] } {
  const copy: TreeFile[] = [];
  const skipped: MirrorState['skipped'] = [];
  let bytes = 0;
  for (const f of [...files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
    if (f.size > SYNC_LIMITS.fileBytes) skipped.push({ path: f.path, reason: 'over 50 MiB' });
    else if (copy.length >= SYNC_LIMITS.files) skipped.push({ path: f.path, reason: `past ${SYNC_LIMITS.files} files` });
    else if (bytes + f.size > SYNC_LIMITS.totalBytes) skipped.push({ path: f.path, reason: 'past the 1 GiB a copy holds' });
    else { copy.push(f); bytes += f.size; }
  }
  return { copy, skipped };
}

function removeEntry(p: string): void {
  try {
    const st = lstatSync(p);
    if (st.isDirectory()) {
      chmodSync(p, 0o700);
      for (const e of readdirSync(p)) removeEntry(join(p, e));
      rmdirSync(p);
    } else rmSync(p, { force: true });
  } catch { /* already gone */ }
}

/** Every folder from the copy's root down to `target` is a real folder: a link or a file in the way is removed. */
function clearWay(root: string, target: string): void {
  let at = root;
  for (const part of relative(root, target).split(sep).slice(0, -1)) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch { return; }
    if (!st.isDirectory() || st.isSymbolicLink()) removeEntry(at);
  }
  try {
    const st = lstatSync(target);
    if (!st.isFile()) removeEntry(target);
  } catch { /* not there yet */ }
}

/** Removes what the copy holds that the space doesn't (and empty folders); returns how many files went. */
function prune(root: string, wanted: Set<string>): number {
  let removed = 0;
  const walk = (dir: string): boolean => {
    let empty = true;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(root, p).split(sep).join('/');
      if (e.isDirectory()) {
        if (walk(p)) rmdirSync(p);
        else empty = false;
      } else if (e.isFile() && wanted.has(rel)) {
        empty = false;
      } else {
        removeEntry(p);
        removed++;
      }
    }
    return empty;
  };
  walk(root);
  return removed;
}

/** A lock untouched this long is a killed sync's; a running one touches its lock each LOCK_BEAT_MS. */
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_BEAT_MS = 60_000;

/**
 * One sync of a space at a time, across processes. A first sync at the caps can
 * outlast LOCK_STALE_MS, so it keeps its lock fresh; release removes the lock
 * only while it's still this sync's.
 */
function lock(home: string, space: string): (() => void) | null {
  mkdirSync(join(spacesDir(home), '.mirrors'), { recursive: true, mode: 0o700 });
  const file = checkInSpaces(home, join(spacesDir(home), '.mirrors', `.${space}.lock`));
  const token = `${process.pid} ${randomUUID()}`;
  try {
    writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS) return null;
      writeFileSync(file, token, { mode: 0o600 });
    } catch { return null; }
  }
  const ours = () => { try { return readFileSync(file, 'utf8') === token; } catch { return false; } };
  const beat = setInterval(() => {
    if (!ours()) return;
    const now = new Date();
    try { utimesSync(file, now, now); } catch { /* the next beat tries again */ }
  }, LOCK_BEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    if (ours()) rmSync(file, { force: true });
  };
}

/** A fresh folder beside the copies, for downloads in progress: nothing can be planted in it ahead of a download. */
function staging(home: string, space: string): string {
  const root = checkInMirrors(home, mirrorsDir(home));
  // One a killed sync of this space left behind goes first. mkdtemp adds six
  // letters or digits, so `team` never matches `team-notes`'s, which another sync may be using.
  const prefix = `.staging-${space}-`;
  for (const e of readdirSync(root)) {
    if (e.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(e.slice(prefix.length))) removeEntry(join(root, e));
  }
  return mkdtempSync(join(root, prefix));
}

export async function mirrorSpace(ctx: Ctx, a: Api, space: string): Promise<MirrorResult> {
  const home = ctx.home;
  const dir = join(mirrorsDir(home), space);
  checkInSpaces(home, spacesDir(home));
  const release = lock(home, space);
  if (!release) return { kind: 'busy', space, dir };
  let stage: string | null = null;
  try {
    checkInMirrors(home, dir);
    const prev = readState(home, space);
    const { copy, skipped } = planMirror(await listAll(a, space, ''));
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    stage = staging(home, space);
    const files: MirrorState['files'] = {};
    const seen: Array<{ path: string; etag: string; versionId: string | null }> = [];
    let downloaded = 0;
    for (const f of copy) {
      const target = localTarget(dir, f.path);
      clearWay(dir, target);
      const etag = f.etag ?? `${f.size}:${f.modifiedAt ?? ''}`;
      const have = prev?.files[f.path];
      // A file changed in the copy (made writable and edited) is put back when its size gives it away.
      if (!have || have.etag !== etag || !existsSync(target) || statSync(target).size !== f.size) {
        // Downloaded in the staging folder, then renamed over the copy: a rename replaces a link, never follows it.
        const staged = join(stage, String(downloaded));
        const got = await download(ctx, a, space, f.path, staged);
        chmodSync(staged, 0o444);
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        renameSync(staged, target);
        downloaded++;
        // The version a later put, rm or mv replaces is the one downloaded, not the
        // listing's: the file can change between the two.
        if (got.etag && versionOf(home, space, f.path)?.etag !== got.etag) seen.push({ path: f.path, etag: got.etag, versionId: got.versionId });
        files[f.path] = { etag: got.etag ?? etag, size: got.size };
        continue;
      }
      files[f.path] = { etag, size: f.size };
    }
    const removed = prune(dir, new Set(Object.keys(files)));
    writeState(home, { version: 1, space, syncedAt: new Date().toISOString(), files, skipped });
    // What this box can read now: the version a later `space put` of the same path says it replaces.
    try { rememberVersions(home, space, seen, 'sync'); } catch (err) { ctx.err(`termag: not remembering file versions: ${(err as Error).message}`); }
    const bytes = Object.values(files).reduce((n, f) => n + f.size, 0);
    return { kind: 'synced', space, dir, files: copy.length, bytes, downloaded, removed, skipped };
  } finally {
    if (stage) removeEntry(stage);
    release();
  }
}

/**
 * A copy this CLI made (it has a state file), removed with its state. A folder
 * someone else put there is left alone. The state goes only once the copy has:
 * a copy left half-removed is still this CLI's to remove next time. A sync of
 * the space still running keeps it until the next one.
 */
function removeMirror(home: string, space: string): boolean {
  if (!existsSync(statePath(home, space))) return false;
  const release = lock(home, space);
  if (!release) return false;
  try {
    const dir = checkInMirrors(home, join(mirrorsDir(home), space));
    removeEntry(dir);
    if (existsSync(dir)) return false;
    rmSync(statePath(home, space), { force: true });
    return true;
  } finally {
    release();
  }
}

/** Copies this CLI made of spaces not in `reached`. */
function staleMirrors(home: string, reached: Set<string>): string[] {
  const states = join(spacesDir(home), '.mirrors');
  if (!existsSync(states)) return [];
  return readdirSync(states)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -'.json'.length))
    .filter(s => SPACE_NAME_RE.test(s) && !reached.has(s));
}

export async function cmdSpaceSync(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const a = await api(ctx, args);
  // A name the server sends is checked like one from argv: it becomes a path.
  const spaces: SpaceView[] = (await listSpaces(a)).filter(s => SPACE_NAME_RE.test(s.name));
  const named = args.args[0];
  if (named !== undefined && !SPACE_NAME_RE.test(named)) throw new CliError('usage', `${JSON.stringify(named)} is not a space name`);
  const reached = new Set(spaces.map(s => s.name));
  if (named !== undefined && !reached.has(named)) {
    // Not reaching it is the answer; a copy that won't go is the next full sync's to report.
    try { removeMirror(ctx.home, named); } catch { /* see above */ }
    throw new CliError('not_found', `You don't reach ${named}`);
  }
  const results: MirrorResult[] = [];
  const removed: string[] = [];
  // A stale copy that can't go fails on its own, like a space that can't be copied.
  for (const stale of named === undefined ? staleMirrors(ctx.home, reached) : []) {
    try {
      if (removeMirror(ctx.home, stale)) removed.push(stale);
    } catch (err) {
      results.push({ kind: 'failed', space: stale, dir: join(mirrorsDir(ctx.home), stale), error: (err as Error).message });
    }
  }
  for (const view of named === undefined ? spaces : spaces.filter(s => s.name === named)) {
    try {
      results.push(await mirrorSpace(ctx, a, view.name));
    } catch (err) {
      results.push({ kind: 'failed', space: view.name, dir: join(mirrorsDir(ctx.home), view.name), error: (err as Error).message });
    }
  }
  const failed = results.some(r => r.kind === 'failed');
  if (args.json) {
    const access = new Map(spaces.map(s => [s.name, { role: s.role, readOnly: s.readOnly, ...(s.access ? { access: s.access } : {}) }]));
    ctx.out(json({
      root: mirrorsDir(ctx.home),
      default: defaultSpace(spaces, ctx.env),
      spaces: results.map(r => ({ ...r, ...access.get(r.space) })),
      removed,
    }));
    return failed ? EXIT.FAILED : EXIT.OK;
  }
  if (results.length === 0 && removed.length === 0) ctx.out('You reach no spaces.');
  for (const r of results) {
    if (r.kind === 'busy') ctx.out(`${r.space}: another sync is running`);
    else if (r.kind === 'failed') ctx.err(`${r.space}: ${r.error}`);
    else {
      const notCopied = r.skipped.length ? `; ${r.skipped.length} not copied (--json says why)` : '';
      ctx.out(`${r.space}: ${r.files} file${r.files === 1 ? '' : 's'} (${formatBytes(r.bytes)}) in ${r.dir}${notCopied}`);
    }
  }
  for (const s of removed) ctx.out(`${s}: removed, you no longer reach it`);
  return failed ? EXIT.FAILED : EXIT.OK;
}
