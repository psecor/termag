#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` on the e2e boxes
// (E2E_FAKE_CLAUDE=1), the mode the simple UI's chat runner drives
// (agent/chat-runner.js). Reads the prompt on stdin and prints what Claude
// Code prints: a system init with the session id, partial-message stream
// events (with --include-partial-messages), one assistant event per content
// block, tool results as user events, and a result. Two tool calls run for
// real in the cwd (a listing and a README read), then a markdown answer with
// a code block. The conversation goes to ~/.claude/projects/<cwd>/<id>.jsonl
// in Claude's transcript shape, so --resume <id> continues it and the
// runner's history reads it back.
//
// The permission mode is honoured as Claude Code does in print mode:
// bypassPermissions (or acceptEdits) runs the shell command; any other mode
// refuses it with Claude Code's permission error, while the read still runs.
//
// Env: E2E_STUB_DELAY_MS (default 30) between streamed words; a prompt that
// starts with "long" streams ten times slower.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const partial = args.includes('--include-partial-messages');
const resume = opt('--resume');
const mode = opt('--permission-mode') || 'default';
// --tools leaves only the listed built-ins; without Bash the listing is a Glob.
const tools = opt('--tools');
const hasBash = tools == null || tools.split(',').includes('Bash');
const mayRun = hasBash && (mode === 'bypassPermissions' || mode === 'acceptEdits');

const prompt = readFileSync(0, 'utf8').trim();
const cwd = process.cwd();
const sessionId = resume || randomUUID();
const dir = join(homedir(), '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, `${sessionId}.jsonl`);
const earlier = existsSync(transcript)
  ? readFileSync(transcript, 'utf8').split('\n').filter(Boolean).filter(l => JSON.parse(l).type === 'user').length
  : 0;

const slow = /^long/i.test(prompt);
const delay = Number(process.env.E2E_STUB_DELAY_MS ?? 30) * (slow ? 10 : 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const emit = ev => process.stdout.write(`${JSON.stringify({ ...ev, session_id: sessionId })}\n`);
let parentUuid = null;
const record = (type, message) => {
  const uuid = randomUUID();
  appendFileSync(transcript, `${JSON.stringify({ type, uuid, parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, message })}\n`);
  parentUuid = uuid;
  return uuid;
};

process.on('SIGINT', () => {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted', num_turns: 0 });
  process.exit(130);
});

emit({ type: 'system', subtype: 'init', cwd, model: 'claude-stub', permissionMode: opt('--permission-mode') || 'default', tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'] });
record('user', { role: 'user', content: prompt });

// One assistant API message: text blocks streamed word by word, tool_use
// blocks streamed as input JSON, then one assistant event per block.
async function assistantMessage(blocks) {
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  if (partial) emit({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', content: [] } } });
  for (const [index, block] of blocks.entries()) {
    if (partial) {
      const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} };
      emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: start } });
      if (block.type === 'text') {
        for (const word of block.text.match(/\S+\s*|\s+/g) ?? []) {
          emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } } });
          await sleep(delay);
        }
      } else {
        const json = JSON.stringify(block.input);
        for (let i = 0; i < json.length; i += 12) {
          emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 12) } } });
          await sleep(delay);
        }
      }
      emit({ type: 'stream_event', event: { type: 'content_block_stop', index } });
    }
    const message = { id, type: 'message', role: 'assistant', model: 'claude-stub', content: [block] };
    record('assistant', message);
    emit({ type: 'assistant', message, parent_tool_use_id: null });
  }
  if (partial) emit({ type: 'stream_event', event: { type: 'message_stop' } });
}

async function toolResult(id, content, isError = false) {
  await sleep(delay * 8);
  const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] };
  record('user', message);
  emit({ type: 'user', message, parent_tool_use_id: null });
}

const entries = (() => { try { return readdirSync(cwd).filter(n => n !== '.git').sort(); } catch { return []; } })();
const readme = entries.find(n => /^readme(\.md)?$/i.test(n));
const project = basename(cwd);

const lsId = `toolu_${randomUUID().slice(0, 8)}`;
const intro = earlier > 0 ? 'Picking up where we left off. Let me check the tree again.' : `I'll start by looking at how ${project} is laid out.`;
if (hasBash) {
  await assistantMessage([
    { type: 'text', text: intro },
    { type: 'tool_use', id: lsId, name: 'Bash', input: { command: 'ls -la', description: 'List the repository root' } },
  ]);
  if (mayRun) await toolResult(lsId, entries.length ? entries.map(n => `-rw-r--r--  1 user user   ${n}`).join('\n') : '(empty directory)');
  else await toolResult(lsId, "Claude requested permissions to use Bash, but you haven't granted it yet.", true);
} else {
  await assistantMessage([
    { type: 'text', text: intro },
    { type: 'tool_use', id: lsId, name: 'Glob', input: { pattern: '*' } },
  ]);
  await toolResult(lsId, entries.length ? entries.map(n => join(cwd, n)).join('\n') : 'No files found');
}

const readId = `toolu_${randomUUID().slice(0, 8)}`;
await assistantMessage([{ type: 'tool_use', id: readId, name: 'Read', input: { file_path: join(cwd, readme || 'README.md') } }]);
await toolResult(readId, readme ? readFileSync(join(cwd, readme), 'utf8').split('\n').slice(0, 20).map((l, i) => `${String(i + 1).padStart(4)}→${l}`).join('\n') : 'File does not exist.', !readme);

const answer = mayRun ? [
  `Here's what I found in **${project}** for _${prompt.slice(0, 80)}_:`,
  '',
  '## Layout',
  `- ${entries.length} entries at the top level${readme ? `, including \`${readme}\`` : ''}`,
  `- ${readme ? 'The README explains the basics' : 'There is no README yet'}`,
  '',
  '## Running it',
  '```bash',
  'npm install',
  'npm test -- --watch=false',
  '```',
  '',
  'Want me to add a CI workflow that runs this on every push?',
].join('\n') : [
  `Here's what I can tell from reading **${project}**:`,
  '',
  `- ${entries.length} entries at the top level${readme ? `, including \`${readme}\`` : ''}`,
  `- ${readme ? 'The README explains the basics' : 'There is no README yet'}`,
  '',
  "I can read the code and answer questions here, but I can't run commands or edit files in this chat, so I haven't run anything.",
].join('\n');
await assistantMessage([{ type: 'text', text: answer }]);

emit({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3, result: answer,
  total_cost_usd: 0.0123, usage: { input_tokens: 1200, output_tokens: 240 },
});
