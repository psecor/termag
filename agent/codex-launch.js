'use strict';
// The line the agent types into a Codex agent pane once its bridge's app
// server is up (agent.js startCodexSession): the TUI as a --remote client of
// that server. Kept apart from agent.js so it can be tested: the agent has no
// hot reload.
//
// A tool update stops a pane's Codex for a new
// binary, and the orchestrator relaunches the pane with the conversation the
// box saw in it (`resumeSessionId` on codex-session-start): then the line is
// `codex resume <id>`, the same client with the same flags. The id is a
// thread id Codex minted (a UUID); anything else is ignored and the pane
// starts fresh, as it did before resumes existed.
//
// With it the orchestrator may send a `notice`: one line saying the tool was
// updated and why (backend/src/services/toolUpdate/notice.ts), printed before
// the client starts. It is typed into the pane's shell, so only a line of
// NOTICE_SAFE's characters (no quote, $, `, \ or control character) is
// typed, in single quotes; any other is dropped.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The same set as the orchestrator's NOTICE_SAFE (notice.ts).
const NOTICE_SAFE = /^[A-Za-z0-9 .,;:()\[\]_+-]{1,200}$/;

const isCodexSessionId = (v) => typeof v === 'string' && SESSION_ID.test(v);

function shellEscape(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

/** The line that prints a tool update's notice, or '' for none or one that is not safe to type. */
function noticeCommand(notice) {
  return typeof notice === 'string' && NOTICE_SAFE.test(notice) ? `printf '%s\\n' '${notice}'; ` : '';
}

/** The pane's launch line; `resumeSessionId` only when it is a Codex thread id, `notice` only when NOTICE_SAFE. */
function codexPaneCommand({ remoteUrl, cwd, resumeSessionId, notice }) {
  const resume = isCodexSessionId(resumeSessionId) ? `resume ${resumeSessionId} ` : '';
  return `${noticeCommand(notice)}codex ${resume}--remote ${remoteUrl} --no-alt-screen -C ${shellEscape(cwd)} -a on-request`;
}

module.exports = { codexPaneCommand, isCodexSessionId, noticeCommand };
