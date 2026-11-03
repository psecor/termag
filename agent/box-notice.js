'use strict';
/**
 * What happened to a chat's box between two of its turns, told to Claude in
 * the next turn's message, never in its system prompt:
 * a resumed session's appended system prompt must stay byte-identical across
 * turns, for the prompt cache (the same rule space-memory.js follows).
 *
 *   - The box restarted (stopped or hibernated, then started) since the
 *     session's last turn: its background processes and /tmp are gone. The
 *     runner records the boot at every turn start (bootIdentity) and adds
 *     RESTART_NOTICE once, to the first turn after a different boot.
 *   - The chat continues on a new box: the orchestrator sends that notice,
 *     with the old box's last git state, on the first turn there.
 *
 * Either goes ahead of the person's text inside <termag-box-notice>, so the
 * chat's history, live events and session titles never show it as something
 * the person typed (stripNotice).
 *
 * Only a notice the runner put there may be stripped. A message never opens
 * with the tag otherwise: text that does (a sender writing their own block) is
 * defused as it comes in (defuseSent: a zero-width space ahead of it), so it
 * stays in the view as typed and no strip, here or on the orchestrator
 * (chatTranscriptView.ts), can hide it.
 */

const fs = require('fs');
const os = require('os');

const CAPABILITIES = ['chat-box-notice-v1', 'chat-restore-v1'];

const RESTART_NOTICE = 'The box restarted since your last turn. Background processes you started (dev servers, watchers, background shells, tmux panes) aren\'t running, and /tmp was cleared. Restart what you need.';

const NOTICE_OPEN = '<termag-box-notice>';
const NOTICE_CLOSE = '</termag-box-notice>';
const NOTICE_RE = /^<termag-box-notice>[\s\S]*?<\/termag-box-notice>\n*/;
/** The longest notice a send may carry: the template and a few lines of git state. */
const MAX_NOTICE = 4096;

/** Linux's id for this boot; another boot has another. */
const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
/** Without a boot id, two boot times this far apart are two boots (uptime and the clock drift a little). */
const BOOT_AT_SLACK_MS = 2 * 60_000;

/**
 * This boot: its id where the kernel has one, else when it began (macOS).
 * `file` is TERMAG_BOOT_ID_FILE when set: the e2e stand-in boxes share their
 * host's kernel, so each start of one writes its own.
 */
function bootIdentity({ file = BOOT_ID_FILE, fsImpl = fs, uptime = os.uptime, now = Date.now } = {}) {
  try {
    const id = fsImpl.readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9-]{8,64}$/.test(id)) return { id };
  } catch { /* no boot id here */ }
  const up = Number(uptime());
  return Number.isFinite(up) && up > 0 ? { at: now() - Math.round(up * 1000) } : null;
}

/** A stored boot as bootIdentity returns it, or null for anything else. */
function parseBoot(b) {
  if (!b || typeof b !== 'object') return null;
  if (typeof b.id === 'string' && b.id) return { id: b.id };
  if (Number.isFinite(b.at)) return { at: b.at };
  return null;
}

/** Whether `cur` is a later boot than `prev`. Unknown either way is not a restart. */
function restartedSince(prev, cur) {
  const a = parseBoot(prev), b = parseBoot(cur);
  if (!a || !b) return false;
  if (a.id && b.id) return a.id !== b.id;
  if (a.at != null && b.at != null) return Math.abs(b.at - a.at) > BOOT_AT_SLACK_MS;
  return false;
}

function sameBoot(a, b) {
  const x = parseBoot(a), y = parseBoot(b);
  return Boolean(x && y) && x.id === y.id && (x.id != null || x.at === y.at);
}

/** A notice the orchestrator sent, or null when it is not one. */
function sentNotice(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return t && t.length <= MAX_NOTICE && !t.includes(NOTICE_CLOSE) ? t : null;
}

/** Ahead of sender text that opens with the tag, so it is never read as a notice the runner inserted. */
const DEFUSE = '\u200b';

/** Sender text as it may enter a turn: unchanged, unless it opens with the tag. */
function defuseSent(text) {
  return typeof text === 'string' && text.startsWith(NOTICE_OPEN) ? `${DEFUSE}${text}` : text;
}

/** A turn's message with the notices ahead of it, one paragraph each. */
function withNotice(notices, text) {
  const list = (Array.isArray(notices) ? notices : [notices]).filter(n => typeof n === 'string' && n);
  return list.length ? `${NOTICE_OPEN}\n${list.join('\n\n')}\n${NOTICE_CLOSE}\n\n${text}` : text;
}

/** A user message's content without the notice withNotice put there: a string, or its first text block. */
function stripNotice(content) {
  if (typeof content === 'string') return content.replace(NOTICE_RE, '');
  if (!Array.isArray(content)) return content;
  const i = content.findIndex(p => p && p.type === 'text' && typeof p.text === 'string');
  if (i < 0 || !NOTICE_RE.test(content[i].text)) return content;
  const text = content[i].text.replace(NOTICE_RE, '');
  // A message of images alone keeps no empty text block.
  if (!text && content.length > 1) return content.filter((_, j) => j !== i);
  return content.map((p, j) => (j === i ? { ...p, text } : p));
}

/** A stream-json event without the notice, for what leaves the box. */
function stripNoticeEvent(ev) {
  if (!ev || ev.type !== 'user' || !ev.message) return ev;
  const content = stripNotice(ev.message.content);
  return content === ev.message.content ? ev : { ...ev, message: { ...ev.message, content } };
}

module.exports = {
  CAPABILITIES, RESTART_NOTICE, MAX_NOTICE, BOOT_ID_FILE,
  bootIdentity, parseBoot, restartedSince, sameBoot, sentNotice, defuseSent, withNotice, stripNotice, stripNoticeEvent,
};
