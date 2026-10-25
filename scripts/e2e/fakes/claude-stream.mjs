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
// runner's history reads it back. Like Claude Code, it names the session from
// its opening (an `ai-title` line, here the prompt's first words) and writes
// the same name again every turn (agent/session-title.js).
//
// The permission mode is honoured as Claude Code does in print mode:
// bypassPermissions (or acceptEdits) runs the shell command; any other mode
// refuses it with Claude Code's permission error, while the read still runs.
//
// Env: E2E_STUB_DELAY_MS (default 30) between streamed words; a prompt that
// starts with "long" streams ten times slower, and one that starts with
// "survey" runs five more shell commands after the listing, one that starts
// with "skill" loads a skill first (the Skill tool), one that starts with
// "background" starts three background tasks (one a `termag ask`) and keeps
// the turn open after its answer for E2E_BACKGROUND_MS (default ten minutes)
// or until stopped ("long background" streams it slower), one that
// starts with "markdown" answers with every element the chat's renderer
// reads (GFM tables, task and nested lists, quotes, strikethrough, autolinks;
// see frontend/src/chat/markdownParse.ts), one that starts with "echo " answers
// with the rest of the prompt as its markdown (a space file link, say), and
// one that starts with "fail" ends at
// once with an overloaded API error. An interrupt
// control request (the chat's turn-only Stop) ends the turn's current work and
// leaves the background tasks running; SIGINT (Stop everything) ends it all.
//
// With --input-format stream-json (a live turn, or a turn whose message
// carries images, agent/chat-images.js) the prompt is the first user line; its
// image blocks are answered from their own bytes (type, size, and a PNG's
// average colour) instead of the repository tour, so a demo's "description"
// is of the image that was really sent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const partial = args.includes('--include-partial-messages');
const resume = opt('--resume');
const mode = opt('--permission-mode') || 'default';
// --tools leaves only the listed built-ins; without Bash the listing is a Glob.
const tools = opt('--tools');
const hasBash = tools == null || tools.split(',').includes('Bash');
const mayRun = hasBash && (mode === 'bypassPermissions' || mode === 'acceptEdits');

// A live turn (--input-format stream-json) keeps stdin open: the prompt is its
// first user line (text, or blocks with images: agent/chat-images.js), later user lines are not read, and an interrupt
// control_request ends the turn's current work as Claude Code does (see
// `interrupt` below).
let onInterrupt = () => {};
const firstUserContent = () => new Promise(resolve => {
  let buf = '';
  let prompted = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* not JSON */ }
      if (msg?.type === 'control_request' && msg.request?.subtype === 'interrupt') {
        emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
        onInterrupt();
      } else if (!prompted && msg?.type === 'user') {
        prompted = true;
        resolve(msg.message?.content ?? '');
      }
    }
  });
  process.stdin.on('end', () => {
    if (prompted) return;
    try { resolve(JSON.parse(buf).message?.content ?? ''); } catch { resolve(buf.trim()); }
  });
});
const live = opt('--input-format') === 'stream-json';
const userContent = live ? await firstUserContent() : readFileSync(0, 'utf8').trim();
const blocks = Array.isArray(userContent) ? userContent : [];
const prompt = typeof userContent === 'string'
  ? userContent.trim()
  : blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
const images = blocks.filter(b => b?.type === 'image' && b.source?.type === 'base64');
const startedAt = Date.now();
const cwd = process.cwd();
const sessionId = resume || randomUUID();
const dir = join(homedir(), '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, `${sessionId}.jsonl`);
const earlier = existsSync(transcript)
  ? readFileSync(transcript, 'utf8').split('\n').filter(Boolean).filter(l => JSON.parse(l).type === 'user').length
  : 0;
const keptTitle = existsSync(transcript)
  ? readFileSync(transcript, 'utf8').split('\n').filter(l => l.includes('"ai-title"')).map(l => JSON.parse(l).aiTitle).pop()
  : null;
const openingWords = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').replace(/[.?!,:;]+$/, '');
const aiTitle = keptTitle || (openingWords ? openingWords[0].toUpperCase() + openingWords.slice(1) : 'Image description');

const slow = /^long\b/i.test(prompt);
const survey = /^survey/i.test(prompt);
const SURVEY = [
  ['git log --oneline -5', 'Recent commits'],
  ['git status --short', 'Working tree state'],
  ['wc -l AGENTS.md CLAUDE.md', 'Size of the agent docs'],
  ['grep -rn TODO . --exclude-dir=.git', 'Open TODOs'],
  ['du -sh .', 'Checkout size'],
];
const background = /^(long )?background/i.test(prompt);
const BACKGROUND = [
  ['npm test -- --watch=false', 'Run the test suite'],
  ['npm run build', 'Build the frontend'],
  ['termag ask devbox/api "Does the schema allow null owners?"', 'Ask devbox/api about null owners'],
];
const skill = /^skill/i.test(prompt);
const SKILL_BODY = [
  `Base directory for this skill: ${join(homedir(), '.claude/skills/termag-spaces')}`,
  '',
  '---',
  'name: termag-spaces',
  'description: Read and write files in a termag space with `termag space`.',
  '---',
  '',
  '# termag spaces',
  '',
  'A space is a named file store shared by people and the boxes they grant.',
  '',
  '## Commands',
  '- `termag space ls` lists the spaces this box may use',
  '- `termag space get <space>/<path> <file>` downloads a file',
  '- `termag space put <file> <space>/<path>` uploads one',
  '',
  'Never print a presigned URL; give the `/termag/files/<space>/<path>` link instead.',
].join('\n');
const delay = Number(process.env.E2E_STUB_DELAY_MS ?? 30) * (slow ? 10 : 1);
// The turn's own work sleeps through `sleep`, which an interrupt cuts short;
// the wait on background tasks after the answer uses `wait`, which it does not.
const INTERRUPTED = Symbol('interrupted');
const sleeping = new Set();
let answered = false;
let interrupted = false;
const wait = ms => new Promise(r => setTimeout(r, ms));
function emit(ev) { process.stdout.write(`${JSON.stringify({ ...ev, session_id: sessionId })}\n`); }
const sleep = ms => new Promise((resolve, reject) => {
  if (interrupted) { reject(INTERRUPTED); return; }
  const s = { reject, timer: setTimeout(() => { sleeping.delete(s); resolve(); }, ms) };
  sleeping.add(s);
});
onInterrupt = () => {
  if (answered || interrupted) return;
  interrupted = true;
  for (const s of sleeping) { clearTimeout(s.timer); s.reject(INTERRUPTED); }
  sleeping.clear();
};
let parentUuid = null;
let openTool = null;
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
record('user', { role: 'user', content: userContent });
appendFileSync(transcript, `${JSON.stringify({ type: 'ai-title', aiTitle, sessionId })}\n`);

if (/^fail/i.test(prompt)) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', num_turns: 0 });
  process.exit(1);
}

/** What an image's bytes say: its size and, for an 8-bit RGB(A) PNG, its average colour. */
function describeImage(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), depth = buf[24], colorType = buf[25];
    const out = { kind: 'PNG', width, height, colour: null };
    const channels = { 2: 3, 6: 4 }[colorType];
    if (depth !== 8 || !channels) return out;
    const idat = [];
    for (let at = 8; at + 8 <= buf.length;) {
      const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
      if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
      at += 12 + len;
    }
    let raw;
    try { raw = inflateSync(Buffer.concat(idat)); } catch { return out; }
    const stride = width * channels, prev = Buffer.alloc(stride), row = Buffer.alloc(stride);
    const sum = [0, 0, 0];
    for (let y = 0; y < height; y++) {
      const base = y * (stride + 1), filter = raw[base];
      for (let x = 0; x < stride; x++) {
        const v = raw[base + 1 + x], a = x >= channels ? row[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[x] = (v + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]) & 0xff;
      }
      for (let x = 0; x < stride; x += channels) { sum[0] += row[x]; sum[1] += row[x + 1]; sum[2] += row[x + 2]; }
      row.copy(prev);
    }
    const n = width * height || 1;
    out.colour = `#${sum.map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('')}`;
    return out;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let at = 2; at + 9 < buf.length;) {
      if (buf[at] !== 0xff) break;
      const marker = buf[at + 1], len = buf.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { kind: 'JPEG', height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7), colour: null };
      at += 2 + len;
    }
    return { kind: 'JPEG', width: null, height: null, colour: null };
  }
  return { kind: buf.toString('latin1', 0, 3) === 'GIF' ? 'GIF' : 'WebP', width: null, height: null, colour: null };
}

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
    if (block.type === 'tool_use') openTool = block.id;
  }
  if (partial) emit({ type: 'stream_event', event: { type: 'message_stop' } });
}

async function toolResult(id, content, isError = false) {
  await sleep(delay * 8);
  const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] };
  record('user', message);
  emit({ type: 'user', message, parent_tool_use_id: null });
  openTool = null;
}

const entries = (() => { try { return readdirSync(cwd).filter(n => n !== '.git').sort(); } catch { return []; } })();
const readme = entries.find(n => /^readme(\.md)?$/i.test(n));
const project = basename(cwd);

// The Skill tool as Claude Code runs it: a short tool result, then the
// skill's SKILL.md as a synthetic user message (isSynthetic in stream-json,
// isMeta with the tool's id in the transcript).
const MARKDOWN_ANSWER = [
  `# Markdown in **${project}**`,
  '',
  'A table, with alignment and inline markup in its cells:',
  '',
  '| Check | Status | Time | Notes |',
  '| :--- | :---: | ---: | --- |',
  '| `backend` build | **pass** | 41 s | tsc, no errors |',
  '| `frontend` tests | **pass** | 12 s | 1170 tests<br>129 files |',
  '| e2e | ~~skipped~~ *flaky* | 3 m | see [the guide](https://example.com/e2e) |',
  '| lint | n/a | 0 s | none configured; escaped \\| pipe |',
  '',
  '## Lists',
  '1. Install',
  '   - with `npm`',
  '     - or `pnpm`',
  '2. Run the tests',
  '',
  '- [x] tables',
  '- [ ] footnotes',
  '',
  '> **Note:** quotes hold blocks too:',
  '> - like this list',
  '',
  '---',
  '',
  '```ts',
  "const ok = parseMarkdown('| a |\\n|---|');",
  '```',
  '',
  'Autolinks like https://example.com/docs, <mailto:dev@example.com>, an image ![chart](https://example.com/chart.png), \\*escaped\\* stars, `<b>` and <b>raw HTML</b> stays text.',
].join('\n');

const tasks = [];
try {
  if (skill) {
    const skillId = `toolu_${randomUUID().slice(0, 8)}`;
    await assistantMessage([
      { type: 'text', text: 'This is about spaces, so I\'ll load the skill for them first.' },
      { type: 'tool_use', id: skillId, name: 'Skill', input: { skill: 'termag-spaces' } },
    ]);
    await toolResult(skillId, 'Launching skill: termag-spaces');
    const message = { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] };
    const uuid = randomUUID();
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid, parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, isMeta: true, sourceToolUseID: skillId, message })}\n`);
    parentUuid = uuid;
    emit({ type: 'user', message, parent_tool_use_id: null, uuid, isSynthetic: true });
  }

  if (images.length) {
    const lines = images.map((img, i) => {
      const d = describeImage(Buffer.from(img.source.data, 'base64'));
      const size = d.width ? ` of ${d.width}×${d.height} pixels` : '';
      const colour = d.colour ? `, mostly the colour \`${d.colour}\`` : '';
      return `- Image ${i + 1}: a ${d.kind}${size}${colour}`;
    });
    const answer = [
      images.length === 1 ? 'I can see the image you sent:' : `I can see the ${images.length} images you sent:`,
      '',
      ...lines,
      '',
      prompt ? `You asked: _${prompt.slice(0, 120)}_. (This is the e2e stand-in for Claude, so that is all it can say about pixels.)` : '(This is the e2e stand-in for Claude, so that is all it can say about pixels.)',
    ].join('\n');
    await assistantMessage([{ type: 'text', text: answer }]);
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 1, result: answer, total_cost_usd: Math.round((0.004 + answer.length * 0.00004) * 10000) / 10000, usage: { input_tokens: 1600, output_tokens: 80 } });
    process.exit(0);
  }

  const lsId = `toolu_${randomUUID().slice(0, 8)}`;
  const intro = earlier > 0 ? 'Picking up where we left off. Let me check the tree again.' : `I'll start by looking at how ${project} is laid out.`;
  if (hasBash) {
    await assistantMessage([
      { type: 'text', text: intro },
      { type: 'tool_use', id: lsId, name: 'Bash', input: { command: 'ls -la', description: 'List the repository root' } },
    ]);
    if (mayRun) await toolResult(lsId, entries.length ? entries.map(n => `-rw-r--r--  1 user user   ${n}`).join('\n') : '(empty directory)');
    else await toolResult(lsId, "Claude requested permissions to use Bash, but you haven't granted it yet.", true);
    if (background && mayRun) {
      for (const [command, description] of BACKGROUND) {
        const id = `toolu_${randomUUID().slice(0, 8)}`;
        await assistantMessage([{ type: 'tool_use', id, name: 'Bash', input: { command, description, run_in_background: true } }]);
        const taskId = `b${randomUUID().slice(0, 6)}`;
        await toolResult(id, `Command running in background with ID: ${taskId}`);
        tasks.push({ task_id: taskId, task_type: 'local_bash', description });
        emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [...tasks] });
      }
    }
    if (survey) {
      for (const [command, description] of SURVEY) {
        const id = `toolu_${randomUUID().slice(0, 8)}`;
        await assistantMessage([{ type: 'tool_use', id, name: 'Bash', input: { command, description } }]);
        if (mayRun) await toolResult(id, `(${command}: nothing to report)`);
        else await toolResult(id, "Claude requested permissions to use Bash, but you haven't granted it yet.", true);
      }
    }
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

  const echoed = /^echo\s/i.test(prompt) ? prompt.replace(/^echo\s+/i, '') : null;
  const answer = echoed !== null ? echoed : /^markdown/i.test(prompt) ? MARKDOWN_ANSWER : mayRun ? [
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

  answered = true;
  emit({
    type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 3, result: answer,
    // Priced like a short Sonnet turn: a base for the context, plus the output.
    total_cost_usd: Math.round((0.018 + answer.length * 0.00004 + prompt.length * 0.00002) * 10000) / 10000,
    usage: { input_tokens: 1200 + prompt.length, output_tokens: Math.ceil(answer.length / 4) },
  });
} catch (err) {
  if (err !== INTERRUPTED) throw err;
  // Claude Code's interrupt: the foreground tool call is refused, the turn
  // ends with error_during_execution, and background commands go on.
  answered = true;
  interrupted = false;
  const refused = '[Request interrupted by user for tool use]';
  if (openTool) {
    const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: openTool, content: refused, is_error: true }] };
    record('user', message);
    emit({ type: 'user', message, parent_tool_use_id: null });
  }
  const message = { role: 'user', content: [{ type: 'text', text: refused }] };
  record('user', message);
  emit({ type: 'user', message, parent_tool_use_id: null });
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: Date.now() - startedAt, num_turns: 1, errors: ['[ede_diagnostic] result_type=user'] });
}

// The turn stays open on its background tasks until they end or it is stopped.
// A stop of everything (SIGINT) ends it at once; an interrupt does not. When
// the tasks end, Claude takes one more turn on their notification.
if (tasks.length) {
  await wait(Number(process.env.E2E_BACKGROUND_MS ?? 600_000));
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  const done = `The background work finished: ${tasks.map(t => t.description).join(', ')}.`;
  await assistantMessage([{ type: 'text', text: done }]);
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 1, result: done, total_cost_usd: 0.004, usage: { input_tokens: 400, output_tokens: 20 } });
}
process.exit(0);
