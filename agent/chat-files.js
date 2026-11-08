'use strict';
/**
 * Files attached to a simple-UI chat message that don't go in it
 * (Other files): a zip, a spreadsheet, a
 * binary, a text file over the inline cap. The backend sends one with the
 * chat-file-put RPC; it is kept in the chat's own checkout, under
 * .termag-attachments/<sha256 prefix>/<name>, and the message names that
 * path for Claude to open with its tools. In the checkout, not ~/, because
 * an untrusted chat's Read is confined to it. Git never sees the folder: it
 * goes in the repository's info/exclude, as /.worktrees/ does.
 *
 * Nothing here runs or opens what it writes. It refuses a folder on the way
 * that is a symlink (a repository may commit one by that name), so a file
 * only ever lands under the checkout.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CAPABILITIES = ['chat-files-v1'];
// The upload route's body limit is a little above this (backend services/chatFiles.ts).
const MAX_FILE_BYTES = 20 * 1000 * 1000;
const DIR = '.termag-attachments';
// Unanchored, so it holds wherever the checkout sits in its repository.
const EXCLUDE_LINE = `${DIR}/`;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** A file name fit for a path Claude can name in a shell: its last segment, plain characters, bounded. */
function safeName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop() || '';
  // Bounded first, then stripped: the tail kept must not start a hidden file or a -flag either.
  const name = base.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120).replace(/^[.-]+/, '');
  return name || 'file';
}

/** A directory under `parent` that is a real directory, made if missing; refused when it is anything else. */
function realDir(parent, name, fsImpl) {
  const dir = path.join(parent, name);
  try {
    fsImpl.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = fsImpl.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`file-refused: ${name} in the checkout is not a folder`);
  // One that was already there (a repository's own, say) is made private too.
  fsImpl.chmodSync(dir, 0o700);
  return dir;
}

/** Puts .termag-attachments/ in the checkout's info/exclude, once; a checkout that isn't a git repository is left alone. */
async function excludeFromGit(cwd, { execFile, fsImpl = fs }) {
  let out;
  try {
    ({ stdout: out } = await execFile('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], { timeout: 10_000 }));
  } catch {
    return false;
  }
  const file = path.resolve(cwd, String(out).trim());
  let text = '';
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (text.split('\n').includes(EXCLUDE_LINE)) return true;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
  return true;
}

/**
 * Keeps one attached file in the chat's checkout `cwd`. Answers its path
 * relative to the checkout (Claude's working directory), the name it was
 * kept as and its size. Throws `file-refused: …` for what the browser may
 * show: no checkout, not base64, empty or over MAX_FILE_BYTES. The same
 * bytes sent again land at the same path (named by their hash).
 */
async function putFile({ cwd, name, data }, { execFile, fsImpl = fs } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('file-refused: the chat has no checkout');
  let st;
  try { st = fsImpl.statSync(cwd); } catch { st = null; }
  if (!st?.isDirectory()) throw new Error('file-refused: the chat has no checkout on this box yet');
  if (typeof data !== 'string' || !BASE64_RE.test(data)) throw new Error('file-refused: the file is not base64 data');
  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0) throw new Error('file-refused: the file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file-refused: the file is larger than ${MAX_FILE_BYTES / 1_000_000} MB`);
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const kept = safeName(name);
  const dir = realDir(realDir(cwd, DIR, fsImpl), id, fsImpl);
  const target = path.join(dir, kept);
  let existing = null;
  try { existing = fsImpl.lstatSync(target); } catch { /* not there yet */ }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('file-refused: something else is already at that path');
  // Written afresh every time, through a private temp file: a copy edited since (or one the repository
  // brought, with its own mode) is replaced by exactly the bytes sent, readable by this user alone.
  const tmp = path.join(dir, `.${kept}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fsImpl.writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
  fsImpl.renameSync(tmp, target);
  if (execFile) await excludeFromGit(cwd, { execFile, fsImpl });
  return { path: path.posix.join(DIR, id, kept), name: kept, size: buf.length };
}

module.exports = { CAPABILITIES, DIR, EXCLUDE_LINE, MAX_FILE_BYTES, excludeFromGit, putFile, safeName };
