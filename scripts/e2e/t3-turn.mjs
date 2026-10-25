// One t3 thread turn on a box through the desktop bridge's relay, as the
// desktop app makes it (scripts/e2e/t3.test.sh): register a directory as a t3
// project, launch a thread on Claude with a first message over the relayed
// t3 WebSocket (Effect RPC, JSON), and wait for the answer in its projection.
// Prints the answer's first line, or exits non-zero. With a worktree (and its
// branch) the thread runs there, as t3 runs one in an existing worktree of the
// project (a termag workstream the desktop made for New worktree).
//
//   node t3-turn.mjs <relay base URL> <termag JWT> <t3 session token> <workspace dir> <prompt> [<worktree> <branch>]
// Needs `ws` on NODE_PATH (backend/node_modules).
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const [relay, jwt, t3, root, prompt, worktreePath, branch] = process.argv.slice(2);
const workspaceStrategy = worktreePath
  ? { type: 'existing_worktree', worktreePath, ...(branch ? { branch } : {}) }
  : { type: 'root' };
const headers = { authorization: `Bearer ${jwt}`, 'x-t3-authorization': `Bearer ${t3}` };
const fail = (msg) => { console.error(msg); process.exit(1); };

let projectId = randomUUID();
const created = await fetch(`${relay}/api/projects/mutate`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'project.create', commandId: randomUUID(), projectId, title: 'e2e', workspaceRoot: root }),
});
if (created.status !== 200) {
  const snap = await (await fetch(`${relay}/api/projects`, { headers })).json();
  projectId = snap.projects?.find(p => p.workspaceRoot === root)?.id ?? fail(`project.create: HTTP ${created.status}`);
}
const { ticket } = await (await fetch(`${relay}/api/auth/websocket-ticket`, { method: 'POST', headers })).json();
const ws = new WebSocket(`${relay.replace(/^http/, 'ws')}/ws?wsTicket=${ticket}&orchestrationProtocol=2`, { headers: { authorization: `Bearer ${jwt}` } });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const waiting = new Map();
ws.on('message', (d) => {
  for (const m of [].concat(JSON.parse(String(d)))) {
    if (m._tag === 'Ping') { ws.send(JSON.stringify({ _tag: 'Pong' })); continue; }
    waiting.get(String(m.requestId))?.(m);
  }
});
let next = 0;
const call = (tag, payload) => new Promise((resolve) => {
  const id = String(++next);
  waiting.set(id, resolve);
  ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
});
const launched = await call('orchestration.launchThread', {
  commandId: randomUUID(), projectId, title: 'e2e thread',
  modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-4-6' },
  runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy,
  initialMessage: { text: prompt, attachments: [] },
});
const threadId = launched?.exit?.value?.threadId ?? fail(`launchThread: ${JSON.stringify(launched).slice(0, 400)}`);
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const p = JSON.stringify(await call('orchestration.getThreadProjection', { threadId }));
  const m = /Stub Claude here[^"\\]*/.exec(p);
  if (m) { console.log(m[0]); ws.close(1000); process.exit(0); }
}
fail('no answer within 60 s');
