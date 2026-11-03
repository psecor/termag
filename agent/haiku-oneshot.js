'use strict';

// One headless question to Haiku, off a chat's turn: the box's session titles
// (session-title.js) and tool-group
// headings (tool-group-headings.js) both ask
// through here. It is a separate `claude -p --model haiku` with nothing to act
// with (no tools, MCP servers or hooks), nothing saved to resume, thinking
// off, under `nice`, and killed after a timeout. The caller gives it a
// gateway-only scratch config (CLAUDE_CONFIG_DIR, chat-runner.js
// prepareChatConfigDir) and an empty directory to run in, so the call goes
// where the chat's own turns go, with the box's own token, and shares no file
// with a turn.

const childProcess = require('node:child_process');
const fs = require('node:fs');

const ONESHOT_TIMEOUT_MS = 60_000;
const OUTPUT_MAX_BYTES = 64 * 1024;

/**
 * The call's argv: print mode on Haiku with `systemPrompt` in place of Claude
 * Code's, no tools, an empty strict MCP config, hooks off, no session file,
 * and only the user settings source, which the caller points at the
 * gateway-only scratch config. `--bare` is not used: it skips the gateway's
 * apiKeyHelper and the call never answers. `settingsEnv` goes in the same
 * `--settings` (Claude Code reads only the last): the call's telemetry
 * resource (chat-runner.js chatTelemetryEnv), which outranks the scratch
 * config's copy of the owner's.
 */
function oneshotArgs(systemPrompt, settingsEnv = null) {
  return [
    '-p', '--setting-sources', 'user', '--tools', '',
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--no-session-persistence', '--settings', JSON.stringify({ disableAllHooks: true, ...(settingsEnv ? { env: settingsEnv } : {}) }),
    '--model', 'haiku', '--system-prompt', systemPrompt, '--output-format', 'json',
  ];
}

/**
 * The env the call runs with: the caller's, with thinking off. With it on,
 * Claude Code spends about 700 thinking tokens on a one-line answer, about
 * seven times the cost (measured for #753).
 */
function oneshotEnv(env) {
  return { ...env, MAX_THINKING_TOKENS: '0' };
}

/** The answer text in a `--output-format json` result, or null for an error result or anything else. */
function resultText(stdout) {
  let d;
  try { d = JSON.parse(String(stdout).trim()); } catch { return null; }
  if (!d || typeof d !== 'object' || d.is_error === true || typeof d.result !== 'string') return null;
  return d.result;
}

/**
 * Ask Haiku once: `bin` with oneshotArgs(systemPrompt, settingsEnv), `input` on stdin.
 * Resolves the answer text, or null on any failure (a spawn error, a non-zero
 * exit, an error result, the timeout), and never rejects. Runs under `nice`
 * where there is one, so the chat's own Claude keeps the CPU.
 */
function askHaiku({
  bin, env, cwd, systemPrompt, input, timeoutMs = ONESHOT_TIMEOUT_MS, settingsEnv = null,
  spawn = childProcess.spawn, nice = fs.existsSync('/usr/bin/nice') ? '/usr/bin/nice' : null,
}) {
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = value => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const args = oneshotArgs(systemPrompt, settingsEnv);
    const [cmd, argv] = nice ? [nice, ['-n', '10', bin, ...args]] : [bin, args];
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env: oneshotEnv(env), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }
    let out = '';
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (out.length < OUTPUT_MAX_BYTES) out += chunk; });
    child.on('error', () => finish(null));
    child.on('close', code => finish(code === 0 ? resultText(out) : null));
    // A claude that exits before reading (bad flags, an immediate failure)
    // makes this write fail with EPIPE; `close` reports the exit.
    child.stdin.on('error', () => { /* it exited before reading */ });
    child.stdin.end(input);
  });
}

/** The first non-empty line of an answer, without wrapping quotes or markdown emphasis. */
function firstLine(text) {
  const line = String(text || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  return line.replace(/^["'`*_]+|["'`*_]+$/g, '').trim();
}

module.exports = { askHaiku, firstLine, oneshotArgs, oneshotEnv, resultText, ONESHOT_TIMEOUT_MS };
