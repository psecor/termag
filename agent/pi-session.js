'use strict';
// pi's session files, for a chat on the pi engine (chat-runner.js): where
// one lives, moving it when the checkout moves, and its conversation as the
// entries chat-history returns for a Claude transcript.
//
// pi keeps a session at ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl
// (pi's docs/session-format.md, version 3), where <cwd> drops the leading
// separator and turns `/`, `\` and `:` into `-`. The runner leaves pi's
// default directory alone, so usage-scanner.js still counts these turns.
// `--session-id <id>` looks the id up only under the cwd's own directory and
// creates a new, empty session when it is not there: a checkout that moved (a
// rename) needs its file moved first, as rehomeTranscript does for Claude.

const fs = require('fs');
const path = require('path');
const { claudeBlocks, claudeUsage, contentText } = require('./pi-events');

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const sessionsRoot = home => path.join(home, '.pi/agent/sessions');

/** pi's directory name for a cwd. */
function piSessionSlug(cwd) {
  return `--${String(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** The session file of `sessionId`, in any cwd's directory; null when there is none. */
function findPiSession(home, sessionId, { readdir = fs.readdirSync } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const root = sessionsRoot(home);
  let dirs = [];
  try { dirs = readdir(root); } catch { return null; }
  const suffix = `_${sessionId}.jsonl`;
  for (const d of dirs) {
    let names = [];
    try { names = readdir(path.join(root, d)); } catch { continue; }
    const hit = names.find(n => n.endsWith(suffix));
    if (hit) return path.join(root, d, hit);
  }
  return null;
}

/** Move a session's file under `newCwd`'s directory so `--session-id` finds it there. A no-op when it is already there or there is none. */
function rehomePiSession(home, sessionId, newCwd, fsImpl = fs) {
  const file = findPiSession(home, sessionId, { readdir: fsImpl.readdirSync });
  if (!file) return;
  const dir = path.join(sessionsRoot(home), piSessionSlug(newCwd));
  if (path.dirname(file) === dir) return;
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.renameSync(file, path.join(dir, path.basename(file)));
  } catch { /* leave it; pi starts a new session, the turn still runs */ }
}

/** One session-file line as an object, or null. */
function entryOf(line) {
  if (!line || !line.trim()) return null;
  try {
    const e = JSON.parse(line);
    return e && typeof e === 'object' ? e : null;
  } catch { return null; }
}

/**
 * The conversation in a pi session file as chat-history's entries, the
 * shape historyEntries gives a Claude transcript ({type, uuid, timestamp,
 * message}), so the browser's one reducer reads both: a user prompt is a
 * user message of text, an assistant message keeps its text, tool calls
 * (tool_use) and thinking, and a tool result is a user message of one
 * tool_result. pi's system prompt and its model and thinking changes are
 * not conversation.
 */
function piHistoryEntries(jsonl, max = 600) {
  const out = [];
  for (const line of String(jsonl || '').split('\n')) {
    const e = entryOf(line);
    if (!e || e.type !== 'message' || !e.message) continue;
    const m = e.message;
    const base = { uuid: typeof e.id === 'string' ? e.id : undefined, timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined };
    if (m.role === 'user') {
      const text = contentText(m.content);
      out.push({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'text', text }] } });
    } else if (m.role === 'assistant') {
      const content = claudeBlocks(m.content);
      if (!content.length) continue;
      const usage = claudeUsage(m.usage);
      out.push({
        type: 'assistant', ...base,
        message: {
          id: base.uuid, role: 'assistant', ...(typeof m.model === 'string' && { model: m.model }), content,
          ...(usage && { usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens } }),
        },
      });
    } else if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
      out.push({
        type: 'user', ...base,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: contentText(m.content), is_error: m.isError === true }] },
      });
    }
  }
  return out.slice(-max);
}

/** The id of the first user prompt in a slice of a session file (a turn's record keys on it, as on Claude's prompt uuid). */
function piUserEntryId(lines) {
  for (const raw of typeof lines === 'string' || lines == null ? String(lines || '').split('\n') : lines) {
    const e = entryOf(String(raw));
    if (e && e.type === 'message' && e.message && e.message.role === 'user' && typeof e.id === 'string') return e.id;
  }
  return null;
}

module.exports = { findPiSession, piHistoryEntries, piSessionSlug, piUserEntryId, rehomePiSession };
