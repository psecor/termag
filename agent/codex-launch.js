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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isCodexSessionId = (v) => typeof v === 'string' && SESSION_ID.test(v);

function shellEscape(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

/** The pane's launch line; `resumeSessionId` only when it is a Codex thread id. */
function codexPaneCommand({ remoteUrl, cwd, resumeSessionId }) {
  const resume = isCodexSessionId(resumeSessionId) ? `resume ${resumeSessionId} ` : '';
  return `codex ${resume}--remote ${remoteUrl} --no-alt-screen -C ${shellEscape(cwd)} -a on-request`;
}

module.exports = { codexPaneCommand, isCodexSessionId };
