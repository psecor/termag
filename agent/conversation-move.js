'use strict';
/**
 * The agent conversations a rename carries along: a project's (the
 * `project-rename` RPC, agent/project-rename.js) or a workstream's
 * (`git-worktree-move`, `workspace-move`), when the backend sends
 * `conversations: true` to an agent announcing `rename-conversations-v1`.
 *
 * Claude Code keeps a conversation under ~/.claude/projects/<cwd, every
 * non-alphanumeric turned to '-'>/ and pi under ~/.pi/agent/sessions/--<cwd>--/,
 * and each looks only in the folder of the cwd it starts in: once a rename
 * moves the checkout, `claude --resume` and `--continue` there find nothing
 * ("No conversations found"), though every file is still on the box. So after
 * the move each checkout's folder moves to its new path's name: the moved
 * folder's own, each worktree's under its .worktrees/ and, in a multi-repo
 * project, each repository's checkout in those.
 *
 * Only exact names move, never a prefix: `-…-projects-event` is also how
 * `-…-projects-event-recorder`, another project's folder, starts. When the new
 * folder is already there (a retry, or a copy made by hand) the two are merged
 * without overwriting anything: an entry the new folder lacks moves in, a
 * folder both have is merged the same way, and a file both have stays where it
 * is. A folder another existing directory also encodes to (`my_app` and
 * `my-app` both give `my-app`) holds that directory's conversations too, so
 * it is left alone, whether it is the old folder or the new one: moving into
 * it would hand this checkout's conversations to the other directory as well.
 * Checkouts inside the moved folder (two worktrees `fix_1` and `fix-1`) moved
 * together and shared their old folder just the same, so they are not each
 * other's "other directory".
 * A checkout whose old folder is not there (nothing ever ran in it) is
 * nothing to move, so a second call does nothing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { slugForCwd } = require('./chat-runner');
const { piSessionSlug } = require('./pi-session');

const CAPABILITIES = ['rename-conversations-v1'];

// Past 200 characters Claude Code cuts the name and appends a hash of the
// path that only its runtime computes, so such a folder can't be named here.
const CLAUDE_SLUG_MAX = 200;

const STORES = [
  {
    name: 'claude',
    root: home => path.join(home, '.claude', 'projects'),
    slug: dir => { const s = slugForCwd(dir); return s.length <= CLAUDE_SLUG_MAX ? s : null; },
  },
  { name: 'pi', root: home => path.join(home, '.pi', 'agent', 'sessions'), slug: piSessionSlug },
];

function lstatOrNull(p, fsImpl) {
  try { return fsImpl.lstatSync(p); } catch { return null; }
}

/** A directory itself, not a symlink to one. */
function isRealDir(p, fsImpl) {
  const st = lstatOrNull(p, fsImpl);
  return Boolean(st && st.isDirectory());
}

function dirNames(dir, fsImpl) {
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  return names.filter(n => {
    try { return fsImpl.statSync(path.join(dir, n)).isDirectory(); } catch { return false; }
  }).sort();
}

/** `p` with its parent spelled as realpath spells it: Claude Code names a folder after the cwd it starts in. */
function realParent(p, fsImpl) {
  try { return path.join(fsImpl.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}

/**
 * Old path → new path for every checkout a rename moved: the project folder,
 * each worktree now under `toDir/.worktrees/`, and each of `repos` in those,
 * once as the backend spells the paths and once through a symlinked parent's
 * realpath (on macOS /tmp is /private/tmp). `inTree` marks a checkout inside
 * the moved folder, whose neighbours all moved with it.
 */
function movedCheckouts({ fromDir, toDir, repos = [] }, fsImpl = fs) {
  const roots = ['', ...dirNames(path.join(toDir, '.worktrees'), fsImpl).map(n => path.join('.worktrees', n))];
  const rels = [...roots, ...roots.flatMap(r => repos.map(repo => path.join(r, repo)))];
  const bases = [[fromDir, toDir], [realParent(fromDir, fsImpl), realParent(toDir, fsImpl)]];
  const out = [];
  const seen = new Set();
  for (const [from, to] of bases) {
    for (const rel of rels) {
      const pair = { from: path.join(from, rel), to: path.join(to, rel), ...(rel ? { inTree: true } : {}) };
      if (pair.from === pair.to || seen.has(pair.from)) continue;
      seen.add(pair.from);
      out.push(pair);
    }
  }
  return out;
}

/** Another directory beside `dir` whose path gives the same folder name, so that folder is not only `dir`'s. */
function sharedWith(dir, slug, fsImpl) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const key = slug(dir);
  return dirNames(parent, fsImpl).some(n => n !== base && slug(path.join(parent, n)) === key);
}

/**
 * Move `src`'s entries into `dst` without overwriting any: `dst` absent takes
 * `src` whole, a folder both have is merged, a file both have stays in `src`.
 * `src` is removed once it is empty.
 */
function mergeInto(src, dst, fsImpl) {
  const names = fsImpl.readdirSync(src);
  if (!lstatOrNull(dst, fsImpl)) {
    fsImpl.mkdirSync(path.dirname(dst), { recursive: true });
    fsImpl.renameSync(src, dst);
    return { moved: names.length, kept: 0 };
  }
  if (!isRealDir(dst, fsImpl)) return { moved: 0, kept: names.length };
  let moved = 0;
  let kept = 0;
  for (const n of names) {
    const s = path.join(src, n);
    const d = path.join(dst, n);
    if (!lstatOrNull(d, fsImpl)) {
      fsImpl.renameSync(s, d);
      moved++;
    } else if (isRealDir(s, fsImpl) && isRealDir(d, fsImpl)) {
      const r = mergeInto(s, d, fsImpl);
      moved += r.moved;
      kept += r.kept;
    } else {
      kept++;
    }
  }
  try { fsImpl.rmdirSync(src); } catch { /* something stayed */ }
  return { moved, kept };
}

/**
 * Move each moved checkout's conversation folders, per store, to the new
 * path's name. Returns the folders moved (`moved` entries went over, `kept`
 * stayed because the new folder has them too) and the ones left alone, with
 * why. Never throws: a failure is reported and the rest still move.
 */
function moveConversations({ home, checkouts }, fsImpl = fs) {
  const out = { claude: [], pi: [], left: [] };
  for (const store of STORES) {
    const root = store.root(home);
    if (!isRealDir(root, fsImpl)) continue;
    for (const { from, to, inTree } of checkouts) {
      const a = store.slug(from);
      const b = store.slug(to);
      if (!a || !b || a === b) continue;
      const src = path.join(root, a);
      if (!isRealDir(src, fsImpl)) continue;
      if (sharedWith(from, store.slug, fsImpl)) {
        out.left.push({ store: store.name, from: a, reason: 'shared with another directory' });
        continue;
      }
      if (!inTree && sharedWith(to, store.slug, fsImpl)) {
        out.left.push({ store: store.name, from: a, reason: 'destination shared with another directory' });
        continue;
      }
      try {
        out[store.name].push({ from: a, to: b, ...mergeInto(src, path.join(root, b), fsImpl) });
      } catch (err) {
        out.left.push({ store: store.name, from: a, reason: err.message });
      }
    }
  }
  return out;
}

/** After a rename moved `fromDir` to `toDir`: carry the conversations of every checkout in it. */
function carryConversations({ home, fromDir, toDir, repos = [] }, fsImpl = fs) {
  return moveConversations({ home, checkouts: movedCheckouts({ fromDir, toDir, repos }, fsImpl) }, fsImpl);
}

module.exports = { CAPABILITIES, CLAUDE_SLUG_MAX, carryConversations, mergeInto, moveConversations, movedCheckouts };
