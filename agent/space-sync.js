'use strict';
/**
 * The `space-sync` RPC (capability space-sync-v1): the box copies the spaces
 * it reaches to ~/termag/spaces/<space>/, read-only, with the box CLI's
 * `termag space sync [space] --json` (cli/src/spaceSync.ts), on the box's own
 * token. The termag desktop asks for it (POST /api/cli/v1/boxes/:id/spaces/sync)
 * before it opens a thread's space in its Files panel.
 *
 * The answer is the CLI's JSON as it printed it. A space that failed is in
 * there with its error (the CLI then exits 1); only a CLI that printed no JSON
 * at all (an older one, the orchestrator out of reach) is an error here.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile: execFileCb } = require('node:child_process');
const { promisify } = require('node:util');

const CAPABILITIES = ['space-sync-v1'];
// A first copy of a large space downloads every file; the orchestrator waits 180 s.
const CLI_TIMEOUT_MS = 170_000;
// A space name (the CLI's SPACE_NAME_RE) that can't be read as an option, since it goes on argv.
const SPACE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function firstLine(text) {
  return String(text || '').trim().split('\n')[0].slice(0, 300);
}

/** With --json the CLI writes a failure as `{ "error": { code, message } }`; its message, or null. */
function cliErrorMessage(text) {
  try {
    const message = JSON.parse(String(text)).error.message;
    return typeof message === 'string' ? message.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function createSpaceSync({ home, execFile = promisify(execFileCb), fsImpl = fs, env = process.env, bin = null }) {
  const termag = bin || path.join(home, '.local/bin/termag');

  async function sync({ space } = {}) {
    if (space !== undefined && space !== null && !(typeof space === 'string' && SPACE_RE.test(space))) {
      throw new Error('space must be a space name');
    }
    if (!fsImpl.existsSync(termag)) throw new Error(`no ${termag} on this box`);
    const argv = ['space', 'sync', ...(space ? [space] : []), '--json'];
    let stdout;
    try {
      ({ stdout } = await execFile(termag, argv, { timeout: CLI_TIMEOUT_MS, env, maxBuffer: 8 * 1024 * 1024 }));
    } catch (err) {
      // Exit 1 with a JSON answer: some space failed, and the answer says which.
      stdout = err && err.stdout;
      if (!String(stdout || '').trim()) {
        const reason = cliErrorMessage(err && err.stderr) || firstLine(err && err.stderr) || firstLine(err && err.message);
        // An older CLI without `space sync` answers usage (exit 2).
        throw new Error(err && err.code === 2 ? `the termag CLI on this box can't copy spaces yet (${reason})` : reason);
      }
    }
    let answer;
    try {
      answer = JSON.parse(String(stdout));
    } catch {
      throw new Error('termag space sync printed something other than JSON');
    }
    const failure = answer && !Array.isArray(answer.spaces) ? cliErrorMessage(stdout) : null;
    if (failure) throw new Error(failure);
    return answer;
  }

  return { sync };
}

module.exports = { CAPABILITIES, createSpaceSync };
