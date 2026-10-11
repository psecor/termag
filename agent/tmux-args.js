'use strict';
/**
 * argv builders for the tmux commands the agent runs on behalf of the backend.
 *
 * Every builder returns an ARRAY for child_process.execFile('tmux', argv):
 * no shell is involved, so the text typed into a pane arrives byte-for-byte.
 * The previous implementation built a shell string and single-quote-escaped
 * the text twice, which turned every `'` into the four characters `'\''`
 * (MetaTerm send_keys, Slack /t and the launch commands all went through it).
 *
 * `--` ends tmux option parsing so text starting with `-` is typed, not
 * parsed as a flag (verified on tmux 3.4: `send-keys -l -- '-x'` types `-x`).
 */

/**
 * tmux resolves `-t name` by exact match first, then by UNIQUE PREFIX, so
 * `-t u-x-1` happily hits the only session `u-x-10`. `=name` means exact
 * match only, and it is a SESSION target: has-session and kill-session take
 * it as is, but window and pane commands (set-option -w, send-keys,
 * list-panes, capture-pane) need the session qualified with a trailing
 * colon, `=name:`, or they answer "no such window" / "can't find pane"
 * (verified on tmux 3.2a and 3.7b). Callers that generate names (the Claude
 * runner spawn) pass exact: true; the historical callers keep prefix
 * semantics unchanged.
 */
function tmuxSessionTarget(sessionName, exact = false) {
  return exact ? `=${sessionName}` : sessionName;
}
function tmuxPaneTarget(sessionName, exact = false) {
  return exact ? `=${sessionName}:` : sessionName;
}

/**
 * Variables a new session carries from the agent's own environment (`-e`).
 * A pane normally inherits the tmux SERVER's environment, which is whatever
 * the agent had when it first spawned the server. termag-agent.service sets
 * TERMAG_BOX=1 for webapp's boot telemetry, but KillMode=process keeps the
 * server alive across an agent restart, and tmux does not refresh a server's
 * environment from later clients, so a box that picked the unit up without a
 * reboot would keep creating sessions without it. `-e` sets the variable on
 * the session itself, which its panes and command inherit, on a fresh server
 * and a surviving one alike (verified on tmux 3.4; `-e` exists since 3.2).
 */
const SESSION_ENV = ['TERMAG_BOX'];

/**
 * `new-session` for tmux-create. Without `command` the pane runs the user's
 * login shell, as every project pane does. With it (an argv array, two or more
 * elements) tmux execs that program directly, no shell in between, so the
 * session lives exactly as long as the program: the Claude runner's session
 * ends when the runner does (verified on tmux 3.4: the arguments arrive
 * verbatim, `.` included, and the session is gone once the command exits).
 * `env` is the agent's environment (process.env at the call site); the
 * SESSION_ENV variables present in it ride along as `-e KEY=VALUE`.
 */
function newSessionArgv(sessionName, cwd, command = null, env = {}) {
  const argv = ['new-session', '-d', '-s', sessionName, '-c', cwd, '-x', '120', '-y', '30'];
  for (const key of SESSION_ENV) {
    if (env[key] !== undefined && env[key] !== '') argv.push('-e', `${key}=${env[key]}`);
  }
  if (command) argv.push('--', ...command);
  return argv;
}

/**
 * The options tmux-create sets on a new session, as argv arrays. set-option's
 * -t is a PANE target even for session options like history-limit, so both
 * need `=name:`: a bare `=name` answers "no such session" (tmux 3.5a).
 */
function newSessionOptionArgvs(sessionName) {
  const target = tmuxPaneTarget(sessionName, true);
  return [
    ['set-option', '-t', target, '-w', 'window-size', 'largest'],
    ['set-option', '-t', target, 'history-limit', '10000'],
  ];
}

/**
 * `keys` typed into `sessionName`. literal=true → `-l` (text is text, even
 * "C-c"); literal=false → tmux key-name parsing (the historical default that
 * Slack /t and the agent launch rely on). When `withEnter` is set in literal
 * mode Enter must be a separate invocation because `-l` applies to every
 * argument; in key-name mode it rides along in the same call.
 */
function sendKeysArgv(sessionName, keys, { literal = false, withEnter = false } = {}) {
  const argv = ['send-keys', '-t', sessionName];
  if (literal) argv.push('-l');
  argv.push('--', keys);
  if (withEnter && !literal) argv.push('Enter');
  return argv;
}

function enterArgv(sessionName) {
  return ['send-keys', '-t', sessionName, 'Enter'];
}

/**
 * `capture-pane -p` for the last `lines` lines. styled=true adds `-e` so SGR
 * escape sequences survive: a reader can then tell dimmed ghost-text
 * (ESC[2m … ESC[22m / ESC[0m) from real typed input on a prompt line.
 */
function captureArgv(sessionName, { lines = 200, styled = false } = {}) {
  const argv = ['capture-pane', '-t', sessionName, '-p'];
  if (styled) argv.push('-e');
  argv.push('-S', `-${lines}`);
  return argv;
}

/**
 * The last `n` non-blank lines of a pane capture. `capture-pane -S -n` is NOT
 * "the last n lines": it starts n lines into the scrollback and runs to the
 * bottom of the visible pane, so on a 65-row pane it returns 75 lines.
 */
function tailLines(text, n) {
  return text.split('\n').filter(l => l.trim() !== '').slice(-n).join('\n');
}

/**
 * Announced in the agent's hello. The backend launches Claude runners only on
 * boxes whose agent runs tmux-create's `command` (an older agent would ignore
 * it and leave a bare shell holding a runner slot).
 */
const CAPABILITIES = ['tmux-create-command-v1'];

module.exports = { sendKeysArgv, enterArgv, captureArgv, tailLines, newSessionArgv, newSessionOptionArgvs, tmuxSessionTarget, tmuxPaneTarget, CAPABILITIES, SESSION_ENV };
