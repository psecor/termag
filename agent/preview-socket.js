'use strict';
// The agent's local socket, for `termag preview run`: $XDG_RUNTIME_DIR/termag/agent.sock,
// 0600 in a 0700 directory. One JSON line in, one JSON line out.
//
//   { op: 'preview-run', checkout, command, port?, allow? }   -> { id, pid, checkout, logPath, allowed }
//   { op: 'preview-stop', id }                        -> { stopped }
//   { op: 'preview-status', id }                      -> { run: status | null }
//   { op: 'preview-list' }                            -> { runs }
//   anything else, or a refusal                       -> { error }
//
// A confined process can't reach it: seccomp refuses every AF_UNIX socket
// (preview-launcher/seccomp.go). Two checks back that up. The caller's uid and
// pid come from SO_PEERCRED, which Node can't read, so the accepted socket goes
// to the launcher's `peercred` mode; the request is read first, because Node
// stops reading a socket once it's handed to a child. A uid other than the
// agent's is refused, and so is a caller descending from a confined root, so a
// confined app can't start another app, confined or not.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_REQUEST = 256 * 1024;

function socketPath(env = process.env, uid = process.getuid()) {
  return path.join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'termag', 'agent.sock');
}

/** SO_PEERCRED of an accepted socket, read by the launcher binary. */
function peerCred(launcher, socket) {
  return new Promise((resolve, reject) => {
    const p = spawn(launcher, ['peercred'], { stdio: ['ignore', 'pipe', 'pipe', socket], env: {} });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('error', reject);
    // 'close', not 'exit': exit can come before the pipe's last data (Bugbot, #1520).
    p.on('close', (code) => {
      const m = /^(\d+) (\d+) (\d+)/.exec(out);
      if (code !== 0 || !m) { reject(new Error('could not read the caller (peercred)')); return; }
      resolve({ pid: Number(m[1]), uid: Number(m[2]), gid: Number(m[3]) });
    });
  });
}

/** Answer one request from a checked caller. */
async function handle(req, runs) {
  switch (req && req.op) {
    case 'preview-run': return runs.start({ checkout: req.checkout, command: req.command, port: req.port ?? undefined, allow: req.allow ?? undefined });
    case 'preview-stop': return { stopped: runs.stop(String(req.id)) };
    case 'preview-status': return { run: runs.status(String(req.id)) };
    case 'preview-list': return { runs: runs.list() };
    default: throw new Error(`unknown op ${String(req && req.op).slice(0, 40)}`);
  }
}

/**
 * Listen on the local socket. deps: runs (PreviewRuns), launcher, at
 * (socketPath()), log, uid (process.getuid()), peer (peerCred) for tests.
 */
function serve({ runs, launcher, at = socketPath(), log = () => {}, uid = process.getuid(), peer = peerCred }) {
  fs.mkdirSync(path.dirname(at), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(at), 0o700);
  try { fs.unlinkSync(at); } catch { /* none */ }
  const server = net.createServer((sock) => {
    const reply = (o) => { try { sock.end(`${JSON.stringify(o)}\n`); } catch { /* gone */ } };
    sock.on('error', () => {});
    // A caller gone before its answer (Ctrl-C or a hangup during the copy)
    // leaves no run behind with nobody in front of it (Bugbot, #1520).
    let gone = false;
    sock.on('close', () => { gone = true; });
    let buf = '';
    const onData = async (b) => {
      buf += b;
      if (buf.length > MAX_REQUEST) { sock.off('data', onData); reply({ error: 'request too large' }); return; }
      if (!buf.includes('\n')) return;
      sock.off('data', onData);
      let req;
      try { req = JSON.parse(buf.slice(0, buf.indexOf('\n'))); } catch { reply({ error: 'bad request' }); return; }
      let cred;
      try { cred = await peer(launcher, sock); } catch (e) {
        // The caller is read through the launcher: on a box without a usable one, say that, not the spawn's
        // ENOENT (Bugbot, #1520).
        const usable = typeof runs.usable === 'function' ? runs.usable(launcher) : { ok: true };
        reply(usable && usable.ok === false ? { error: usable.reason, code: usable.code } : { error: e.message });
        return;
      }
      if (cred.uid !== uid) { reply({ error: 'refused: another user' }); return; }
      if (runs.isConfined(cred.pid)) { reply({ error: 'refused: the caller runs under termag preview run' }); return; }
      try {
        const answer = await handle(req, runs);
        if (gone && req.op === 'preview-run' && answer && answer.id) {
          runs.stop(answer.id);
          log(`[PREVIEW-RUN] ${answer.id} stopped: its caller left before it started`);
          return;
        }
        reply(answer);
      } catch (e) {
        log(`[PREVIEW-RUN] ${String(req && req.op).slice(0, 40)} refused: ${e.message}`);
        // The refusal's name too, where it has one (launcher_missing...), for the CLI to say plainly.
        reply(typeof e.code === 'string' && /^[a-z_]+$/.test(e.code) ? { error: e.message, code: e.code } : { error: e.message });
      }
    };
    sock.on('data', onData);
  });
  server.on('error', (e) => log(`[PREVIEW-RUN] socket ${at}: ${e.message}`));
  server.listen(at, () => { try { fs.chmodSync(at, 0o600); } catch { /* gone */ } log(`[PREVIEW-RUN] listening on ${at}`); });
  return server;
}

module.exports = { socketPath, peerCred, handle, serve, MAX_REQUEST };
