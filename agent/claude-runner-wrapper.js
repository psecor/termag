'use strict';
// What the installed Claude cloud-session wrapper on this box can do
// (deploy/termag-claude-runner), announced in the agent's hello so the
// orchestrator sends only flags the wrapper understands.
// The wrapper ignores flags it does not
// know, by design, so an orchestrator that sent `--anthropic-git` to an old
// wrapper would get a runner fetching without the proxy and failing; the
// capability is what stops that. Read once at startup, like the box-update
// capability: the agent runs the wrapper it finds on PATH at launch time, but
// termag-reconcile installs a new wrapper and restarts the agent together.
//
// Kept apart from agent.js so it can be tested with a fake reader.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CAPABILITIES = ['claude-runner-wrapper-v2'];

/** The line a wrapper carries once it understands --anthropic-git and --github. */
const FLAGS_MARKER = 'termag-claude-runner-flags: anthropic-git github';

/** Where termag-reconcile installs the wrapper (its table names this path). */
function wrapperPath(home = os.homedir()) {
  return path.join(home, '.local', 'bin', 'termag-claude-runner');
}

/**
 * Whether the installed wrapper carries the flags marker. False, never a
 * throw, when there is no wrapper or it cannot be read.
 */
function wrapperSupportsFlags(readFile = fs.readFileSync, home = os.homedir()) {
  try {
    return String(readFile(wrapperPath(home), 'utf8')).includes(FLAGS_MARKER);
  } catch {
    return false;
  }
}

module.exports = { CAPABILITIES, FLAGS_MARKER, wrapperPath, wrapperSupportsFlags };
