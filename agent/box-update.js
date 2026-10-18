'use strict';
// Box self-update, the agent's side. The update itself is
// deploy/termag-box-update, run by termag-box-update.service on a timer; this
// module tells the orchestrator which commit this agent runs, and starts that
// unit when the orchestrator asks (the `box-update` RPC), so a box whose agent
// is behind can be brought forward without waiting for the timer.
//
// Kept apart from agent.js so it can be tested with a fake execFile: the agent
// has no hot reload and runs on many boxes at once, so what goes into it
// should be small and proven.

const fs = require('fs');

const CAPABILITIES = ['box-update-v1'];
const BOX_UPDATE_UNIT = 'termag-box-update.service';

/**
 * The commit of the checkout this agent runs from, read once at startup: a
 * process keeps running the code it loaded, so the value belongs to the
 * process, not to the hello that carries it (a checkout pulled since still
 * runs the old code until the agent restarts, and that is exactly what the
 * orchestrator needs to see). `git rev-parse HEAD` on the checkout agent/ is
 * part of, and only when that checkout's top level is the directory itself:
 * git walks up to find a repository, and an agent copied into some other
 * repository must not report that repository's commit as its own. Null,
 * never a throw, when there is no git or no checkout.
 */
async function readCheckoutCommit(execFile, checkoutDir, realpath = fs.realpathSync) {
  try {
    const { stdout } = await execFile('git', ['-C', checkoutDir, 'rev-parse', '--show-toplevel', 'HEAD'], { timeout: 5000 });
    const [top, sha] = String(stdout).trim().split('\n').map((line) => line.trim());
    let expected;
    try { expected = realpath(checkoutDir); } catch { expected = checkoutDir; }
    if (!top || top !== expected) return null;
    return /^[0-9a-f]{40}$/.test(sha || '') ? sha : null;
  } catch {
    return null;
  }
}

/**
 * When the checkout's HEAD was committed (ISO 8601, the committer date), so
 * the admin Fleet table can sort boxes by how old their agent is without a
 * commit-to-date lookup it has no credential for. Null, never a throw, when
 * git cannot say.
 */
async function readCheckoutCommitDate(execFile, checkoutDir) {
  try {
    const { stdout } = await execFile('git', ['-C', checkoutDir, 'show', '-s', '--format=%cI', 'HEAD'], { timeout: 5000 });
    const iso = String(stdout).trim();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.test(iso) ? iso : null;
  } catch {
    return null;
  }
}

/**
 * Whether this user's systemd knows the update unit, i.e. termag-reconcile
 * has installed it from a checkout that has it. The capability is announced
 * only then: an orchestrator asking a box without the unit would get "not
 * found" back every time, and silence is the right answer from a box that
 * cannot update this way yet. Read once at startup like the commit; the
 * agent is restarted by the update that brings the unit, so the next process
 * sees it.
 */
async function boxUpdateUnitLoaded(execFile) {
  try {
    const { stdout } = await execFile('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', BOX_UPDATE_UNIT], { timeout: 5000 });
    return String(stdout).trim() === 'loaded';
  } catch {
    return false;
  }
}

/**
 * Start the update unit and return at once. The update restarts this very
 * agent, so it must not run in this process: the unit is its own cgroup.
 * `--no-block` because it is a oneshot that pulls and reconciles, longer than
 * an RPC should wait; systemd merges a start into a run already in flight and
 * the script holds a lock as well, so a repeated RPC is a no-op. A box whose
 * checkout predates the unit fails with an error that says so, which the
 * orchestrator logs rather than retries.
 */
async function startBoxUpdate(execFile) {
  try {
    await execFile('systemctl', ['--user', 'start', '--no-block', BOX_UPDATE_UNIT], { timeout: 10_000 });
  } catch (err) {
    const text = String((err && (err.stderr || err.message)) || '').trim();
    const detail = text.split('\n').filter(Boolean).pop() || 'systemctl failed';
    if (/not found|could not be found|no such/i.test(detail)) {
      throw new Error(`${BOX_UPDATE_UNIT} is not installed on this box; run termag-reconcile from a checkout that has it`);
    }
    throw new Error(`could not start ${BOX_UPDATE_UNIT}: ${detail}`);
  }
  return { ok: true, started: true, unit: BOX_UPDATE_UNIT };
}

module.exports = { CAPABILITIES, BOX_UPDATE_UNIT, readCheckoutCommit, readCheckoutCommitDate, boxUpdateUnitLoaded, startBoxUpdate };
