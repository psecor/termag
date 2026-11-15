'use strict';
// A stand-in for `devin acp` (tests only): answers initialize, session/new, session/load and session/set_mode with
// Devin 3000.12.57's own recorded answers (3000.12.57/acp.json), and plays a scenario's turn on session/prompt.
// It writes what it saw (its argv, cwd, environment, every message from the client) to the scenario's `log`.
//   FAKE_DEVIN_SCENARIO=<file>: { log, load: 'ok'|'missing', replay: [update…], mode?: { ask: false },
//     turn: [{ update } | { request: { method, params } } | { waitCancel: true } | { exit: code }],
//     end: { stopReason } | { error } }
const fs = require('fs');
const path = require('path');

const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, '3000.12.57', 'acp.json'), 'utf8'));
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_DEVIN_SCENARIO, 'utf8'));
const log = (entry) => fs.appendFileSync(scenario.log, `${JSON.stringify(entry)}\n`);
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HOME|DEVIN_|XDG_|CHISEL_)/.test(k))) });

let nextId = 1000;
const waiting = new Map();
let cancelled = null;
const out = m => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) => new Promise((resolve) => { const id = ++nextId; waiting.set(id, resolve); out({ jsonrpc: '2.0', id, method, params }); });

function modesOf(base) {
  const r = JSON.parse(JSON.stringify(base));
  if (scenario.mode && scenario.mode.ask === false) r.modes.availableModes = r.modes.availableModes.filter(m => m.id !== 'ask');
  return r;
}

async function prompt(m) {
  const sessionId = m.params.sessionId;
  for (const step of scenario.turn || []) {
    if (step.sleep) await new Promise(r => setTimeout(r, step.sleep));
    if (step.update) update(sessionId, step.update);
    if (step.request) {
      const answer = await ask(step.request.method, { sessionId, ...step.request.params });
      log({ answered: step.request.method, answer });
    }
    if (step.waitCancel) {
      await new Promise(r => { cancelled = r; });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'cancelled' } });
      return;
    }
    if (step.exit != null) process.exit(step.exit);
  }
  const end = scenario.end || { stopReason: 'end_turn' };
  if (end.error) out({ jsonrpc: '2.0', id: m.id, error: end.error });
  else out({ jsonrpc: '2.0', id: m.id, result: { stopReason: end.stopReason } });
}

let carry = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const lines = (carry + chunk).split('\n');
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log({ got: m });
    if (m.id != null && !m.method) { const w = waiting.get(m.id); waiting.delete(m.id); if (w) w(m.result !== undefined ? { result: m.result } : { error: m.error }); continue; }
    if (m.method === 'session/cancel') { if (cancelled) cancelled(); continue; }
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: recorded.initialize });
    else if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: modesOf(recorded.sessionNew) });
    else if (m.method === 'session/load') {
      if (scenario.load !== 'ok') { out({ jsonrpc: '2.0', id: m.id, error: recorded.loadNotFound.error }); continue; }
      for (const u of scenario.replay || []) update(m.params.sessionId, u);
      out({ jsonrpc: '2.0', id: m.id, result: modesOf(recorded.sessionLoad.result) });
    } else if (m.method === 'session/set_mode') {
      update(m.params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: m.params.modeId });
      out({ jsonrpc: '2.0', id: m.id, result: {} });
    } else if (m.method === 'session/prompt') prompt(m);
    else out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not in the stand-in' } });
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => { log({ signal: 'SIGTERM' }); process.exit(143); });
