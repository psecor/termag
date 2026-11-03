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
/**
 * Announced when the wrapper takes --claude-floor <x.y.z> (the word
 * `claude-floor` on its flags line): the orchestrator then passes the policy's
 * Claude Code floor, which takes precedence over the box's floor file.
 * A wrapper without the word
 * would ignore the flag and judge by its file alone, so it gets no v3.
 */
const FLOOR_CAPABILITY = 'claude-runner-wrapper-v3';

/** The line a wrapper carries once it understands --anthropic-git and --github. */
const FLAGS_MARKER = 'termag-claude-runner-flags: anthropic-git github';
/** The word on that line for --claude-floor. */
const FLOOR_WORD = 'claude-floor';

/** Where termag-reconcile installs the wrapper (its table names this path). */
function wrapperPath(home = os.homedir()) {
  return path.join(home, '.local', 'bin', 'termag-claude-runner');
}

/** The installed wrapper's text, or null when there is none or it cannot be read. */
function readWrapper(readFile, home) {
  try {
    return String(readFile(wrapperPath(home), 'utf8'));
  } catch {
    return null;
  }
}

/** The words on the wrapper's `termag-claude-runner-flags:` line (none without one). */
function flagWords(text) {
  const m = /termag-claude-runner-flags:([^\n]*)/.exec(text || '');
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * Whether the installed wrapper carries the flags marker. False, never a
 * throw, when there is no wrapper or it cannot be read.
 */
function wrapperSupportsFlags(readFile = fs.readFileSync, home = os.homedir()) {
  const text = readWrapper(readFile, home);
  return text !== null && text.includes(FLAGS_MARKER);
}

/**
 * The wrapper capabilities to announce: v2 for the git flags' marker, as
 * before, and v3 when the flags line also has `claude-floor`. Empty, never a
 * throw, when there is no wrapper.
 */
function wrapperCapabilities(readFile = fs.readFileSync, home = os.homedir()) {
  const text = readWrapper(readFile, home);
  if (text === null) return [];
  return [
    ...(text.includes(FLAGS_MARKER) ? CAPABILITIES : []),
    ...(flagWords(text).includes(FLOOR_WORD) ? [FLOOR_CAPABILITY] : []),
  ];
}

module.exports = { CAPABILITIES, FLOOR_CAPABILITY, FLAGS_MARKER, FLOOR_WORD, wrapperPath, flagWords, wrapperSupportsFlags, wrapperCapabilities };
