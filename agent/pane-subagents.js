'use strict';
/**
 * A pane Claude's subagents, for the simple UI's pane chat
 *
 * (pane-subagents-v1). A project made in Lab runs Claude Code in a tmux pane,
 * whose Agent-tool subagents never reach the chat runner's event stream, but
 * Claude Code writes them beside the session's transcript, as it does for a
 * chat's: `<projects>/<slug>/<session>/subagents/agent-<id>.jsonl` and its
 * `.meta.json` (agentType, description, toolUseId, requestShape, model,
 * finished).
 *
 * Which session is the pane's: Claude Code (2.1 on) keeps one file per
 * process, `~/.claude/sessions/<pid>.json` ({pid, sessionId, cwd, startedAt,
 * kind, entrypoint}), and moves its sessionId with the session on /clear and
 * --resume. So the pane's session is the one whose file names a process in
 * the pane's process tree, the one nearest the pane's own process first. A
 * file older than the process it names is a dead process's whose pid was
 * reused, and is passed over. A Claude Code that writes no such file gets no
 * session (`session: null`), never a guess from the newest transcript in the
 * directory: a second Claude there (a ctrl pane's) would be taken for it.
 *
 * Running alongside (`alongside`): the other live, interactive Claude Code
 * sessions in the pane Claude's own directory (the same cwd), outside the
 * pane's tree: one started in the ctrl pane, or an agent team's teammates in
 * panes of their own. Interactive means `entrypoint: "cli"`; a headless
 * `claude -p` writes `sdk-cli`, the Agent SDK `sdk-ts` / `sdk-py`, and they
 * are left out. Their transcripts are read by session id, only from the pane
 * Claude's own directory's slug.
 *
 * Read only: nothing here writes, and everything read is the box user's own
 * ~/.claude.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { historyEntries, isSessionId, slugForCwd, isAgentId } = require('./chat-runner');
const { historyTail } = require('./transcript-lines');

const CAPABILITIES = ['pane-subagents-v1'];

/** A tmux session name as termag makes them: no path, no tmux target syntax. */
const SESSION_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;
/** A session file may be written a moment after its process starts, and lstart has whole seconds. */
const START_SLACK_MS = 5000;
/** A file is not read past these, as the chat's own history is not (chat-runner.js). */
const HISTORY_MAX_ENTRIES = 600;
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
/** How much of a subagent's brief and its report the listing carries; the tab reads the whole file. */
const TEXT_MAX_CHARS = 4000;
/** How many subagents a listing carries, newest first. */
const MAX_SUBAGENTS = 50;
/** How far into a subagent's file its brief is looked for, and back from its end its report. */
const SCAN_BYTES = 256 * 1024;

const execFileAsync = promisify(execFile);

/**
 * `ps -A -o pid=,ppid=,lstart=` as a Map of pid to its parent and its start
 * (ms; NaN where lstart doesn't parse). lstart is "Thu Nov  5 11:37:53 2026",
 * local time, the same on Linux procps and macOS.
 */
function parsePs(stdout) {
  const out = new Map();
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), { ppid: Number(m[2]), start: Date.parse(m[3]) });
  }
  return out;
}

/** The pids under `root` (itself first), nearest first. */
function treeOf(procs, root) {
  const children = new Map();
  for (const [pid, p] of procs) {
    if (pid === p.ppid) continue;
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  const out = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of (children.get(pid) || []).sort((a, b) => a - b)) queue.push(c);
  }
  return out;
}

/** `~/.claude/sessions/<pid>.json`, when it is a session file for that pid; else null. */
function readSessionFile(home, pid, fsImpl = fs) {
  let j;
  try { j = JSON.parse(fsImpl.readFileSync(path.join(home, '.claude/sessions', `${pid}.json`), 'utf8')); } catch { return null; }
  if (!j || typeof j !== 'object' || j.pid !== pid || !isSessionId(j.sessionId)) return null;
  if (typeof j.cwd !== 'string' || !path.isAbsolute(j.cwd)) return null;
  return {
    pid,
    sessionId: j.sessionId,
    cwd: j.cwd,
    startedAt: Number.isFinite(j.startedAt) ? j.startedAt : null,
    entrypoint: typeof j.entrypoint === 'string' ? j.entrypoint : null,
    kind: typeof j.kind === 'string' ? j.kind : null,
  };
}

/** A session file whose process is the one running now: alive, and the file no older than the process. */
function liveFile(file, proc) {
  if (!file || !proc) return false;
  if (file.startedAt == null || !Number.isFinite(proc.start)) return true;
  return file.startedAt >= proc.start - START_SLACK_MS;
}

/** The pane's Claude session: the live session file nearest the pane's process, or null. */
function paneSessionOf(home, panePid, procs, fsImpl = fs) {
  for (const pid of treeOf(procs, panePid)) {
    const file = readSessionFile(home, pid, fsImpl);
    if (liveFile(file, procs.get(pid))) return file;
  }
  return null;
}

/** The same path for two spellings of it (a symlinked project dir, gotcha project-dir-symlinks). */
function sameDir(a, b, fsImpl = fs) {
  if (a === b) return true;
  try { return fsImpl.realpathSync(a) === fsImpl.realpathSync(b); } catch { return false; }
}

/** The other live interactive Claude sessions in `pane`'s cwd, outside the pane's tree, oldest first. */
function alongsideOf(home, pane, tree, procs, fsImpl = fs) {
  let names = [];
  try { names = fsImpl.readdirSync(path.join(home, '.claude/sessions')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (tree.has(pid)) continue;
    const file = readSessionFile(home, pid, fsImpl);
    if (!file || file.entrypoint !== 'cli' || file.sessionId === pane.sessionId) continue;
    if (!liveFile(file, procs.get(pid)) || !sameDir(file.cwd, pane.cwd, fsImpl)) continue;
    out.push(file);
  }
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** A string, cut to `max` characters. */
function clip(s, max = TEXT_MAX_CHARS) {
  return typeof s === 'string' && s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A message's text: a string, or its text blocks joined. */
function textOf(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

/** The first `bytes` of a file and the last, as text (the same when it is small). */
function ends(file, bytes, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const size = fsImpl.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, bytes));
    fsImpl.readSync(fd, head, 0, head.length, 0);
    if (size <= bytes) { const all = head.toString('utf8'); return { head: all, tail: all }; }
    const tail = Buffer.alloc(bytes);
    fsImpl.readSync(fd, tail, 0, bytes, size - bytes);
    return { head: head.toString('utf8'), tail: tail.toString('utf8') };
  } catch {
    return { head: '', tail: '' };
  } finally {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* closed */ }
  }
}

const parseLines = text => text.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });

/**
 * One subagent as the listing says it: its meta, when it started and last
 * wrote, its brief (its file's first user message) and, once it finished,
 * its report (its last assistant words).
 */
function subagentOf(dir, agentId, fsImpl = fs) {
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  let stat;
  try { stat = fsImpl.statSync(file); } catch { return null; }
  let meta = {};
  try { meta = JSON.parse(fsImpl.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')) || {}; } catch { /* none yet */ }
  const { head, tail } = ends(file, SCAN_BYTES, fsImpl);
  const first = parseLines(head).find(e => e && e.type === 'user' && e.message);
  const finished = meta.finished === true;
  const last = finished ? parseLines(tail).reverse().find(e => e && e.type === 'assistant' && textOf(e.message).trim()) : null;
  const str = v => (typeof v === 'string' && v ? v : null);
  return {
    agentId,
    toolUseId: str(meta.toolUseId),
    agentType: str(meta.agentType),
    description: str(meta.description),
    background: meta.requestShape === 'background',
    model: str(meta.model),
    finished,
    startedAt: first && typeof first.timestamp === 'string' ? first.timestamp : null,
    updatedAt: stat.mtime.toISOString(),
    prompt: first ? clip(textOf(first.message)) || null : null,
    report: last ? clip(textOf(last.message)) : null,
  };
}

/**
 * The session's subagents, newest first, at most MAX_SUBAGENTS, from every
 * slug that has its folder: a session resumed from another directory writes
 * its later subagents under that directory's slug. An id in two of them is
 * listed once, its newest copy.
 */
function subagentsOf(home, sessionId, fsImpl = fs) {
  const root = path.join(home, '.claude/projects');
  let slugs = [];
  try { slugs = fsImpl.readdirSync(root); } catch { return []; }
  const byId = new Map();
  for (const slug of slugs) {
    const dir = path.join(root, slug, sessionId, 'subagents');
    let names;
    try { names = fsImpl.readdirSync(dir); } catch { continue; }
    for (const id of names.map(n => /^agent-(.+)\.jsonl$/.exec(n)?.[1]).filter(isAgentId)) {
      const sub = subagentOf(dir, id, fsImpl);
      const had = byId.get(id);
      if (sub && (!had || Date.parse(sub.updatedAt) > Date.parse(had.updatedAt))) byId.set(id, sub);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_SUBAGENTS);
}

/** A subagent's file under the newest of the slugs that have it (subagentsOf lists that copy), or null. */
function newestSubagentFile(home, sessionId, agentId, fsImpl = fs) {
  const root = path.join(home, '.claude/projects');
  let slugs = [];
  try { slugs = fsImpl.readdirSync(root); } catch { return null; }
  let best = null;
  for (const slug of slugs) {
    const file = path.join(root, slug, sessionId, 'subagents', `agent-${agentId}.jsonl`);
    let mtime;
    try { mtime = fsImpl.statSync(file).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best ? best.file : null;
}

/**
 * An entry with its base64 images dropped: the pane chat has no image store
 * to keep them in (chat-images.js), so each becomes a reference to nothing,
 * which the browser draws as an image it can't show.
 */
function withoutImages(e) {
  const drop = content => {
    if (!Array.isArray(content)) return content;
    let changed = false;
    const out = content.map(part => {
      if (part && (part.type === 'image' || part.type === 'document') && part.source && part.source.type === 'base64') {
        changed = true;
        return { type: part.type, source: { type: 'termag', media_type: part.source.media_type || null, path: null } };
      }
      if (part && part.type === 'tool_result' && Array.isArray(part.content)) {
        const inner = drop(part.content);
        if (inner !== part.content) { changed = true; return { ...part, content: inner }; }
      }
      return part;
    });
    return changed ? out : content;
  };
  if (!e || !e.message || !Array.isArray(e.message.content)) return e;
  const content = drop(e.message.content);
  return content === e.message.content ? e : { ...e, message: { ...e.message, content } };
}

/** A transcript as the browser's history entries (chat-runner.js historyEntries). */
function entriesOf(file, sidechain) {
  const jsonl = historyTail(file, { maxBytes: HISTORY_MAX_BYTES, shrink: withoutImages });
  return historyEntries(jsonl, HISTORY_MAX_ENTRIES, { sidechain }).map(withoutImages);
}

/**
 * The RPCs, over a tmux query and `ps` (injected for the tests). Each takes
 * the agent pane's tmux session name and finds its Claude afresh: a /clear, a
 * restart or a resume moves it, and nothing is cached.
 */
function createPaneSubagents({ home, tmux = args => execFileAsync('tmux', args, { timeout: 5000, killSignal: 'SIGKILL' }), ps = () => execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }), fsImpl = fs } = {}) {
  async function locate(session) {
    if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) throw new Error('bad session');
    let panePid;
    try {
      const { stdout } = await tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']);
      panePid = Number(String(stdout).trim());
    } catch {
      return { running: false };
    }
    if (!Number.isSafeInteger(panePid) || panePid <= 0) return { running: false };
    const procs = parsePs((await ps()).stdout);
    const tree = new Set(treeOf(procs, panePid));
    return { running: true, procs, tree, pane: paneSessionOf(home, panePid, procs, fsImpl) };
  }

  return {
    /**
     * `pane-subagents`: the pane Claude's session and its subagents, and the
     * sessions running alongside it. `running: false`, the pane is gone;
     * `session: null`, no Claude in it this can tell (none running, or one
     * that writes no session file).
     */
    async list(session) {
      const at = await locate(session);
      if (!at.running || !at.pane) return { running: at.running, session: null, subagents: [], alongside: [] };
      const { pane, procs, tree } = at;
      return {
        running: true,
        session: { sessionId: pane.sessionId, cwd: pane.cwd, startedAt: pane.startedAt },
        subagents: subagentsOf(home, pane.sessionId, fsImpl),
        alongside: alongsideOf(home, pane, tree, procs, fsImpl).map(f => {
          const file = path.join(home, '.claude/projects', slugForCwd(f.cwd), `${f.sessionId}.jsonl`);
          let updatedAt = null;
          try { updatedAt = fsImpl.statSync(file).mtime.toISOString(); } catch { /* not written yet */ }
          const { head } = ends(file, SCAN_BYTES, fsImpl);
          const first = parseLines(head).find(e => e && e.type === 'user' && e.message && !e.isMeta && textOf(e.message).trim());
          return {
            sessionId: f.sessionId,
            startedAt: f.startedAt,
            updatedAt,
            title: first ? clip(textOf(first.message), 200) : null,
          };
        }),
      };
    },

    /**
     * `pane-subagent-read`: one subagent's transcript, of the pane Claude's
     * current session only, as subagentHistory hands out a chat's.
     */
    async readSubagent(session, agentId) {
      if (!isAgentId(agentId)) throw new Error('bad agentId');
      const at = await locate(session);
      if (!at.pane) return { found: false, entries: [] };
      const file = newestSubagentFile(home, at.pane.sessionId, agentId, fsImpl);
      if (!file) return { found: false, entries: [] };
      return { found: true, sessionId: at.pane.sessionId, entries: entriesOf(file, true) };
    },

    /**
     * `pane-session-read`: a session's own transcript, by id, from the pane
     * Claude's directory only (a session running alongside it, or one that
     * was).
     */
    async readSession(session, sessionId) {
      if (!isSessionId(sessionId)) throw new Error('bad sessionId');
      const at = await locate(session);
      if (!at.pane) return { found: false, entries: [] };
      // The pane's directory as it and its realpath spell it, and as a session alongside it spells it (another symlink to it).
      const dirs = [at.pane.cwd, ...alongsideOf(home, at.pane, at.tree, at.procs, fsImpl).filter(f => f.sessionId === sessionId).map(f => f.cwd)];
      const spellings = dirs.flatMap(d => { try { return [d, fsImpl.realpathSync(d)]; } catch { return [d]; } });
      const file = [...new Set(spellings)].map(d => path.join(home, '.claude/projects', slugForCwd(d), `${sessionId}.jsonl`)).find(f => fsImpl.existsSync(f));
      if (!file) return { found: false, entries: [] };
      return { found: true, sessionId, entries: entriesOf(file, false) };
    },
  };
}

module.exports = { CAPABILITIES, createPaneSubagents, parsePs, treeOf, paneSessionOf, alongsideOf, subagentsOf, withoutImages };
