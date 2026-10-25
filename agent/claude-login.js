'use strict';
// Headless Claude Enterprise sign-in for the simple UI.
//
// Checked against Claude Code 2.1.302, not guessed:
//   `claude auth login --help` offers --claudeai, --console, --email, --sso.
//   There is no device-code flag. A headless `claude auth login --claudeai --sso`
//   prints an https://claude.com/cai/oauth/authorize URL (PKCE; the verifier
//   stays in that process) and blocks on "Paste code here if prompted > ".
//   The line it reads is code#state. "Login successful." means the CLI stored
//   the token itself. "Invalid code. …" means try the same process again.
//   `claude auth status` prints JSON and exits 0 when logged in, 1 when not.
//   Gateway settings (Bedrock + apiKeyHelper) report loggedIn with
//   authMethod "third_party". This module will not start a login then.
//
// The one-time code is written to the CLI's stdin and dropped. It is never
// logged, stored, or put on a returned object. `claude setup-token` is never
// run: that command prints a long-lived token.

const { spawn } = require('child_process');
const { resolveClaude } = require('./chat-runner');

const CAPABILITIES = ['claude-login-v1'];
const URL_WAIT_MS = 20_000;
const RESULT_WAIT_MS = 25_000;
const LOGIN_TTL_MS = 10 * 60 * 1000;

const AUTHORIZE_RE = /https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+/;
const CODE_RE = /^[A-Za-z0-9._~+/=-]{8,512}#[A-Za-z0-9._~+/=-]{8,512}$/;
const TOKEN_RE = /sk-ant/i;

function safeEmail(email) {
  if (typeof email !== 'string') return null;
  const value = email.trim();
  if (value.length < 3 || value.length > 200 || value.startsWith('-')) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

/** Why a paste cannot be forwarded, or null. The text never includes the paste. */
function codeError(code) {
  if (typeof code !== 'string') return 'Paste the full code from the Claude page.';
  const value = code.trim();
  if (TOKEN_RE.test(value)) return 'Paste the one-time code from the Claude page, not a token.';
  if (!CODE_RE.test(value)) return 'Paste the full code from the Claude page, including the #.';
  return null;
}

function publicAuth(raw) {
  const loggedIn = Boolean(raw && raw.loggedIn === true);
  const methodOk = raw && typeof raw.authMethod === 'string' && /^[a-z0-9._-]{1,40}$/i.test(raw.authMethod);
  const providerOk = raw && typeof raw.apiProvider === 'string' && /^[a-z0-9._-]{1,40}$/i.test(raw.apiProvider);
  return {
    loggedIn,
    authMethod: methodOk ? raw.authMethod : 'none',
    apiProvider: providerOk ? raw.apiProvider : 'firstParty',
  };
}

/** The authorize URL from CLI output, or null. Only the SSO PKCE URL is accepted. */
function authorizeUrlFrom(text) {
  const match = String(text).match(AUTHORIZE_RE);
  if (!match) return null;
  const url = match[0].replace(/[)>\]]+$/, '');
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'claude.com') return null;
  if (parsed.pathname !== '/cai/oauth/authorize') return null;
  if (!parsed.searchParams.get('code_challenge')) return null;
  if (parsed.searchParams.get('login_method') !== 'sso') return null;
  return url;
}

/** A fixed sentence. CLI stderr is not forwarded; it can echo a bad paste. */
function fixedError(text) {
  const value = String(text);
  if (/Invalid code/i.test(value)) return 'That code was not accepted. Copy the whole code from the browser and try again.';
  if (/timed out/i.test(value)) return 'Sign-in timed out. Start again.';
  if (/Login failed/i.test(value) || /OAuth error/i.test(value)) return 'Claude could not finish sign-in. Start again.';
  return 'Claude sign-in stopped. Start again.';
}

/** Drop a paste or a token wherever it sits in CLI output, not only as a whole line. */
function scrubLoginOutput(text) {
  return String(text)
    .replace(/sk-ant\S*/gi, '')
    .replace(/[A-Za-z0-9._~+/=-]{8,512}#[A-Za-z0-9._~+/=-]{8,512}/g, '');
}

function childEnv(env, home) {
  const next = { ...env, HOME: home };
  // Status and login must use the box user's own ~/.claude, not a turn's
  // scratch config dir, and must not pop a browser on the box.
  delete next.CLAUDE_CONFIG_DIR;
  delete next.BROWSER;
  delete next.DISPLAY;
  return next;
}

function createClaudeLogin({
  home,
  env = process.env,
  spawnImpl = spawn,
  execFile,
  now = () => Date.now(),
  claudeBin,
  urlWaitMs = URL_WAIT_MS,
  resultWaitMs = RESULT_WAIT_MS,
  ttlMs = LOGIN_TTL_MS,
} = {}) {
  let proc = null;
  let phase = 'needed';
  let url = null;
  let error = null;
  let buf = '';
  let outcome = null;
  let startedAt = 0;
  let waiters = [];
  // Bumped only when a sign-in settles. A status read still in flight can
  // observe the old value and must not apply that stale snapshot.
  let epoch = 0;
  let signedIn = null;
  // start() awaits status before it records the child. Overlapping clicks
  // would both see no process and leave two CLIs, and the paste would go to
  // only one of them. One start runs at a time; the next joins it.
  let startTail = Promise.resolve();
  // submit() writes one line and waits. A second paste in that window would
  // write another line and clear outcome, so the first waiter can miss
  // "Login successful." One submit runs at a time; the next joins it.
  let submitTail = Promise.resolve();
  let expireTimer = null;

  function wake() {
    const pending = waiters;
    waiters = [];
    for (const fn of pending) fn();
  }

  function waitFor(pred, ms) {
    if (pred()) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      let timer;
      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters = waiters.filter(fn => fn !== on);
        resolve(ok);
      }
      timer = setTimeout(() => finish(false), ms);
      // note() wakes on every chunk, including the opening line and an echoed
      // paste. Those do not satisfy the predicate yet. Put the waiter back,
      // or start/submit sit out the rest of the timeout after the URL or the
      // result has already arrived.
      function on() {
        if (settled) return;
        if (!pred()) {
          waiters.push(on);
          return;
        }
        finish(true);
      }
      waiters.push(on);
    });
  }

  function bin() {
    return claudeBin || resolveClaude({ home, env });
  }

  function shape(auth) {
    const out = { ...publicAuth(auth), phase: phase === 'success-pending' ? 'submitting' : phase };
    if (error && out.phase !== 'ready') out.error = error;
    if (url && (out.phase === 'needs-code' || out.phase === 'submitting')) out.url = url;
    return out;
  }

  // starting / needs-code / submitting, including the confirm after
  // "Login successful." A status read that fails then must not become
  // unavailable: the card would stop polling and hide the paste field
  // while this CLI is still running.
  function loginOpen() {
    return phase === 'starting' || phase === 'needs-code' || phase === 'submitting' || phase === 'success-pending';
  }

  function unavailable() {
    return {
      phase: 'unavailable', loggedIn: false, authMethod: 'none', apiProvider: 'firstParty',
      error: 'Claude Code on this box did not report a sign-in status.',
    };
  }

  function clearExpire() {
    if (!expireTimer) return;
    clearTimeout(expireTimer);
    expireTimer = null;
  }

  function armExpire() {
    clearExpire();
    // Nobody has to poll. A navigate-away leaves the CLI at the paste prompt
    // until this fires. unref so a quiet box does not stay alive for it.
    expireTimer = setTimeout(() => {
      expireTimer = null;
      expireIfNeeded();
    }, ttlMs);
    if (typeof expireTimer.unref === 'function') expireTimer.unref();
  }

  function kill() {
    const child = proc;
    proc = null;
    clearExpire();
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    // The exit handler ignores a child whose proc was already cleared, so it
    // never wakes anyone. A start or submit parked on this child would
    // otherwise sit out the rest of its timeout.
    wake();
  }

  function note(chunk) {
    buf = scrubLoginOutput(buf + chunk.toString());
    if (buf.length > 8000) buf = buf.slice(-4000);
    if (!url) {
      const found = authorizeUrlFrom(buf);
      if (found) { url = found; phase = 'needs-code'; error = null; }
    }
    if (/Login successful/.test(buf)) {
      outcome = 'success';
      phase = 'success-pending';
      buf = '';
    } else if (/Invalid code/i.test(buf)) {
      outcome = 'invalid';
      error = fixedError('Invalid code');
      phase = 'needs-code';
      buf = '';
    }
    wake();
  }

  function expireIfNeeded() {
    if (proc && startedAt && now() - startedAt >= ttlMs) {
      kill();
      url = null;
      buf = '';
      outcome = null;
      phase = 'expired';
      error = 'That sign-in expired. Start again.';
      wake();
    }
  }

  async function readStatus() {
    try {
      const { stdout } = await execFile(bin(), ['auth', 'status'], {
        timeout: 8000,
        env: childEnv(env, home),
      });
      return publicAuth(JSON.parse(String(stdout)));
    } catch (err) {
      const stdout = err && err.stdout ? String(err.stdout) : '';
      if (stdout.trim().startsWith('{')) {
        try { return publicAuth(JSON.parse(stdout)); } catch { /* not status JSON */ }
      }
      return null;
    }
  }

  function ready(auth) {
    if (proc) kill();
    phase = 'ready';
    error = null;
    url = null;
    buf = '';
    outcome = null;
    signedIn = { ...auth, phase: 'ready' };
    epoch += 1;
    return signedIn;
  }

  async function status() {
    expireIfNeeded();
    const seen = epoch;
    const auth = await readStatus();
    // ready() finished while this read was in flight. The snapshot can still
    // say logged out, and the child is already gone. Applying it would force
    // phase back to needed and the card would offer Sign in again.
    if (seen !== epoch && signedIn && phase === 'ready') return signedIn;
    if (!auth) {
      if (loginOpen()) return shape({ loggedIn: false });
      return unavailable();
    }
    if (auth.loggedIn) return ready(auth);
    // submit has seen "Login successful." and is confirming. proc is often
    // already null here. Leave that phase; the confirming read owns the result.
    if (phase === 'success-pending' || phase === 'submitting') return shape(auth);
    if (!proc && phase !== 'failed' && phase !== 'expired') phase = 'needed';
    return shape(auth);
  }

  async function beginStart(email) {
    const auth = await readStatus();
    if (!auth) {
      // A second Sign in while the first CLI is up must join it, not report
      // that Claude is missing and let the card drop the paste field.
      if (loginOpen()) return shape({ loggedIn: false });
      return unavailable();
    }
    // A gateway box, or any box that already has a seat, is not logged in again.
    if (auth.loggedIn) return ready(auth);
    expireIfNeeded();
    if (proc && (phase === 'starting' || phase === 'needs-code' || phase === 'submitting' || phase === 'success-pending')) {
      return shape(auth);
    }
    kill();
    buf = '';
    url = null;
    error = null;
    outcome = null;
    phase = 'starting';
    startedAt = now();
    const args = ['auth', 'login', '--claudeai', '--sso'];
    const hint = safeEmail(email);
    if (hint) args.push('--email', hint);
    let child;
    try {
      child = spawnImpl(bin(), args, { env: childEnv(env, home), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      phase = 'unavailable';
      error = 'Claude Code on this box did not report a sign-in status.';
      return shape(auth);
    }
    proc = child;
    armExpire();
    child.stdout.on('data', note);
    child.stderr.on('data', note);
    child.on('error', () => {
      if (proc !== child) return;
      proc = null;
      phase = 'unavailable';
      error = 'Claude Code on this box did not report a sign-in status.';
      buf = '';
      wake();
    });
    child.on('exit', () => {
      if (proc !== child) return;
      proc = null;
      if (outcome === 'invalid') {
        phase = 'needs-code';
        error = fixedError('Invalid code');
      } else if (outcome !== 'success' && phase !== 'success-pending' && phase !== 'expired') {
        phase = 'failed';
        error = error || 'Claude sign-in stopped. Start again.';
      }
      buf = '';
      wake();
    });
    await waitFor(() => Boolean(url) || phase === 'failed' || phase === 'unavailable' || proc !== child, urlWaitMs);
    if (proc === child && !url && phase === 'starting') {
      kill();
      phase = 'failed';
      error = 'Claude did not offer a sign-in link. Start again.';
      buf = '';
    }
    const again = await readStatus();
    if (again && again.loggedIn) return ready(again);
    return shape(again || auth);
  }

  function start(email) {
    const run = startTail.then(() => beginStart(email));
    startTail = run.then(() => {}, () => {});
    return run;
  }

  async function beginSubmit(code) {
    const rejected = codeError(code);
    if (rejected) {
      const auth = await readStatus();
      const current = auth && auth.loggedIn ? ready(auth) : shape(auth || { loggedIn: false });
      if (current.phase === 'ready') return current;
      return { ...current, error: rejected };
    }
    expireIfNeeded();
    if (!proc || !url || phase === 'expired' || phase === 'failed') {
      const auth = await readStatus();
      const current = auth && auth.loggedIn ? ready(auth) : shape(auth || { loggedIn: false });
      if (current.phase === 'ready') return current;
      return { ...current, error: 'Start sign-in again, then paste the code.' };
    }
    const line = String(code).trim();
    phase = 'submitting';
    error = null;
    buf = '';
    outcome = null;
    try {
      proc.stdin.write(`${line}\n`);
    } catch {
      phase = 'failed';
      error = 'Claude is not waiting for a code. Start again.';
      const auth = await readStatus();
      return shape(auth || { loggedIn: false });
    }
    await waitFor(() => outcome === 'success' || outcome === 'invalid' || proc == null, resultWaitMs);
    if (outcome === 'invalid') {
      phase = 'needs-code';
      error = fixedError('Invalid code');
      buf = '';
      const auth = await readStatus();
      return shape(auth || { loggedIn: false });
    }
    if (outcome === 'success' || phase === 'success-pending') {
      buf = '';
      await waitFor(() => proc == null, 5000);
      const auth = await readStatus();
      if (auth && auth.loggedIn) return ready(auth);
      phase = 'failed';
      error = 'Claude said sign-in succeeded, but the box is still not signed in. Start again.';
      return shape(auth || { loggedIn: false });
    }
    phase = 'failed';
    error = 'Claude did not accept the code in time. Start again.';
    buf = '';
    const auth = await readStatus();
    return shape(auth || { loggedIn: false });
  }

  function submit(code) {
    const run = submitTail.then(() => beginSubmit(code));
    submitTail = run.then(() => {}, () => {});
    return run;
  }

  function cancel() {
    kill();
    url = null;
    buf = '';
    outcome = null;
    error = null;
    phase = 'needed';
    return { phase: 'needed', loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
  }

  return { status, start, submit, cancel };
}

module.exports = {
  CAPABILITIES,
  LOGIN_TTL_MS,
  URL_WAIT_MS,
  authorizeUrlFrom,
  codeError,
  createClaudeLogin,
  scrubLoginOutput,
  fixedError,
  publicAuth,
  safeEmail,
};
