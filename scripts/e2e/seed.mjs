// Seeds the local e2e stack through the real HTTP API, as a signed-in user.
//
//   node seed.mjs boxes   <root> <count>  create box-1..N and write each box's
//                                          agent config. The first E2E_EC2_BOXES
//                                          are kind "ec2" (with no AWS configured
//                                          the API hands back a token, as for a
//                                          hand-built box; with E2E_EC2_LAUNCH it
//                                          launches them), the rest "external".
//   node seed.mjs project <root>          wait for every box to be ready, then
//                                          create the sample project on box-1
//
// Box tokens are written only to <root>/boxes/<name>/home/.termag/agent.config.json
// (mode 0600) and are never printed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, root, countArg] = process.argv.slice(2);
const base = process.env.E2E_API_URL;
if (!cmd || !root || !base) {
  console.error('usage: E2E_API_URL=http://127.0.0.1:<port>/termag node seed.mjs boxes|project <root> [count]');
  process.exit(2);
}

async function login() {
  const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find(c => c.startsWith('termag.sid='));
  if (res.status !== 302 || !cookie) throw new Error(`local sign-in failed: HTTP ${res.status}`);
  return cookie.split(';')[0];
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { cookie, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function seedBoxes(cookie, count) {
  const agentWsUrl = process.env.E2E_AGENT_WS_URL || base.replace(/^http/, 'ws') + '/ws/agent';
  const ec2Boxes = Number(process.env.E2E_EC2_BOXES || 0);
  const launched = Boolean(process.env.E2E_EC2_LAUNCH);
  const boxes = [];
  for (let i = 1; i <= count; i++) {
    const name = `box-${i}`;
    const kind = i <= ec2Boxes ? 'ec2' : 'external';
    const { instance, token } = await api(cookie, 'POST', '/instances', { name, kind });
    boxes.push({ name, id: instance.id });
    console.log(`[seed] box ${name} (${instance.id}) kind=${instance.kind} status=${instance.status}`);
    // Provisioning is on: the EC2 launch fake starts this box from its user data.
    if (kind === 'ec2' && launched) {
      if (token) throw new Error(`POST /instances returned a token for ${name}: box provisioning is not configured`);
      continue;
    }
    if (!token) throw new Error(`POST /instances (${kind}) returned no token: is box provisioning configured?`);
    const configDir = join(root, 'boxes', name, 'home', '.termag');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent.config.json'),
      JSON.stringify({ termag_url: agentWsUrl, token, reconnect_interval_seconds: 2, path_remap: {} }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  writeFileSync(join(root, 'boxes.json'), JSON.stringify(boxes, null, 2) + '\n');
}

async function seedProject(cookie) {
  const boxes = JSON.parse(readFileSync(join(root, 'boxes.json'), 'utf8'));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const live = await api(cookie, 'GET', '/instances');
    const notReady = boxes.filter(b => live.find(l => l.id === b.id)?.status !== 'ready');
    if (notReady.length === 0) break;
    if (Date.now() > deadline) {
      throw new Error(`boxes not ready after 60s: ${notReady.map(b => b.name).join(', ')} (see logs/box-*.log)`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[seed] ${boxes.length} box(es) ready`);

  const project = await api(cookie, 'POST', '/projects', {
    name: 'sample',
    instanceId: boxes[0].id,
    initialAgent: { enabled: true, provider: 'claude' },
  });
  console.log(`[seed] project sample (${project.id ?? project.project?.id}) on ${boxes[0].name}`);
}

try {
  const cookie = await login();
  if (cmd === 'boxes') await seedBoxes(cookie, Number(countArg ?? 1));
  else if (cmd === 'project') await seedProject(cookie);
  else throw new Error(`unknown command ${cmd}`);
} catch (err) {
  console.error(`[seed] ${err.message}`);
  process.exit(1);
}
