#!/usr/bin/env node
// Stand-in for Claude Code under the Claude Agent SDK on the e2e boxes
// (E2E_FAKE_CLAUDE=1): `claude --output-format stream-json --input-format
// stream-json …` with no -p, the long-lived mode the SDK's query() drives, as
// a t3code server on a box does (E2E_T3=1).
//
// stdin and stdout are JSON lines. The SDK's control requests are answered:
// `initialize` with an account and a slash command (what t3's capability probe
// reads), `interrupt` by ending the running turn, anything else with an empty
// success. Each user message is one turn: a system init (on the first), the
// answer streamed as partial-message events (with --include-partial-messages),
// the assistant message, and a result. The conversation goes to
// ~/.claude/projects/<cwd>/<id>.jsonl in Claude's transcript shape, so
// --resume <id> continues it: its turns count on from the transcript's. The
// SDK passes --session-id=<id> and --resume=<id>; both forms are read.
//
// A prompt starting with "run" calls the Bash tool (`ls -1` in the cwd) first:
// in bypassPermissions or acceptEdits it runs at once; in any other mode the
// fake asks the SDK with a `can_use_tool` control request, as Claude Code does,
// and runs it only if the answer is allow. A prompt starting with "long"
// streams ten times slower; one starting with "fail" ends in an overloaded
// API error. E2E_STUB_DELAY_MS (default 30) paces the streamed words.
//
// Hooks run as Claude Code runs them under the SDK, which loads the user,
// project and local settings unless --setting-sources says otherwise (the
// user's from CLAUDE_CONFIG_DIR, else ~/.claude), plus --settings: every
// matching `command` hook through /bin/sh in the cwd, with the event's JSON on
// stdin and CLAUDE_PROJECT_DIR in the environment, waited for (60 s, or the
// hook's `timeout`) before the turn goes on. SessionStart (with
// CLAUDE_ENV_FILE) before the first turn, UserPromptSubmit as a turn starts,
// PreToolUse before the Bash call's permission check, PostToolUse after it
// ran, Stop as the turn ends (not after an interrupt or an API error, as with
// Claude Code). `disableAllHooks` in any of them turns them off. A hook's
// output and exit code decide nothing here. No Notification: the permission
// question goes to the SDK as `can_use_tool`. On an e2e box the user settings
// are deploy/claude-settings.json, so the hooks report through termag-status
// as a real box's do (scripts/e2e/fakes/fakes.sh).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// `--name value` or `--name=value` (the Agent SDK sends --resume=<id> and --session-id=<id>).
const opt = name => {
  const eq = args.find(a => a.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const partial = args.includes('--include-partial-messages');
let mode = opt('--permission-mode') || 'default';
const sessionId = opt('--resume') || opt('--session-id') || randomUUID();
const cwd = process.cwd();
const MODEL = 'claude-stub';
const dir = join(homedir(), '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, `${sessionId}.jsonl`);
const baseDelay = Number(process.env.E2E_STUB_DELAY_MS ?? 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// E2E_STUB_LOG=<file>: every line in and out, for debugging a client.
const trace = (dir, line) => { if (process.env.E2E_STUB_LOG) appendFileSync(process.env.E2E_STUB_LOG, `${dir} ${line}\n`); };
trace('argv', JSON.stringify(args));
const write = obj => { const line = JSON.stringify(obj); trace('>>', line); process.stdout.write(`${line}\n`); };
const emit = ev => write({ ...ev, session_id: sessionId, uuid: randomUUID() });
// A resumed conversation goes on where its transcript ends.
const earlier = (() => {
  try { return readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
})();
let parentUuid = earlier.at(-1)?.uuid ?? null;
const record = (type, message) => {
  const uuid = randomUUID();
  appendFileSync(transcript, `${JSON.stringify({ type, uuid, parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, message })}\n`);
  parentUuid = uuid;
};

// ── hooks ───────────────────────────────────────────────────────────────────
const sourcesArg = opt('--setting-sources');
const sources = sourcesArg === undefined ? ['user', 'project', 'local'] : sourcesArg.split(',').map(x => x.trim()).filter(Boolean);
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const settingsFiles = [
  sources.includes('user') && readJson(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')),
  sources.includes('project') && readJson(join(cwd, '.claude', 'settings.json')),
  sources.includes('local') && readJson(join(cwd, '.claude', 'settings.local.json')),
  (() => {
    const v = opt('--settings');
    if (!v) return null;
    if (v.trim().startsWith('{')) { try { return JSON.parse(v); } catch { return null; } }
    return existsSync(v) ? readJson(v) : null;
  })(),
].filter(x => x && typeof x === 'object');
const hooksOff = settingsFiles.some(f => f.disableAllHooks === true);
const hookGroups = (event) => hooksOff ? [] : settingsFiles.flatMap(f => (Array.isArray(f.hooks?.[event]) ? f.hooks[event] : []));
const matches = (matcher, tool) => {
  if (tool === undefined || matcher === undefined || matcher === '' || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return matcher === tool; }
};
const runCommandHook = (command, input, env, timeoutSec) => new Promise((resolve) => {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'ignore', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), (Number(timeoutSec) > 0 ? Number(timeoutSec) : 60) * 1000);
  child.on('error', () => { clearTimeout(timer); resolve(-1); });
  child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(input));
});
let envFile = null;
async function runHooks(event, fields = {}, tool) {
  const hooks = hookGroups(event).filter(g => matches(g?.matcher, tool)).flatMap(g => (Array.isArray(g?.hooks) ? g.hooks : []))
    .filter(h => h?.type === 'command' && typeof h.command === 'string');
  if (hooks.length === 0) return;
  const input = { session_id: sessionId, transcript_path: transcript, cwd, permission_mode: mode, hook_event_name: event, ...fields };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
  if (event === 'SessionStart') {
    envFile ??= join(mkdtempSync(join(tmpdir(), 'claude-sdk-stub-')), 'env.sh');
    env.CLAUDE_ENV_FILE = envFile;
  }
  const codes = await Promise.all(hooks.map(h => runCommandHook(h.command, input, env, h.timeout)));
  trace('hook', `${event}${tool ? ` ${tool}` : ''} exit=${codes.join(',')}`);
}

// ── control requests, both ways ─────────────────────────────────────────────
const pending = new Map();
function askSdk(request) {
  const request_id = randomUUID();
  write({ type: 'control_request', request_id, request });
  return new Promise(resolve => pending.set(request_id, resolve));
}
const ok = (request_id, response = {}) => write({ type: 'control_response', response: { subtype: 'success', request_id, response } });

let interrupted = false;
function onControlRequest(msg) {
  const { request_id, request } = msg;
  switch (request?.subtype) {
    case 'initialize':
      ok(request_id, {
        commands: [{ name: 'compact', description: 'Clear history but keep a summary', argumentHint: '' }],
        models: [{ value: 'default', displayName: 'Stub', description: 'The e2e stand-in' }],
        account: { email: 'e2e@termag.local', subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' },
        output_style: 'default',
        available_output_styles: ['default'],
        pid: process.pid,
      });
      return;
    case 'interrupt':
      interrupted = true;
      ok(request_id);
      return;
    case 'set_permission_mode':
      if (typeof request.mode === 'string') mode = request.mode;
      ok(request_id);
      return;
    case 'mcp_status':
      ok(request_id, { mcpServers: [] });
      return;
    case 'mcp_set_servers':
      // The SDK's setMcpServers() result; the servers are accepted and never called.
      ok(request_id, { added: Object.keys(request.servers ?? {}), removed: [], errors: {} });
      return;
    default:
      ok(request_id);
  }
}

// ── one turn ────────────────────────────────────────────────────────────────
let initSent = false;
let sessionStarted = false;
// A turn is a prompt; a tool's result goes into the transcript as a user line too.
const isPrompt = entry => entry.type === 'user'
  && !(Array.isArray(entry.message?.content) && entry.message.content.some(block => block?.type === 'tool_result'));
let turnNo = earlier.filter(isPrompt).length;
let queue = Promise.resolve();

function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
}

async function streamText(text, delay) {
  const messageId = `msg_stub_${randomUUID().slice(0, 8)}`;
  if (partial) {
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } } });
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  }
  let sent = '';
  for (const word of text.split(/(?<= )/)) {
    if (interrupted) break;
    sent += word;
    if (partial) emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } });
    await sleep(delay);
  }
  if (partial) {
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: sent.split(' ').length } } });
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } });
  }
  const message = { id: messageId, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: sent }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: sent.split(' ').length } };
  emit({ type: 'assistant', parent_tool_use_id: null, message });
  record('assistant', message);
  return sent;
}

async function runBash() {
  const toolUseId = `toolu_stub_${randomUUID().slice(0, 8)}`;
  const input = { command: 'ls -1', description: 'List the files here' };
  const message = { id: `msg_stub_${randomUUID().slice(0, 8)}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
  emit({ type: 'assistant', parent_tool_use_id: null, message });
  record('assistant', message);
  await runHooks('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: toolUseId }, 'Bash');
  let allowed = mode === 'bypassPermissions' || mode === 'acceptEdits';
  let denial = 'Permission to use Bash has been denied.';
  if (!allowed) {
    const answer = await askSdk({ subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: toolUseId, permission_suggestions: [] });
    allowed = answer?.subtype === 'success' && answer.response?.behavior === 'allow';
    if (!allowed && typeof answer?.response?.message === 'string') denial = answer.response.message;
  }
  let content;
  let isError = false;
  if (allowed) {
    try { content = execFileSync('ls', ['-1'], { cwd, encoding: 'utf8' }).trim() || '(empty)'; } catch (err) { content = String(err.message); isError = true; }
  } else {
    content = denial;
    isError = true;
  }
  if (allowed && !isError) {
    await runHooks('PostToolUse', {
      tool_name: 'Bash', tool_input: input, tool_use_id: toolUseId,
      tool_response: { stdout: content, stderr: '', interrupted: false, isImage: false },
    }, 'Bash');
  }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] };
  emit({ type: 'user', parent_tool_use_id: null, message: result });
  record('user', result);
  return allowed;
}

async function turn(userMessage) {
  const startedAt = Date.now();
  interrupted = false;
  turnNo += 1;
  const prompt = textOf(userMessage?.content);
  if (!sessionStarted) {
    sessionStarted = true;
    await runHooks('SessionStart', { source: opt('--resume') ? 'resume' : 'startup' });
  }
  await runHooks('UserPromptSubmit', { prompt });
  if (!initSent) {
    initSent = true;
    emit({
      type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode: mode, apiKeySource: 'none',
      tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'], mcp_servers: [], slash_commands: ['compact'],
      output_style: 'default', skills: [], plugins: [],
    });
  }
  record('user', { role: 'user', content: userMessage?.content ?? '' });
  if (/^fail/i.test(prompt)) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', num_turns: 0, duration_ms: Date.now() - startedAt, duration_api_ms: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] });
    return;
  }
  let ran = null;
  if (/^run/i.test(prompt)) ran = await runBash();
  const delay = baseDelay * (/^long/i.test(prompt) ? 10 : 1);
  const answer = ran === null
    ? `Stub Claude here (turn ${turnNo}, ${mode}). You said: ${prompt || '(nothing)'}`
    : ran ? 'I listed the files in this directory with `ls -1`; the output is above.' : 'I was not allowed to run `ls -1`, so I did not list the files.';
  const text = await streamText(answer, delay);
  if (!interrupted) await runHooks('Stop', { stop_hook_active: false });
  emit({
    type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', is_error: interrupted,
    result: interrupted ? 'Interrupted' : text, num_turns: ran === null ? 1 : 2,
    duration_ms: Date.now() - startedAt, duration_api_ms: Date.now() - startedAt, total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: text.split(' ').length, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [],
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  trace('<<', line);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') { onControlRequest(msg); return; }
  if (msg.type === 'control_response') {
    const resolve = pending.get(msg.response?.request_id);
    if (resolve) { pending.delete(msg.response.request_id); resolve(msg.response); }
    return;
  }
  if (msg.type === 'control_cancel_request') return;
  if (msg.type === 'user') queue = queue.then(() => turn(msg.message)).catch((err) => process.stderr.write(`claude-sdk stub: ${err.stack}\n`));
});
rl.on('close', () => { queue.then(() => process.exit(0)); });
