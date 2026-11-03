// Generative UI's loop against a running e2e stack:
// the fake Claude answers "genui plan" with a ```spec fence, the answer a
// click on its "Choose shadow table" button sends goes back as a chat
// message, and the agent reads that answer, on a turn that carried the
// catalog's system prompt. The click itself, and the exact message it
// builds, are the browser's (frontend/src/chat/genui/GenUiSurface.test.tsx);
// this sends the same message the way the browser does.
//
//   node scripts/e2e/genui-loop.mjs <backend base, e.g. http://127.0.0.1:3940/termag>
// Needs E2E_FAKE_CLAUDE=1 and E2E_FLAGS with chat-generative-ui-enabled on.
const [base] = process.argv.slice(2);
if (!base) { console.error('usage: genui-loop.mjs <base>'); process.exit(2); }

let failures = 0;
const ok = msg => console.log(`ok:   ${msg}`);
const fail = (msg, detail) => { console.log(`FAIL: ${msg}`); if (detail) console.log(`      ${String(detail).slice(0, 600)}`); failures++; };
const check = (msg, cond, detail) => (cond ? ok(msg) : fail(msg, detail));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().find(c => c.startsWith('termag.sid='))?.split(';')[0];
if (!cookie) { console.log(`FAIL: local sign-in (HTTP ${login.status})`); process.exit(1); }
async function api(method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** Every text block of Claude's replies in a chat's history, in order. */
function replies(history) {
  const out = [];
  for (const e of history?.entries ?? []) {
    if (e?.type !== 'assistant') continue;
    for (const b of e.message?.content ?? []) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out;
}

/** The chat's history once its turn is over and a reply matches `test`. */
async function replyMatching(projectId, test, what) {
  for (let i = 0; i < 180; i++) {
    const h = await api('GET', `/projects/${projectId}/chat?workstream=main`);
    if (h.status === 200 && !h.json.running) {
      const found = replies(h.json).find(test);
      if (found) return { text: found, history: h.json };
    }
    await sleep(500);
  }
  fail(`${what} arrived within 90 s`);
  return null;
}

async function send(projectId, text) {
  for (let i = 0; i < 120; i++) {
    const r = await api('POST', `/projects/${projectId}/chat/messages`, { workstream: 'main', text });
    if (r.status === 202) return true;
    await sleep(500);
  }
  return false;
}

// FNV-1a over the fence's text, as frontend/src/chat/genui/action.ts surfaceIdOf.
function surfaceIdOf(body) {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `ui-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

const [box] = (await api('GET', '/instances')).json ?? [];
if (!box) { console.log('FAIL: the stack has a box'); process.exit(1); }
const created = await api('POST', '/projects', {
  name: `genui-loop-${Date.now().toString(36)}`, instanceId: box.id, chatTrusted: true,
  initialAgent: { enabled: true, provider: 'claude-chat' },
});
const projectId = created.json?.id ?? created.json?.project?.id;
check('a simple-UI chat to talk to', !!projectId, created.text);
if (!projectId) process.exit(1);

check('"genui plan" is sent', await send(projectId, 'genui plan'));
const drawn = await replyMatching(projectId, t => t.includes('```spec'), 'a reply with a spec');
const fence = drawn && /```spec\n([\s\S]*?)\n```/.exec(drawn.text);
check('the reply carries a closed spec fence', !!fence, drawn?.text);
if (!fence) process.exit(1);

const body = fence[1];
const elements = Object.fromEntries(body.split('\n').map(l => JSON.parse(l)).filter(p => p.path.startsWith('/elements/')).map(p => [p.path.slice('/elements/'.length), p.value]));
const choose = elements['plan-b-choose'];
check('the spec has a Choose button bound to the choose action', choose?.type === 'Button' && choose.on?.press?.action === 'choose', JSON.stringify(choose));

// What the browser sends for a press on it (action.ts payloadOf + formatActionMessage).
const surfaceId = surfaceIdOf(body);
const payload = { action: 'choose', surfaceId, sourceComponentId: 'plan-b-choose', context: {}, label: choose.on.press.params.label, value: choose.on.press.params.value };
const message = `Chose “${payload.label}”\n\n\`\`\`ui-action\n${JSON.stringify(payload)}\n\`\`\``;
check('the answer is sent', await send(projectId, message));

const read = await replyMatching(projectId, t => t.startsWith('Got your answer from the UI'), 'the agent\'s reply to the answer');
check('the agent read the action, its source and its surface',
  read?.text.includes(`**choose** from \`plan-b-choose\` on \`${surfaceId}\` (value \`shadow\``), read?.text);
check('the turn that read it had the generative UI system prompt', read?.text.includes('Generative UI prompt this turn: yes'), read?.text);
// A box agent that files the prompt (chat-genui-v2) appends only the hint; the reference it names must be readable.
check('the hint\'s reference, if the turn had only the hint, was readable', !read?.text.includes('its reference unreadable'), read?.text);
const kept = (read?.history.entries ?? []).some(e => e?.type === 'user' && JSON.stringify(e.message?.content ?? '').includes('ui-action'));
check('the answer is in the transcript, where a reload finds it and locks the surface', kept);

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
