'use strict';
// An agent-to-agent ask as a chat on its target project (ask-chat-v1).
// The orchestrator gives each
// thread a workstream of its own (`ask-<thread>`, provider claude-chat), and
// every ask on the thread is one turn of that chat in the chat runner
// (chat-runner.js), so the owner sees it in the simple UI and can answer in
// it. The clone and the report stay deploy/termag-subagent-run's, called as
// phases:
//
//   ask-run   job file -> `--prepare` (the thread's clone of the committed
//             code) -> chat-send in that clone, bypassPermissions, the
//             orchestrator's system prompt, the asker's git identity
//   turn end  the turn's stream-json `result` event -> `--report` (bundle,
//             then the reply, to /api/cli/v1/ask/runs/<id>/...)
//   dropped   a queued ask the chat never ran -> `--fail`
//
// A person's message in that chat (chat-send with `ask`) is prepared the
// same way and runs as a turn with no run: nothing is reported for it, and
// what it commits goes up with the thread's next ask.
//
// A job file is the run's until it is reported: `stage` is `preparing`,
// `sent` (queued or running in the chat) or `reporting` (the reporter's pid
// beside it), and a canceled run's file is removed, which is what keeps it
// from being reported.

const fs = require('fs');
const path = require('path');
const askRun = require('./ask-run');
const { sessionIdFrom } = require('./chat-turn');

const CAPABILITIES = ['ask-chat-v1'];
const PHASES_MARKER = 'Phases: ask-chat-v1';
const TRUSTED_MODE = 'bypassPermissions';
// The script waits up to five minutes for a checkout to land, then clones.
const PREPARE_TIMEOUT_MS = 15 * 60 * 1000;
const STOPPED = 'The ask\'s turn on the target box stopped before Claude answered.';

function jobsDir(home) { return path.join(askRun.stateDir(home), 'jobs'); }

/** Only a runner that has the phases: an older install keeps the headless run. */
function askChatCapable(home, fsImpl = fs) {
  if (!askRun.askRunnerInstalled(home, fsImpl)) return false;
  try { return fsImpl.readFileSync(askRun.runnerPath(home), 'utf8').includes(PHASES_MARKER); } catch { return false; }
}

/** The chat an ask-run names, or a thrown Error. */
function chatOf(msg) {
  const c = msg && msg.chat;
  if (!c || typeof c !== 'object') throw new Error('chat required');
  if (typeof c.chatKey !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(c.chatKey) || c.chatKey.includes('..')) throw new Error('chat.chatKey is malformed');
  return {
    chatKey: c.chatKey,
    projectId: String(c.projectId || ''),
    workstream: String(c.workstream || ''),
    workstreamId: c.workstreamId != null ? String(c.workstreamId) : null,
  };
}

/**
 * The reply of a finished turn, as the result event termag-subagent-run
 * reports: Claude's own last `result`, else an error naming why there is
 * none (stopped, or the runner's last error), keeping the session so the
 * thread's next ask resumes it.
 */
function turnResult(log) {
  let result = null;
  let runnerError = null;
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev && ev.type === 'result') result = ev;
    else if (ev && ev.type === 'runner-error' && typeof ev.message === 'string') runnerError = ev.message;
  }
  if (result) return result;
  return {
    type: 'result',
    subtype: 'error_turn_stopped',
    is_error: true,
    result: runnerError ? `${STOPPED} ${runnerError}` : STOPPED,
    session_id: sessionIdFrom(log) || undefined,
    num_turns: null,
  };
}

/** The reason the script logged for a failed phase (`failed: <reason>`), else the error. */
function failureReason(err) {
  const lines = String((err && err.stderr) || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /failed: (.+)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return (err && err.message) || 'the thread could not be prepared';
}

function createAskChat({ home, chats, spawn, fsImpl = fs, log = () => {} }) {
  const jobs = jobsDir(home);
  const logs = path.join(path.dirname(jobs), 'logs');
  const jobFile = runId => path.join(jobs, `${runId}.json`);
  const readJob = file => { try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; } };
  const writeJob = (file, job) => {
    const tmp = `${file}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
  };
  const setStage = (file, stage) => {
    const job = readJob(file);
    if (!job) return false;
    writeJob(file, { ...job, stage });
    return true;
  };
  const ensureDirs = () => {
    fsImpl.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    fsImpl.mkdirSync(logs, { recursive: true, mode: 0o700 });
  };

  /** A phase that reports to the orchestrator itself, detached so an agent restart leaves it running. */
  function spawnPhase(args, logName) {
    ensureDirs();
    const fd = fsImpl.openSync(path.join(logs, `${logName}.log`), 'a', 0o600);
    let child;
    try {
      child = spawn(askRun.runnerPath(home), args, { detached: true, stdio: ['ignore', fd, fd], cwd: home });
    } finally {
      fsImpl.closeSync(fd);
    }
    if (!child || !child.pid) throw new Error(`${askRun.RUNNER} did not start`);
    child.unref();
    return child.pid;
  }

  function fail(runId, reason) {
    const file = jobFile(runId);
    if (!fsImpl.existsSync(file)) return;
    log(`[ASK] run ${runId}: ${reason}`);
    try { spawnPhase(['--fail', file, reason], runId); } catch (err) { log(`[ASK] run ${runId}: could not report the failure: ${err.message}`); }
  }

  // A run's --prepare, by run id, so a cancel can stop it (and the git under it).
  const preparing = new Map();

  async function prepare(file, runId = null) {
    const stdout = await new Promise((resolve, reject) => {
      // Its own process group (execFile drops `detached`): git inherits the
      // thread lock's fd, so stopping only the script would leave the clone
      // holding the lock.
      const child = spawn(askRun.runnerPath(home), ['--prepare', file], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: home });
      if (runId) preparing.set(runId, child);
      let out = '';
      let err = '';
      const keep = (s, chunk) => (s.length < 1024 * 1024 ? s + chunk : s);
      child.stdout.on('data', c => { out = keep(out, String(c)); });
      child.stderr.on('data', c => { err = keep(err, String(c)); });
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }, PREPARE_TIMEOUT_MS);
      const done = (e) => {
        clearTimeout(timer);
        if (runId) preparing.delete(runId);
        if (e) { e.stderr = err; reject(e); } else resolve(out);
      };
      child.on('error', done);
      child.on('close', (code, signal) => done(code === 0 ? null : new Error(`--prepare exited ${signal || code}`)));
    });
    const last = String(stdout || '').trim().split('\n').pop();
    const prep = JSON.parse(last);
    if (!prep || typeof prep.repoDir !== 'string' || !path.isAbsolute(prep.repoDir)) throw new Error('the runner named no clone');
    return prep;
  }

  const systemPromptFile = repoDir => path.join(path.dirname(repoDir), 'system-prompt.txt');

  /**
   * Where the turn writes PR descriptions (termag-subagent-run's pr_body_file
   * and pr_dir), as --prepare names them; a runner that names none keeps them
   * in the same place, the clone's .git.
   */
  function prPaths(prep) {
    const git = path.join(prep.repoDir, '.git');
    const inGit = p => typeof p === 'string' && path.dirname(p) === git;
    return {
      prBodyFile: inGit(prep.prBodyFile) ? prep.prBodyFile : path.join(git, 'termag-pr-body.md'),
      prDir: inGit(prep.prDir) ? prep.prDir : path.join(git, 'termag-prs'),
    };
  }

  /** A new clone is a new session; a thread first run headless goes on with that run's session. */
  function pointSession(chatKey, prep, resumeSessionId) {
    if (prep.fresh) { chats.setSession(chatKey, { sessionId: null, cwd: prep.repoDir }); return; }
    const state = chats.readSession(chatKey);
    if (!state.sessionId && resumeSessionId) chats.setSession(chatKey, { sessionId: resumeSessionId, cwd: prep.repoDir });
  }

  // chat-recover comes on every reconnect, so a run may still be on its way when reconcile sees it.
  const inFlight = new Set();
  async function runPrepared(runId) {
    if (inFlight.has(runId)) return;
    inFlight.add(runId);
    try { await prepareAndSend(runId); } finally { inFlight.delete(runId); }
  }

  async function prepareAndSend(runId) {
    const file = jobFile(runId);
    let prep;
    try {
      prep = await prepare(file, runId);
    } catch (err) {
      // The script has reported the failure to the asker already, or it was canceled.
      log(`[ASK] run ${runId}: prepare failed: ${failureReason(err)}`);
      fsImpl.rmSync(file, { force: true });
      return;
    }
    const job = readJob(file);
    if (!job) { log(`[ASK] run ${runId}: canceled while its clone was prepared`); return; }
    try {
      pointSession(job.chat.chatKey, prep, job.resumeSessionId);
      fsImpl.writeFileSync(systemPromptFile(prep.repoDir), job.systemPrompt || '', { mode: 0o600 });
      setStage(file, 'sent');
      const sent = await chats.sendMessage({
        chatKey: job.chat.chatKey, cwd: prep.repoDir, text: job.prompt,
        projectId: job.chat.projectId, workstream: job.chat.workstream, workstreamId: job.chat.workstreamId,
        permissionMode: TRUSTED_MODE,
        ask: { threadId: job.threadId, runId, systemPrompt: job.systemPrompt, gitName: job.gitName, gitEmail: job.gitEmail, ...prPaths(prep) },
      });
      log(`[ASK] run ${runId} on thread ${job.threadId}: ${sent.queued ? 'queued in' : 'started in'} chat ${job.chat.chatKey}`);
    } catch (err) {
      fail(runId, `the chat runner did not take the turn: ${err.message}`);
    }
  }

  return {
    capable: () => askChatCapable(home, fsImpl),

    /** ask-run with a chat: write the job and answer; the clone and the turn follow. */
    startRun(msg, cwd) {
      const job = { ...askRun.buildJob(msg, cwd), mode: 'chat', chat: chatOf(msg), stage: 'preparing' };
      if (!fsImpl.existsSync(cwd)) throw new Error(`the project checkout ${cwd} does not exist on this box`);
      ensureDirs();
      writeJob(jobFile(job.runId), job);
      runPrepared(job.runId).catch(err => log(`[ASK] run ${job.runId}: ${err.message}`));
      return { ok: true, started: true, chat: job.chat.chatKey };
    },

    /**
     * A person's message in an ask's chat: the thread's clone (made again if
     * it was swept), then a turn with no run.
     */
    async sendMessage(msg, cwd) {
      const chat = { chatKey: msg.chatKey, projectId: msg.projectId, workstream: msg.workstream, workstreamId: msg.workstreamId };
      const a = msg.ask || {};
      const job = askRun.buildJob({
        runId: 'person0000', threadId: a.threadId, prompt: msg.text, baseSha: a.baseSha || null,
        gitName: a.gitName, gitEmail: a.gitEmail,
      }, cwd);
      ensureDirs();
      const file = path.join(jobs, `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
      writeJob(file, { runId: '', threadId: job.threadId, cwd, baseSha: job.baseSha, waitForCheckout: false });
      let prep;
      try {
        prep = await prepare(file);
      } catch (err) {
        throw new Error(`the ask's clone could not be prepared: ${failureReason(err)}`);
      } finally {
        fsImpl.rmSync(file, { force: true });
      }
      pointSession(chat.chatKey, prep, null);
      let systemPrompt = '';
      try { systemPrompt = fsImpl.readFileSync(systemPromptFile(prep.repoDir), 'utf8'); } catch { /* a thread cloned again: none */ }
      return chats.sendMessage({
        ...chat, cwd: prep.repoDir, text: msg.text, permissionMode: TRUSTED_MODE, model: msg.model, images: msg.images,
        ask: { threadId: job.threadId, systemPrompt, gitName: job.gitName, gitEmail: job.gitEmail, ...prPaths(prep) },
      });
    },

    /** chat-runner onTurnDone: an ask's turn is over, so report it. */
    async onTurnDone(meta, dir) {
      const runId = meta.ask && meta.ask.runId;
      if (!runId) return;
      const file = jobFile(runId);
      const job = readJob(file);
      if (!job || job.stage === 'reporting') return;
      let text = '';
      try { text = fsImpl.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch { /* never started */ }
      const resultFile = path.join(jobs, `${runId}.result.json`);
      fsImpl.writeFileSync(resultFile, JSON.stringify(turnResult(text)), { mode: 0o600 });
      setStage(file, 'reporting');
      const pid = spawnPhase(['--report', file, resultFile], runId);
      fsImpl.writeFileSync(path.join(jobs, `${runId}.pid`), String(pid), { mode: 0o600 });
      log(`[ASK] run ${runId}: turn ${meta.turnId} over, reporting (pid ${pid})`);
    },

    /** chat-runner onDropped: asks a cleared chat never ran still get an answer. */
    onDropped(dropped) {
      for (const j of dropped) fail(j.ask.runId, 'the ask\'s chat on the target box was stopped before this ask ran');
    },

    /** ask-run-status: a chat run is live from its job file until it is reported. */
    status(msg) {
      const runId = typeof msg.runId === 'string' ? msg.runId : '';
      const job = /^[a-z0-9]{8,40}$/.test(runId) ? readJob(jobFile(runId)) : null;
      if (job && job.mode === 'chat' && job.stage !== 'reporting') return { running: true, known: true, stage: job.stage };
      return askRun.askRunStatus(msg, { home, fsImpl });
    },

    /** ask-run-cancel: drop the job (so nothing reports), then take the run out of its chat. */
    async cancel(msg) {
      const runId = typeof msg.runId === 'string' ? msg.runId : '';
      const job = /^[a-z0-9]{8,40}$/.test(runId) ? readJob(jobFile(runId)) : null;
      if (!job || job.mode !== 'chat' || job.stage === 'reporting') return askRun.cancelAskRun(msg, { home, fsImpl });
      fsImpl.rmSync(jobFile(runId), { force: true });
      const child = preparing.get(runId);
      if (child && child.pid) {
        // The script's TERM trap exits without reporting: the orchestrator has marked the run canceled.
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
        return { stopped: true, stage: 'preparing', pid: child.pid };
      }
      const stopped = await chats.cancelAsk(runId);
      return { stopped: true, stage: job.stage, ...stopped };
    },

    /**
     * After chat-recover: runs a previous agent left preparing are prepared
     * again, queued ones go on (the orchestrator wants them: it asked), and a
     * sent run the chat no longer has is reported lost.
     */
    async reconcile() {
      let names = [];
      try { names = fsImpl.readdirSync(jobs); } catch { return; }
      for (const name of names) {
        const m = /^([a-z0-9]{8,40})\.json$/.exec(name);
        if (!m) continue;
        const job = readJob(path.join(jobs, name));
        if (!job || job.mode !== 'chat' || inFlight.has(m[1])) continue;
        if (job.stage === 'preparing') {
          runPrepared(m[1]).catch(err => log(`[ASK] run ${m[1]}: ${err.message}`));
        } else if (job.stage === 'sent') {
          const where = chats.findAsk(m[1]);
          if (!where) fail(m[1], 'the ask\'s turn was lost when the box agent restarted');
          else if (where.state === 'queued') await chats.resumeQueue(where.chatKey);
        }
      }
    },
  };
}

module.exports = { CAPABILITIES, PHASES_MARKER, askChatCapable, chatOf, createAskChat, failureReason, turnResult };
