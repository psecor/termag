// A one-shot box agent for fakes.test.sh: connects with a box token, says
// hello as a credentials-v1 agent, and prints the first delivery step it gets
// ("<type> <provider> <reason>"), then leaves; a refused connection prints
// "closed <code> <reason>". Used to show that how an agent connects, and what
// headers it sends, changes nothing about its delivery.
//   node agent-probe.cjs <ws module> <url> <token> [ca.pem] [header=value ...]
// The token goes in Authorization, as agent/agent.js sends it;
// AGENT_PROBE_TOKEN_IN=query sends it as ?token=, as agents before that did.
const [wsModule, url, token, ca, ...extra] = process.argv.slice(2);
const WebSocket = require(wsModule);
const fs = require('fs');
const inQuery = process.env.AGENT_PROBE_TOKEN_IN === 'query';
const headers = {
  ...(inQuery ? {} : { Authorization: `Bearer ${token}` }),
  ...Object.fromEntries(extra.map(h => [h.slice(0, h.indexOf('=')), h.slice(h.indexOf('=') + 1)])),
};
const ws = new WebSocket(inQuery ? `${url}?token=${encodeURIComponent(token)}` : url, {
  headers, ...(ca && ca !== '-' ? { ca: fs.readFileSync(ca) } : {}),
});
const timer = setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
ws.on('open', () => ws.send(JSON.stringify({
  type: 'hello', unixUser: 'probe', home: '/tmp', hostname: 'probe', agentVersion: '0.0.0-probe', warm: false,
  capabilities: ['credentials-v1', 'github-broker-v1'],
})));
ws.on('message', raw => {
  const msg = JSON.parse(String(raw));
  if (!/^credentials-/.test(msg.type ?? '')) return;
  console.log(`${msg.type} ${msg.provider} ${msg.reason ?? '-'}`);
  clearTimeout(timer);
  ws.close();
  process.exit(0);
});
ws.on('close', (code, reason) => { console.log(`closed ${code} ${reason}`); process.exit(1); });
ws.on('error', err => { console.log(`error ${err.message}`); process.exit(1); });
