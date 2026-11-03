'use strict';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Owner identity and the optional repo URL. Never a token. */
function renderOnClaimEnv({ dotfilesRepoUrl, ownerName, ownerEmail }) {
  const lines = [
    `TERMAG_OWNER_NAME=${shellQuote(ownerName)}`,
    `TERMAG_OWNER_EMAIL=${shellQuote(ownerEmail)}`,
  ];
  if (dotfilesRepoUrl) lines.push(`TERMAG_DOTFILES_REPO_URL=${shellQuote(dotfilesRepoUrl)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * A repeated claim RPC must not replace the file under a run already reading
 * it, and must not rerun owner code that already finished or was deferred
 * until GitHub login.
 */
function planOnClaim({ unitState, hasWork, existingState = null }) {
  if (!hasWork) return { write: false, start: false };
  if (existingState === 'succeeded' || existingState === 'failed' || existingState === 'skipped') {
    return { write: false, start: false };
  }
  if (unitState === 'active' || unitState === 'activating') {
    return { write: false, start: false };
  }
  return { write: true, start: true };
}

/**
 * Forwards the on-claim status file over one socket. It lives for the whole
 * socket, not just a run: the owner reruns the claim hook after GitHub
 * login, long after the RPC's run ended, and that result has to reach the
 * backend too. A frame counts as sent only once it went out on an open
 * socket, so a disconnect cannot swallow a state change; a new socket gets a
 * new forwarder and resends whatever the file says now.
 */
function createStatusForwarder({ read, send, isOpen }) {
  let lastSent = null;
  return {
    tick() {
      if (!isOpen()) return false;
      let raw;
      try { raw = read(); } catch { return false; }
      if (typeof raw !== 'string' || raw === lastSent) return false;
      let report;
      try { report = JSON.parse(raw); } catch { return false; }
      if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
      // `type` goes after the spread, so a status file cannot redirect the frame.
      send({ ...report, type: 'on-claim-status' });
      lastSent = raw;
      return true;
    },
  };
}

/**
 * What to do with a deferred claim once GitHub reaches the box through termag
 * (credentials-apply github). The box-claim RPC starts the run before the
 * orchestrator delivers the broker's gitconfig, so a private repo's clone ran
 * without it and the run ended skipped/needs-auth. With the rewrites in
 * place the same run succeeds, and the runner skips a checkout it already
 * applied, so repeating it is safe.
 *
 *   wait   a run is in flight; it may still end needs-auth
 *   start  the last run ended needs-auth and there is a URL to retry
 *   none   no URL, no run yet, or a run that was not waiting for GitHub
 */
function planOnClaimRetry({ hasUrl, unitState, status }) {
  if (!hasUrl) return 'none';
  if (unitState === 'active' || unitState === 'activating') return 'wait';
  if (status && typeof status === 'object' && status.state === 'skipped' && status.reason === 'needs-auth') return 'start';
  return 'none';
}

// One deferred rerun per GitHub connection the orchestrator delivers. Every
// reconnect redelivers the same connection, so the broker and login alone
// would make the rerun after a token the owner replaced on the Credentials
// page, or after an org the recheck found newly authorized, look like a
// repeat. Those arrive with the credential's later updatedAt, so it is part
// of the key. An orchestrator that sends none gets the broker and login.
function onClaimRetryKey(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return [p.broker, p.login, p.updatedAt].map(v => (v == null ? '' : String(v))).join('|');
}

module.exports = { planOnClaim, planOnClaimRetry, onClaimRetryKey, renderOnClaimEnv, createStatusForwarder };
