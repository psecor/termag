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
// runner's history reads it back. Like Claude Code on Bedrock, which is every
// real box, it names no session; with E2E_CLAUDE_AI_TITLES=1 (env or the box's
// ~/.termag/e2e-claude.env) it writes the `ai-title` line Claude Code writes on
// the first-party API, the prompt's first words, again every turn
// (agent/session-title.js). With --output-format json it is the box's own
// title call instead (session-title.js generateTitle): the opening message on
// stdin, a title from its first words back as one result, nothing written.
//
// The permission mode is honoured as Claude Code does in print mode:
// bypassPermissions (or acceptEdits) runs the shell command; any other mode
// refuses it with Claude Code's permission error, while the read still runs.
//
// Env: E2E_STUB_DELAY_MS (default 30; also read from the box's
// ~/.termag/e2e-claude.env) between streamed words; a prompt that
// starts with "long" streams ten times slower, and one that starts with
// "survey" runs five more shell commands after the listing, one that starts
// with "skill" loads a skill first (the Skill tool), one that starts with
// "background" starts three background tasks (one a `termag ask`) and keeps
// the turn open after its answer while they run: they end one by one over
// E2E_BACKGROUND_MS (default ten minutes), each end waking Claude in the same
// process as Claude Code does (task_notification, background_tasks_changed, a
// new init, a Read of the task's output and an answer with its own result),
// or until stopped ("long background" streams it slower), one that
// starts with "markdown" answers with every element the chat's renderer
// reads (GFM tables, task and nested lists, quotes, strikethrough, autolinks;
// see frontend/src/chat/markdownParse.ts), one that starts with "echo " answers
// with the rest of the prompt as its markdown (a space file link, say), one
// that starts with "genui" answers with generative UI (```spec fences from
// fakes/genui/, docs/simple-ui-chat-generative-ui.md: "genui rollout",
// "genui <name>" for fakes/genui/<name>.jsonl, "genui" alone for every one), a message carrying a ```ui-action fence (a generative UI answer,
// frontend/src/chat/genui/action.ts) is read back with what it carried and
// whether the turn had generative UI's system prompt (--append-system-prompt-file,
// agent chat-genui-v1), and one that starts with "fail" ends at
// once with an overloaded API error. `/compact` on a resumed session compacts
// it as Claude Code 2.1.310 does headless (agent chat-context-v1): a
// compact_boundary event and transcript line with the context it started
// from, the summary as a synthetic user message (isCompactSummary in the
// transcript), the "Compacted" echo, and a result with `local_command`.
// Later turns count only what came after the last boundary, so the context
// ring drops, and they say they go on from the summary. An interrupt
// control request (the chat's turn-only Stop) ends the turn's current work and
// leaves the background tasks running; SIGINT (Stop everything) ends it all.
//
// With --input-format stream-json (a live turn, or a turn whose message
// carries images, agent/chat-images.js) the prompt is the first user line; its
// image blocks are answered from their own bytes (type, size, and a PNG's
// average colour) instead of the repository tour, so a demo's "description"
// is of the image that was really sent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const partial = args.includes('--include-partial-messages');
const resume = opt('--resume');
const mode = opt('--permission-mode') || 'default';
// The chat's effort (agent/chat-runner.js turnArgs): said at the end of the answer, so a stack shows it.
const effort = opt('--effort');
// Generative UI's system prompt (backend services/chatGenUi.ts), when the turn got one: the
// runner appends it from a file (agent/chat-runner.js appendedSystemPrompt), as Claude Code reads it.
const appendedPrompt = (() => {
  const file = opt('--append-system-prompt-file');
  try { return file ? readFileSync(file, 'utf8') : opt('--append-system-prompt') || ''; } catch { return ''; }
})();
const genUiPrompted = appendedPrompt.includes('GENERATIVE UI (termag):');
// With only the hint appended (agent chat-genui-v2), the reference it names: there, and in a directory the turn
// was given (--add-dir), so even a confined turn could Read it as Claude Code would.
const genUiReference = (() => {
  const file = /Read (\/\S+?\.md)\b/.exec(appendedPrompt)?.[1];
  if (!genUiPrompted || !file) return null;
  const dirs = args.flatMap((a, i) => (a === '--add-dir' && args[i + 1] ? [args[i + 1]] : []));
  try { return dirs.some(d => file.startsWith(`${d}/`)) && readFileSync(file, 'utf8').includes('AVAILABLE COMPONENTS') ? 'readable' : 'unreadable'; } catch { return 'unreadable'; }
})();
// --tools leaves only the listed built-ins; without Bash the listing is a Glob.
const tools = opt('--tools');
const hasBash = tools == null || tools.split(',').includes('Bash');
const mayRun = hasBash && (mode === 'bypassPermissions' || mode === 'acceptEdits');

if (opt('--output-format') === 'json' && args.includes('--no-session-persistence')) {
  const input = readFileSync(0, 'utf8');
  const message = (/<message>\n?([\s\S]*?)\n?<\/message>/.exec(input)?.[1] ?? input).replace(/\s+/g, ' ').trim();
  const words = message.split(' ').slice(0, 6).join(' ').replace(/[.?!,:;]+$/, '');
  const title = words ? words[0].toUpperCase() + words.slice(1) : 'New session';
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: title, total_cost_usd: 0 })}\n`);
  process.exit(0);
}

// A live turn (--input-format stream-json) keeps stdin open: the prompt is its
// first user line (text, or blocks with images: agent/chat-images.js), and an interrupt
// control_request ends the turn's current work as Claude Code does (see
// `interrupt` below). A later user line (a live chat message, a steered ask)
// that arrives while it works (the first answer, or a background task's
// wake-up) is taken in at the next tool boundary and answered in the same
// result, as Claude Code does, and the transcript keeps it only as a
// queued_command; one that arrives after the answer gets a query and a result
// of its own. Each is replayed when taken in, with --replay-user-messages; the
// process ends once stdin has closed, its background tasks have ended and
// every line is answered (takeIn, answerLater).
let onInterrupt = () => {};
const laterMessages = [];
let stdinEnded = false;
let wakeLater = () => {};
const replays = args.includes('--replay-user-messages');
/** A user line's words: its text, or the text blocks of a content array. */
const contentText = c => (typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '')).trim();
/**
 * A later user line taken in, as Claude Code 2.1.310 does it: replayed on
 * stdout with --replay-user-messages. Taken in mid-work (at a tool boundary)
 * the transcript keeps no user line, only a queued_command attachment under
 * the replay's uuid; taken in while idle it is a user line that starts a query.
 */
function takeIn(content, midWork) {
  const message = { role: 'user', content };
  let uuid;
  if (midWork) {
    uuid = randomUUID();
    appendFileSync(transcript, `${JSON.stringify({ type: 'attachment', uuid: randomUUID(), parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, attachment: { type: 'queued_command', prompt: contentText(content), source_uuid: uuid, commandMode: 'prompt' } })}\n`);
  } else {
    uuid = record('user', message);
  }
  if (replays) emit({ type: 'user', message, parent_tool_use_id: null, uuid, isReplay: true });
  return uuid;
}
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
      } else if (msg?.type === 'user') {
        laterMessages.push(msg.message?.content ?? '');
        wakeLater();
      }
    }
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    wakeLater();
    if (prompted) return;
    try { resolve(JSON.parse(buf).message?.content ?? ''); } catch { resolve(buf.trim()); }
  });
});
const live = opt('--input-format') === 'stream-json';
const userContent = live ? await firstUserContent() : readFileSync(0, 'utf8').trim();
const blocks = Array.isArray(userContent) ? userContent : [];
const sent = typeof userContent === 'string'
  ? userContent.trim()
  : blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
// What happened to the box since the last turn (agent/box-notice.js) leads the
// message. The stand-in quotes it back first, as a real Claude would act on it,
// and reads the rest as the prompt.
const BOX_NOTICE = /^<termag-box-notice>\n([\s\S]*?)\n<\/termag-box-notice>\n*/;
const boxNotice = BOX_NOTICE.exec(sent)?.[1] ?? null;
// Space memory's notice of a change (agent/space-memory.js) comes next; Claude reads it as context, not as the prompt.
const SPACE_MEMORY_NOTICE = /^<space-memory-notice>\n[\s\S]*?\n<\/space-memory-notice>\n*/;
const prompt = sent.replace(BOX_NOTICE, '').replace(SPACE_MEMORY_NOTICE, '').trim();
const images = blocks.filter(b => b?.type === 'image' && b.source?.type === 'base64');
const startedAt = Date.now();
const cwd = process.cwd();
const sessionId = resume || randomUUID();
const dir = join(homedir(), '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, `${sessionId}.jsonl`);
const lines = existsSync(transcript) ? readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const lastBoundary = lines.map(e => e.type === 'system' && e.subtype === 'compact_boundary').lastIndexOf(true);
// What the context holds: the turns since the last compaction (its summary and echo are not turns).
const earlier = lines.slice(lastBoundary + 1).filter(e => e.type === 'user' && !e.isCompactSummary && !/^<command-name>/.test(typeof e.message?.content === 'string' ? e.message.content : '')).length;
const compactedBefore = lastBoundary >= 0;
const keptTitle = existsSync(transcript)
  ? readFileSync(transcript, 'utf8').split('\n').filter(l => l.includes('"ai-title"')).map(l => JSON.parse(l).aiTitle).pop()
  : null;
const openingWords = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').replace(/[.?!,:;]+$/, '');
const aiTitle = keptTitle || (openingWords ? openingWords[0].toUpperCase() + openingWords.slice(1) : 'Image description');

const slow = /^long\b/i.test(prompt);
const survey = /^(long )?(quiet )?survey/i.test(prompt);
// `quiet survey`: the run of calls starts with no sentence from Claude before it.
// `quiet check`: just the listing and the README read, with no sentence before them either.
const quiet = /^(long )?quiet (survey|check)/i.test(prompt);
// [command, description, error]: a step with an error fails, as a missing script does.
const SURVEY = [
  ['git log --oneline -5', 'Show the last five commits'],
  ['git status --short', 'Check the working tree for changes'],
  ['wc -l AGENTS.md CLAUDE.md', 'Count lines in the agent docs'],
  ['npm run lint', 'Run the linter', 'npm error Missing script: "lint"'],
  ['grep -rn TODO . --exclude-dir=.git', 'Find open TODOs'],
  ['du -sh .', 'Measure the checkout size'],
];
const background = /^(long )?background/i.test(prompt);
const BACKGROUND = [
  ['npm test -- --watch=false', 'Run the test suite'],
  ['npm run build', 'Build the frontend'],
  ['termag ask devbox/api "Does the schema allow null owners?"', 'Ask devbox/api about null owners'],
];
const skill = /^skill/i.test(prompt);
// `subagents`: three Agent calls as Claude Code 2.1.312 runs them, two in the
// foreground and one in the background, for the chat's subagents.
// Needs Bash: an untrusted chat gets the tour.
const subagents = /^(long )?subagents/i.test(prompt);
const SUBAGENTS = [
  {
    type: 'Explore', description: 'Map the repository layout',
    prompt: "List the top level of this repository and say what each entry is for. Don't change anything; report a short list.",
    steps: [['Bash', { command: 'ls -la', description: 'List the repository root' }], ['Glob', { pattern: '*/' }]],
  },
  {
    type: 'general-purpose', description: 'Check the README for setup steps',
    prompt: 'Read the README and list the setup steps it gives, in order. Say what a new contributor would be missing.',
    steps: [['Read', { file_path: 'README.md' }], ['Grep', { pattern: 'npm (install|test)', output_mode: 'content' }]],
  },
  {
    type: 'general-purpose', description: 'Run the test suite', background: true,
    prompt: 'Run the test suite once and report how many tests pass and fail. Fix nothing.',
    steps: [['Bash', { command: 'npm test -- --watch=false', description: 'Run the test suite' }], ['Read', { file_path: 'package.json' }]],
  },
];
// `asks` (trusted chats only): an orchestrator's fan-out (the agent-orchestrator
// skill), three real `termag ask --no-wait` calls to E2E_ASK_TARGET (default
// box-2/sample; the env or a box's ~/.termag/e2e-claude.env), each a prompt
// file written first, for the chat's ask rows.
// The calls run the box's own `termag`, so the threads, their chats on
// the target and the parent link are real; a box without the CLI gets its error.
const asks = /^(long )?asks/i.test(prompt);
const ASKS = [
  ['Titanic wreck: discovery', 'discovery', 'Research how and when the wreck of the RMS Titanic was found: the date, the expedition, who led it and what found it. Cite two sources, and reply with one line.'],
  ['Titanic wreck: location', 'location', 'Research where the wreck lies and what state it is in: its depth, how far it is from land, how it broke apart and how fast it is decaying. Cite two sources, and reply with one line.'],
  ['Titanic wreck: expeditions', 'expeditions', 'List the notable expeditions to the wreck since it was found: who went, when, and what each one did or brought back. Cite two sources, and reply with one line.'],
];
// termag's ask finish notice:
// answered as an orchestrator would, naming what finished and, in a trusted
// chat, checking `termag ask --inbox` first.
const askNotice = /^\[termag\] (?:Your ask |\d+ of your asks finished)/.test(prompt);
// `triage`: a turn of three runs of tool calls with Claude's text between them
// (reproduce, find, fix), for the chat's tool-group headings.
// Needs Bash: an untrusted chat gets the tour.
const triage = /^(long )?triage/i.test(prompt);
const TRIAGE = [
  {
    lead: 'Let me reproduce the failing check first.',
    calls: [
      ['Bash', { command: 'npm test -- --watch=false', description: 'Run the test suite' }, 'Exit code 1\nFAIL src/config.test.ts\n  ● config › reads the port from PORT\n    expected 8080, received NaN\nTests: 1 failed, 13 passed, 14 total', true],
      ['Bash', { command: 'git log --oneline -3 -- src/config.ts', description: 'Show recent changes to the config' }, 'a1b2c3d read the port from the environment\n9f8e7d6 add config module'],
    ],
  },
  {
    lead: 'The test wants a default port, and the last change to `config.ts` reads it from the environment. Checking where:',
    calls: [
      ['Grep', { pattern: 'PORT', path: 'src', output_mode: 'content' }, 'src/config.ts:4:export const port = Number(process.env.PORT);\nsrc/server.ts:12:app.listen(port);'],
      ['Read', { file_path: 'src/config.ts' }, '   1→// Settings read once at start-up.\n   2→\n   3→\n   4→export const port = Number(process.env.PORT);'],
    ],
  },
  {
    lead: '`config.ts` has no fallback when `PORT` is unset, so the port is `NaN` in tests. Adding the default and running them again:',
    calls: [
      ['Edit', { file_path: 'src/config.ts', old_string: 'Number(process.env.PORT)', new_string: 'Number(process.env.PORT ?? 8080)' }, 'The file src/config.ts has been updated.'],
      ['Bash', { command: 'npm test -- --watch=false', description: 'Run the test suite again' }, 'Tests: 14 passed, 14 total'],
    ],
  },
];
const TRIAGE_ANSWER = [
  'Fixed. `src/config.ts` read `PORT` with no fallback, so with it unset the port was `NaN` and `config.test.ts` failed.',
  '',
  '- It now defaults to **8080** (`process.env.PORT ?? 8080`).',
  '- All 14 tests pass.',
].join('\n');
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

// What a box's ~/.termag/e2e-claude.env (KEY=value lines) or the env sets:
// E2E_CLAUDE_PLAN=pro|max for those plans' rate-limit windows instead of an
// Enterprise seat's, E2E_CLAUDE_CONTEXT_WINDOW=200000 to fill the ring in a
// few turns.
const boxSettings = (() => {
  try {
    return Object.fromEntries(readFileSync(join(homedir(), '.termag/e2e-claude.env'), 'utf8').split('\n')
      .map(l => /^\s*([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim()]));
  } catch { return {}; }
})();
const setting = k => process.env[k] || boxSettings[k] || '';
// The box's ~/.termag/e2e-claude.env can pace the words too (a demo's turn).
const delay = Number(setting('E2E_STUB_DELAY_MS') || 30) * (slow ? 10 : 1);

// Token usage in Claude's shapes, so the chat's context ring has numbers: the
// prompt grows with each earlier turn and each API call of this one, almost
// all of it served from the prompt cache, against the 1M window Claude Code
// gives Opus 5.5, Sonnet 5.5 and Haiku 5.5.
const CONTEXT_WINDOW = Number(setting('E2E_CLAUDE_CONTEXT_WINDOW')) || 1_000_000;
// The model Claude Code names for `--model` on a claude.ai sign-in (an alias's
// model, Opus 5.5 with none), so the ring's guess before a result is right.
const ALIASES = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
const asked = (opt('--model') || '').replace(/\[1m\]$/i, '');
const MODEL = ALIASES[asked] || asked || 'claude-opus-5-5';
let contextTokens = Math.min(CONTEXT_WINDOW - 4_000, 18_000 + earlier * 11_000);
const spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function callUsage(outputTokens) {
  const fresh = 1_200 + Math.floor(Math.random() * 600);
  const usage = { input_tokens: 6, cache_creation_input_tokens: fresh, cache_read_input_tokens: contextTokens - fresh - 6, output_tokens: outputTokens };
  spent.input += usage.input_tokens; spent.cacheWrite += usage.cache_creation_input_tokens;
  spent.cacheRead += usage.cache_read_input_tokens; spent.output += outputTokens;
  contextTokens = Math.min(CONTEXT_WINDOW - 1_000, contextTokens + outputTokens + 400);
  return usage;
}
// Claude Code's total_cost_usd is what the session has cost so far, which a
// --resume carries on (verified on 2.1.310), not the turn's: the runner takes
// each turn's own from the growth (agent/chat-runner.js turnCost). The total
// is kept beside the transcript.
const costFile = `${transcript}.cost`;
let sessionCost = existsSync(costFile) ? Number(readFileSync(costFile, 'utf8')) || 0 : 0;
function sessionTotal(turnCost) {
  sessionCost = Math.round((sessionCost + turnCost) * 10000) / 10000;
  writeFileSync(costFile, String(sessionCost));
  return sessionCost;
}
const modelUsage = costUsd => ({
  [MODEL]: {
    inputTokens: spent.input, outputTokens: spent.output, cacheReadInputTokens: spent.cacheRead,
    cacheCreationInputTokens: spent.cacheWrite, webSearchRequests: 0, costUSD: costUsd,
    contextWindow: CONTEXT_WINDOW, maxOutputTokens: 32_000,
  },
});
// A claude.ai sign-in (fakes/claude-auth.mjs writes ~/.claude/signed-in) gets
// rate-limit events as Claude Code reports them for the plan; the Bedrock
// gateway has no plan limits and gets none. A Claude Enterprise seat, the
// default, reports one extra-usage window with no utilization and a reset at
// the start of next month; Pro and Max report 5-hour and 7-day windows.
function rateLimitEvents() {
  if (!existsSync(join(homedir(), '.claude/signed-in'))) return;
  const now = Math.floor(Date.now() / 1000);
  if (!/^(pro|max)$/i.test(setting('E2E_CLAUDE_PLAN'))) {
    const d = new Date();
    const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
    emit({
      type: 'rate_limit_event', uuid: randomUUID(),
      rate_limit_info: { status: 'allowed', resetsAt: month, rateLimitType: 'overage', overageStatus: 'allowed', overageResetsAt: month, isUsingOverage: false, overageInUse: true },
    });
    return;
  }
  const windows = [
    { rateLimitType: 'five_hour', utilization: Math.min(0.97, 0.12 + earlier * 0.04), resetsAt: now + 3 * 3600 + 1200 },
    { rateLimitType: 'seven_day', utilization: Math.min(0.97, 0.41 + earlier * 0.01), resetsAt: now + 3 * 86400 + 7200 },
  ];
  for (const w of windows) emit({ type: 'rate_limit_event', rate_limit_info: { status: w.utilization >= 0.9 ? 'allowed_warning' : 'allowed', ...w }, uuid: randomUUID() });
}
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

if (prompt === '/compact' && resume) {
  emit({ type: 'system', subtype: 'status', status: 'compacting', uuid: randomUUID() });
  await wait(delay * 40);
  emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success', uuid: randomUUID() });
  emit({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode: opt('--permission-mode') || 'default', tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'] });
  // What the last reply reported, as Claude Code's pre_tokens is the context it compacted.
  const lastUsage = lines.slice(lastBoundary + 1).filter(e => e.type === 'assistant' && e.message?.usage).map(e => e.message.usage).pop();
  const pre = lastUsage ? lastUsage.input_tokens + lastUsage.cache_read_input_tokens + lastUsage.cache_creation_input_tokens : contextTokens;
  const post = 1_600;
  const at = new Date().toISOString();
  const boundary = randomUUID();
  const summary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nThe person asked about ${basename(cwd)} and I walked its tree and README.`;
  const line = obj => appendFileSync(transcript, `${JSON.stringify({ uuid: randomUUID(), sessionId, cwd, timestamp: at, isSidechain: false, ...obj })}\n`);
  line({ type: 'system', subtype: 'compact_boundary', uuid: boundary, isMeta: false, compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post, durationMs: delay * 40 } });
  line({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: summary } });
  line({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>' } });
  emit({ type: 'system', subtype: 'compact_boundary', uuid: boundary, compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: post, cumulative_dropped_tokens: pre - post, duration_ms: delay * 40 } });
  emit({ type: 'user', uuid: randomUUID(), isReplay: false, isSynthetic: true, message: { role: 'user', content: summary }, parent_tool_use_id: null });
  emit({ type: 'user', uuid: randomUUID(), isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, parent_tool_use_id: null });
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, duration_api_ms: 0, num_turns: 0, result: '', local_command: 'compact', total_cost_usd: sessionTotal(0.031), usage: { input_tokens: pre, output_tokens: 400 }, modelUsage: modelUsage(0.031) });
  process.exit(0);
}

emit({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode: opt('--permission-mode') || 'default', ...(effort ? { effort } : {}), tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'] });
rateLimitEvents();
// Claude Code replays a live turn's first user line too, as it took it in
// (notices and all), under its transcript uuid; the browser skips it as the
// turn's own prompt (sdkChat.ts replaySkip).
const promptUuid = record('user', { role: 'user', content: userContent });
if (live && replays) emit({ type: 'user', message: { role: 'user', content: userContent }, parent_tool_use_id: null, uuid: promptUuid, isReplay: true });
if (setting('E2E_CLAUDE_AI_TITLES') === '1') appendFileSync(transcript, `${JSON.stringify({ type: 'ai-title', aiTitle, sessionId })}\n`);

// ~/.claude/expired (an e2e run writes it; claude-auth.mjs's login removes
// it): the seat's token is gone, as Claude Code reports it. `auth status`
// still says logged in, as it does with a stale token on disk.
if (existsSync(join(homedir(), '.claude/expired'))) {
  const text = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}} · Please run /login';
  const message = { id: `msg_${randomUUID()}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] };
  appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', uuid: randomUUID(), parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, isApiErrorMessage: true, error: 'authentication_failed', message })}\n`);
  emit({ type: 'assistant', message, parent_tool_use_id: null, error: 'authentication_failed' });
  emit({ type: 'result', subtype: 'success', is_error: true, result: text, num_turns: 1, duration_ms: 20, total_cost_usd: sessionTotal(0) });
  process.exit(1);
}

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
async function assistantMessage(blocks, wordDelay = delay) {
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const outputTokens = Math.max(8, Math.ceil(blocks.reduce((n, b) => n + (b.text ?? JSON.stringify(b.input ?? {})).length, 0) / 4));
  const usage = callUsage(outputTokens);
  if (partial) emit({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', model: MODEL, content: [], usage: { ...usage, output_tokens: 1 } } } });
  for (const [index, block] of blocks.entries()) {
    if (partial) {
      const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} };
      emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: start } });
      if (block.type === 'text') {
        for (const word of block.text.match(/\S+\s*|\s+/g) ?? []) {
          emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } } });
          await sleep(wordDelay);
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
    const message = { id, type: 'message', role: 'assistant', model: MODEL, content: [block], usage };
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

// Generative UI's demo specs (fakes/genui/<name>.jsonl, json-render's JSONL
// patches), each with the line a real answer would lead with. The frontend's
// catalog test reads the same files, so they stay valid specs.
const GENUI_DEMOS = {
  rollout: 'Here is the rollout form. Pick the environment and how much traffic, and start it when you are ready.',
  review: "Here's #742 for review. Approve it or ask for changes, and I'll post that on the PR.",
  plan: 'There are three reasonable ways to do this migration:',
  dashboard: "Here's how the box is doing right now:",
  outbox: 'Here are both outboxes. Pick an action on any row:',
  feedback: 'I have four review comments for #797. Tell me what to do with each:',
};
/** A generative UI answer read back: its action, where it came from and what it carried. null for any other message. */
function genUiActionAnswer(prompt) {
  const m = /```ui-action\n(\{[^\n]*\})\n```/.exec(prompt);
  if (!m) return null;
  let p;
  try { p = JSON.parse(m[1]); } catch { return null; }
  const what = [p.value != null ? `value \`${p.value}\`` : null, p.row ? `row “${p.row.title ?? p.row.key}”` : null, p.comment ? `comment “${p.comment}”` : null, `${Object.keys(p.context || {}).length} values of state`].filter(Boolean).join(', ');
  return [
    `Got your answer from the UI: **${p.action}** from \`${p.sourceComponentId}\` on \`${p.surfaceId}\` (${what}).`,
    '',
    `Generative UI prompt this turn: ${genUiPrompted ? 'yes' : 'no'}${genUiReference ? ` (the hint; its reference ${genUiReference})` : ''}. (The e2e stand-in only reads the answer back.)`,
  ].join('\n');
}
function genUiAnswer(prompt) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'genui');
  // Every <name>.jsonl there is a demo, so a component's own demo needs no line here.
  const all = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length)).sort();
  const asked = prompt.replace(/^genui\s*/i, '').trim().split(/\s+/)[0]?.toLowerCase();
  const names = asked && all.includes(asked) ? [asked] : all;
  const intro = name => GENUI_DEMOS[name] ?? `Here is the ${name} demo:`;
  return names.map(name => `${intro(name)}\n\n\`\`\`spec\n${readFileSync(join(dir, `${name}.jsonl`), 'utf8').trimEnd()}\n\`\`\``).join('\n\n');
}

// ── `subagents` ──
// Each subagent's own transcript is beside the session's, as Claude Code
// keeps it: <session>/subagents/agent-<id>.jsonl and a .meta.json.
const subagentMs = Number(setting('E2E_SUBAGENT_MS')) || 15_000;
const subagentFile = (a, ext = 'jsonl') => join(dir, sessionId, 'subagents', `agent-${a.agentId}.${ext}`);
function subagentLine(a, type, message) {
  const uuid = randomUUID();
  appendFileSync(subagentFile(a), `${JSON.stringify({ parentUuid: a.parentUuid ?? null, isSidechain: true, agentId: a.agentId, type, message, uuid, timestamp: new Date().toISOString(), sessionId, cwd })}\n`);
  a.parentUuid = uuid;
}
const subagentResult = (a, name) => {
  if (name === 'Bash' && /npm test/.test(a.steps[0][1].command ?? '')) return 'Tests: 14 passed, 14 total\nTime: 2.1 s';
  if (name === 'Bash') return entries.length ? entries.map(n => `-rw-r--r--  1 user user   ${n}`).join('\n') : '(empty directory)';
  if (name === 'Glob') return entries.filter(n => !n.includes('.')).map(n => join(cwd, n)).join('\n') || 'No files found';
  if (name === 'Read') return readme ? readFileSync(join(cwd, readme), 'utf8').split('\n').slice(0, 12).map((l, i) => `${String(i + 1).padStart(4)}→${l}`).join('\n') : 'File does not exist.';
  return 'README.md:3:npm install\nREADME.md:4:npm test';
};
const subagentReport = a => (a.background ? 'All 14 tests pass (14 total, no failures), in about 2 seconds.'
  : a.type === 'Explore' ? `**${entries.length} entries** at the top level of ${project}:\n\n${entries.slice(0, 6).map(n => `- \`${n}\``).join('\n') || '- (nothing yet)'}`
  : readme ? `The README gives two steps, in order:\n\n1. \`npm install\`\n2. \`npm test\`\n\nMissing for a new contributor: which Node version, and how to run it locally.` : 'There is no README, so no setup steps are written down anywhere.');
async function subagentMessage(a, block) {
  const message = { id: `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`, type: 'message', role: 'assistant', model: MODEL, content: [block], usage: callUsage(40) };
  subagentLine(a, 'assistant', message);
  emit({ type: 'assistant', message, parent_tool_use_id: a.callId });
}
async function subagentStep(a, [name, input]) {
  const id = `toolu_${randomUUID().slice(0, 8)}`;
  await subagentMessage(a, { type: 'tool_use', id, name, input });
  a.toolUses += 1;
  emit({ type: 'system', subtype: 'task_progress', task_id: a.agentId, tool_use_id: a.callId, description: `${name === 'Bash' ? 'Running' : name === 'Read' ? 'Reading' : 'Searching'} ${input.description ?? input.file_path ?? input.pattern}`, subagent_type: a.type, usage: { total_tokens: 8000 + a.toolUses * 2100, tool_uses: a.toolUses, duration_ms: Date.now() - a.startedAt }, last_tool_name: name });
  await sleep(a.background ? subagentMs / 4 : delay * 20);
  const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: subagentResult(a, name) }] };
  subagentLine(a, 'user', message);
  emit({ type: 'user', message, parent_tool_use_id: a.callId });
}
function subagentEnd(a) {
  const report = subagentReport(a);
  const usage = { total_tokens: 8000 + a.toolUses * 2100 + report.length, tool_uses: a.toolUses, duration_ms: Date.now() - a.startedAt };
  writeFileSync(subagentFile(a, 'meta.json'), JSON.stringify({ agentType: a.type, isBuiltIn: true, description: a.description, toolUseId: a.callId, spawnDepth: 1, requestShape: a.background ? 'background' : 'foreground', finished: true }));
  emit({ type: 'system', subtype: 'task_updated', task_id: a.agentId, patch: { status: 'completed', end_time: Date.now() } });
  emit({ type: 'system', subtype: 'task_notification', task_id: a.agentId, tool_use_id: a.callId, status: 'completed', output_file: subagentFile(a), summary: report, usage });
  return { report, usage };
}
async function runSubagents() {
  await assistantMessage([{ type: 'text', text: "I'll split this three ways: one agent maps the layout, one reads the README's setup steps, and one runs the tests in the background." }]);
  const runs = SUBAGENTS.map(a => ({ ...a, callId: `toolu_${randomUUID().slice(0, 8)}`, agentId: `a${randomUUID().replace(/-/g, '').slice(0, 16)}`, toolUses: 0, startedAt: Date.now() }));
  await assistantMessage(runs.map(a => ({ type: 'tool_use', id: a.callId, name: 'Agent', input: { description: a.description, prompt: a.prompt, subagent_type: a.type, run_in_background: a.background === true } })));
  mkdirSync(join(dir, sessionId, 'subagents'), { recursive: true });
  for (const a of runs) {
    subagentLine(a, 'user', { role: 'user', content: a.prompt });
    emit({ type: 'system', subtype: 'task_started', task_id: a.agentId, tool_use_id: a.callId, description: a.description, subagent_type: a.type, is_backgrounded: a.background === true, spawn_depth: 1, task_type: 'local_agent', prompt: a.prompt });
    if (!a.background) {
      // The prompt as the subagent's own first message, under its call.
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: a.prompt }] }, parent_tool_use_id: a.callId });
      continue;
    }
    tasks.push({ task_id: a.agentId, task_type: 'local_agent', subagent_type: a.type, description: a.description });
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [...tasks] });
    const text = `Async agent launched successfully.\nagentId: ${a.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${a.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\noutput_file: ${subagentFile(a)}`;
    const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: a.callId, content: [{ type: 'text', text }] }] };
    record('user', message);
    emit({ type: 'user', message, parent_tool_use_id: null, tool_use_result: { isAsync: true, status: 'async_launched', agentId: a.agentId, description: a.description, resolvedModel: MODEL, prompt: a.prompt } });
  }
  const fg = runs.filter(a => !a.background);
  for (let i = 0; fg.some(a => a.steps[i]); i++) {
    for (const a of fg) if (a.steps[i]) await subagentStep(a, a.steps[i]);
  }
  for (const a of fg) {
    await subagentMessage(a, { type: 'text', text: subagentReport(a) });
    const { report, usage } = subagentEnd(a);
    const text = `[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n${report.split('\n').map(l => `  ${l}`).join('\n')}\nagentId: ${a.agentId} (use SendMessage with to: '${a.agentId}' to continue this agent)\n<usage>subagent_tokens: ${usage.total_tokens}\ntool_uses: ${usage.tool_uses}\nduration_ms: ${usage.duration_ms}</usage>`;
    const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: a.callId, content: [{ type: 'text', text }] }] };
    record('user', message);
    emit({ type: 'user', message, parent_tool_use_id: null, tool_use_result: { status: 'completed', agentId: a.agentId, agentType: a.type, content: [{ type: 'text', text: report }], resolvedModel: MODEL, totalDurationMs: usage.duration_ms, totalTokens: usage.total_tokens, totalToolUseCount: usage.tool_uses } });
  }
  const first = `Two are back. **${project}** has ${entries.length} entries at the top level, and ${readme ? 'its README gives `npm install` then `npm test`, with no Node version' : 'it has no README yet'}. The test run is still going in the background; I'll say what it finds.`;
  await assistantMessage([{ type: 'text', text: first }]);
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 4, result: first, total_cost_usd: sessionTotal(0.042), usage: { input_tokens: 3200, output_tokens: 240 }, modelUsage: modelUsage(0.042) });
  answered = true;
  // The background one works on, then wakes Claude in this process with its notification.
  for (const a of runs.filter(r => r.background)) {
    for (const step of a.steps) await subagentStep(a, step);
    await subagentMessage(a, { type: 'text', text: subagentReport(a) });
    const { report, usage } = subagentEnd(a);
    const note = `<task-notification>\n<task-id>${a.agentId}</task-id>\n<tool-use-id>${a.callId}</tool-use-id>\n<output-file>${subagentFile(a)}</output-file>\n<status>completed</status>\n<summary>Agent "${a.description}" finished</summary>\n<result>${report}</result>\n<usage><subagent_tokens>${usage.total_tokens}</subagent_tokens><tool_uses>${usage.tool_uses}</tool_uses><duration_ms>${usage.duration_ms}</duration_ms></usage>\n</task-notification>`;
    const uuid = randomUUID();
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid, parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, origin: { kind: 'task-notification' }, message: { role: 'user', content: note } })}\n`);
    parentUuid = uuid;
    tasks.splice(tasks.findIndex(t => t.task_id === a.agentId), 1);
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [...tasks] });
    emit({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode: mode, tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'] });
    const done = `The test run is back: ${report.charAt(0).toLowerCase()}${report.slice(1)}`;
    await assistantMessage([{ type: 'text', text: done }]);
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 1, result: done, total_cost_usd: sessionTotal(0.006), usage: { input_tokens: 500, output_tokens: 30 }, modelUsage: modelUsage(0.006) });
  }
}

const tasks = [];
// Each background task's Bash call, by task id: its notification names it.
const taskCalls = new Map();
const taskOutput = taskId => join(dir, sessionId, 'tasks', `${taskId}.output`);
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

  if (subagents && mayRun) {
    await runSubagents();
    process.exit(0);
  }

  if (asks && mayRun) {
    const target = setting('E2E_ASK_TARGET') || 'box-2/sample';
    const scratch = join(dir, sessionId, 'asks');
    mkdirSync(scratch, { recursive: true });
    await assistantMessage([{ type: 'text', text: `The plan: three asks to \`${target}\`, each researching one fact about the Titanic wreck. Writing the prompts now.` }]);
    for (const [, slug, brief] of ASKS) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const file = join(scratch, `titanic-${slug}.md`);
      await assistantMessage([{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: brief } }]);
      writeFileSync(file, `${brief}\n`);
      await toolResult(id, `File created successfully at: ${file}`);
    }
    for (const [i, [title, slug]] of ASKS.entries()) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const command = `termag ask --no-wait ${target} --title "${title}" - < ${join(scratch, `titanic-${slug}.md`)} 2>&1`;
      await assistantMessage([{ type: 'tool_use', id, name: 'Bash', input: { command, description: `Fire ask ${i + 1}: ${title} (no-wait)` } }]);
      const ran = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 120_000 });
      const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() || (ran.error ? String(ran.error.message) : '(no output)');
      await toolResult(id, out, ran.status !== 0);
    }
    const answer = 'All three are running. Each answers in its own session; I\'m not waiting on them, so check each one when you need it.';
    await assistantMessage([{ type: 'text', text: answer }]);
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 7, result: answer, total_cost_usd: sessionTotal(0.02), usage: { input_tokens: 2000, output_tokens: 120 }, modelUsage: modelUsage(0.02) });
    process.exit(0);
  }

  if (askNotice) {
    const done = [...prompt.matchAll(/message ([a-z0-9]+)\) finished: ([a-z]+)/g)].map(m => `\`${m[1]}\` ${m[2]}`);
    if (mayRun) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const command = 'termag ask --inbox 2>&1';
      await assistantMessage([{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Check the asks termag says finished' } }]);
      const ran = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 60_000 });
      const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() || (ran.error ? String(ran.error.message) : '(no output)');
      await toolResult(id, out, ran.status !== 0);
    }
    const answer = `termag says ${done.length === 1 ? 'an ask' : `${done.length} asks`} finished: ${done.join(', ')}. `
      + 'That notice is termag\'s, not yours, and carries no reply, so next I read each handoff and tell you what came back.';
    await assistantMessage([{ type: 'text', text: answer }]);
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: mayRun ? 2 : 1, result: answer, total_cost_usd: sessionTotal(0.005), usage: { input_tokens: 900, output_tokens: 60 }, modelUsage: modelUsage(0.005) });
    process.exit(0);
  }

  if (triage && mayRun) {
    for (const { lead, calls } of TRIAGE) {
      await assistantMessage([{ type: 'text', text: lead }]);
      for (const [name, input, result, isError] of calls) {
        const id = `toolu_${randomUUID().slice(0, 8)}`;
        await assistantMessage([{ type: 'tool_use', id, name, input }]);
        await toolResult(id, result, Boolean(isError));
      }
    }
    await assistantMessage([{ type: 'text', text: TRIAGE_ANSWER }]);
    const cost = Math.round((0.03 + TRIAGE_ANSWER.length * 0.00004) * 10000) / 10000;
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 7, result: TRIAGE_ANSWER, total_cost_usd: cost, usage: { input_tokens: 2400, output_tokens: 300 }, modelUsage: modelUsage(cost) });
    process.exit(0);
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
    const cost = Math.round((0.004 + answer.length * 0.00004) * 10000) / 10000;
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 1, result: answer, total_cost_usd: sessionTotal(cost), usage: { input_tokens: 1600, output_tokens: 80 }, modelUsage: modelUsage(cost) });
    process.exit(0);
  }

  // E2E_CLAUDE_ANSWER_PAD=<words> streams that many words first, fast: a
  // turn long enough that its history replay is only its newest lines, which
  // still hold the tool calls after it.
  const pad = Number(setting('E2E_CLAUDE_ANSWER_PAD')) || 0;
  if (pad > 0) await assistantMessage([{ type: 'text', text: `Progress log: ${Array.from({ length: Math.ceil(pad / 2) }, (_, i) => `step ${i + 1}`).join(', ')}.` }], 1);
  const lsId = `toolu_${randomUUID().slice(0, 8)}`;
  const intro = survey
    ? `The README alone won't say whether ${project} builds. Let me survey how it is set up and whether its checks pass.`
    : compactedBefore && earlier === 0 ? 'Going on from my summary of our conversation so far. Let me check the tree again.'
    : earlier > 0 ? 'Picking up where we left off. Let me check the tree again.' : `I'll start by looking at how ${project} is laid out.`;
  if (hasBash) {
    await assistantMessage([
      ...(quiet ? [] : [{ type: 'text', text: intro }]),
      { type: 'tool_use', id: lsId, name: 'Bash', input: { command: 'ls -la', description: 'List the repository root' } },
    ]);
    if (mayRun) await toolResult(lsId, entries.length ? entries.map(n => `-rw-r--r--  1 user user   ${n}`).join('\n') : '(empty directory)');
    else await toolResult(lsId, "Claude requested permissions to use Bash, but you haven't granted it yet.", true);
    if (background && mayRun) {
      for (const [command, description] of BACKGROUND) {
        const id = `toolu_${randomUUID().slice(0, 8)}`;
        await assistantMessage([{ type: 'tool_use', id, name: 'Bash', input: { command, description, run_in_background: true } }]);
        const taskId = `b${randomUUID().slice(0, 6)}`;
        await toolResult(id, `Command running in background with ID: ${taskId}. Output is being written to: ${taskOutput(taskId)}. You will be notified when it completes.`);
        tasks.push({ task_id: taskId, task_type: 'local_bash', description });
        taskCalls.set(taskId, id);
        emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [...tasks] });
      }
    }
    if (survey) {
      for (const [command, description, error] of SURVEY) {
        const id = `toolu_${randomUUID().slice(0, 8)}`;
        await assistantMessage([{ type: 'tool_use', id, name: 'Bash', input: { command, description } }]);
        if (mayRun) await toolResult(id, error ?? `(${command}: nothing to report)`, Boolean(error));
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

  // Messages that came in while it worked are taken in at this tool boundary and answered in the same
  // result, as Claude Code does with a mid-turn message (replayed when taken in).
  const folded = live ? laterMessages.splice(0) : [];
  for (const content of folded) takeIn(content, true);
  const foldedText = folded.map(contentText);
  const echoed = /^echo\s/i.test(prompt) ? prompt.replace(/^echo\s+/i, '') : null;
  const tour = echoed !== null ? echoed : /^markdown/i.test(prompt) ? MARKDOWN_ANSWER : /^genui\b/i.test(prompt) ? genUiAnswer(prompt) : genUiActionAnswer(prompt) ?? (mayRun ? [
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
  ].join('\n'));
  const answer = foldedText.length ? [
    `You added to the request while I was working, so this answers it as changed: _${foldedText.join(' / ').slice(0, 160)}_.`,
    '',
    `- For that: **${project}** has ${entries.length} entries at the top level${readme ? `, and \`${readme}\` explains the basics` : ', and no README yet'}.`,
    '- I finished the step I was on (the listing and the read) before taking your message in.',
  ].join('\n') : tour;
  const noted = boxNotice
    ? `**Box notice received.** termag told me:\n\n${boxNotice.split('\n').map(l => `> ${l}`).join('\n')}\n\nI'll check \`git status\` and restart what I need before relying on earlier work.\n\n${answer}`
    : answer;
  await assistantMessage([{ type: 'text', text: effort ? `${noted}\n\n_This turn ran with \`--effort ${effort}\`._` : noted }]);

  answered = true;
  // Priced like a short Sonnet turn: a base for the context, plus the output.
  const cost = Math.round((0.018 + answer.length * 0.00004 + prompt.length * 0.00002) * 10000) / 10000;
  emit({
    type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 3, result: answer,
    total_cost_usd: sessionTotal(cost),
    usage: { input_tokens: 1200 + prompt.length, output_tokens: Math.ceil(answer.length / 4) },
    modelUsage: modelUsage(cost),
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
// A stop of everything (SIGINT) ends it at once; an interrupt does not. Each
// task's end wakes Claude in this same process, with no message from anyone,
// in Claude Code's order: the task's status, its notification (the transcript
// keeps it as a user line with a task-notification origin), the tasks left,
// then a new query: init, a Read of the task's output, an answer, a result.
const backgroundMs = Number(setting('E2E_BACKGROUND_MS')) || 600_000;
const replyTo = content => `On "${contentText(content).slice(0, 60)}": noted. (This is the e2e stand-in, so that is all it says.)`;
for (let left = [...tasks]; left.length;) {
  // Idle until the next task ends; a message meanwhile is answered at once,
  // in a query of its own.
  for (const until = Date.now() + backgroundMs / tasks.length; Date.now() < until;) {
    if (!laterMessages.length) { await wait(200); continue; }
    await answerLater(laterMessages.shift());
  }
  const task = left.shift();
  const output = taskOutput(task.task_id);
  mkdirSync(join(dir, sessionId, 'tasks'), { recursive: true });
  appendFileSync(output, `${task.description}: ok\n\n[exited with code 0]\n`);
  const toolUseId = taskCalls.get(task.task_id);
  emit({ type: 'system', subtype: 'task_updated', task_id: task.task_id, patch: { status: 'completed', end_time: Date.now() } });
  emit({ type: 'system', subtype: 'task_notification', task_id: task.task_id, tool_use_id: toolUseId, status: 'completed', output_file: output, summary: `Background command "${task.description}" completed (exit code 0)` });
  const note = `<task-notification>\n<task-id>${task.task_id}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>${output}</output-file>\n<status>completed</status>\n<summary>Background command "${task.description}" completed (exit code 0)</summary>\n</task-notification>`;
  const uuid = randomUUID();
  appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid, parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, origin: { kind: 'task-notification' }, message: { role: 'user', content: note } })}\n`);
  parentUuid = uuid;
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [...left] });
  emit({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode: mode, tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'] });
  await wait(delay * 60);
  const readId = `toolu_${randomUUID().slice(0, 8)}`;
  await assistantMessage([
    { type: 'text', text: `${task.description} finished. Reading its output.` },
    { type: 'tool_use', id: readId, name: 'Read', input: { file_path: output } },
  ]);
  await wait(delay * 40);
  await toolResult(readId, `     1→${task.description}: ok\n     2→\n     3→[exited with code 0]`);
  // Messages sent during this work go in now, at the tool boundary, before the answer.
  const asked = laterMessages.splice(0);
  for (const content of asked) takeIn(content, true);
  const done = asked.map(t => `${replyTo(t)}\n\n`).join('') + (left.length
    ? `${task.description} passed. Still waiting on ${left.map(t => t.description).join(' and ')}.`
    : `${task.description} passed. That was the last of the background work.`);
  await assistantMessage([{ type: 'text', text: done }]);
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startedAt, num_turns: 2, result: done, total_cost_usd: sessionTotal(0.004), usage: { input_tokens: 400, output_tokens: 20 }, modelUsage: modelUsage(0.004) });
}

// A live turn's later messages, in order, until stdin closes: each is taken in
// (replayed), answered, and gets its own result. The answer names the message
// it answers, so a steered ask's reply visibly belongs to the follow-up.
async function answerLater(content) {
  const text = contentText(content);
  takeIn(content, false);
  // Taken in while idle, it starts a query of its own, which opens with an init as every query does.
  emit({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode: mode, tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'] });
  const at = Date.now();
  const echoed = /^echo\s/i.test(text) ? text.replace(/^echo\s+/i, '') : null;
  const answer = echoed ?? [
    `You sent a follow-up while I was still on the first request, so this answers the follow-up: _${text.slice(0, 160)}_.`,
    '',
    `- What I did for it: looked at **${project}** again with that in mind (${entries.length} entries at the top level).`,
    '- The first request\'s answer above is superseded by this one.',
  ].join('\n');
  await assistantMessage([{ type: 'text', text: answer }]);
  const cost = Math.round((0.006 + answer.length * 0.00004) * 10000) / 10000;
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - at, num_turns: 1, result: answer, total_cost_usd: sessionTotal(cost), usage: { input_tokens: 400 + text.length, output_tokens: Math.ceil(answer.length / 4) }, modelUsage: modelUsage(cost) });
}
if (live) {
  for (;;) {
    while (laterMessages.length) await answerLater(laterMessages.shift());
    if (stdinEnded) break;
    await new Promise(resolve => { wakeLater = resolve; });
    wakeLater = () => {};
  }
}
process.exit(0);
