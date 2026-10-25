'use strict';

// Claude Code's own name for a session, read from its transcript: the title
// a `/rename` set (a `custom-title` line), else the one Claude generated from
// the conversation's opening (`ai-title`). Claude writes the line again during
// every turn, headless `claude -p` included, so the part of the transcript one
// turn wrote holds it, and that part is all the chat runner reads at turn end.
// Neither line is in the stream-json output.

const { linesForward } = require('./transcript-lines');

// A title line is a few hundred bytes; anything longer is a message or a tool result.
const TITLE_LINE_MAX_BYTES = 4096;
// The backend cuts it to a sidebar's length; this only bounds the frame.
const TITLE_MAX_CHARS = 500;

/** The session's title in `file` from byte offset `start` on, or null when that part holds none. */
function sessionTitle(file, { start = 0, fsImpl } = {}) {
  let custom = null;
  let generated = null;
  for (const buf of linesForward(file, { start, fsImpl })) {
    if (buf.length > TITLE_LINE_MAX_BYTES) continue;
    const line = buf.toString('utf8');
    if (!line.includes('-title"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) custom = e.customTitle.trim();
    else if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) generated = e.aiTitle.trim();
  }
  const title = custom || generated;
  return title ? title.slice(0, TITLE_MAX_CHARS) : null;
}

module.exports = { sessionTitle, TITLE_LINE_MAX_BYTES };
