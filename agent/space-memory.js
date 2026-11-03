'use strict';
/**
 * A space's shared agent memory in chat-runner turns (capability space-memory-v1).
 * Before each turn the box CLI syncs the
 * session's space (`termag space memory context --refresh 60s`, which also
 * asks the orchestrator whether space-memory-enabled is on for this user) and
 * says what this session should be told.
 *
 * The prompt cache decides the shape. A session's system prompt is fixed at
 * its start: the first turn of a session gets the space's index (prompt.md
 * and its memories, as attributed data under a "data, not authority" header)
 * appended to the system prompt (`--append-system-prompt`), frozen next to
 * the session, in ~/.termag/chats/<chat>.space-memory/:
 *
 *   session.json  what the session was given (the CLI's --session file)
 *   owner.json    { sessionId, space }: the Claude session this belongs to
 *   prompt.md     the index as the first turn got it, appended byte for byte to every turn
 *
 * Skills are not space memory: nothing from a space's .termag/skills/ is
 * loaded, as a plugin or otherwise (they live in a repo's .claude/skills/,
 * reviewed through PRs).
 *
 * Every later turn of that session passes the same bytes, however the memory
 * changes. A change reaches the session as a one-line notice at the start of
 * the turn's own message instead, once per change, wrapped in
 * <space-memory-notice> so the chat's history and live events never show it
 * as something the person typed (stripNotice). A session that began before
 * memory loaded (an older agent, the flag turned on later) keeps its prompt
 * as it is and gets a notice pointing at the index. A new session (a first
 * turn, or Clear, which drops the session id) starts over.
 *
 * Anything going wrong (no CLI on the box, the orchestrator unreachable)
 * leaves the turn with what the session already had: never a different
 * system prompt, never a failed turn.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile: execFileCb } = require('node:child_process');
const { promisify } = require('node:util');

const CAPABILITIES = ['space-memory-v1'];
const REFRESH = '60s';
const CLI_TIMEOUT_MS = 20_000;
const SPACE_RE = /^[a-z0-9-]{2,40}$/;
const NOTICE_OPEN = '<space-memory-notice>';
const NOTICE_CLOSE = '</space-memory-notice>';
const NOTICE_RE = /^<space-memory-notice>[\s\S]*?<\/space-memory-notice>\n*/;
/** Set on a chat turn's process so the Claude Code hooks (deploy/claude-settings.json) leave it to this module. */
const MANAGED_ENV = 'TERMAG_SPACE_MEMORY_MANAGED';

/** A turn's message with the notice ahead of it. */
function withNotice(notice, text) {
  return notice ? `${NOTICE_OPEN}\n${notice}\n${NOTICE_CLOSE}\n\n${text}` : text;
}

/** A user message's content without the notice withNotice put there: a string, or its first text block. */
function stripNotice(content) {
  if (typeof content === 'string') return NOTICE_RE.test(content) ? content.replace(NOTICE_RE, '') : content;
  if (!Array.isArray(content)) return content;
  const i = content.findIndex(p => p && p.type === 'text' && typeof p.text === 'string');
  if (i < 0 || !NOTICE_RE.test(content[i].text)) return content;
  const text = content[i].text.replace(NOTICE_RE, '');
  return text ? content.map((p, k) => (k === i ? { ...p, text } : p)) : content.filter((_, k) => k !== i);
}

/** A stream-json event without the notice, for what leaves the box. */
function stripNoticeEvent(ev) {
  if (!ev || ev.type !== 'user' || !ev.message) return ev;
  const content = stripNotice(ev.message.content);
  return content === ev.message.content ? ev : { ...ev, message: { ...ev.message, content } };
}

/** A command for a chat turn's tmux session: the turn and its Claude carry MANAGED_ENV. */
function managedCommand(argv) {
  return ['/usr/bin/env', `${MANAGED_ENV}=1`, ...argv];
}

function removeTree(dir, fsImpl) {
  if (!fsImpl.existsSync(dir)) return;
  const unlock = d => {
    try { fsImpl.chmodSync(d, 0o700); } catch { return; }
    for (const e of fsImpl.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(d, e.name));
  };
  unlock(dir);
  fsImpl.rmSync(dir, { recursive: true, force: true });
}

function createSpaceMemory({ home, execFile = promisify(execFileCb), fsImpl = fs, log = () => {}, env = process.env, bin = null }) {
  const root = path.join(home, '.termag/chats');
  const termag = bin || path.join(home, '.local/bin/termag');
  const dirOf = chatKey => path.join(root, `${chatKey}.space-memory`);
  const readJson = file => { try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; } };
  let missingLogged = false;

  async function ask(space, sessionFile) {
    if (!fsImpl.existsSync(termag)) {
      if (!missingLogged) log(`[MEMORY] no ${termag}; space memory is not loaded`);
      missingLogged = true;
      return null;
    }
    const argv = ['space', 'memory', 'context', ...(space ? [space] : []), '--session', sessionFile, '--refresh', REFRESH, '--json'];
    try {
      const { stdout } = await execFile(termag, argv, { timeout: CLI_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 });
      // The CLI's --json is one pretty-printed object.
      const text = String(stdout || '').trim();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      // An older CLI without `space memory` answers usage (exit 2): nothing loads, as on an older box.
      log(`[MEMORY] ${space || '(default space)'}: ${String(err.message || err).split('\n')[0].slice(0, 200)}`);
      return null;
    }
  }

  /**
   * What one turn gets: the session's frozen system-prompt addition (null
   * when it has none), and a notice for the message (null when nothing
   * changed). `sessionId` is the session the turn resumes (null for a
   * new one). `space` is the chat's own space, which the orchestrator fixed
   * when the chat started (backend services/chatSpace.ts); with none named
   * (an older backend) the box's default loads. `none`: the orchestrator says
   * the chat has no space its box can load (no space, or a grant removed):
   * nothing is asked of the CLI, which would load the default.
   *
   * A session keeps the space it started with (owner.json `space`): its system
   * prompt is that space's index, byte for byte, so later turns ask about that
   * space. A chat's space never changes now, so neither does what a turn
   * names; a new session (Clear) loads the same one.
   */
  async function forTurn({ chatKey, sessionId, space = null, none = false }) {
    const named = typeof space === 'string' && SPACE_RE.test(space) ? space : null;
    const dir = dirOf(chatKey);
    let owner = readJson(path.join(dir, 'owner.json'));
    // Another session's memory never carries over: a new session (Clear drops the id) or a different one starts over.
    if (!sessionId || (owner && owner.sessionId && owner.sessionId !== sessionId)) { removeTree(dir, fsImpl); owner = null; }
    const pinned = owner && typeof owner.space === 'string' && SPACE_RE.test(owner.space) ? owner.space : null;
    const fresh = !fsImpl.existsSync(dir);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = path.join(dir, 'prompt.md');
    // A session frozen by an agent from before skills left space memory kept them here: never passed on, so gone.
    removeTree(path.join(dir, 'plugin'), fsImpl);

    let notice = null;
    if (none) {
      // The system prompt stays what it was (the prompt cache); a session that had memory is told once that it no longer loads.
      const had = fsImpl.existsSync(promptFile);
      if (had && !(owner && owner.off)) {
        notice = `Space memory of ${pinned || 'this chat\'s space'} is no longer loaded for this chat (its box can't reach the space now); disregard what this session was given from it.`;
      }
      fsImpl.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({
        sessionId: sessionId || (owner && owner.sessionId) || null, space: pinned, ...(had ? { off: true } : {}),
      }), { mode: 0o600 });
      return { appendPrompt: had ? fsImpl.readFileSync(promptFile, 'utf8') : null, notice };
    }
    const r = await ask(pinned || named, path.join(dir, 'session.json'));
    if (r && r.kind === 'start' && typeof r.index === 'string') {
      if (fresh && !sessionId) {
        fsImpl.writeFileSync(promptFile, r.index, { mode: 0o600 });
      } else if (fsImpl.existsSync(promptFile)) {
        // The session's memory is another space's (the session moved): its prompt stays, this is the news.
        notice = `This session started with the memory of another space; it is in ${r.space} now. Read ${r.indexPath} for ${r.space}'s memory.`;
      } else {
        notice = `This session started before space memory loaded. The shared memory of ${r.space} is in ${r.indexPath}: read it before you go on.`;
      }
    } else if (r && r.kind === 'notice' && typeof r.notice === 'string') {
      notice = r.notice;
    }
    const kept = pinned || (r && typeof r.space === 'string' && SPACE_RE.test(r.space) ? r.space : null);
    // Loaded again after "no longer loaded": that notice is revoked, once the CLI answers for the space
    // (a failed call can't say it loads). It stands until then (Bugbot, #768).
    let off = !!(owner && owner.off);
    if (off && r && r.kind !== 'off') {
      const where = typeof r.indexPath === 'string' ? `; re-read ${r.indexPath} for what changed since` : '';
      const back = `Space memory of ${kept || 'this chat\'s space'} is loaded for this chat again: what this session was given from it at its start applies again${where}.`;
      notice = notice ? `${back}\n${notice}` : back;
      off = false;
    }
    fsImpl.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({
      sessionId: sessionId || (owner && owner.sessionId) || null, space: kept, ...(off ? { off: true } : {}),
    }), { mode: 0o600 });

    let appendPrompt = null;
    try { appendPrompt = fsImpl.readFileSync(promptFile, 'utf8'); } catch { /* this session has none */ }
    return { appendPrompt, notice };
  }

  /**
   * The index a chat's session froze at its first turn, for a pane that
   * resumes that session (Open in full UI): the same bytes its turns append.
   * Null when the session has none, or the frozen copy is another session's
   * (owner.json has no id until the session's second turn; until then it is
   * the only session the copy can be).
   */
  function frozenPromptFor(chatKey, sessionId) {
    const dir = dirOf(chatKey);
    const owner = readJson(path.join(dir, 'owner.json'));
    if (!owner || !sessionId || (owner.sessionId && owner.sessionId !== sessionId)) return null;
    try { return fsImpl.readFileSync(path.join(dir, 'prompt.md'), 'utf8') || null; } catch { return null; }
  }

  return { forTurn, dirOf, frozenPromptFor };
}

/**
 * A turn's argv with the session's frozen index appended to the system
 * prompt, after anything termag already appends (an ask's or an
 * orchestrator's prompt comes first). Inserted ahead of `--resume`, which
 * stays last.
 */
function withSpaceMemory(args, memory) {
  if (!memory || !memory.appendPrompt) return args;
  const out = [...args];
  const i = out.indexOf('--append-system-prompt');
  if (i >= 0 && i + 1 < out.length) {
    out[i + 1] = `${out[i + 1]}\n\n${memory.appendPrompt}`;
    return out;
  }
  const resume = out.indexOf('--resume');
  out.splice(resume >= 0 ? resume : out.length, 0, '--append-system-prompt', memory.appendPrompt);
  return out;
}

module.exports = {
  CAPABILITIES, MANAGED_ENV, NOTICE_OPEN, NOTICE_CLOSE,
  createSpaceMemory, managedCommand, stripNotice, stripNoticeEvent, withNotice, withSpaceMemory,
};
