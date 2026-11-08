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
//             or the branches the clone pushed (ask-push-v1), then the
//             reply, to /api/cli/v1/ask/runs/<id>/...)
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
//
// Steering (ask-steer-v1):
// an ask-run with `live` runs as a live turn, and one with `steerOf` goes into
// the live turn that ask runs in, as another user message (chat-runner.js
// steerAsk). The turn's chain of asks is its asks.json; when it ends, the
// report goes to the last one that reached Claude, with Claude's last result
// after that message. The ask it joined becomes a tombstone (`superseded`,
// `supersededBy`) until then. A follow-up the turn can't take is refused and
// starts nothing here: the orchestrator holds it as the thread's next turn, so
// at most one run ever works in the thread's clone.

const fs = require('fs');
const path = require('path');
const askRun = require('./ask-run');
const { sessionIdFrom } = require('./chat-turn');
const { userMessageKind } = require('./tool-group-headings');
const { WORKFLOW_SCOPE_HINT, isWorkflowScopeRefusal } = require('./workflow-scope');

// ask-model-v1: an ask-run's `model` (termag ask --model) is the turn's --model.
const CAPABILITIES = ['ask-chat-v1', 'ask-steer-v1', 'ask-model-v1'];
/** An ask-run `model` the chat runner may launch with (chat-runner.js claudeModelArg): a tier alias or a US Anthropic profile id. */
const LAUNCH_MODEL = /^(opus|sonnet|haiku|us\.anthropic\.claude-[A-Za-z0-9._:-]{1,80})$/;
/** The job's `model`, when the orchestrator named one this runner takes; anything else is left out (the box's default). */
const modelOf = (msg) => (typeof msg.model === 'string' && LAUNCH_MODEL.test(msg.model) ? { model: msg.model } : {});
const RUN_ID_RE = /^[a-z0-9]{8,40}$/;
const PHASES_MARKER = 'Phases: ask-chat-v1';
const TRUSTED_MODE = 'bypassPermissions';
/** An ask's mode: its own, or the lower one the orchestrator capped it at (ask-run.js CAPPED_MODES). */
const askMode = (capped) => (askRun.CAPPED_MODES.includes(capped) ? capped : TRUSTED_MODE);
// The script waits up to five minutes for a checkout to land, then clones.
const PREPARE_TIMEOUT_MS = 15 * 60 * 1000;
const STOPPED = 'The ask\'s turn on the target box stopped before Claude answered.';
const STOPPED_FOLLOW_UP = 'The ask\'s turn on the target box stopped before Claude answered this follow-up.';

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
    // The project's name, for the turn's telemetry resource (chat-runner.js chatTelemetryEnv); an older orchestrator sends none.
    ...(typeof c.project === 'string' && c.project ? { project: c.project } : {}),
  };
}

/** The text of a user message's content: a string, or its text blocks. */
function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : null;
}

/**
 * A prompt Claude took in (its replay): a line the chat shows as a person's
 * or an ask's message (tool-group-headings.js userMessageKind, as
 * chat/sdkChat.ts draws it). A task's notification, a reminder, a local
 * command's or /compact's echo, a compaction's summary, Claude Code's own
 * text and a subagent's prompt are not. A line with no text (an image) is.
 */
function isPrompt(ev) {
  if (!ev || ev.type !== 'user' || ev.isReplay !== true) return false;
  const text = contentText(ev.message && ev.message.content);
  return userMessageKind(ev, typeof text === 'string' ? text : '', false) === 'message';
}

/**
 * The reply of a finished turn, as the result event termag-subagent-run
 * reports: Claude's own last `result`, else an error naming why there is
 * none (stopped, or the runner's last error), keeping the session so the
 * thread's next ask resumes it. A background task (a Monitor, a background
 * command or agent) that ends after Claude answered wakes it into another
 * `result` in the same turn, often a short "that was my watcher" note, so the
 * reply is every result's text since the last prompt Claude took in
 * (isPrompt), in order: a wake-up never replaces the answer. An error
 * result (an interrupt) ends its attempt: the reply is the results after the
 * last one, or that error alone when it is the last result. With `after` (a follow-up steered into
 * the turn), only results after Claude took that message in count: its
 * replay (--replay-user-messages) is where it did. A log with no such replay
 * (an older Claude) falls back to the last result.
 */
function turnResult(log, after = null) {
  const events = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* not a whole line */ }
  }
  let from = 0;
  let replayed = false;
  if (after != null) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && ev.type === 'user' && ev.isReplay === true && contentText(ev.message && ev.message.content) === after) { from = i + 1; replayed = true; break; }
    }
  }
  let result = null;
  let texts = [];
  let runnerError = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev && ev.type === 'result') {
      if (i < from) continue;
      // An error result ends its attempt: an error, or an answer after one, starts the reply over.
      if (ev.is_error === true || (result && result.is_error === true)) texts = [];
      result = ev;
      if (typeof ev.result === 'string' && ev.result.trim()) texts.push(ev.result);
    } else if (ev && ev.type === 'runner-error' && typeof ev.message === 'string') runnerError = ev.message;
    else if (i >= from && isPrompt(ev)) texts = [];
  }
  // An older Claude's log without the follow-up's replay can't tell its results apart: the last one.
  if (result && after != null && !replayed) return result;
  if (result) {
    const text = texts.join('\n\n');
    return text && text !== result.result ? { ...result, result: text } : result;
  }
  const stopped = replayed ? STOPPED_FOLLOW_UP : STOPPED;
  return {
    type: 'result',
    subtype: 'error_turn_stopped',
    is_error: true,
    result: runnerError ? `${stopped} ${runnerError}` : stopped,
    session_id: sessionIdFrom(log) || undefined,
    num_turns: null,
  };
}

/**
 * Who a finished turn answers (chat-runner.js keeps the chain): the ask it
 * started with, then those steered into it (`steered`, from asks.json), each
 * `delivered` once the wrapper wrote it to Claude (its inbox file is
 * `.sent`) and `waiting` while its inbox file is still there. The target is
 * the last delivered one. A later one was taken out of the inbox for the next
 * turn, so the target is superseded and nothing is reported for it (`report`
 * false); one still waiting, of a stopped turn, is `lost`.
 */
function turnTarget(head, steered, { delivered, waiting }) {
  const chain = [{ runId: head, text: null }, ...steered];
  let target = 0;
  for (let i = 1; i < chain.length; i++) if (delivered(chain[i])) target = i;
  const later = chain.slice(target + 1);
  return {
    runId: chain[target].runId,
    after: target > 0 ? chain[target].text : null,
    superseded: chain.slice(0, target).map(e => e.runId),
    report: later.length === 0,
    lost: later.filter(e => waiting(e)).map(e => e.runId),
  };
}

/**
 * A reply from a turn that ran read-only (chat-runner.js settleTurnMode
 * refused bypassPermissions) leads with that, so the asker sees why nothing
 * was changed, not only Claude's account of it.
 */
function withReadOnlyNotice(result, readOnly, fix) {
  if (typeof readOnly !== 'string' || !readOnly) return result;
  const back = typeof fix === 'string' && fix ? ` To give it its tools back, on the box, ${fix}.` : '';
  const notice = `[termag: this turn ran read-only, with only Read, Grep and Glob, because ${readOnly}. It could not edit files, run commands or commit.${back}]`;
  return { ...result, result: `${notice}\n\n${typeof result.result === 'string' ? result.result : ''}` };
}

/** A tool result's text: a string, or its text blocks. */
function toolResultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
}

/**
 * A reply whose turn had a push GitHub refused for want of the `workflow`
 * scope (workflow-scope.js) ends with termag's line on why and what to do, so
 * the asker sees it even when Claude's answer doesn't explain. Only failed
 * tool results (a push GitHub refused exits non-zero) since the turn's last
 * prompt (isPrompt) count, so a successful push or an earlier turn's refusal
 * adds nothing.
 */
function withPushScopeNotice(result, log) {
  let refused = false;
  for (const line of String(log || '').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (isPrompt(ev)) { refused = false; continue; }
    if (refused || !ev || ev.type !== 'user' || !Array.isArray(ev.message && ev.message.content)) continue;
    refused = ev.message.content.some(b => b && b.type === 'tool_result' && b.is_error === true && isWorkflowScopeRefusal(toolResultText(b)));
  }
  if (!refused) return result;
  const text = typeof result.result === 'string' ? result.result : '';
  if (text.includes(WORKFLOW_SCOPE_HINT)) return result;
  return { ...result, result: text ? `${text}\n\n[${WORKFLOW_SCOPE_HINT}]` : `[${WORKFLOW_SCOPE_HINT}]` };
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
   * What the turn's `ask` says of the clone --prepare made. A bundle-mode
   * clone: where the turn writes PR descriptions (termag-subagent-run's
   * pr_body_file and pr_dir), as --prepare names them; a runner that names
   * none keeps them in the same place, the clone's .git. A push-mode clone:
   * that it is one, and its branch (the chat runner's read-only fix names
   * them, as the origin there is termag's own), and the notice of a clone
   * converted for this turn.
   */
  function cloneLayout(prep) {
    // A push-mode clone: the run opens its PRs itself, so there are no description files.
    if (prep.push === true) {
      return {
        push: true,
        ...(typeof prep.branch === 'string' && askRun.isPushBranch(prep.branch) ? { branch: prep.branch } : {}),
        ...(typeof prep.notice === 'string' && prep.notice ? { notice: prep.notice } : {}),
      };
    }
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
  const inFlight = new Map();
  async function runPrepared(runId) {
    if (inFlight.has(runId)) return;
    const run = prepareAndSend(runId);
    inFlight.set(runId, run);
    try { await run; } finally { inFlight.delete(runId); }
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
    // A new thread's clone, timed by the runner (termag-subagent-run clone_for_push).
    if (typeof prep.cloneSeconds === 'number') log(`[ASK] run ${runId}: the thread's clone took ${prep.cloneSeconds}s`);
    const job = readJob(file);
    if (!job) { log(`[ASK] run ${runId}: canceled while its clone was prepared`); return; }
    try {
      pointSession(job.chat.chatKey, prep, job.resumeSessionId);
      fsImpl.writeFileSync(systemPromptFile(prep.repoDir), job.systemPrompt || '', { mode: 0o600 });
      setStage(file, 'sent');
      const sent = await chats.sendMessage({
        chatKey: job.chat.chatKey, cwd: prep.repoDir, text: job.prompt,
        projectId: job.chat.projectId, project: job.chat.project, workstream: job.chat.workstream, workstreamId: job.chat.workstreamId,
        permissionMode: askMode(job.permissionMode), ...(job.spaceMemory ? { spaceMemory: job.spaceMemory } : {}),
        // The turn's --model (termag ask --model, else the thread chat's stored tier); none is the box's default.
        ...modelOf(job),
        // live: the turn reads stdin as it runs, so a later ask on the thread can join it (steerRun).
        ...(job.live === true ? { liveInput: true } : {}),
        ask: {
          threadId: job.threadId, runId, systemPrompt: job.systemPrompt, gitName: job.gitName, gitEmail: job.gitEmail, ...cloneLayout(prep),
          // Who asked, for the turn's telemetry resource (chat-runner.js askTelemetryOf checks it).
          ...(job.telemetry ? { telemetry: job.telemetry } : {}),
        },
      });
      log(`[ASK] run ${runId} on thread ${job.threadId}: ${sent.queued ? 'queued in' : 'started in'} chat ${job.chat.chatKey}`);
    } catch (err) {
      fail(runId, `the chat runner did not take the turn: ${err.message}`);
    }
  }

  /** ask-run with a chat: write the job and answer; the clone and the turn follow. */
  function startRun(msg, cwd) {
    // spaceMemory: the thread chat's own space (backend services/chatSpace.ts), as its other turns load.
    const job = {
      ...askRun.buildJob(msg, cwd), mode: 'chat', chat: chatOf(msg), stage: 'preparing',
      ...(msg.live === true ? { live: true } : {}),
      ...modelOf(msg),
      ...(msg.spaceMemory && typeof msg.spaceMemory === 'object' ? { spaceMemory: msg.spaceMemory } : {}),
      ...(msg.telemetry && typeof msg.telemetry === 'object' ? { telemetry: msg.telemetry } : {}),
    };
    if (!fsImpl.existsSync(cwd)) throw new Error(`the project checkout ${cwd} does not exist on this box`);
    ensureDirs();
    writeJob(jobFile(job.runId), job);
    runPrepared(job.runId).catch(err => log(`[ASK] run ${job.runId}: ${err.message}`));
    return { ok: true, started: true, chat: job.chat.chatKey };
  }

  /** Why the run `prev` has no live turn a follow-up can join now, or null when it may have one. */
  function steerRefusal(prev) {
    const job = readJob(jobFile(prev));
    if (!job) return 'gone';
    if (job.mode !== 'chat') return 'headless';
    if (inFlight.has(prev) || job.stage === 'preparing') return 'preparing';
    return job.stage === 'sent' ? null : job.stage;
  }

  return {
    capable: () => askChatCapable(home, fsImpl),

    startRun: (msg, cwd) => startRun(msg, cwd),

    /**
     * ask-run with `steerOf`: the follow-up joins the live turn that run is
     * in, and that run is superseded (`steered: true`). A turn that can't
     * take it (headless, still being prepared, queued, not live, over or
     * reporting) refuses it (`started: false`, `steered: false` and why), and
     * nothing starts: a run of its own now would share the thread's clone
     * with that one, so the orchestrator holds it as the next turn instead.
     */
    async steerRun(msg, cwd) {
      const prev = typeof msg.steerOf === 'string' && RUN_ID_RE.test(msg.steerOf) ? msg.steerOf : null;
      if (!prev) throw new Error('steerOf is not a run id');
      const job = { ...askRun.buildJob(msg, cwd), mode: 'chat', chat: chatOf(msg), live: true };
      if (!fsImpl.existsSync(cwd)) throw new Error(`the project checkout ${cwd} does not exist on this box`);
      let reason = steerRefusal(prev);
      if (!reason) {
        ensureDirs();
        // Before the steer, so the turn's end finds the job it reports to.
        writeJob(jobFile(job.runId), { ...job, stage: 'sent', steerOf: prev });
        let r;
        try {
          r = await chats.steerAsk({ runId: prev, newRunId: job.runId, text: job.prompt });
        } catch (err) {
          r = { steered: false, reason: err.message };
        }
        if (r.steered) {
          // Gone once the turn has ended and cleaned up, and then not written again.
          const prevFile = jobFile(prev);
          const prevJob = readJob(prevFile);
          if (prevJob) writeJob(prevFile, { ...prevJob, stage: 'superseded', supersededBy: job.runId });
          log(`[ASK] run ${job.runId} on thread ${job.threadId}: steered into ${prev}'s turn ${r.turnId}`);
          return { ok: true, started: true, steered: true, chat: job.chat.chatKey, turnId: r.turnId };
        }
        fsImpl.rmSync(jobFile(job.runId), { force: true });
        reason = r.reason || 'refused';
      }
      log(`[ASK] run ${job.runId} on thread ${job.threadId}: not steered into ${prev} (${reason}); the orchestrator holds it as the next turn`);
      return { ok: true, started: false, steered: false, chat: job.chat.chatKey, reason };
    },

    /**
     * A person's message in an ask's chat: the thread's clone (made again if
     * it was swept), then a turn with no run.
     */
    async sendMessage(msg, cwd) {
      const chat = { chatKey: msg.chatKey, projectId: msg.projectId, project: msg.project, workstream: msg.workstream, workstreamId: msg.workstreamId };
      const a = msg.ask || {};
      const job = askRun.buildJob({
        runId: 'person0000', threadId: a.threadId, prompt: msg.text, baseSha: a.baseSha || null,
        gitName: a.gitName, gitEmail: a.gitEmail,
      }, cwd);
      ensureDirs();
      const file = path.join(jobs, `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
      writeJob(file, {
        runId: '', threadId: job.threadId, cwd, baseSha: job.baseSha, waitForCheckout: false,
        // A clone made again for this message pushes as the thread's asks do.
        ...(typeof a.pushBranch === 'string' && askRun.isPushBranch(a.pushBranch) ? { pushBranch: a.pushBranch, gitEmail: job.gitEmail } : {}),
        // And is capped as they are: its prepare installs no repo git hooks (termag-subagent-run).
        ...(askRun.CAPPED_MODES.includes(a.permissionMode) ? { permissionMode: a.permissionMode } : {}),
      });
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
        ...chat, cwd: prep.repoDir, text: msg.text, permissionMode: askMode(a.permissionMode), model: msg.model, images: msg.images,
        // A repeat of this id is answered as the send that first carried it (chat-send-ids.js).
        sendId: msg.sendId,
        ...(msg.spaceMemory && typeof msg.spaceMemory === 'object' ? { spaceMemory: msg.spaceMemory } : {}),
        ask: {
          threadId: job.threadId, systemPrompt, gitName: job.gitName, gitEmail: job.gitEmail, ...cloneLayout(prep),
          // Who asked, for the turn's telemetry resource: the same session as the thread's asks.
          ...(a.telemetry && typeof a.telemetry === 'object' ? { telemetry: a.telemetry } : {}),
        },
      });
    },

    /**
     * chat-runner onTurnDone: an ask's turn is over, so report it, to the
     * newest ask of its chain that reached Claude (turnTarget).
     */
    async onTurnDone(meta, dir) {
      const head = meta.ask && meta.ask.runId;
      if (!head) return;
      let steered = [];
      try { steered = JSON.parse(fsImpl.readFileSync(path.join(dir, 'asks.json'), 'utf8')); } catch { /* never steered */ }
      if (!Array.isArray(steered)) steered = [];
      steered = steered.filter(e => e && RUN_ID_RE.test(String(e.runId || '')) && /^\d+\.json$/.test(String(e.inbox || '')));
      const inbox = path.join(dir, 'inbox');
      const t = turnTarget(head, steered, {
        delivered: e => fsImpl.existsSync(path.join(inbox, e.inbox.replace(/\.json$/, '.sent'))),
        waiting: e => fsImpl.existsSync(path.join(inbox, e.inbox)),
      });
      // Their follow-up's reply answers them; the orchestrator marked them superseded.
      for (const id of t.superseded) {
        const j = readJob(jobFile(id));
        if (j && j.stage !== 'reporting') fsImpl.rmSync(jobFile(id), { force: true });
      }
      for (const id of t.lost) fail(id, 'the ask\'s turn on the target box stopped before this follow-up went in');
      const runId = t.runId;
      const file = jobFile(runId);
      const job = readJob(file);
      if (!job || job.stage === 'reporting') return;
      if (!t.report || job.stage === 'superseded') {
        // A later follow-up answers it: the next turn's, or one steered in after this turn's end.
        fsImpl.rmSync(file, { force: true });
        log(`[ASK] run ${runId}: turn ${meta.turnId} over, superseded, nothing to report`);
        return;
      }
      let text = '';
      try { text = fsImpl.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch { /* never started */ }
      const resultFile = path.join(jobs, `${runId}.result.json`);
      fsImpl.writeFileSync(resultFile, JSON.stringify(withPushScopeNotice(withReadOnlyNotice(turnResult(text, t.after), meta.readOnly, meta.readOnlyFix), text)), { mode: 0o600 });
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
      // Its turn goes on as the follow-up's: that one is live, not this.
      if (job && job.stage === 'superseded') return { running: false, known: true, stage: job.stage, supersededBy: job.supersededBy };
      // live: a turn a follow-up can join (steerRun); anything else holds the clone without taking messages.
      if (job && job.mode === 'chat' && job.stage !== 'reporting') return { running: true, known: true, stage: job.stage, mode: 'chat', live: job.live === true };
      return askRun.askRunStatus(msg, { home, fsImpl });
    },

    /** ask-run-cancel: drop the job (so nothing reports), then take the run out of its chat. */
    async cancel(msg) {
      const runId = typeof msg.runId === 'string' ? msg.runId : '';
      const job = /^[a-z0-9]{8,40}$/.test(runId) ? readJob(jobFile(runId)) : null;
      // The turn is the follow-up's now; a cancel of that one stops it.
      if (job && job.stage === 'superseded') return { stopped: false, stage: job.stage, supersededBy: job.supersededBy };
      if (!job || job.mode !== 'chat' || job.stage === 'reporting') return askRun.cancelAskRun(msg, { home, fsImpl });
      fsImpl.rmSync(jobFile(runId), { force: true });
      const child = preparing.get(runId);
      if (child && child.pid) {
        // The script's TERM trap exits without reporting: the orchestrator has marked the run canceled.
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
        return { stopped: true, stage: 'preparing', pid: child.pid };
      }
      const stopped = await chats.cancelAsk(runId);
      // The asks it superseded in that turn: the turn's end that would remove them is not reported.
      for (let prev = job.steerOf, n = 0; prev && RUN_ID_RE.test(prev) && n < 100; n++) {
        const j = readJob(jobFile(prev));
        if (!j || j.stage !== 'superseded') break;
        fsImpl.rmSync(jobFile(prev), { force: true });
        prev = j.steerOf;
      }
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

module.exports = { CAPABILITIES, PHASES_MARKER, askChatCapable, chatOf, createAskChat, failureReason, turnResult, turnTarget, withPushScopeNotice, withReadOnlyNotice };
