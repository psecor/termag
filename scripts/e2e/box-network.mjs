// The network between the e2e stack's boxes and its orchestrator. Every box's
// agent URL points here, and each connection is relayed to the stack's front
// door (the backend, or nginx's TLS listener with E2E_TLS) from BOX_ADDRESS
// instead of 127.0.0.1. A real box reaches the orchestrator from its own VPC
// address, so the backend has to see the stand-in boxes as another host too:
// it trusts 127.0.0.1 as the orchestrator itself (status writes skip auth and
// are filed under no box), and behind nginx it reads the address nginx stamps
// in X-Termag-Peer-Addr. Linux routes all of 127.0.0.0/8 to lo, so no setup
// is needed. Plain TCP, so TLS passes through untouched.
//
// With several upstream ports (E2E_OVERLAP) it stands in for the ALB as well:
// it polls each backend's /termag/health/serving and sends new connections only
// to the ones answering 200, round robin, and to any listening one when none
// does. Connections it already relayed stay where they are, as on the ALB.
//
//   node box-network.mjs <listen-port> <upstream-port>[,<upstream-port>...]
import { connect, createServer } from 'node:net';

const BOX_ADDRESS = '127.0.0.2';
const HEALTH_PATH = '/termag/health/serving';
const HEALTH_EVERY_MS = 500;

const [listenArg, upstreamArg] = process.argv.slice(2);
const listenPort = Number(listenArg);
const upstreams = (upstreamArg ?? '').split(',').map(Number).filter(Boolean);
if (!listenPort || upstreams.length === 0) {
  console.error('usage: node box-network.mjs <listen-port> <upstream-port>[,<upstream-port>...]');
  process.exit(2);
}

const serving = new Set(upstreams.length === 1 ? upstreams : []);
let next = 0;

if (upstreams.length > 1) {
  const poll = async () => {
    for (const port of upstreams) {
      const ok = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(400) })
        .then(r => r.status === 200, () => false);
      if (ok !== serving.has(port)) console.log(`upstream ${port} ${ok ? 'serving' : 'not serving'}`);
      if (ok) serving.add(port); else serving.delete(port);
    }
  };
  setInterval(() => { void poll(); }, HEALTH_EVERY_MS);
  void poll();
}

function pickUpstream() {
  const pool = serving.size > 0 ? upstreams.filter(p => serving.has(p)) : upstreams;
  next = (next + 1) % pool.length;
  return pool[next];
}

createServer(box => {
  const up = connect({ host: '127.0.0.1', port: pickUpstream(), localAddress: BOX_ADDRESS });
  const close = () => { box.destroy(); up.destroy(); };
  box.on('error', close);
  up.on('error', close);
  box.pipe(up).pipe(box);
}).listen(listenPort, '127.0.0.1', () => {
  console.log(`box network on 127.0.0.1:${listenPort} -> 127.0.0.1:${upstreams.join(',')} from ${BOX_ADDRESS}`);
});
