'use strict';
// Agent-to-agent asks, the agent's side. The
// orchestrator sends `ask-run` with the message id, the target checkout and
// the prompt; this module writes the job to a 0600 file and starts
// ~/.local/bin/termag-subagent-run (deploy/termag-subagent-run) detached,
// which clones the committed code, runs Claude Code headless as the box user
// in that clone and posts the reply and the commits back to the orchestrator.
// The RPC answers as soon as the runner is started; nothing here waits for
// the run. An ask-run that names a `chat` (an orchestrator that saw
// ask-chat-v1) runs as a turn of the thread's chat instead (agent/ask-chat.js);
// this headless path is what an older orchestrator still gets.
//
// `ask-run-status` tells the orchestrator whether a run is still going, so a
// thread whose previous turn died can take a new one. `ask-run-cancel` sends
// the runner a TERM, on which it stops the run's process group and reports
// nothing.
//
// Kept apart from agent.js so it can be tested with fakes.

const fs = require('fs');
const path = require('path');

const CAPABILITIES = ['ask-v1', 'ask-cancel-v1'];
const RUNNER = 'termag-subagent-run';

const ID = /^[a-z0-9]{8,40}$/;
const SHA = /^[0-9a-f]{40}$/;
const SESSION = /^[A-Za-z0-9-]{1,64}$/;

function runnerPath(home) {
  return path.join(home, '.local', 'bin', RUNNER);
}

function stateDir(home) {
  return path.join(home, '.termag', 'subagent');
}

/** The capability is announced only where termag-reconcile installed the runner. */
function askRunnerInstalled(home, fsImpl = fs) {
  try {
    fsImpl.accessSync(runnerPath(home), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The job file's content, or a thrown Error naming the bad field. */
function buildJob(msg, cwd) {
  const str = (v) => (typeof v === 'string' ? v : '');
  if (!ID.test(str(msg.runId))) throw new Error('runId is not a message id');
  if (!ID.test(str(msg.threadId))) throw new Error('threadId is not a thread id');
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  if (!str(msg.prompt).trim()) throw new Error('prompt required');
  if (msg.baseSha != null && !SHA.test(str(msg.baseSha))) throw new Error('baseSha is not a commit');
  if (msg.resumeSessionId != null && !SESSION.test(str(msg.resumeSessionId))) throw new Error('resumeSessionId is malformed');
  if (!str(msg.gitEmail).includes('@')) throw new Error('gitEmail required');
  return {
    runId: msg.runId,
    threadId: msg.threadId,
    cwd,
    prompt: msg.prompt,
    resumeSessionId: msg.resumeSessionId || null,
    baseSha: msg.baseSha || null,
    systemPrompt: str(msg.systemPrompt),
    gitName: str(msg.gitName).replace(/[\r\n<>]/g, ' ').trim() || msg.gitEmail,
    gitEmail: msg.gitEmail.replace(/[\r\n<>\s]/g, ''),
  };
}

/**
 * Write the job and start the runner, detached into its own process group so
 * an agent restart (KillMode=process) leaves it running. Returns the pid.
 */
function startAskRun(msg, cwd, deps) {
  const { home, spawn, fsImpl = fs } = deps;
  const job = buildJob(msg, cwd);
  if (!fsImpl.existsSync(cwd)) throw new Error(`the project checkout ${cwd} does not exist on this box`);
  const dir = stateDir(home);
  const jobs = path.join(dir, 'jobs');
  const logs = path.join(dir, 'logs');
  fsImpl.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  fsImpl.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const jobFile = path.join(jobs, `${job.runId}.json`);
  fsImpl.writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
  const logFd = fsImpl.openSync(path.join(logs, `${job.runId}.log`), 'a', 0o600);
  let child;
  try {
    child = spawn(runnerPath(home), [jobFile], { detached: true, stdio: ['ignore', logFd, logFd], cwd: home });
  } finally {
    fsImpl.closeSync(logFd);
  }
  if (!child || !child.pid) throw new Error(`${RUNNER} did not start`);
  child.unref();
  fsImpl.writeFileSync(path.join(jobs, `${job.runId}.pid`), String(child.pid), { mode: 0o600 });
  return { ok: true, started: true, pid: child.pid };
}

/**
 * Whether the run's runner process is alive. The pid file outlives the run,
 * so a live pid also has to be the runner started on this run's job file: a
 * reused pid can be another process, or a later ask's runner.
 */
function askRunStatus(msg, deps) {
  const { home, fsImpl = fs, kill = process.kill.bind(process) } = deps;
  const runId = typeof msg.runId === 'string' ? msg.runId : '';
  if (!ID.test(runId)) throw new Error('runId is not a message id');
  const jobs = path.join(stateDir(home), 'jobs');
  let pid;
  try {
    pid = Number(fsImpl.readFileSync(path.join(jobs, `${runId}.pid`), 'utf8').trim());
  } catch {
    return { running: false, known: false };
  }
  if (!Number.isInteger(pid) || pid <= 1) return { running: false, known: true };
  try {
    kill(pid, 0);
  } catch {
    return { running: false, known: true };
  }
  try {
    const args = fsImpl.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const isThisRun = args.some(a => path.basename(a) === RUNNER) && args.includes(path.join(jobs, `${runId}.json`));
    if (!isThisRun) return { running: false, known: true };
  } catch {
    // No /proc (macOS): trust the signal check.
  }
  return { running: true, known: true, pid };
}

/** TERM to a live runner; a run that is already gone is not an error. */
function cancelAskRun(msg, deps) {
  const { kill = process.kill.bind(process) } = deps;
  const st = askRunStatus(msg, deps);
  if (!st.running) return { stopped: false, running: false };
  try {
    kill(st.pid, 'SIGTERM');
  } catch {
    return { stopped: false, running: false };
  }
  return { stopped: true, pid: st.pid };
}

module.exports = { CAPABILITIES, RUNNER, runnerPath, stateDir, askRunnerInstalled, buildJob, startAskRun, askRunStatus, cancelAskRun };
