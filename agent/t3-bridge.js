'use strict';
/**
 * The box half of the desktop app's box bridge:
 * a t3 server (the t3code "environment") run as the box user on loopback,
 * pairing credentials minted for it, and tunnels the orchestrator asks for so
 * the desktop app can reach it through /termag/api/cli/v1/boxes/:id/t3/relay.
 *
 *   t3-ensure    start the t3 server if it isn't answering; report its state
 *   t3-pair      `t3 auth pairing create --json` as the box user; with a label,
 *                the box's earlier t3 sessions and unredeemed pairing
 *                credentials of that label are revoked (the desktop pairs each
 *                box with one label per device, so a Reconnect replaces its
 *                last session instead of adding one)
 *   t3-revoke    revoke the t3 sessions and pairing credentials of a label
 *                (the desktop's Forget and sign-out)
 *   t3-paths     project directories as this box sees them (path_remap)
 *   t3-update    the server of the desktop's own release when it is newer
 *                than this one: the installer's --release, then a restart
 *                onto it (t3-update-v1, where the agent runs the installer's
 *                launcher)
 *   tunnel-open  connect to the t3 server's port, then dial the orchestrator
 *                back on /ws/agent-tunnel?id=<tunnelId> with this agent's own
 *                token and pipe bytes both ways; fails when the server isn't
 *                running, and the orchestrator ensures and retries
 *
 * The server runs in a detached tmux session `termag-t3` on the box's tmux
 * server, so an agent restart (a box update) leaves it running, bound to
 * 127.0.0.1 on a port picked once and kept in ~/.termag/t3.json, with its
 * state under ~/.t3 and product analytics off. A tunnel names a target, never
 * a port: the orchestrator can reach the t3 server and nothing else. Its
 * environment carries TERMAG_T3=1, which the Claude Code hooks of its threads
 * see, so their status goes to the project they work in (deploy/termag-status).
 *
 * A port that is listening but slow to answer (t3 holds every request until
 * its startup is done) is waited for, never killed. Only one that clearly
 * answers as something else, and isn't the termag-t3 pane's own process tree,
 * is given up: its session killed and a new port picked (probeT3).
 *
 * Advertised as `t3-v1` when a t3 command resolves (TERMAG_T3_COMMAND, else
 * the agent config's `t3Command`, else `t3` on PATH), or when the checkout
 * pins a server this box can install and hasn't (createPinnedInstall): the
 * first t3-ensure installs it and answers `starting` until it is in place.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { TUNNEL_ID_RE, TUNNEL_STALL_MS, TUNNEL_DRAIN_POLL_MS, TUNNEL_CLOSE_TIMEOUT_MS, tunnelDialUrl, dialBack, pipe } = require('./tunnel-dial');

// t3-revoke-v1: t3-revoke, and t3-pair revoking what an earlier pair of its label left.
const CAPABILITIES = ['t3-v1', 't3-revoke-v1'];
// Advertised apart: only where the t3 the agent runs is the installer's own.
const UPDATE_CAPABILITIES = ['t3-update-v1'];
// A fork release's version (deploy/termag-t3-install --release takes the same).
const RELEASE_VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const SESSION_NAME = 'termag-t3';
const STATE_FILE = 't3.json';
const LOG_FILE = 't3.log';
const DESCRIPTOR_PATH = '/.well-known/t3/environment';
// A server that has not answered after this long is restarted: one launched
// and not listening, or the pane's own listener not answering as t3.
const START_GRACE_MS = 90_000;
// How long t3-ensure waits for a fresh server before answering `starting`.
const ENSURE_WAIT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1500;
const PAIR_TIMEOUT_MS = 60_000;
// `t3 auth … list` and `… revoke`: each a CLI process of a few seconds.
const AUTH_TIMEOUT_MS = 30_000;
// A `t3 thread` answer: the server closes a live query or imports a session's tail first.
const THREAD_TIMEOUT_MS = 30_000;
const THREAD_RESULTS = { session: null, release: ['released', 'busy', 'unknown'], adopt: ['adopted', 'busy', 'unknown', 'forked'] };
const LABEL_RE = /^[\w .:@()-]{1,80}$/;
const MAX_PATHS = 500;
// The pinned server is a ~90 MB download. The desktop asks again every 30 s,
// so a failed install waits a while before it downloads again.
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const INSTALL_RETRY_MS = 2 * 60_000;
const INSTALL_CHECK_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 30_000;
// How long t3-update waits for the running server to answer with its version
// (within the orchestrator's 7-minute bound on the RPC, after the install's 5).
const UPDATE_READY_WAIT_MS = 45_000;

/** The absolute path `cmd` runs as: itself when it has a slash, else its PATH hit; null when none. */
function resolveOnPath(cmd, envPath, fsImpl = fs) {
  if (!cmd || typeof cmd !== 'string') return null;
  const executable = (p) => {
    try { fsImpl.accessSync(p, fs.constants.X_OK); return fsImpl.statSync(p).isFile(); } catch { return false; }
  };
  if (cmd.includes('/')) return executable(cmd) ? path.resolve(cmd) : null;
  for (const dir of String(envPath || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, cmd);
    if (executable(p)) return p;
  }
  return null;
}

/**
 * The claude the box's t3 server should run, when one is pinned:
 * TERMAG_T3_CLAUDE_COMMAND, else the agent config's `t3ClaudeCommand`,
 * resolved to an absolute path on the agent's PATH. Null (the usual case on a
 * box) leaves t3 to its own lookup, which reads PATH from the user's login
 * shell and so can find a different claude than the agent's PATH would (the
 * e2e stand-in boxes pin theirs).
 */
function resolveT3ClaudeCommand({ env = process.env, config = {}, fsImpl = fs } = {}) {
  const fromEnv = typeof env.TERMAG_T3_CLAUDE_COMMAND === 'string' ? env.TERMAG_T3_CLAUDE_COMMAND.trim() : '';
  const fromConfig = typeof config.t3ClaudeCommand === 'string' ? config.t3ClaudeCommand.trim() : '';
  const cmd = fromEnv || fromConfig;
  return cmd ? resolveOnPath(cmd, env.PATH, fsImpl) : null;
}

/**
 * Pin t3's Claude provider to `claudePath` in the server's settings
 * (<home>/.t3/userdata/settings.json, providerInstances.claudeAgent), keeping
 * everything else in the file. A binary path someone set by hand is kept.
 */
function pinClaudeBinary(home, claudePath, fsImpl = fs) {
  const file = path.join(home, '.t3', 'userdata', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  const instances = settings.providerInstances && typeof settings.providerInstances === 'object' ? settings.providerInstances : {};
  const current = instances.claudeAgent && typeof instances.claudeAgent === 'object' ? instances.claudeAgent : {};
  const config = current.config && typeof current.config === 'object' ? current.config : {};
  if (typeof config.binaryPath === 'string' && config.binaryPath.trim()) return false;
  settings.providerInstances = { ...instances, claudeAgent: { driver: 'claudeAgent', ...current, config: { ...config, binaryPath: claudePath } } };
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** A Bedrock model id (`us.anthropic.claude-opus-5-5`) as t3's slug (`claude-opus-5-5`); null for any other shape. */
function gatewayModelSlug(id) {
  if (typeof id !== 'string') return null;
  // A cross-region prefix (us., eu., apac., global., us-gov.) or none.
  const m = /^(?:[a-z]+(?:-[a-z]+)*\.)?anthropic\.(claude-[a-z]+(?:-\d+)+)$/.exec(id.trim());
  return m ? m[1] : null;
}

/**
 * On a box whose Claude Code runs through termag's Claude gateway (Bedrock,
 * set in ~/.claude/settings.json's `env`), t3's own default Claude model may
 * be one the gateway refuses (403), and t3 titles threads and writes commit
 * messages with Codex unless told otherwise. So, while the server's settings
 * name none, its default model is the box's own ANTHROPIC_MODEL and its text
 * generation model ANTHROPIC_DEFAULT_SONNET_MODEL (else ANTHROPIC_MODEL), as
 * t3 slugs. A choice made in the app is kept. Returns what it set.
 */
function pinGatewayModels(home, fsImpl = fs) {
  let claude;
  try { claude = JSON.parse(fsImpl.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); } catch { return []; }
  const env = claude && typeof claude.env === 'object' && claude.env !== null ? claude.env : {};
  if (String(env.CLAUDE_CODE_USE_BEDROCK) !== '1' && env.CLAUDE_CODE_USE_BEDROCK !== true) return [];
  const wanted = [
    ['defaultModelSelection', gatewayModelSlug(env.ANTHROPIC_MODEL)],
    ['textGenerationModelSelection', gatewayModelSlug(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ?? gatewayModelSlug(env.ANTHROPIC_MODEL)],
  ];
  const file = path.join(home, '.t3', 'userdata', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  const set = [];
  for (const [key, model] of wanted) {
    if (!model || settings[key] != null) continue;
    settings[key] = { instanceId: 'claudeAgent', model };
    set.push(`${key}=${model}`);
  }
  if (set.length === 0) return [];
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return set;
}

// T3's Pi provider instance for Fireworks through termag's gateway,
// under an id that is termag's: an
// instance the owner added in the app gets an id of its own and is never
// touched. pi's provider is the one `termag-credentials pi-model` keeps.
const FIREWORKS_INSTANCE = 'termag-fireworks';
const CREDENTIALS_SCRIPT = path.join(__dirname, '..', 'deploy', 'termag-credentials');
const FIREWORKS_PI_PROVIDER = 'termag-fireworks';
// The shape the gateway and termag-credentials accept (services/fireworksGateway.ts FIREWORKS_MODEL_ID).
const FIREWORKS_MODEL_RE = /^accounts\/[a-z0-9-]+\/(?:models|routers)\/[A-Za-z0-9._-]+$/;

/**
 * t3-ensure's `fireworks` (routes/cliT3Prisma.ts): undefined when the
 * orchestrator said nothing (an older one, or the flags were unreadable),
 * null when Fireworks is off for this box, else the models it may call and
 * the one a new thread starts on. Malformed models are dropped.
 */
function parseFireworksParam(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.models)) return null;
  const models = raw.models
    .filter((m) => m && typeof m.id === 'string' && FIREWORKS_MODEL_RE.test(m.id))
    .map((m) => ({ id: m.id, context: Number.isInteger(m.context) && m.context >= 1000 && m.context < 1e9 ? m.context : null }));
  if (models.length === 0) return null;
  const defaultModel = models.some((m) => m.id === raw.defaultModel) ? raw.defaultModel : models[0].id;
  return { models, defaultModel };
}

/** The model ids pi's models.json already has under termag's Fireworks provider. */
function piFireworksModelIds(home, fsImpl = fs) {
  try {
    const config = JSON.parse(fsImpl.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8'));
    const models = config && config.providers && config.providers[FIREWORKS_PI_PROVIDER] && config.providers[FIREWORKS_PI_PROVIDER].models;
    return new Set(Array.isArray(models) ? models.map((m) => m && m.id).filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Write, update or (with `pin` null) remove t3's Fireworks instance in the
 * server's settings, keeping everything else in the file and the owner's
 * name and on/off choice for it. Returns whether the file changed.
 */
function pinFireworksInstance(home, pin, fsImpl = fs) {
  const file = path.join(home, '.t3', 'userdata', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  const instances = settings.providerInstances && typeof settings.providerInstances === 'object' ? settings.providerInstances : {};
  const current = instances[FIREWORKS_INSTANCE] && typeof instances[FIREWORKS_INSTANCE] === 'object' ? instances[FIREWORKS_INSTANCE] : null;
  let next;
  if (pin === null) {
    if (!current) return false;
    const { [FIREWORKS_INSTANCE]: _gone, ...rest } = instances;
    next = { ...settings, providerInstances: rest };
  } else {
    const config = current && current.config && typeof current.config === 'object' ? current.config : {};
    const instance = {
      ...current,
      driver: 'pi',
      displayName: (current && current.displayName) || 'Fireworks',
      enabled: current && typeof current.enabled === 'boolean' ? current.enabled : true,
      config: { ...config, binaryPath: pin.piPath, launchArgs: `--provider ${FIREWORKS_PI_PROVIDER} --model ${pin.defaultModel}` },
    };
    if (current && JSON.stringify(current) === JSON.stringify(instance)) return false;
    next = { ...settings, providerInstances: { ...instances, [FIREWORKS_INSTANCE]: instance } };
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

/**
 * The t3 command this agent would run, as an absolute path on the agent's
 * PATH, or null when none resolves. Absolute because the server runs in a
 * tmux pane, whose PATH is the tmux server's (however old that is), not the
 * agent's.
 */
function resolveT3Command({ env = process.env, config = {}, fsImpl = fs } = {}) {
  const fromEnv = typeof env.TERMAG_T3_COMMAND === 'string' ? env.TERMAG_T3_COMMAND.trim() : '';
  const fromConfig = typeof config.t3Command === 'string' ? config.t3Command.trim() : '';
  return resolveOnPath(fromEnv || fromConfig || 't3', env.PATH, fsImpl);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The shell line tmux runs for the server: exec, so the session ends with it. */
function serverCommandLine({ command, port, home, label = null }) {
  const t3Home = path.join(home, '.t3');
  const log = path.join(home, '.termag', LOG_FILE);
  return [
    'exec env',
    'T3CODE_TELEMETRY_ENABLED=false',
    'T3CODE_NO_BROWSER=1',
    // Tells termag-status that a Claude hook comes from a desktop thread: its
    // status is filed under the project whose checkout the thread runs in,
    // not this tmux session. t3 hands its environment to the Claude it runs.
    'TERMAG_T3=1',
    // The environment's name in the desktop app: the box's, not the VM's hostname.
    ...(label ? [`T3CODE_ENVIRONMENT_LABEL=${shellQuote(label)}`] : []),
    shellQuote(command),
    'serve',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--base-dir', shellQuote(t3Home),
    '>>', shellQuote(log), '2>&1',
  ].join(' ');
}

/**
 * One `t3 thread <sub> --json` answer: `session` is { sessionId, busy } as `{ result: 'ok', … }`, and
 * `release` and `adopt` name their result. Anything else is an error: the
 * runner then holds back rather than guess.
 */
function parseThreadOutput(sub, stdout) {
  const text = String(stdout || '');
  const start = text.lastIndexOf('\n{') >= 0 ? text.lastIndexOf('\n{') + 1 : text.indexOf('{');
  let parsed = null;
  if (start >= 0) { try { parsed = JSON.parse(text.slice(start)); } catch { parsed = null; } }
  if (!parsed || typeof parsed !== 'object') throw new Error(`t3 thread ${sub} printed no answer`);
  const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null;
  if (sub === 'session') return { result: 'ok', sessionId, busy: parsed.busy === true };
  if (!THREAD_RESULTS[sub].includes(parsed.result)) throw new Error(`t3 thread ${sub} answered ${JSON.stringify(parsed.result)}`);
  return { result: parsed.result, ...(sessionId ? { sessionId } : {}) };
}

/**
 * The last JSON object in `t3 auth pairing create --json` output. The command
 * prints the object pretty-printed; logs, when there are any, come before it.
 */
function parsePairingOutput(stdout) {
  const text = String(stdout || '');
  const start = text.lastIndexOf('\n{') >= 0 ? text.lastIndexOf('\n{') + 1 : text.indexOf('{');
  if (start < 0) throw new Error('t3 printed no pairing credential');
  let parsed;
  try { parsed = JSON.parse(text.slice(start)); } catch { throw new Error('t3 printed an unreadable pairing credential'); }
  if (typeof parsed?.credential !== 'string' || !parsed.credential) throw new Error('t3 printed no pairing credential');
  return {
    credential: parsed.credential,
    expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
    // The credential's own id, so a pair never revokes the one it just minted.
    id: typeof parsed.id === 'string' ? parsed.id : null,
  };
}

/**
 * The JSON array `t3 auth session list --json` and `t3 auth pairing list
 * --json` print (pretty-printed; logs, when there are any, come before it).
 */
function parseListOutput(stdout, what) {
  const text = String(stdout || '').trim();
  const start = text.startsWith('[') ? 0 : text.lastIndexOf('\n[');
  if (start < 0) throw new Error(`t3 printed no ${what} list`);
  let parsed;
  try { parsed = JSON.parse(text.slice(start)); } catch { throw new Error(`t3 printed an unreadable ${what} list`); }
  if (!Array.isArray(parsed)) throw new Error(`t3 printed no ${what} list`);
  return parsed;
}

/**
 * What to revoke for `label`, from the two lists: the sessions minted by
 * redeeming a pairing credential of that label (t3 gives the session the
 * credential's label) and the credentials of that label nobody redeemed yet.
 */
function staleAuthFor(label, { sessions, pairings }) {
  return {
    sessionIds: sessions
      .filter((s) => s && typeof s.sessionId === 'string' && s.client && s.client.label === label)
      .map((s) => s.sessionId),
    pairingIds: pairings
      .filter((p) => p && typeof p.id === 'string' && p.label === label)
      .map((p) => p.id),
  };
}

// Statuses t3 never answers its descriptor with, but a busy server may: t3
// itself answers 503 until its routes are attached (and 500 if startup failed).
const BUSY_STATUSES = new Set([408, 429]);

/**
 * GET the t3 descriptor on loopback:
 *   { t3: true, version }     t3 answered
 *   { t3: false }             something that is not t3 answered: a 200 that is
 *                             not t3's descriptor, another 2xx-4xx (t3 serves
 *                             the descriptor without auth), or not HTTP at all
 *   { t3: false, busy: true } something is listening but gave no clear answer:
 *                             a timeout (t3 holds every request until its
 *                             startup is done), a reset, a 5xx, 408 or 429
 *   null                      nothing is listening
 * Only the second may be taken as "not ours": a t3 that is starting or slow is
 * busy, never foreign.
 */
function probeT3(port, { httpImpl = http, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const busy = { t3: false, busy: true };
    let settled = false;
    let req = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req?.destroy();
      resolve(result);
    };
    // The whole answer, not only an idle socket: a trickle is no answer either.
    const deadline = setTimeout(() => done(busy), timeoutMs);
    deadline.unref?.();
    req = httpImpl.get({ host: '127.0.0.1', port, path: DESCRIPTOR_PATH, timeout: timeoutMs, agent: false, headers: { accept: 'application/json' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 500 || BUSY_STATUSES.has(status)) { res.destroy(); done(busy); return; }
      if (status !== 200) { res.destroy(); done({ t3: false }); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        // t3's descriptor is a few KiB.
        if (body.length > 64 * 1024) { res.destroy(); done({ t3: false }); }
      });
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          const looksLikeT3 = d && typeof d === 'object' && (typeof d.environmentId === 'string' || typeof d.serverVersion === 'string');
          done(looksLikeT3 ? { t3: true, version: typeof d.serverVersion === 'string' ? d.serverVersion : null } : { t3: false });
        } catch { done({ t3: false }); }
      });
      // Cut off mid-body: no clear answer.
      res.on('aborted', () => done(busy));
      res.on('error', () => done(busy));
    });
    req.on('timeout', () => done(busy));
    req.on('error', (err) => {
      const code = err && err.code;
      if (code === 'ECONNREFUSED') done(null);
      // The reply was not HTTP: whatever holds the port, it is not t3.
      else if (typeof code === 'string' && code.startsWith('HPE_')) done({ t3: false });
      else done(busy);
    });
  });
}

/** Every pid that descends from `roots` (roots included), from `ps -A -o pid=,ppid=` output. */
function descendants(psOutput, roots) {
  const children = new Map();
  for (const line of String(psOutput || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [pid, ppid] = [Number(m[1]), Number(m[2])];
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const tree = new Set();
  const todo = [...roots];
  while (todo.length) {
    const pid = todo.pop();
    if (tree.has(pid)) continue;
    tree.add(pid);
    for (const c of children.get(pid) || []) todo.push(c);
  }
  return tree;
}

/** Socket inodes listening on `port` (any address), from /proc/net/tcp{,6} contents. */
function listeningInodes(procNetTcp, port) {
  const inodes = new Set();
  for (const line of String(procNetTcp || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
    if (f.length < 10 || !/^[0-9A-Fa-f]+:[0-9A-Fa-f]{4}$/.test(f[1])) continue;
    if (f[3] !== '0A') continue; // TCP_LISTEN
    if (parseInt(f[1].split(':')[1], 16) === port && f[9] !== '0') inodes.add(f[9]);
  }
  return inodes;
}

function pidList(stdout) {
  return String(stdout || '').split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
}

function pickFreePort(netImpl = net) {
  return new Promise((resolve, reject) => {
    const srv = netImpl.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * deps:
 *   command      the t3 command (resolveT3Command); null with `pinned`
 *   pinned       createPinnedInstall: where the command comes from when
 *                there is none yet
 *   release      createReleaseInstall: what t3-update installs with; null,
 *                and t3-update refuses
 *   home         the box user's home
 *   execFile     promisified child_process.execFile ({ stdout })
 *   remapPath    the agent's path_remap
 *   termagUrl    the agent's /ws/agent URL; token: its bearer token
 *   claudeCommand  resolveT3ClaudeCommand: a claude to pin t3's Claude provider to
 *   piCommand    pi on the agent's PATH, for t3's Fireworks instance (null: none)
 *   credentials  deploy/termag-credentials, which adds a model to pi's Fireworks provider
 *   WebSocket    the ws library's WebSocket
 *   now, log     injectable for tests
 *   updateReadyWaitMs  how long t3-update waits for the running server's
 *                answer (UPDATE_READY_WAIT_MS)
 *   tunnelStallMs, tunnelDrainPollMs  how long a finished tunnel's queued
 *                bytes may make no progress before it is given up, and how
 *                often that is checked (TUNNEL_STALL_MS, TUNNEL_DRAIN_POLL_MS)
 *   tunnelCloseTimeoutMs  the dial-back's close handshake bound (TUNNEL_CLOSE_TIMEOUT_MS)
 */
function createT3Bridge(deps) {
  const {
    command: given = null, pinned = null, release = null, home, execFile, remapPath = (p) => p, termagUrl, token, WebSocket, claudeCommand = null,
    piCommand = null, credentials = CREDENTIALS_SCRIPT,
    netImpl = net, httpImpl = http, fsImpl = fs, now = () => Date.now(), log = () => {},
    ensureWaitMs = ENSURE_WAIT_MS, updateReadyWaitMs = UPDATE_READY_WAIT_MS, pollMs = 250,
    tunnelStallMs = TUNNEL_STALL_MS, tunnelDrainPollMs = TUNNEL_DRAIN_POLL_MS,
    tunnelCloseTimeoutMs = TUNNEL_CLOSE_TIMEOUT_MS,
  } = deps;
  const stateDir = path.join(home, '.termag');
  const statePath = path.join(stateDir, STATE_FILE);
  const tunnels = new Set();
  let startedAt = 0;
  // While the pane's own listener isn't answering as t3: since when, and when
  // that was last seen. A gap longer than the grace starts the count over, so
  // two slow moments hours apart don't add up to a restart.
  let unanswered = null;
  let boxLabel = null;
  let fireworksSync = Promise.resolve();
  let ensuring = null;
  let command = given;

  function readState() {
    try {
      const s = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
      return Number.isInteger(s?.port) && s.port > 0 && s.port < 65536 ? s : {};
    } catch { return {}; }
  }

  function writeState(state) {
    fsImpl.mkdirSync(stateDir, { recursive: true });
    fsImpl.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  async function port() {
    const s = readState();
    if (s.port) return s.port;
    const p = await pickFreePort(netImpl);
    writeState({ port: p });
    return p;
  }

  async function sessionExists() {
    try { await execFile('tmux', ['has-session', '-t', `=${SESSION_NAME}`], { timeout: 5000 }); return true; } catch { return false; }
  }

  async function killSession() {
    try { await execFile('tmux', ['kill-session', '-t', `=${SESSION_NAME}`], { timeout: 5000 }); } catch { /* gone */ }
  }

  /** The termag-t3 session's pane pids; none when there is no session. */
  async function panePids() {
    try {
      const { stdout } = await execFile('tmux', ['list-panes', '-s', '-t', `=${SESSION_NAME}`, '-F', '#{pane_pid}'], { timeout: 5000 });
      return pidList(stdout);
    } catch { return []; }
  }

  /**
   * Which of `candidates` listen on `port`, or every listener lsof can see;
   * null when this host can tell neither way (no lsof and no /proc, say).
   */
  async function listenersOn(port, candidates) {
    try {
      const { stdout } = await execFile('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 5000 });
      return pidList(stdout);
    } catch (err) {
      // lsof exits 1 when it finds nothing; anything else means no lsof to ask.
      if (err && err.code === 1) return pidList(err.stdout);
    }
    // No lsof (a minimal Linux image): the socket's inode, then which of the
    // candidates holds it. macOS has neither /proc nor, then, an answer.
    if (!fsImpl.existsSync('/proc/net/tcp')) return null;
    const inodes = listeningInodes(['/proc/net/tcp', '/proc/net/tcp6'].map((f) => {
      try { return fsImpl.readFileSync(f, 'utf8'); } catch { return ''; }
    }).join('\n'), port);
    const found = [];
    for (const pid of candidates) {
      let fds;
      try { fds = fsImpl.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      if (fds.some((fd) => {
        try { return inodes.has((/^socket:\[(\d+)\]$/.exec(fsImpl.readlinkSync(`/proc/${pid}/fd/${fd}`)) || [])[1]); } catch { return false; }
      })) found.push(pid);
    }
    return found;
  }

  /**
   * Whether what listens on `port` is the termag-t3 pane's own process or one
   * of its descendants (a wrapper script's node, say): true or false, or null
   * when this host can't tell. Without ps the pane's own pid still counts.
   */
  async function portHeldByPane(port) {
    const panes = await panePids();
    if (!panes.length) return false;
    let tree;
    try { tree = descendants((await execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout, panes); } catch { tree = new Set(panes); }
    const listeners = await listenersOn(port, [...tree]);
    if (listeners === null) return null;
    return listeners.some((pid) => tree.has(pid));
  }

  async function startServer(p) {
    fsImpl.mkdirSync(stateDir, { recursive: true });
    if (claudeCommand && pinClaudeBinary(home, claudeCommand, fsImpl)) log(`[T3] pinned t3's Claude to ${claudeCommand}`);
    const models = pinGatewayModels(home, fsImpl);
    if (models.length > 0) log(`[T3] the Claude gateway's models: ${models.join(', ')}`);
    const line = serverCommandLine({ command, port: p, home, label: boxLabel });
    await execFile('tmux', ['new-session', '-d', '-s', SESSION_NAME, '-c', home, line], { timeout: 10_000 });
    startedAt = now();
    unanswered = null;
    log(`[T3] started ${command} on 127.0.0.1:${p} in tmux session ${SESSION_NAME}`);
  }

  async function waitReady(p, ms) {
    const deadline = now() + ms;
    for (;;) {
      const probe = await probeT3(p, { httpImpl });
      if (probe?.t3 && (await portHeldByPane(p)) === true) return probe;
      if (now() >= deadline) return null;
      await wait(pollMs);
    }
  }

  /** Ready once the server on `p` answers within `ms`, else starting. */
  async function readyOrStarting(p, ms) {
    const ready = await waitReady(p, ms);
    if (ready) unanswered = null;
    return ready ? { state: 'ready', port: p, version: ready.version, home } : { state: 'starting', port: p, version: null, home };
  }

  async function ensureOnce(waitMs) {
    if (!command && pinned) command = pinned.commandOrInstall();
    if (!command) return { state: 'starting', port: null, version: null, home };
    let p = await port();
    const probe = await probeT3(p, { httpImpl });
    if (probe) {
      // Whatever answers, it is the server only if the termag-t3 pane's own
      // process tree holds the port: a loopback port is any local user's to
      // bind, and tunnels carry the desktop's t3 credentials to it.
      const held = await portHeldByPane(p);
      if (held === null) throw new Error(`can't tell what listens on 127.0.0.1:${p} (no lsof or /proc)`);
      if (held) {
        if (probe.t3) { unanswered = null; return { state: 'ready', port: p, version: probe.version, home }; }
        // Listening, no clear answer (a t3 still starting holds requests
        // until it is up), or not answering as t3: ours either way, so it is
        // never moved for that, and restarted only once it has gone a whole
        // grace without answering.
        const t = now();
        if (!unanswered || t - unanswered.seen > START_GRACE_MS) unanswered = { since: t, seen: t };
        unanswered.seen = t;
        if (t - unanswered.since < START_GRACE_MS) {
          log(`[T3] 127.0.0.1:${p} is the ${SESSION_NAME} pane's own process, not answering yet; waiting`);
          return readyOrStarting(p, waitMs);
        }
      }
      // Something else holds it (a restart handed the port out, or another
      // user), or the pane's own server stopped answering: a fresh one, on a
      // port nothing holds, since a wedged process can outlive its session.
      const silentFor = held ? Math.round((now() - unanswered.since) / 1000) : 0;
      await killSession();
      const taken = p;
      p = await pickFreePort(netImpl);
      writeState({ port: p });
      log(held
        ? `[T3] the ${SESSION_NAME} pane's server on 127.0.0.1:${taken} has not answered for ${silentFor} s; restarting it on ${p}`
        : `[T3] 127.0.0.1:${taken} is held by a process outside the ${SESSION_NAME} pane; moved to ${p}`);
    }
    if (await sessionExists()) {
      if (startedAt && now() - startedAt < START_GRACE_MS) {
        return readyOrStarting(p, waitMs);
      }
      // Nothing listens on its port: a session this process didn't start, or
      // one that never answered. Start over.
      await killSession();
    }
    await startServer(p);
    return readyOrStarting(p, waitMs);
  }

  /**
   * Concurrent callers share one attempt. `label` (the box's name, from the
   * orchestrator) names the environment when this call starts the server.
   */
  async function ensure({ waitMs = ensureWaitMs, label, fireworks } = {}) {
    if (typeof label === 'string' && LABEL_RE.test(label)) boxLabel = label;
    // Before the server can start, so its settings and pinClaudeBinary's never race.
    fireworksSync = fireworksSync.then(() => syncFireworks(parseFireworksParam(fireworks)))
      .catch((err) => log(`[T3] could not set up Fireworks for t3: ${err.message}`));
    await fireworksSync;
    if (!ensuring) ensuring = ensureOnce(waitMs).finally(() => { ensuring = null; });
    return ensuring;
  }

  /**
   * t3's Fireworks instance as the orchestrator's `fireworks` says: each of
   * its models into pi's provider (the box keeps no list of its own, so each
   * is added once, as a launch would), then the instance; off, or not set up
   * here, the instance goes. Nothing when the orchestrator said nothing.
   */
  async function syncFireworks(fw) {
    if (fw === undefined) return;
    if (fw === null || !piCommand) {
      if (pinFireworksInstance(home, null, fsImpl)) log('[T3] removed t3\'s Fireworks instance');
      return;
    }
    const had = piFireworksModelIds(home, fsImpl);
    for (const m of fw.models) {
      if (had.has(m.id)) continue;
      try {
        await execFile(credentials, ['pi-model', '--model', m.id, ...(m.context ? ['--context', String(m.context)] : [])], { timeout: 15_000 });
      } catch (err) {
        // One model failing (a timeout, a context pi-model refuses) leaves the others.
        log(`[T3] could not add Fireworks model ${m.id} for pi: ${lastLine(err.stderr) || err.message}`);
      }
    }
    // What pi has now decides: none means Fireworks isn't set up for pi here.
    const have = piFireworksModelIds(home, fsImpl);
    const usable = fw.models.filter((m) => have.has(m.id));
    if (usable.length === 0) {
      if (pinFireworksInstance(home, null, fsImpl)) log('[T3] removed t3\'s Fireworks instance');
      return;
    }
    const defaultModel = usable.some((m) => m.id === fw.defaultModel) ? fw.defaultModel : usable[0].id;
    if (pinFireworksInstance(home, { piPath: piCommand, defaultModel }, fsImpl)) {
      log(`[T3] t3's Fireworks instance: ${usable.length} model(s), ${defaultModel} first`);
    }
  }

  async function t3Auth(args, timeout = AUTH_TIMEOUT_MS) {
    if (!command) throw new Error('the t3 server is not installed yet');
    return execFile(command, ['auth', ...args, '--base-dir', path.join(home, '.t3')], {
      timeout,
      cwd: home,
      env: { ...process.env, T3CODE_TELEMETRY_ENABLED: 'false', T3CODE_NO_BROWSER: '1' },
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  /**
   * `t3 thread <sub> … --json` against this box's running server: which Claude
   * session a thread has, closing its live query (release), and making it the
   * writer of a chat's session (adopt). A server without the command answers
   * `unsupported`, and one that isn't running `offline`: it holds nothing live.
   */
  async function t3Thread(sub, args) {
    if (!command) return { result: 'unsupported' };
    let stdout;
    try {
      ({ stdout } = await execFile(command, ['thread', sub, ...args, '--base-dir', path.join(home, '.t3'), '--json'], {
        timeout: THREAD_TIMEOUT_MS,
        cwd: home,
        env: { ...process.env, T3CODE_TELEMETRY_ENABLED: 'false', T3CODE_NO_BROWSER: '1' },
        maxBuffer: 1024 * 1024,
      }));
    } catch (err) {
      const stderr = String((err && err.stderr) || '');
      if (/Unknown subcommand "(session|release|adopt)"/.test(stderr)) return { result: 'unsupported' };
      if (/No running T3 Code server uses/.test(stderr)) return { result: 'offline' };
      throw err;
    }
    return parseThreadOutput(sub, stdout);
  }
  const threadSession = ({ threadId }) => t3Thread('session', ['--thread', threadId]);
  const threadRelease = ({ threadId }) => t3Thread('release', ['--thread', threadId]);
  const threadAdopt = ({ threadId, sessionId }) => t3Thread('adopt', ['--thread', threadId, '--session', sessionId]);

  /** The version a restart would run: the command's own --version. */
  async function installedVersion() {
    const { stdout } = await execFile(command, ['--version'], {
      timeout: VERSION_TIMEOUT_MS, cwd: home, env: { ...process.env, T3CODE_TELEMETRY_ENABLED: 'false' },
    });
    return (/(\d+\.\d+\.\d+)/.exec(String(stdout)) || [])[1] || null;
  }

  /**
   * The server of the desktop's own release, when it is newer than this one:
   * the installer's --release, then the running server restarted onto it,
   * so the desktop finds the server it was built with. The desktop asks only
   * while none of the box's threads runs a turn, since the restart ends them.
   * Only the installer's launcher is updated: a box that names its own t3
   * keeps it. Answers as ensure does, with the version the server reports.
   */
  let updating = null;
  async function updateOnce(version, label) {
    if (!command && pinned) {
      command = pinned.commandOrInstall();
      // A pinned install in flight (one the drop-in already names, when a box
      // update deferred the agent's restart) finishes first: the installer
      // runs one at a time, and --release would leave it to that one.
      if (!command) { await pinned.idle(); command = pinned.commandOrInstall(); }
    }
    const launcher = release.launcher();
    if (!command || command !== launcher) {
      throw new Error(command ? `this box runs its own t3 (${command}), not termag's; update it there` : 'the t3 server is not installed yet');
    }
    await release.install(version);
    const installed = await installedVersion();
    const state = await ensure({ label, waitMs: updateReadyWaitMs });
    // A server that answers restarts only onto a newer install. One that
    // doesn't answer may still be coming up on the previous tree, and has no
    // turn to lose.
    if (!installed || (state.state === 'ready' && (!state.version || compareVersions(installed, state.version) <= 0))) return state;
    log(`[T3] restarting the t3 server on ${installed} (was ${state.version ?? 'not answering'})`);
    await killSession();
    // An ensure already in flight may have planned around the server just
    // killed (waiting on it to answer): let it settle, then start afresh.
    while (ensuring) await ensuring.catch(() => {});
    return ensure({ label });
  }
  function update({ version, label } = {}) {
    if (typeof version !== 'string' || !RELEASE_VERSION_RE.test(version)) return Promise.reject(new Error('version must be x.y.z'));
    if (!release) return Promise.reject(new Error("this agent has no installer to update t3 with"));
    if (!updating) updating = updateOnce(version, label).finally(() => { updating = null; });
    return updating;
  }

  function checkLabel(label) {
    if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new Error('label must be 1-80 plain characters');
  }

  /** One pair or revoke at a time per label, so two pairs never each keep a credential. */
  const authQueues = new Map();
  function queued(label, run) {
    const previous = authQueues.get(label) || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    const tail = next.catch(() => {});
    authQueues.set(label, tail);
    tail.then(() => { if (authQueues.get(label) === tail) authQueues.delete(label); });
    return next;
  }

  async function listAuth() {
    const [sessions, pairings] = await Promise.all([
      t3Auth(['session', 'list', '--json']).then(({ stdout }) => parseListOutput(stdout, 'session')),
      t3Auth(['pairing', 'list', '--json']).then(({ stdout }) => parseListOutput(stdout, 'pairing')),
    ]);
    return { sessions, pairings };
  }

  /** Revokes what `staleAuthFor` picked; how many of each t3 says it revoked. */
  async function revokeAll({ sessionIds, pairingIds }) {
    // t3 may log before its `Revoked …` line.
    const revoked = (outs) => outs.reduce((n, { stdout }) => n + (String(stdout || '').match(/^Revoked /gm) || []).length, 0);
    const [sessions, pairings] = await Promise.all([
      Promise.all(sessionIds.map((id) => t3Auth(['session', 'revoke', id]))),
      Promise.all(pairingIds.map((id) => t3Auth(['pairing', 'revoke', id]))),
    ]);
    return { sessions: revoked(sessions), pairings: revoked(pairings) };
  }

  /**
   * A one-time pairing credential. With a label, what an earlier pair of that
   * label left is revoked too: the session its credential was redeemed for,
   * and a credential nobody redeemed. The lists are read before the create,
   * and pairs of one label are queued, so neither the new credential nor its
   * session can be among them; a revocation that fails is logged and the
   * credential still handed out.
   */
  async function pair({ label } = {}) {
    if (label === undefined || label === null) {
      const { credential, expiresAt } = await createPairing([]);
      return { credential, expiresAt };
    }
    checkLabel(label);
    return queued(label, async () => {
      const listed = await listAuth().catch((err) => { log(`[T3] could not list t3 sessions to revoke for "${label}": ${err.message}`); return null; });
      const created = await createPairing(['--label', label]);
      if (listed) {
        const stale = staleAuthFor(label, listed);
        try {
          const revoked = await revokeAll(stale);
          if (revoked.sessions || revoked.pairings) log(`[T3] pair "${label}": revoked ${revoked.sessions} session(s) and ${revoked.pairings} pairing credential(s) from before`);
        } catch (err) {
          log(`[T3] pair "${label}": could not revoke what an earlier pair left: ${err.message}`);
        }
      }
      return { credential: created.credential, expiresAt: created.expiresAt };
    });
  }

  async function createPairing(extra) {
    const { stdout } = await t3Auth(['pairing', 'create', '--json', ...extra], PAIR_TIMEOUT_MS);
    return parsePairingOutput(stdout);
  }

  /** Revokes the t3 sessions and unredeemed pairing credentials of `label`: `{ sessions, pairings }` revoked. */
  async function revoke({ label } = {}) {
    checkLabel(label);
    return queued(label, async () => revokeAll(staleAuthFor(label, await listAuth())));
  }

  function paths({ paths: list } = {}) {
    if (!Array.isArray(list) || list.length > MAX_PATHS) throw new Error(`paths must be an array of at most ${MAX_PATHS}`);
    return list.map((p) => {
      if (typeof p !== 'string' || !p.startsWith('/')) return { path: null, exists: false };
      const local = remapPath(p);
      let exists = false;
      try { exists = fsImpl.statSync(local).isDirectory(); } catch { /* missing */ }
      return { path: local, exists };
    });
  }

  function connectLocal(p) {
    return new Promise((resolve, reject) => {
      const sock = netImpl.connect({ host: '127.0.0.1', port: p });
      const fail = (err) => { sock.destroy(); reject(err); };
      sock.once('error', fail);
      sock.once('connect', () => { sock.off('error', fail); resolve(sock); });
    });
  }

  /**
   * Connect to the server first, then dial back, so the orchestrator's first
   * bytes always have somewhere to go. A server that isn't running dials
   * nothing and answers `{ ok: false, reason: 't3_not_running' }`; the
   * orchestrator then ensures and retries.
   */
  async function openTunnel({ tunnelId, target } = {}) {
    if (target !== 't3') throw new Error('unknown tunnel target');
    if (typeof tunnelId !== 'string' || !TUNNEL_ID_RE.test(tunnelId)) throw new Error('bad tunnel id');
    const p = readState().port;
    // The relay carries the desktop's t3 credentials: only to the pane's own
    // server, checked every time (the orchestrator then ensures, which moves
    // off a port someone else took, and retries).
    const owned = p ? (await portHeldByPane(p)) === true : false;
    const sock = owned ? await connectLocal(p).catch(() => null) : null;
    if (!sock) return { ok: false, reason: 't3_not_running' };
    const { ws, opened } = dialBack({ WebSocket, termagUrl, token, tunnelId, closeTimeoutMs: tunnelCloseTimeoutMs });
    const end = pipe(ws, sock, { WebSocket, tunnels, now, log, stallMs: tunnelStallMs, drainPollMs: tunnelDrainPollMs });
    await opened.catch((err) => { end(); throw err; });
    return { ok: true, port: p };
  }

  return { ensure, update, pair, revoke, paths, openTunnel, openTunnels: () => tunnels.size, threadSession, threadRelease, threadAdopt };
}

/** -1, 0 or 1 as release a is older than, the same as or newer than b (x.y.z, anything after ignored). */
function compareVersions(a, b) {
  const parts = (v) => String(v).split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  return 0;
}

/** The command the agent drop-in deploy/termag-t3-install writes names; null when there is none. */
function commandFromDropin(file, fsImpl = fs) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch { return null; }
  const found = [...text.matchAll(/^Environment=TERMAG_T3_COMMAND=(\S+)\s*$/gm)];
  return found.length ? found[found.length - 1][1] : null;
}

function lastLine(text) {
  return String(text || '').trim().split('\n').filter(Boolean).pop() || '';
}

/**
 * The server deploy/t3-server.pin names, on a box whose checkout pins one it
 * hasn't installed. termag-reconcile installs it at boot, before the agent
 * runs, and a new box has no gh login then (the agent signs gh in when its
 * owner's credentials arrive), so that first gh:// fetch fails. This runs the
 * same installer once the agent can.
 *
 *   check()             whether there is a server to adopt: `--check` reports
 *                       drift this box can fix, or the drop-in already names
 *                       an installed server this process started without
 *   commandOrInstall()  the installed server's command once an install has
 *                       succeeded; null while one runs, starting one when
 *                       none does; the last failure, thrown, for retryMs
 *   retry()             install again now, past the backoff, or right after
 *                       the run in flight: the owner's gh login is what makes
 *                       a failed gh:// fetch worth trying again, and a
 *                       t3-ensure can start an install before it lands
 *   idle()              settles once no install runs: the one in flight, and
 *                       a retry it starts, have finished, whatever the outcome
 */
function createPinnedInstall({
  installer, dropin, execFile, env = process.env, fsImpl = fs, now = () => Date.now(), log = () => {},
  timeoutMs = INSTALL_TIMEOUT_MS, retryMs = INSTALL_RETRY_MS,
}) {
  let installed = null;
  let running = null;
  let failed = null;
  let again = false;

  function adopted() {
    const cmd = commandFromDropin(dropin, fsImpl);
    return cmd ? resolveOnPath(cmd, env.PATH, fsImpl) : null;
  }

  async function check() {
    if (adopted()) return true;
    try {
      await execFile('bash', [installer, '--check'], { timeout: INSTALL_CHECK_TIMEOUT_MS, env });
      return false;
    } catch (err) {
      // 1 is drift this box can fix; anything else (no installer, 127) is not.
      return err?.code === 1;
    }
  }

  function commandOrInstall() {
    if (installed) return installed;
    if (running) return null;
    if (failed && now() - failed.at < retryMs) throw new Error(failed.message);
    log('[T3] installing the pinned t3 server');
    running = execFile('bash', [installer], { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 })
      .then(({ stdout }) => {
        const cmd = adopted();
        if (!cmd) throw new Error(lastLine(stdout) || 'the installer named no server');
        installed = cmd;
        failed = null;
        log(`[T3] installed the pinned t3 server: ${cmd}`);
      })
      .catch((err) => {
        const detail = lastLine(err?.stderr) || lastLine(err?.stdout) || err?.message || String(err);
        failed = { at: now(), message: `could not install the pinned t3 server: ${detail}` };
        log(`[T3] ${failed.message}`);
      })
      .finally(() => {
        running = null;
        if (again) { again = false; retry(); }
      });
    return null;
  }

  function retry() {
    if (installed) return;
    if (running) { again = true; return; }
    failed = null;
    commandOrInstall();
  }

  // The chain in commandOrInstall never rejects; its finally may start a retry.
  async function idle() {
    while (running) await running;
  }

  return { check, commandOrInstall, retry, idle };
}

/**
 * The installer's --release (deploy/termag-t3-install), for t3-update.
 *
 *   launcher()        the command the installer's drop-in names, the only t3
 *                     an update moves; null before anything is installed
 *   install(version)  the server of that fork release, made current (the
 *                     installer does nothing when it is no newer); rejects
 *                     with the installer's last line
 */
function createReleaseInstall({ installer, dropin, execFile, env = process.env, fsImpl = fs, timeoutMs = INSTALL_TIMEOUT_MS }) {
  function launcher() {
    const cmd = commandFromDropin(dropin, fsImpl);
    return cmd ? resolveOnPath(cmd, env.PATH, fsImpl) : null;
  }
  async function install(version) {
    try {
      await execFile('bash', [installer, '--release', version], { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 });
    } catch (err) {
      const detail = lastLine(err?.stderr) || lastLine(err?.stdout) || err?.message || String(err);
      throw new Error(`could not install t3 ${version}: ${detail}`);
    }
  }
  return { launcher, install };
}

module.exports = {
  CAPABILITIES,
  UPDATE_CAPABILITIES,
  SESSION_NAME,
  createT3Bridge,
  createPinnedInstall,
  createReleaseInstall,
  compareVersions,
  commandFromDropin,
  resolveT3Command,
  resolveT3ClaudeCommand,
  pinClaudeBinary,
  pinGatewayModels,
  gatewayModelSlug,
  parseFireworksParam,
  piFireworksModelIds,
  pinFireworksInstance,
  resolveOnPath,
  serverCommandLine,
  parsePairingOutput,
  parseThreadOutput,
  parseListOutput,
  staleAuthFor,
  tunnelDialUrl,
  probeT3,
  descendants,
  listeningInodes,
};
