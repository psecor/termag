'use strict';
/**
 * The `briefing-digest` RPC: what one
 * checkout's Claude transcript and git history say about a time window, as
 * truncated extracts. Reply shape: DigestReply in
 * backend/src/services/briefing/types.ts.
 *
 * Transcript text (prompts, assistant text, todo items) is UNTRUSTED data for
 * the composing model; only bounded extracts leave the box, never the file.
 *
 * The log dir is ~/.claude/projects/<cwd with '/' and '.' replaced by '-'>,
 * the same encoding usage-scan in agent.js relies on.
 */
const fs = require('fs');
const path = require('path');

const CAPABILITIES = ['briefing-v1'];

const MAX_FILES = 6;
const TAIL_BYTES = 4 * 1024 * 1024;
const PROMPT_MAX = 300;
const PROMPTS_KEPT = 5;
const ASSISTANT_MAX = 1200;
const TODO_MAX = 200;
const TODOS_KEPT = 30;
const QUESTION_TAIL = 400;
const GIT_TIMEOUT_MS = 3000;
const COMMITS_MAX = 20;
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

function encodeCwd(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

function logDirFor(home, cwd) {
  return path.join(home, '.claude', 'projects', encodeCwd(cwd));
}

/** Read at most the last `maxBytes` of a file; a cut first line is dropped. */
function readTail(file, maxBytes = TAIL_BYTES) {
  const size = fs.statSync(file).size;
  const len = Math.min(size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (len < size) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return text;
}

/** The transcript files worth reading: modified since `sinceMs`, newest first. */
function candidateFiles(dir, sinceMs) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, MAX_FILES);
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();
const head = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tail = (s, n) => (s.length > n ? `…${s.slice(s.length - (n - 1))}` : s);

/** The prompt text of a real user turn, or null for tool results, meta and command lines. */
function userPromptText(entry) {
  if (entry.type !== 'user' || entry.isMeta) return null;
  const content = entry.message && entry.message.content;
  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some(b => b && b.type === 'tool_result')) return null;
    const parts = content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text);
    if (parts.length === 0) return null;
    text = parts.join('\n');
  } else {
    return null;
  }
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('<command-') || t.startsWith('<local-command-') || t.startsWith('Caveat:')) return null;
  return t;
}

function isToolResult(entry) {
  const content = entry.type === 'user' && entry.message && entry.message.content;
  return Array.isArray(content) && content.some(b => b && b.type === 'tool_result');
}

function assistantBlocks(entry) {
  if (entry.type !== 'assistant') return [];
  const content = entry.message && entry.message.content;
  return Array.isArray(content) ? content : [];
}

function asksQuestion(text) {
  // A "?" ending a sentence anywhere in the tail ("Should I X or Y? The first
  // is cleaner."), not one inside code or a query string ("a ?? b", "?project=").
  const end = text.slice(-QUESTION_TAIL)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  return /[^\s?]\?(\s|$)/.test(end);
}

/**
 * Fold the entries of several files into a TranscriptDigest. Pure: takes the
 * file texts, returns the digest or null when nothing falls in the window.
 */
function digestTranscripts(texts, sinceMs, untilMs) {
  const events = [];
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      const at = Date.parse(entry.timestamp);
      if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
      events.push({ at, entry });
    }
  }
  if (events.length === 0) return null;
  events.sort((a, b) => a.at - b.at);

  const prompts = [];
  let lastAssistantText = null;
  let todos = null;
  // The last event that says whether the turn is the user's: 'user' (a prompt),
  // 'assistant' (text), 'ask' (an AskUserQuestion not yet answered), or
  // 'tool' (any other tool call or a tool result: the agent kept working).
  let last = null;
  let lastKindText = null;
  for (const { entry } of events) {
    const prompt = userPromptText(entry);
    if (prompt !== null) {
      prompts.push(head(collapse(prompt), PROMPT_MAX));
      last = 'user';
      continue;
    }
    if (isToolResult(entry)) { last = 'tool'; continue; }
    for (const b of assistantBlocks(entry)) {
      if (!b) continue;
      if (b.type === 'tool_use') last = b.name === 'AskUserQuestion' ? 'ask' : 'tool';
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        lastAssistantText = b.text.trim();
        last = 'assistant';
        lastKindText = lastAssistantText;
      } else if (b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        todos = b.input.todos
          .filter(t => t && typeof t.content === 'string')
          .slice(0, TODOS_KEPT)
          .map(t => ({
            content: head(collapse(t.content), TODO_MAX),
            status: TODO_STATUSES.has(t.status) ? t.status : 'pending',
          }));
      }
    }
  }

  return {
    userTurns: prompts.length,
    firstAt: new Date(events[0].at).toISOString(),
    lastAt: new Date(events[events.length - 1].at).toISOString(),
    lastUserPrompts: prompts.slice(-PROMPTS_KEPT),
    lastAssistantText: lastAssistantText === null ? null : tail(lastAssistantText, ASSISTANT_MAX),
    endsWithQuestion: last === 'ask' || (last === 'assistant' && lastKindText !== null && asksQuestion(lastKindText)),
    todos: todos || [],
  };
}

function readTranscript(home, cwd, sinceMs, untilMs) {
  const files = candidateFiles(logDirFor(home, cwd), sinceMs);
  const texts = [];
  for (const f of files) {
    try { texts.push(readTail(f.path)); } catch { /* unreadable: skip */ }
  }
  return digestTranscripts(texts, sinceMs, untilMs);
}

/** Parse `git log --format=%h%x09%cI%x09%s` output. */
function parseCommits(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    const [sha, at, ...rest] = line.split('\t');
    if (!sha || !at) continue;
    out.push({ sha, at, subject: rest.join('\t') });
    if (out.length >= COMMITS_MAX) break;
  }
  return out;
}

/**
 * The window's commits on HEAD that the checkout's own git identity wrote,
 * merges left out: on a shared branch like main, `git log` alone lists every
 * teammate's work that a pull brought in. With no user.email configured the
 * author filter is skipped.
 */
async function readGit(cwd, since, until, execFile) {
  const git = (args) => execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS }).then(r => String(r.stdout), () => null);
  const [email, ref] = await Promise.all([
    git(['config', 'user.email']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  const author = email === null ? '' : email.trim();
  const log = await git([
    'log', '--no-merges', `--since=${since}`, `--until=${until}`,
    // Anchored on the brackets of "Name <email>": a bare email is a substring
    // match, so pat@example.com would also take apat@example.com's commits.
    ...(author ? ['--fixed-strings', `--author=<${author}>`] : []),
    '--format=%h%x09%cI%x09%s', '-n', String(COMMITS_MAX),
  ]);
  const branch = ref === null ? null : ref.trim();
  return {
    commits: log === null ? [] : parseCommits(log),
    branch: branch && branch !== 'HEAD' ? branch : null,
  };
}

/**
 * @param {{ cwd: string, since: string, until: string }} req
 * @param {{ home: string, execFile: Function }} deps
 */
async function briefingDigest(req, deps) {
  const { cwd, since, until } = req || {};
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd is required');
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
    throw new Error('since and until must be ISO times with since <= until');
  }
  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date(untilMs).toISOString();
  const [transcript, git] = await Promise.all([
    Promise.resolve().then(() => readTranscript(deps.home, cwd, sinceMs, untilMs)).catch(() => null),
    readGit(cwd, sinceIso, untilIso, deps.execFile),
  ]);
  return { transcript, commits: git.commits, branch: git.branch };
}

module.exports = {
  CAPABILITIES,
  briefingDigest,
  digestTranscripts,
  readTail,
  parseCommits,
  encodeCwd,
  logDirFor,
  userPromptText,
};
