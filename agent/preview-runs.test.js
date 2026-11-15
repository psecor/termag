'use strict';
// agent/preview-runs.js, the unit half (ported from the prototype's preview-run.test.js, #1108);
// preview-runs.kernel.test.js runs the launcher for real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseStat, rootOf, listenerConfined, diagnose, validAllow, TCP_NOTICE, PreviewRuns, resolveNodeVersion, appPath, appEnv, needsNodeModulesCopy, commandTool, toolOf, validateCheckout,
} = require("./preview-runs");

const stat = (pid, ppid, start, comm = 'node') => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`;

test('parseStat: ppid and start time, whatever comm holds', () => {
  assert.deepEqual(parseStat(stat(42, 7, '12345')), { pid: 42, ppid: 7, startTime: '12345' });
  assert.deepEqual(parseStat(stat(42, 7, '999', 'a) S 1 (b')), { pid: 42, ppid: 7, startTime: '999' });
});

// A fake /proc: pid -> [ppid, starttime].
function fakeProc(tree, sockets = {}) {
  const files = {};
  for (const [pid, [ppid, start]] of Object.entries(tree)) files[`/proc/${pid}/stat`] = stat(pid, ppid, start);
  return {
    readFileSync: (f) => { if (f in files) return files[f]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    readdirSync: (d) => {
      if (d === '/proc') return Object.keys(tree);
      const m = /^\/proc\/(\d+)\/fd$/.exec(d);
      if (m) return (sockets[m[1]] || []).map((_, i) => String(i + 3));
      throw new Error('ENOENT');
    },
    readlinkSync: (l) => {
      const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(l);
      return `socket:[${sockets[m[1]][Number(m[2]) - 3]}]`;
    },
    files,
  };
}

const roots = new Map([['r1', { pid: 100, startTime: '5000', checkout: '/home/u/app', launcher: { features: ['tcp-allowlist'] } }]]);

test('rootOf: a descendant of a recorded root, matched by pid and start time', () => {
  const io = fakeProc({ 1: [0, '1'], 100: [1, '5000'], 101: [100, '5001'], 102: [101, '5002'], 200: [1, '6000'] });
  assert.equal(rootOf(102, roots, io.readFileSync).checkout, '/home/u/app');
  assert.equal(rootOf(100, roots, io.readFileSync).checkout, '/home/u/app');
  assert.equal(rootOf(200, roots, io.readFileSync), null, 'an unrelated process');
});

test('rootOf: a reused root pid with another start time is not the root', () => {
  const io = fakeProc({ 1: [0, '1'], 100: [1, '7777'], 101: [100, '7778'] });
  assert.equal(rootOf(101, roots, io.readFileSync), null);
});

test('rootOf: a process that double-forked away (reparented to the subreaper) loses the ancestry', () => {
  const io = fakeProc({ 1: [0, '1'], 50: [1, '2'], 100: [1, '5000'], 103: [50, '5003'] });
  assert.equal(rootOf(103, roots, io.readFileSync), null);
});

const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const listen = (inode, hexPort = '1435') => `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 ${inode} 1 0\n`;

function withTables(io, tcp) {
  io.files['/proc/net/tcp'] = header + tcp;
  io.files['/proc/net/tcp6'] = header;
  return io;
}

test('listenerConfined: every holder of every listening socket on the port descends from the checkout\'s root', () => {
  const tree = { 1: [0, '1'], 100: [1, '5000'], 101: [100, '5001'], 300: [1, '9000'] };
  // Port 5173 is 0x1435.
  let io = withTables(fakeProc(tree, { 101: ['11'] }), listen('11'));
  assert.deepEqual(listenerConfined(5173, '/home/u/app', roots, io), { ok: true });
  assert.equal(listenerConfined(5173, '/home/u/other', roots, io).ok, false, 'another checkout');

  io = withTables(fakeProc(tree, { 300: ['11'] }), listen('11'));
  assert.match(listenerConfined(5173, '/home/u/app', roots, io).reason, /wasn't started/);

  // The same socket shared with an unconfined process.
  io = withTables(fakeProc(tree, { 101: ['11'], 300: ['11'] }), listen('11'));
  assert.equal(listenerConfined(5173, '/home/u/app', roots, io).ok, false);

  // SO_REUSEPORT: a second, unconfined listener on the same port.
  io = withTables(fakeProc(tree, { 101: ['11'], 300: ['12'] }), listen('11') + listen('12'));
  assert.equal(listenerConfined(5173, '/home/u/app', roots, io).ok, false);

  // A socket no visible process holds (another user's, Docker's proxy).
  io = withTables(fakeProc(tree, {}), listen('11'));
  assert.equal(listenerConfined(5173, '/home/u/app', roots, io).ok, false);

  io = withTables(fakeProc(tree, {}), '');
  assert.equal(listenerConfined(5173, '/home/u/app', roots, io).ok, false);
});

function nvmHome(versions, aliases = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nvm-'));
  for (const v of versions) fs.mkdirSync(path.join(home, '.nvm/versions/node', v, 'bin'), { recursive: true });
  for (const [name, value] of Object.entries(aliases)) {
    fs.mkdirSync(path.dirname(path.join(home, '.nvm/alias', name)), { recursive: true });
    fs.writeFileSync(path.join(home, '.nvm/alias', name), `${value}\n`);
  }
  return home;
}

test('resolveNodeVersion: .nvmrc values and nvm aliases, without nvm.sh', () => {
  const home = nvmHome(['v20.11.1', 'v20.19.0', 'v24.22.1'], { default: 'lts/krypton', 'lts/krypton': 'v24.22.1' });
  assert.equal(resolveNodeVersion(home, '20'), 'v20.19.0');
  assert.equal(resolveNodeVersion(home, 'v20.11'), 'v20.11.1');
  assert.equal(resolveNodeVersion(home, '20.11.1\n'), 'v20.11.1');
  assert.equal(resolveNodeVersion(home, 'default'), 'v24.22.1');
  assert.equal(resolveNodeVersion(home, 'node'), 'v24.22.1');
  assert.equal(resolveNodeVersion(home, '18'), null, 'not installed');
  assert.equal(resolveNodeVersion(home, '../../.aws/credentials'), null);
});

// Pinning (Bugbot, #1520): a .nvmrc is read as nvm reads it, the first non-comment word, and lts/* is nvm's own alias
// for the newest LTS, not the newest installed version (a newer Current may be installed too).
test('resolveNodeVersion: a commented .nvmrc, and lts/* as nvm\'s alias for the newest LTS', () => {
  const { resolveNodeVersion, nvmrcVersion } = require('./preview-runs');
  const home = nvmHome(['v22.12.0', 'v24.22.1', 'v25.1.0'], { 'lts/*': 'lts/krypton', 'lts/krypton': 'v24.22.1', default: 'v22.12.0' });
  assert.equal(nvmrcVersion('# the app needs 22\n\n22   # LTS\n24\n'), '22');
  assert.equal(nvmrcVersion('\n# only comments\n'), null);
  assert.equal(resolveNodeVersion(home, '# pinned\n22\n'), 'v22.12.0');
  assert.equal(resolveNodeVersion(home, 'lts/*'), 'v24.22.1', 'the LTS, not v25 (Current)');
  assert.equal(resolveNodeVersion(home, 'node'), 'v25.1.0');
  // No lts alias written: unresolved here, so the caller falls back to default.
  const bare = nvmHome(['v22.12.0', 'v25.1.0'], { default: 'v22.12.0' });
  assert.equal(resolveNodeVersion(bare, 'lts/*'), null);
});

test('appPath: the run\'s node_modules/.bin, the .nvmrc\'s node, then the system', () => {
  const home = nvmHome(['v20.19.0', 'v24.22.1'], { default: '24' });
  const checkout = path.join(home, 'app');
  fs.mkdirSync(checkout);
  const work = '/run/r/work';
  assert.equal(appPath({ home, checkout, work }),
    `/run/r/work/node_modules/.bin:${home}/.nvm/versions/node/v24.22.1/bin:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`);
  fs.writeFileSync(path.join(checkout, '.nvmrc'), '20\n');
  assert.match(appPath({ home, checkout, work }), /v20\.19\.0\/bin/);
});

test('appEnv: only names the launcher allows (preview-launcher/env.go)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../preview-launcher/env.go'), 'utf8');
  const block = src.slice(src.indexOf('var AllowedEnv'), src.indexOf('}\n', src.indexOf('var AllowedEnv')));
  const allowed = new Set([...block.matchAll(/"([A-Za-z_]+)": true/g)].map((m) => m[1]));
  assert.ok(allowed.has('PATH') && allowed.has('TMPDIR'));
  const env = appEnv({ home: '/home/u', checkout: '/home/u/app', runDir: '/home/u/.local/state/termag-preview/r', port: 3000 });
  for (const kv of env) assert.ok(allowed.has(kv.split('=')[0]), kv);
  assert.ok(env.includes('TMPDIR=/home/u/.local/state/termag-preview/r/tmp'));
  assert.ok(env.includes('PORT=3000'));
  assert.ok(!env.some((kv) => /TOKEN|AWS|SSH|TMUX|DBUS|TERMAG/.test(kv)));
});

test('needsNodeModulesCopy: Storybook, and Next.js unless the command asks for webpack', () => {
  const has = (f) => f === '/home/u/app/node_modules/next/package.json';
  assert.equal(needsNodeModulesCopy(['npm', 'run', 'dev'], '/home/u/app', has), true);
  assert.equal(needsNodeModulesCopy(['npx', 'next', 'dev', '--webpack'], '/home/u/app', has), false);
  assert.equal(needsNodeModulesCopy(['npx', 'vite'], '/home/u/vite-app', has), false);
  const sb = (f) => f === '/home/u/sb/node_modules/storybook/package.json';
  assert.equal(needsNodeModulesCopy(['npm', 'run', 'storybook'], '/home/u/sb', sb), true);
});

test('needsNodeModulesCopy goes by the tool a command runs, when it can tell for certain', () => {
  // A monorepo that depends on Storybook and Next.js, like webapp (a 2.1 GB node_modules).
  const both = (f) => /node_modules\/(storybook|next)\/package\.json$/.test(f);
  const manifest = (scripts) => (f) => {
    if (f !== '/home/u/mono/package.json') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return JSON.stringify({ scripts });
  };
  const read = manifest({
    'rspack:watch': 'node --import=tsx/esm node_modules/@rspack/cli/bin/rspack.js serve --mode=development',
    storybook: 'NODE_ENV=storybook storybook dev -p 6006',
    dev: 'next dev',
    'dev:webpack': 'next dev --webpack',
    vite: 'vite --port 5173',
  });
  const copy = (argv) => needsNodeModulesCopy(argv, '/home/u/mono', both, read);
  // Known for certain: the overlay unless the tool is Storybook, or Next.js without --webpack.
  assert.equal(copy(['env', 'DEV_SERVER_PORT=3003', 'node', '--import=tsx/esm', 'node_modules/@rspack/cli/bin/rspack.js', 'serve']), false);
  assert.equal(copy(['env', 'A=1', 'npx', 'storybook', 'dev']), true);
  assert.equal(copy(['DEV_SERVER_PORT=3003', 'node', 'node_modules/@rspack/cli/bin/rspack.js', 'serve']), false);
  assert.equal(copy(['npx', 'vite']), false);
  assert.equal(copy(['pnpm', 'run', 'rspack:watch']), false);
  assert.equal(copy(['npm', 'run', 'vite']), false);
  assert.equal(copy(['npm', 'run', 'dev:webpack']), false);
  assert.equal(copy(['pnpm', 'exec', 'next', 'dev', '--webpack']), false);
  assert.equal(copy(['npx', 'storybook', 'dev']), true);
  assert.equal(copy(['node', 'node_modules/next/dist/bin/next', 'dev']), true);
  assert.equal(copy(['node_modules/.bin/next', 'dev']), true);
  assert.equal(copy(['pnpm', 'storybook']), true);
  assert.equal(copy(['yarn', 'dev']), true);
  // Devin, #1757: node's option values aren't the script, and `env VAR=…` reaches the package manager.
  assert.equal(copy(['node', '--require', 'tsx', 'node_modules/next/dist/bin/next', 'dev']), true);
  assert.equal(copy(['node', '-r', 'dotenv/config', 'node_modules/@rspack/cli/bin/rspack.js', 'serve']), false);
  assert.equal(copy(['env', 'NODE_ENV=development', 'pnpm', 'run', 'vite']), false);
});

test('needsNodeModulesCopy: what it can\'t read for certain goes by the dependencies (Devin and Bugbot, #1757)', () => {
  const sb = (f) => f.endsWith('/node_modules/storybook/package.json');
  const none = () => false;
  const pkg = (scripts) => () => JSON.stringify({ scripts });
  const cases = [
    // A shell runs the tool.
    [['sh', '-c', 'storybook dev'], {}],
    [['bash', '-lc', 'next dev'], {}],
    [['env', '-S', 'storybook dev'], {}],
    [['env', 'A=1'], {}],
    // A script runs another script, with or without `run`.
    [['npm', 'run', 'dev'], { dev: 'pnpm preview', preview: 'storybook dev' }],
    [['npm', 'run', 'dev'], { dev: 'yarn start' }],
    [['pnpm', 'dev'], { dev: 'npm run sb' }],
    [['npm', 'start'], { start: 'bun run sb' }],
    // Options that can pick another package's manifest, or that it would have to interpret.
    [['npm', '--workspace', 'web', 'run', 'dev'], { dev: 'vite' }],
    [['pnpm', '--filter', 'web', 'dev'], { dev: 'vite' }],
    [['pnpm', '-C', 'web', 'run', 'dev'], { dev: 'vite' }],
    [['yarn', 'workspace', 'web', 'dev'], { dev: 'vite' }],
    [['npx', '--yes', 'vite'], {}],
    // A wrapper runs the tool further on (Devin, #1757), and one this doesn't know names it.
    [['npm', 'run', 'dev'], { dev: 'cross-env NODE_ENV=storybook storybook dev' }],
    [['npm', 'run', 'dev'], { dev: 'nodemon --exec next dev' }],
    [['npm', 'run', 'dev'], { dev: 'my-runner next dev' }],
    [['dotenv', '--', 'next', 'dev'], {}],
    [['node', 'scripts/launch.js', 'storybook'], {}],
    // Inline code, a package.json script or the test runner instead of a script file (Bugbot, #1757).
    [['node', '-e', 'require("child_process").spawn("next")'], {}],
    [['node', '--run', 'dev'], { dev: 'next dev' }],
    [['node', '--test'], {}],
    // A wrapper reached through node's script path (Bugbot, #1757), and tools it doesn't know.
    [['node', 'node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {}],
    [['node', 'scripts/dev-server.js'], {}],
    [['my-dev-server', '--port', '3000'], {}],
    // A script that is more than one plain command: quotes, operators, substitutions.
    [['npm', 'run', 'dev'], { dev: 'concurrently "next dev" "tsc -w"' }],
    [['npm', 'run', 'dev'], { dev: "concurrently 'storybook dev'" }],
    [['npm', 'run', 'dev'], { dev: 'echo next && vite' }],
    [['npm', 'run', 'dev'], { dev: 'vite; storybook dev' }],
    [['npm', 'run', 'dev'], { dev: 'vite $(cat args)' }],
    // A script package.json doesn't have, no package.json, and npm's other commands.
    [['npm', 'run', 'nope'], { dev: 'vite' }],
    [['npm', 'test'], { test: 'vite' }],
    [['pnpm', 'install'], {}],
    [['bun', 'dev'], { dev: 'vite' }],
  ];
  for (const [argv, scripts] of cases) {
    const known = commandTool(argv, '/c', pkg(scripts));
    assert.ok(!known || !['vite', 'rspack', '@rspack/cli', 'next', 'storybook'].includes(known.tool), `${argv.join(' ')}: ${known && known.tool}`);
    assert.equal(needsNodeModulesCopy(argv, '/c', sb, pkg(scripts)), true, `${argv.join(' ')}, Storybook installed`);
    assert.equal(needsNodeModulesCopy(argv, '/c', none, pkg(scripts)), false, `${argv.join(' ')}, neither installed`);
  }
  assert.equal(commandTool(['npm', 'run', 'dev'], '/c', () => '{not json'), null);
});

test('toolOf: the executable, or node\'s script by its package', () => {
  assert.equal(toolOf(['vite', '--port', '5173']).tool, 'vite');
  assert.equal(toolOf(['A=1', '/usr/bin/node', 'server.mjs']).tool, 'server');
  assert.equal(toolOf(['node', '--import=tsx/esm', 'node_modules/@rspack/cli/bin/rspack.js', 'serve']).tool, '@rspack/cli');
  assert.equal(toolOf(['node', 'node_modules/@storybook/cli/bin/index.cjs']).tool, '@storybook/cli');
  assert.equal(toolOf(['node', 'node_modules/.bin/next', 'dev']).tool, 'next');
  assert.equal(toolOf(['node', './node_modules/.bin/storybook', 'dev']).tool, 'storybook');
  assert.equal(toolOf(['pnpm', 'dlx', 'next', 'dev']).tool, 'next');
  assert.equal(toolOf(['npm', 'exec', '--', 'storybook']).tool, 'storybook');
  assert.equal(toolOf(['node']), null);
  assert.equal(toolOf(['sh', '-c', 'vite']), null);
});

test('validateCheckout: canonical, under $HOME, a git work tree root', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  const repo = path.join(home, 'src/app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, 'termag/projects'), { recursive: true });
  fs.symlinkSync(repo, path.join(home, 'termag/projects/app'));
  assert.equal(validateCheckout(path.join(home, 'termag/projects/app'), home), repo, 'a symlinked project dir resolves');
  fs.mkdirSync(path.join(home, '.aws'));
  fs.symlinkSync(path.join(home, '.aws'), path.join(home, 'termag/projects/aws'));
  assert.throws(() => validateCheckout(path.join(home, 'termag/projects/aws'), home), /git work tree/);
  assert.throws(() => validateCheckout('/etc', home), /isn't under/);
  assert.throws(() => validateCheckout('app', home), /absolute/);
});

test('diagnose: the app\'s refused connects, named by kind and port, once the launcher said which ports it allows', () => {
  const src = fs.readFileSync(path.join(__dirname, '../preview-launcher/net.go'), 'utf8');
  const prefix = /const TCPNoticePrefix = "([^"]+)"/.exec(src)[1];
  assert.equal(prefix, TCP_NOTICE, 'the agent looks for the launcher\'s own line');
  const notice = `${prefix}443, 5432 (443 and the ports given to termag preview run --allow); any other, loopback and port 80 (instance metadata) included, is refused with EACCES`;
  // Output captured from confined runs on a box (2026-11-02, 2026-11-06).
  const log = [
    'termag-preview: landlock ABI 4',
    notice,
    '  [cause]: AggregateError [EACCES]: ',
    '      Error: connect EACCES 172.66.147.243:80 - Local (0.0.0.0:0)',
    '      Error: connect EACCES 2606:4700:10::ac42:93f3:80 - Local (:::0)',
    "curl: (7) Failed to connect to example.com port 80 after 0 ms: Couldn't connect to server",
    'Error: connect EACCES 127.0.0.1:9229',
    'Error: connect EACCES ::1:9229',
    'Error: connect EACCES 10.0.0.5:8443',
    'Error: connect EACCES 127.0.0.1:3001',
    // A declared port's own failure isn't this rule's.
    'Error: connect EACCES 127.0.0.1:5432',
  ].join('\n');
  const d = diagnose(log);
  assert.deepEqual(d.map((x) => [x.code, x.port, x.targets]), [
    ['port80_refused', 80, ['172.66.147.243', '2606:4700:10::ac42:93f3', 'example.com']],
    ['loopback_refused', 9229, ['127.0.0.1', '::1']],
    ['port_refused', 8443, ['10.0.0.5']],
    ['loopback_refused', 3001, ['127.0.0.1']],
    // The log's AggregateError [EACCES] too: its address isn't shown, so it may be another port.
    ['connect_refused', null, []],
  ]);
  assert.match(d[0].message, /port 80 .* instance metadata/);
  assert.match(d[1].message, /port 9229 on this box \(127\.0\.0\.1, ::1\) was refused: it is the Node inspector's default port/);
  assert.match(d[3].message, /port 3001 on this box \(127\.0\.0\.1\) was refused: .*\(this run: 443, 5432\)\. .* --allow 3001; never a debugger's port/);
  assert.match(d[2].message, /10\.0\.0\.5 port 8443 .* --allow 8443/);
  // Node's default print of a failed fetch, as captured: no address in it.
  const fetchLog = `${notice}\nTypeError: fetch failed\n  [cause]: AggregateError [EACCES]: \n    code: 'EACCES',\n    [errors]: [ [Error], [Error] ]\n`;
  assert.deepEqual(diagnose(fetchLog).map((x) => x.code), ['connect_refused']);
  assert.match(diagnose(fetchLog)[0].message, /connects only to 443, 5432/);
  assert.deepEqual(diagnose('Error: connect EACCES 1.2.3.4:80\n'), [], 'no launcher notice: not ours to explain');
  // A debugger's port on another host can't be declared either: no --allow advice (Bugbot, #1521).
  const remote = diagnose(`${notice}\nError: connect EACCES 10.0.0.9:9229\n`);
  assert.deepEqual(remote.map((x) => [x.code, x.port]), [['port_refused', 9229]]);
  assert.match(remote[0].message, /10\.0\.0\.9 port 9229 was refused: it is the Node inspector's default port/);
  assert.doesNotMatch(remote[0].message, /--allow/);
});

test('validAllow: ports, never 80 or a default debugging port; 443 needn\'t be named', () => {
  assert.deepEqual(validAllow([5432, 3001, 5432, 443]), [3001, 5432]);
  assert.deepEqual(validAllow(undefined), []);
  assert.throws(() => validAllow([80]), /instance metadata/);
  assert.throws(() => validAllow([9229]), /Node inspector/);
  assert.throws(() => validAllow([9222]), /Chrome DevTools/);
  assert.throws(() => validAllow([0]), /not a port/);
  assert.throws(() => validAllow(['3001']), /not a port/);
  assert.throws(() => validAllow(Array.from({ length: 33 }, (_, i) => 2000 + i)), /at most 32/);
});

test('start refuses a declared port a debugger, shell or notebook holds (SR6), before anything is made', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  fs.mkdirSync(path.join(home, 'app/.git'), { recursive: true });
  const asked = [];
  const runs = new PreviewRuns({
    home, stateDir: path.join(home, 'state'), cgroupParent: '/nonexistent', usable: () => ({ ok: true }),
    classify: async (port) => { asked.push(port); return port === 8888 ? { ok: false, code: 'port_refused', reason: 'debugger or shell: Jupyter holds port 8888' } : { ok: false, code: 'port_closed', reason: 'nothing listens' }; },
  });
  await assert.rejects(runs.start({ checkout: path.join(home, 'app'), command: ['node', 'x.js'], allow: [5432, 8888] }), /--allow 8888 is refused: debugger or shell: Jupyter holds port 8888/);
  assert.deepEqual(asked, [5432, 8888]);
  assert.ok(!fs.existsSync(path.join(home, 'state')), 'nothing was made');
  await assert.rejects(runs.start({ checkout: path.join(home, 'app'), command: ['node', 'x.js'], allow: [80] }), /instance metadata/);
});

test('the local socket refuses another user, and a caller under a confined root, before any op (SO_PEERCRED)', async () => {
  const net = require('node:net');
  const { serve } = require('./preview-socket');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-sock-'));
  const at = path.join(dir, 'termag', 'agent.sock');
  const started = [];
  const runs = { isConfined: (pid) => pid === 4242, start: async (r) => { started.push(r); return { id: 'x' }; }, list: () => [], stop: () => false, status: () => null };
  let cred = { pid: 1, uid: 999, gid: 999 };
  const server = serve({ runs, launcher: '/nonexistent', at, uid: 1000, peer: async () => cred });
  await new Promise((r) => server.on('listening', r));
  const ask = (body) => new Promise((resolve, reject) => {
    const c = net.connect(at);
    let out = '';
    c.on('connect', () => c.write(`${JSON.stringify(body)}\n`));
    c.on('data', (b) => { out += b; });
    c.on('end', () => resolve(JSON.parse(out)));
    c.on('error', reject);
  });
  try {
    assert.deepEqual(await ask({ op: 'preview-run', checkout: '/x', command: ['x'] }), { error: 'refused: another user' });
    cred = { pid: 4242, uid: 1000, gid: 1000 };
    assert.deepEqual(await ask({ op: 'preview-run', checkout: '/x', command: ['x'] }), { error: 'refused: the caller runs under termag preview run' });
    assert.deepEqual(started, []);
    cred = { pid: 7, uid: 1000, gid: 1000 };
    assert.deepEqual(await ask({ op: 'preview-run', checkout: '/x', command: ['x'] }), { id: 'x' });
    assert.deepEqual(await ask({ op: 'preview-list' }), { runs: [] });
    assert.match((await ask({ op: 'nope' })).error, /unknown op/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run whose caller left before its answer is stopped, not left running with nobody in front of it', async () => {
  const net = require('node:net');
  const { serve } = require('./preview-socket');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-sock-'));
  const at = path.join(dir, 'termag', 'agent.sock');
  let finish;
  const stopped = [];
  const runs = { isConfined: () => false, start: () => new Promise((r) => { finish = () => r({ id: 'abcdef012345' }); }), stop: (id) => { stopped.push(id); return true; } };
  const server = serve({ runs, launcher: '/nonexistent', at, uid: process.getuid(), peer: async () => ({ pid: 7, uid: process.getuid(), gid: 0 }) });
  await new Promise((r) => server.on('listening', r));
  try {
    const c = net.connect(at);
    await new Promise((r) => c.on('connect', r));
    c.write(`${JSON.stringify({ op: 'preview-run', checkout: '/x', command: ['x'] })}\n`);
    for (let i = 0; i < 100 && !finish; i++) await new Promise((r) => setTimeout(r, 10));
    c.destroy(); // Ctrl-C during the copy
    await new Promise((r) => setTimeout(r, 50));
    finish();
    for (let i = 0; i < 100 && stopped.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(stopped, ['abcdef012345']);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('confinedAmong: many ports judged from one read of the tables and one walk of /proc (Bugbot, #1520)', () => {
  const { confinedAmong } = require('./preview-runs');
  const tree = { 1: [0, '1'], 100: [1, '5000'], 101: [100, '5001'], 300: [1, '9000'] };
  // 5173 (0x1435) held by the confined 101; 3000 (0x0BB8) by the unconfined 300; 4000 (0x0FA0) by both.
  const io = withTables(fakeProc(tree, { 101: ['11', '13'], 300: ['12', '14'] }), listen('11') + listen('12', '0BB8') + listen('13', '0FA0') + listen('14', '0FA0'));
  let walks = 0;
  const readdir = io.readdirSync;
  io.readdirSync = (d) => { if (d === '/proc') walks++; return readdir(d); };
  assert.deepEqual([...confinedAmong([5173, 3000, 4000, 8080], '/home/u/app', roots, io)], [5173]);
  assert.equal(walks, 1);
  assert.deepEqual([...confinedAmong([5173], '/home/u/other', roots, io)], []);
});

test('confinedAmong: a run of a repository in a multi-repo workspace counts for the workspace, and only there', () => {
  const { confinedAmong } = require('./preview-runs');
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-')));
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')));
  try {
    fs.writeFileSync(path.join(ws, '.termag-workspace'), 'marker\n');
    fs.mkdirSync(path.join(ws, '.worktrees', 'feat', 'app'), { recursive: true });
    const tree = { 1: [0, '1'], 100: [1, '5000'], 101: [100, '5001'] };
    const io = withTables(fakeProc(tree, { 101: ['11'] }), listen('11'));
    const runOf = (checkout) => new Map([['r1', { pid: 100, startTime: '5000', checkout, launcher: { features: ['tcp-allowlist'] } }]]);
    // A repository directly in the workspace root, and one in a workstream root under .worktrees/: theirs.
    assert.deepEqual([...confinedAmong([5173], ws, runOf(path.join(ws, 'app')), io).vouched], [5173]);
    const wsRoot = path.join(ws, '.worktrees', 'feat');
    assert.deepEqual([...confinedAmong([5173], wsRoot, runOf(path.join(wsRoot, 'app')), io).vouched], [5173]);
    // Not deeper, not the main checkout's repository for a workstream, and not under a folder without the marker.
    assert.deepEqual([...confinedAmong([5173], ws, runOf(path.join(wsRoot, 'app')), io)], []);
    assert.deepEqual([...confinedAmong([5173], wsRoot, runOf(path.join(ws, 'app')), io)], []);
    assert.deepEqual([...confinedAmong([5173], plain, runOf(path.join(plain, 'app')), io)], []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('a launcher that fails to spawn ends the start, and its error event never reaches the agent (Bugbot, #1520)', async () => {
  const { EventEmitter } = require('node:events');
  const { PreviewRuns } = require('./preview-runs');
  const { spawn } = require('node:child_process');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  fs.mkdirSync(path.join(home, 'app/.git'), { recursive: true });
  const cg = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  // The sync helper says ready; the launch spawn fails as Node reports it: no pid, then 'error' on the next tick.
  const spawnImpl = (bin, args, opts) => {
    if (args[0] === 'sync') return spawn('/bin/sh', ['-c', 'echo "termag-preview sync: ready" >&2; exec sleep 5'], { ...opts, stdio: ['ignore', 'ignore', 'pipe'] });
    if (args[0] === 'clean') return spawn('/bin/true');
    const child = new EventEmitter();
    child.pid = undefined;
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })));
    return child;
  };
  const runs = new PreviewRuns({ launcher: '/usr/bin/false', home, stateDir: path.join(home, 'state'), cgroupParent: cg, usable: () => ({ ok: true }), classify: async () => ({ ok: true }), spawnImpl });
  let unhandled = null;
  const onErr = (e) => { unhandled = e; };
  process.on('uncaughtException', onErr);
  try {
    await assert.rejects(runs.start({ checkout: path.join(home, 'app'), command: ['node', 'x.js'] }), /the launcher didn't start: EAGAIN/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, null);
    assert.equal(runs.roots.size, 0);
    // The ended record says why too (Devin, #1520).
    assert.deepEqual([...runs.ended.values()].map((e) => e.exit), ['launch failed (EAGAIN)']);
  } finally {
    process.off('uncaughtException', onErr);
  }
});

test('a sync helper that fails to spawn ends the start, never the agent; a stop kills the launcher\'s own group (Bugbot, #1520)', async () => {
  const { EventEmitter } = require('node:events');
  const { PreviewRuns } = require('./preview-runs');
  const { spawn } = require('node:child_process');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  fs.mkdirSync(path.join(home, 'app/.git'), { recursive: true });
  const cg = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  let unhandled = null;
  const onErr = (e) => { unhandled = e; };
  process.on('uncaughtException', onErr);
  try {
    const failing = () => { const c = new EventEmitter(); c.stderr = new EventEmitter(); process.nextTick(() => c.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }))); return c; };
    const a = new PreviewRuns({ launcher: '/usr/bin/false', home, stateDir: path.join(home, 'state'), cgroupParent: cg, usable: () => ({ ok: true }), spawnImpl: (b, args) => (args[0] === 'clean' ? spawn('/bin/true') : failing()) });
    await assert.rejects(a.start({ checkout: path.join(home, 'app'), command: ['node', 'x.js'] }), /the copy of the checkout didn't start: EMFILE/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, null);
    // A launch whose launcher hasn't joined the cgroup yet: the stop signals its process group.
    const spawnImpl = (b, args, opts) => {
      if (args[0] === 'sync') return spawn('/bin/sh', ['-c', 'echo "termag-preview sync: ready" >&2; exec sleep 30'], { ...opts, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
      if (args[0] === 'clean') return spawn('/bin/true');
      return spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    };
    const b = new PreviewRuns({ launcher: '/usr/bin/false', home, stateDir: path.join(home, 'state2'), cgroupParent: cg, usable: () => ({ ok: true }), spawnImpl });
    const run = await b.start({ checkout: path.join(home, 'app'), command: ['node', 'x.js'] }).catch((e) => ({ error: e.message }));
    if (run.error) assert.fail(run.error);
    const killed = [];
    const realKill = process.kill;
    process.kill = (pid, sig) => { killed.push([pid, sig]); return realKill.call(process, pid, sig); };
    try { b.stop(run.id); } finally { process.kill = realKill; }
    assert.ok(killed.some(([p]) => p === -run.pid), `killed ${JSON.stringify(killed)}, launcher ${run.pid}`);
  } finally {
    process.off('uncaughtException', onErr);
  }
});

test('a sync helper that stops right after ready ends the run, with no gap before the launch (Bugbot, #1520)', async () => {
  const { PreviewRuns } = require('./preview-runs');
  const { spawn } = require('node:child_process');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  fs.mkdirSync(path.join(home, 'app/.git'), { recursive: true });
  const cg = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  const launched = [];
  const spawnImpl = (b, args, opts) => {
    if (args[0] === 'sync') return spawn('/bin/sh', ['-c', 'echo "termag-preview sync: ready" >&2; exit 3'], { ...opts, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    if (args[0] === 'clean') return spawn('/bin/true');
    const c = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    launched.push(c);
    return c;
  };
  const runs = new PreviewRuns({ launcher: '/usr/bin/false', home, stateDir: path.join(home, 'state'), cgroupParent: cg, usable: () => ({ ok: true }), spawnImpl });
  const started = await runs.start({ checkout: path.join(home, 'app'), command: ['node', 'x.js'] }).then((r) => r, (e) => ({ error: e.message }));
  const deadline = Date.now() + 3000;
  while (runs.roots.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs.roots.size, 0, 'the run ended');
  const ended = [...runs.ended.values()];
  assert.ok(started.error || ended.some((e) => /^sync stopped/.test(String(e.exit))), JSON.stringify({ started, ended }));
  for (const c of launched) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('on a box without the launcher, the socket says so rather than the caller check\'s spawn error (Bugbot, #1520)', async () => {
  const net = require('node:net');
  const { serve } = require('./preview-socket');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-sock-'));
  const at = path.join(dir, 'termag', 'agent.sock');
  const { launcherUsable } = require('./preview-runs');
  const runs = { isConfined: () => false, usable: (l) => launcherUsable(l) };
  const server = serve({ runs, launcher: '/nonexistent', at, peer: async () => { throw new Error('spawn /nonexistent ENOENT'); } });
  await new Promise((r) => server.on('listening', r));
  try {
    const answer = await new Promise((resolve, reject) => {
      const c = net.connect(at);
      let out = '';
      c.on('connect', () => c.write(`${JSON.stringify({ op: 'preview-run', checkout: '/x', command: ['x'] })}\n`));
      c.on('data', (b) => { out += b; });
      c.on('end', () => resolve(JSON.parse(out)));
      c.on('error', reject);
    });
    // The refusal, named, for the CLI to say plainly (the 5a merge follow-up).
    assert.deepEqual(answer, { error: "This box's image predates the preview launcher. Update or recreate the box, then try again.", code: 'launcher_missing' });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkout\'s .nvmrc names a version or an alias, never a file to read (Bugbot, #1520)', () => {
  const { resolveNodeVersion, appPath } = require('./preview-runs');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  fs.mkdirSync(path.join(home, '.nvm/versions/node/v24.1.0'), { recursive: true });
  fs.mkdirSync(path.join(home, '.nvm/alias'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm/alias/default'), '24');
  fs.writeFileSync(path.join(home, 'secret'), 'v24.1.0');
  // An absolute path, or one climbing out, is no alias.
  assert.equal(resolveNodeVersion(home, path.join(home, 'secret')), null);
  assert.equal(resolveNodeVersion(home, '/dev/zero'), null);
  assert.equal(resolveNodeVersion(home, 'default'), 'v24.1.0');
  // A .nvmrc that is a symlink to a device isn't read; the default is used.
  const co = path.join(home, 'app');
  fs.mkdirSync(co);
  fs.symlinkSync('/dev/zero', path.join(co, '.nvmrc'));
  assert.match(appPath({ home, checkout: co, work: path.join(home, 'work') }), /v24\.1\.0\/bin/);
});

// Pinning (the 5a merge follow-up): a box without /usr/local/bin/termag-preview (an image before it; `box update`
// doesn't install it) refuses every confined run by name, and vouches for no listener, so only "only me" links,
// which ask for no confinement, are unaffected.
test('without the launcher: every confined run refused as launcher_missing, no listener vouched for, and a later install is seen', async () => {
  const { PreviewRuns, launcherUsable, LAUNCHER_MISSING } = require('./preview-runs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-nolauncher-'));
  const launcher = path.join(dir, 'termag-preview');
  try {
    assert.deepEqual(launcherUsable(launcher), { ok: false, code: 'launcher_missing', reason: LAUNCHER_MISSING });
    assert.equal(LAUNCHER_MISSING, "This box's image predates the preview launcher. Update or recreate the box, then try again.");
    const runs = new PreviewRuns({ launcher, home: dir, stateDir: path.join(dir, 'state'), cgroupParent: dir });
    await assert.rejects(runs.start({ checkout: dir, command: ['npm', 'start'], port: 5173 }), (e) => e.code === 'launcher_missing' && e.message === LAUNCHER_MISSING);
    const vouched = runs.listenerConfined(5173, dir);
    assert.equal(vouched.ok, false);
    assert.match(vouched.reason, /predates the preview launcher/);
    // Installed later (a box update): its features are read then, not the miss remembered.
    assert.equal(runs.loopbackRule(), false);
    fs.writeFileSync(launcher, '#!/bin/sh\n[ "$1" = features ] && echo tcp-allowlist\n', { mode: 0o755 });
    assert.equal(runs.loopbackRule(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pinning (Bugbot, #1520): the caller is read once the launcher's output is in, not at its exit, which can come first.
test('peerCred waits for the launcher\'s output, not just its exit', async () => {
  const net = require('node:net');
  const { peerCred } = require('./preview-socket');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-peercred-'));
  // Exits at once; its child writes the answer a moment later, on the same stdout.
  const fake = path.join(dir, 'termag-preview');
  fs.writeFileSync(fake, '#!/bin/sh\n(sleep 0.3; echo "4242 1000 1000") &\nexit 0\n', { mode: 0o755 });
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const client = net.connect(srv.address().port, '127.0.0.1');
  await new Promise((r) => client.on('connect', r));
  try {
    assert.deepEqual(await peerCred(fake, client), { pid: 4242, uid: 1000, gid: 1000 });
  } finally {
    client.destroy();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pinning (#1520): a version file is read by one open, then fstat of what was opened, capped: a FIFO doesn't
// hang the agent, and a symlink, /dev/zero or an oversized file is refused.
test('readSmall: one open, no symlink, no FIFO wait, a capped read', { skip: process.platform !== 'linux' }, () => {
  const { readSmall } = require('./preview-runs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readsmall-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok'), '22\n');
    assert.equal(readSmall(path.join(dir, 'ok')), '22\n');
    fs.writeFileSync(path.join(dir, 'big'), 'x'.repeat(10000));
    assert.throws(() => readSmall(path.join(dir, 'big')), /not a small regular file/);
    fs.symlinkSync('/dev/zero', path.join(dir, 'zero'));
    assert.throws(() => readSmall(path.join(dir, 'zero')), /ELOOP/);
    require('node:child_process').execFileSync('mkfifo', [path.join(dir, 'fifo')]);
    const started = Date.now();
    assert.throws(() => readSmall(path.join(dir, 'fifo')), /not a small regular file/);
    assert.ok(Date.now() - started < 1000, 'a FIFO was waited on');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pinning (#1520): cleanup never signals a process group whose leader has been reaped (its pid may be
// another's by then); the run's cgroup.kill covers what's left. A live leader's group is still signalled.
test('cleanup signals a launcher\'s or sync helper\'s group only while it is unreaped', () => {
  const { PreviewRuns } = require('./preview-runs');
  const killed = [];
  const runs = new PreviewRuns({ launcher: '/usr/bin/false', home: os.tmpdir(), stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), cgroupParent: os.tmpdir(), killImpl: (pid, sig) => { killed.push([pid, sig]); } });
  runs.cleanup({ id: 'a', pid: 4242, launcherReaped: true, sync: { pid: 4343 }, syncReaped: true, logFd: -1, swept: true });
  assert.deepEqual(killed, [], 'a reaped leader\'s group was signalled');
  runs.cleanup({ id: 'b', pid: 4242, sync: { pid: 4343 }, logFd: -1, swept: true });
  assert.deepEqual(killed, [[-4343, 'SIGKILL'], [-4242, 'SIGKILL']]);
});

// Pinning (#1520): the socket's backup confinement check also takes the run's cgroup, which a double fork
// can't leave, as it can leave the ancestry.
test('isConfined: a descendant of a run, or a process in a run\'s cgroup; not a sibling cgroup with a like name', () => {
  const { PreviewRuns } = require('./preview-runs');
  const runs = new PreviewRuns({ launcher: '/usr/bin/false', home: os.tmpdir(), stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), cgroupParent: '/sys/fs/cgroup/user.slice/agent/preview' });
  const proc = (cg) => (f) => { if (f.endsWith('/cgroup')) return `0::${cg}\n`; throw new Error('ENOENT'); };
  assert.equal(runs.isConfined(77, proc('/user.slice/agent/preview/r1')), true);
  assert.equal(runs.isConfined(77, proc('/user.slice/agent/preview/r1/inner')), true);
  assert.equal(runs.isConfined(77, proc('/user.slice/agent')), false);
  assert.equal(runs.isConfined(77, proc('/user.slice/agent/preview-evil')), false);
  assert.equal(runs.isConfined(77, () => { throw new Error('ENOENT'); }), false);
});

test('probeHost: every LISTEN address as something to dial, native IPv6 included (Bugbot, #1521)', () => {
  const { probeHost } = require('./preview-runs');
  assert.equal(probeHost('0100007F'), '127.0.0.1');
  assert.equal(probeHost('00000000'), '127.0.0.1');
  assert.equal(probeHost('00000000000000000000000000000000'), '::1');
  assert.equal(probeHost('00000000000000000000000001000000'), '0:0:0:0:0:0:0:1');
  assert.equal(probeHost('0000000000000000FFFF00000100007F'), '127.0.0.1');
  assert.equal(probeHost('B80D0120000000000000000001000000'), '2001:db8:0:0:0:0:0:1');
});

test('debuggerOnPort: a Docker-published shell is refused though no process of the user holds the port (Bugbot, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const empty = { readFileSync: (f) => { if (f.endsWith('/net/tcp') || f.endsWith('/net/tcp6')) return 'sl local rem st\n'; throw new Error('ENOENT'); }, readdirSync: () => [], readlinkSync: () => '' };
  const r = await debuggerOnPort(8888, { ...empty, dockerShell: async () => 'a jupyter/base-notebook container', probe: async () => false });
  assert.deepEqual(r, { ok: false, code: 'port_refused', reason: 'debugger or shell: a jupyter/base-notebook container publishes port 8888' });
  assert.deepEqual(await debuggerOnPort(5432, { ...empty, dockerShell: async () => null, probe: async () => false }), { ok: true });
});

test('launcherUsable: root\'s, ABI 4, and the TCP allowlist; an older launcher is refused, not run (Devin, #1521)', () => {
  const { launcherUsable } = require('./preview-runs');
  const io = (features, over = {}) => ({
    statSync: () => ({ uid: 0, mode: 0o100755, ...over }),
    execFileSync: (_bin, args) => { if (args[0] === 'abi') return '4\n'; if (features === null) throw new Error('usage'); return `${features}\n`; },
  });
  assert.deepEqual(launcherUsable('/usr/local/bin/termag-preview', io('tcp-allowlist')), { ok: true });
  assert.match(launcherUsable('/usr/local/bin/termag-preview', io(null)).reason, /predates the loopback rule/);
  assert.match(launcherUsable('/usr/local/bin/termag-preview', io('')).reason, /predates the loopback rule/);
  // Named, with the same plain advice as a missing one: update or recreate the box.
  const old = launcherUsable('/usr/local/bin/termag-preview', io(''));
  assert.equal(old.code, 'launcher_outdated');
  assert.match(old.reason, /Update or recreate the box, then try again\.$/);
  assert.match(launcherUsable('/usr/local/bin/termag-preview', io('tcp-allowlist', { uid: 1001 })).reason, /must be root's/);
});

test('debuggerOnPort: a Docker DNAT publish with no host listener is probed where it is published (Devin, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const empty = { readFileSync: (f) => { if (f.endsWith('/net/tcp') || f.endsWith('/net/tcp6')) return 'sl local rem st\n'; throw new Error('ENOENT'); }, readdirSync: () => [], readlinkSync: () => '' };
  const probed = [];
  const r = await debuggerOnPort(9339, { ...empty, dockerShell: async () => null, dockerBindings: async () => [{ ip: '0.0.0.0' }, { ip: '10.0.0.5' }], boxAddresses: () => ({ v4: [], v6: [] }), probe: async (h) => { probed.push(h); return h === '127.0.0.1'; } });
  assert.match(r.reason, /answers the DevTools protocol \(\/json\/version\) on 127\.0\.0\.1/);
  assert.deepEqual(probed, ['127.0.0.1']);
});

// Pinning (Cursor Security Agent, #1521): a wildcard Docker publish with userland-proxy off is DNAT alone, which
// loopback doesn't reach. It is probed on the box's own addresses too, and a publish no address reached is refused.
test('debuggerOnPort probes a wildcard Docker publish on the box\'s own addresses, and refuses one it couldn\'t reach (Cursor Security Agent, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const empty = { readFileSync: (f) => { if (f.endsWith('/net/tcp') || f.endsWith('/net/tcp6')) return 'sl local rem st\n'; throw new Error('ENOENT'); }, readdirSync: () => [], readlinkSync: () => '', dockerShell: async () => null, dockerSocketExists: () => true };
  const boxAddresses = () => ({ v4: ['10.0.0.5'], v6: ['2600:1f18::5'] });
  const published = async () => [{ ip: '0.0.0.0' }, { ip: '::' }];
  // DevTools answers only on the box's address, as DNAT with route_localnet off.
  const probed = [];
  const r = await debuggerOnPort(9339, { ...empty, boxAddresses, dockerBindings: published, probe: async (h) => { probed.push(h); return h === '10.0.0.5'; }, reaches: async () => true });
  assert.match(r.reason, /answers the DevTools protocol \(\/json\/version\) on 10\.0\.0\.5/);
  assert.deepEqual(probed, ['127.0.0.1', '10.0.0.5']);
  // Not a debugger, and reached (a published Postgres): allowed.
  assert.deepEqual(await debuggerOnPort(5432, { ...empty, boxAddresses, dockerBindings: published, probe: async () => false, reaches: async (h) => h === '10.0.0.5' }), { ok: true });
  // Nothing reached on any address: unchecked, so refused.
  const tried = [];
  const blind = await debuggerOnPort(5432, { ...empty, boxAddresses, dockerBindings: published, probe: async () => false, reaches: async (h) => { tried.push(h); return false; } });
  assert.equal(blind.code, 'port_refused');
  assert.match(blind.reason, /couldn't reach what Docker publishes on port 5432/);
  assert.deepEqual(tried, ['127.0.0.1', '10.0.0.5', '::1', '2600:1f18::5']);
  // No Docker publish: no reach check (a host listener's own probe decides).
  assert.deepEqual(await debuggerOnPort(5432, { ...empty, boxAddresses, dockerBindings: async () => [], probe: async () => false, reaches: async () => false }), { ok: true });
});

// Pinning (Bugbot, #1521): a listener whose holder this user can't see (root's Jupyter under sudo, a host-network
// container's ttyd) isn't taken as safe for want of a Docker publish: its uid's processes are classified, and a uid
// none of whose processes can be seen is refused.
test('debuggerOnPort judges a listener it can\'t see the holder of by its uid\'s processes, and refuses one it can\'t see at all (Bugbot, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const header = 'sl local rem st tx rx tr tm retr uid timeout inode\n';
  const row = '   0: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 77 1 0\n';
  const procs = (cmd) => ({
    readdirSync: (p) => (p === '/proc' ? ['1', '400', '500'] : []),
    readFileSync: (f) => {
      if (f.endsWith('/net/tcp')) return header + row;
      if (f.endsWith('/net/tcp6')) return header;
      if (f === '/proc/1/status' || f === '/proc/400/status') return 'Uid:\t0\t0\t0\t0\n';
      if (f === '/proc/500/status') return 'Uid:\t1000\t1000\t1000\t1000\n';
      if (f === '/proc/1/cmdline') return '/sbin/init\0';
      if (f === '/proc/400/cmdline') return cmd;
      if (f === '/proc/500/cmdline') return '/usr/bin/jupyter-lab\0';
      throw new Error('ENOENT');
    },
  });
  const base = { dockerShell: async () => null, dockerBindings: async () => [], dockerSocketExists: () => true, probe: async () => false, boxAddresses: () => ({ v4: [], v6: [] }) };
  const jupyter = await debuggerOnPort(8888, { ...base, ...procs('/usr/bin/python3\0/usr/local/bin/jupyter-lab\0--allow-root\0') });
  assert.equal(jupyter.code, 'port_refused');
  assert.match(jupyter.reason, /uid 0, which holds port 8888, runs Jupyter/);
  // Another uid's Jupyter isn't this listener's.
  assert.deepEqual(await debuggerOnPort(8888, { ...base, ...procs('/usr/sbin/sshd\0-D\0') }), { ok: true });
  // No process of the uid visible (hidepid): refused.
  const hidden = procs('');
  const blind = await debuggerOnPort(8888, { ...base, ...hidden, readdirSync: (p) => (p === '/proc' ? ['500'] : []) });
  assert.match(blind.reason, /held by a process termag can't see \(uid 0\)/);
});

// Pinning (Bugbot and Devin, #1521): a Docker publish on one address of a port doesn't vouch for a hidden listener on
// another: only root's rows where Docker publishes are taken for docker-proxy.
test('debuggerOnPort still judges a hidden listener on another bind of a port Docker publishes (Bugbot and Devin, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const header = 'sl local rem st tx rx tr tm retr uid timeout inode\n';
  // docker-proxy (root) on 127.0.0.1:8888, where Docker publishes; root's Jupyter on 0.0.0.0:8888 (SO_REUSEPORT).
  const rows = '   0: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 81 1 0\n'
    + '   1: 00000000:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 82 1 0\n';
  // pid 400 runs `cmd`; pid 401 is docker-proxy for `proxyIps`.
  const io = (cmd, table = rows, proxyIps = ['127.0.0.1'], proxyUid = 0) => ({
    // docker-proxy's binary as installed: root's, not writable by others (CI has none to stat).
    statSync: (p) => { if (p === '/usr/bin/docker-proxy') return { isFile: () => true, uid: 0, mode: 0o100755 }; throw new Error('ENOENT'); },
    readdirSync: (p) => (p === '/proc' ? ['400', ...proxyIps.map((_, i) => String(401 + i))] : []),
    readFileSync: (f) => {
      if (f.endsWith('/net/tcp')) return header + table;
      if (f.endsWith('/net/tcp6')) return header;
      if (f === '/proc/400/status') return 'Uid:\t0\t0\t0\t0\n';
      if (/^\/proc\/\d+\/status$/.test(f)) return `Uid:\t${proxyUid}\t${proxyUid}\t${proxyUid}\t${proxyUid}\n`;
      if (f === '/proc/400/cmdline') return cmd;
      const m = /^\/proc\/(\d+)\/cmdline$/.exec(f);
      if (m && proxyIps[Number(m[1]) - 401] !== undefined) return ['/usr/bin/docker-proxy', '-proto', 'tcp', '-host-ip', proxyIps[Number(m[1]) - 401], '-host-port', '8888', '-container-ip', '172.17.0.2', '-container-port', '8888', '-use-listen-fd', ''].join('\0');
      throw new Error('ENOENT');
    },
  });
  const base = { dockerShell: async () => null, dockerBindings: async () => [{ ip: '127.0.0.1' }], dockerSocketExists: () => true, probe: async () => false, reaches: async () => true, boxAddresses: () => ({ v4: ['10.0.0.5'], v6: [] }) };
  const r = await debuggerOnPort(8888, { ...base, ...io('/usr/local/bin/jupyter-lab\0--allow-root\0') });
  assert.match(r.reason, /uid 0, which holds port 8888, runs Jupyter/);
  // docker-proxy alone, where Docker publishes: the Docker checks decide, not root's processes.
  const only = '   0: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 81 1 0\n';
  assert.deepEqual(await debuggerOnPort(8888, { ...base, ...io('/usr/local/bin/jupyter-lab\0', only) }), { ok: true });
  // The same for a publish on the IPv6 wildcard: docker-proxy's `::` row is Docker's (Bugbot, #1521).
  const v6 = (f) => (f.endsWith('/net/tcp6') ? header + '   0: 00000000000000000000000000000000:22B8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 83 1 0\n' : f.endsWith('/net/tcp') ? header : null);
  const io6 = io('/usr/local/bin/jupyter-lab\0', rows, ['::']);
  const read6 = { ...io6, readFileSync: (f) => v6(f) ?? io6.readFileSync(f) };
  assert.deepEqual(await debuggerOnPort(8888, { ...base, ...read6, dockerBindings: async () => [{ ip: '::' }] }), { ok: true });
  // A DNAT-only publish on :: (userland-proxy off) has no docker-proxy: root's row there is someone else's, and root's
  // Jupyter is refused (Devin, #1521).
  const dnat = io('/usr/local/bin/jupyter-lab\0', rows, []);
  const readDnat = { ...dnat, readFileSync: (f) => v6(f) ?? dnat.readFileSync(f) };
  assert.match((await debuggerOnPort(8888, { ...base, ...readDnat, dockerBindings: async () => [{ ip: '::' }] })).reason, /uid 0, which holds port 8888, runs Jupyter/);
  // A forged docker-proxy, another user's process naming itself so with the right flags, vouches for nothing: root's
  // Jupyter on that address is still refused (Cursor Security Agent, #1521).
  const forgedIo = io('/usr/local/bin/jupyter-lab\0', rows, ['::'], 1000);
  const readForged = { ...forgedIo, readFileSync: (f) => v6(f) ?? forgedIo.readFileSync(f) };
  assert.match((await debuggerOnPort(8888, { ...base, ...readForged, dockerBindings: async () => [{ ip: '::' }] })).reason, /uid 0, which holds port 8888, runs Jupyter/);
});

test('dockerProxyAddrs reads docker-proxy\'s own arguments for the port', () => {
  const { dockerProxyAddrs } = require('./preview-runs');
  const argv = (ip, port, proto = 'tcp') => ['/usr/bin/docker-proxy', '-proto', proto, '-host-ip', ip, '-host-port', String(port), '-container-ip', '172.17.0.2', '-container-port', '80', ''].join('\0');
  const forged = (ip) => ['/home/u/bin/docker-proxy', '-proto', 'tcp', '-host-ip', ip, '-host-port', '8888', ''].join('\0');
  const procs = {
    '10': argv('127.0.0.1', 8888), '11': argv('::', 8888), '12': argv('0.0.0.0', 9999), '13': argv('0.0.0.0', 8888, 'udp'),
    '14': ['/usr/bin/sleep', '-host-ip', '127.0.0.1', '-host-port', '8888', ''].join('\0'),
    // Forgeries (Cursor Security Agent, #1521): another user's process, root running a user-writable copy.
    '15': argv('0.0.0.0', 8888), '16': forged('10.0.0.5'),
  };
  const uids = { '15': 1000 };
  const files = {
    '/usr/bin/docker-proxy': { isFile: () => true, uid: 0, mode: 0o100755 },
    '/home/u/bin/docker-proxy': { isFile: () => true, uid: 1000, mode: 0o100755 },
  };
  const d = {
    readdirSync: () => Object.keys(procs),
    readFileSync: (f) => {
      let m = /^\/proc\/(\d+)\/cmdline$/.exec(f);
      if (m && procs[m[1]]) return procs[m[1]];
      m = /^\/proc\/(\d+)\/status$/.exec(f);
      if (m && procs[m[1]]) { const u = uids[m[1]] ?? 0; return `Uid:\t${u}\t${u}\t${u}\t${u}\n`; }
      throw new Error('ENOENT');
    },
    statSync: (p) => { if (files[p]) return files[p]; throw new Error('ENOENT'); },
  };
  assert.deepEqual([...dockerProxyAddrs(8888, d)].sort(), ['127.0.0.1', '::']);
  // A root-owned binary others can write isn't trusted either.
  files['/usr/bin/docker-proxy'] = { isFile: () => true, uid: 0, mode: 0o100777 };
  assert.deepEqual([...dockerProxyAddrs(8888, d)], []);
});

// Pinning (Cursor Security Agent, #1521): a wildcard listener is probed where the kernel hands it connections, so a
// more specific socket on 127.0.0.1 can't answer for it; one every probeable address of which is taken by more
// specific sockets is refused.
test('debuggerOnPort probes a wildcard listener at the addresses it takes, past a more specific loopback one (Cursor Security Agent, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const header = 'sl local rem st tx rx tr tm retr uid timeout inode\n';
  const line = (hex, inode) => `   0: ${hex}:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0\n`;
  const io = (rows) => ({
    readdirSync: (p) => (p === '/proc' ? ['9'] : p === '/proc/9/fd' ? ['3', '4', '5'] : []),
    readlinkSync: (p) => ({ '/proc/9/fd/3': 'socket:[71]', '/proc/9/fd/4': 'socket:[72]', '/proc/9/fd/5': 'socket:[73]', '/proc/9/cwd': '/home/u' }[p] || ''),
    readFileSync: (f) => {
      if (f.endsWith('/net/tcp')) return header + rows;
      if (f.endsWith('/net/tcp6')) return header;
      if (f === '/proc/9/cmdline') return 'node\0app.js\0';
      throw new Error('ENOENT');
    },
  });
  const base = { dockerShell: async () => null, dockerBindings: async () => [], dockerSocketExists: () => false, boxAddresses: () => ({ v4: ['10.0.0.5'], v6: [] }) };
  // 127.0.0.1 (the app's own service) and 0.0.0.0 (an inspector) on the same port: only 10.0.0.5 reaches the wildcard.
  const probed = [];
  const r = await debuggerOnPort(8888, { ...base, ...io(line('0100007F', 71) + line('00000000', 72)), probe: async (h) => { probed.push(h); return h === '10.0.0.5'; } });
  assert.match(r.reason, /answers the DevTools protocol \(\/json\/version\) on 10\.0\.0\.5/);
  assert.deepEqual(probed.sort(), ['10.0.0.5', '127.0.0.1']);
  // Every address it could take held by a more specific socket: unprobeable, refused.
  const covered = await debuggerOnPort(8888, { ...base, ...io(line('0100007F', 71) + line('0500000A', 73) + line('00000000', 72)), probe: async () => false });
  assert.match(covered.reason, /listens on every address, but more specific listeners take each address/);
  // A wildcard alone: probed on loopback and the box's address.
  const alone = [];
  assert.deepEqual(await debuggerOnPort(8888, { ...base, ...io(line('00000000', 72)), probe: async (h) => { alone.push(h); return false; } }), { ok: true });
  assert.deepEqual(alone, ['127.0.0.1', '10.0.0.5']);
});

test('canonIp writes IPv6 as probeHost does', () => {
  const { canonIp } = require('./preview-runs');
  assert.equal(canonIp('2600:1f18::5'), '2600:1f18:0:0:0:0:0:5');
  assert.equal(canonIp('::1'), '0:0:0:0:0:0:0:1');
  assert.equal(canonIp('10.0.0.5'), '10.0.0.5');
});

test('boxAddresses: the box\'s own addresses, loopback and link-local aside', () => {
  const { boxAddresses } = require('./preview-runs');
  assert.deepEqual(boxAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    ens5: [{ address: '10.0.0.5', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }, { address: '2600:1f18::5', family: 'IPv6', internal: false }],
  }), { v4: ['10.0.0.5'], v6: ['2600:1f18::5'] });
});

test('tcpReaches: a listener is reached, a closed port isn\'t', async () => {
  const { tcpReaches } = require('./preview-runs');
  const srv = require('node:net').createServer((c) => c.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await tcpReaches('127.0.0.1', port), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await tcpReaches('127.0.0.1', port), false);
});

test('diagnose: an unnamed refused fetch is reported beside named refusals (Devin, #1521)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../preview-launcher/net.go'), 'utf8');
  const prefix = /const TCPNoticePrefix = "([^"]+)"/.exec(src)[1];
  const log = `${prefix}443 (…)\nError: connect EACCES 127.0.0.1:3001\n  [cause]: AggregateError [EACCES]: \n`;
  assert.deepEqual(diagnose(log).map((d) => d.code), ['loopback_refused', 'connect_refused']);
});

test('debuggerOnPort fails closed when Docker is there but doesn\'t answer, for a root\'s or unseen listener (Bugbot, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  // Port 8888 (0x22B8) held by root's docker-proxy: no visible holder.
  const header = 'sl local rem st tx rx tr tm retr uid timeout inode\n';
  const row = '   0: 00000000:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 77 1 0\n';
  const io = { readFileSync: (f) => { if (f.endsWith('/net/tcp')) return header + row; if (f.endsWith('/net/tcp6')) return header; throw new Error('ENOENT'); }, readdirSync: () => [], readlinkSync: () => '', probe: async () => false };
  const down = await debuggerOnPort(8888, { ...io, dockerShell: async () => null, dockerBindings: async () => null, dockerSocketExists: () => true });
  assert.match(down.reason, /Docker didn't answer/);
  // A DNAT publish (userland-proxy off) has no host row at all: still refused while Docker is down (Bugbot, #1521).
  const noRows = { ...io, readFileSync: (f) => { if (f.endsWith('/net/tcp') || f.endsWith('/net/tcp6')) return header; throw new Error('ENOENT'); } };
  assert.match((await debuggerOnPort(8888, { ...noRows, dockerShell: async () => null, dockerBindings: async () => null, dockerSocketExists: () => true })).reason, /Docker didn't answer/);
  // No Docker on the box, or Docker answering with nothing published: root's listener is judged by root's
  // processes, which here run nothing of the kind (Bugbot, #1521).
  const rootProcs = { readdirSync: (p) => (p === '/proc' ? ['1', '400'] : []), readFileSync: (f) => {
    if (f === '/proc/1/status' || f === '/proc/400/status') return 'Name:\tx\nUid:\t0\t0\t0\t0\n';
    if (f === '/proc/1/cmdline') return '/sbin/init\0';
    if (f === '/proc/400/cmdline') return '/usr/sbin/sshd\0-D\0';
    return io.readFileSync(f);
  } };
  assert.deepEqual(await debuggerOnPort(8888, { ...io, ...rootProcs, dockerShell: async () => null, dockerBindings: async () => null, dockerSocketExists: () => false }), { ok: true });
  assert.deepEqual(await debuggerOnPort(8888, { ...io, ...rootProcs, dockerShell: async () => null, dockerBindings: async () => [], dockerSocketExists: () => true }), { ok: true });
});

test('start honours every refusal of the --allow check, Docker\'s fail-closed one included (Bugbot and Devin, #1521)', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  fs.mkdirSync(path.join(home, 'app/.git'), { recursive: true });
  const runs = new PreviewRuns({
    home, stateDir: path.join(home, 'state'), cgroupParent: '/nonexistent', usable: () => ({ ok: true }),
    classify: async () => ({ ok: false, code: 'port_refused', reason: "Docker didn't answer, so termag can't tell what publishes port 8888; try again once it does" }),
  });
  await assert.rejects(runs.start({ checkout: path.join(home, 'app'), command: ['node', 'x.js'], allow: [8888] }), /--allow 8888 is refused: Docker didn't answer/);
  assert.ok(!fs.existsSync(path.join(home, 'state')));
});

// Pinning (Bugbot, #1521): Docker failing to list a port's publishers is not "no shell publishes it". With a Docker on
// the box it refuses the port, even when a second look (the bindings) answers.
test('debuggerOnPort refuses when the Docker shell listing fails, whatever a later look says (Bugbot, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const empty = { readFileSync: (f) => { if (f.endsWith('/net/tcp') || f.endsWith('/net/tcp6')) return 'sl local rem st\n'; throw new Error('ENOENT'); }, readdirSync: () => [], readlinkSync: () => '' };
  const base = { ...empty, dockerBindings: async () => [{ ip: '127.0.0.1' }], probe: async () => false, reaches: async () => true, boxAddresses: () => ({ v4: [], v6: [] }) };
  const r = await debuggerOnPort(8888, { ...base, dockerShellAnswer: async () => ({ ok: false }), dockerSocketExists: () => true });
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /Docker didn't answer/);
  // Docker answering "no shell": allowed (the publish is reached and isn't DevTools).
  assert.deepEqual(await debuggerOnPort(8888, { ...base, dockerShellAnswer: async () => ({ ok: true, what: null }), dockerSocketExists: () => true }), { ok: true });
  // No Docker on the box at all: nothing to ask, nothing published.
  assert.deepEqual(await debuggerOnPort(8888, { ...base, dockerBindings: async () => [], dockerShellAnswer: async () => ({ ok: false }), dockerSocketExists: () => false }), { ok: true });
});

test('dockerShellAnswer tells a failed listing from "no shell"', async () => {
  const { dockerShellAnswerOn } = require('./port-guard');
  const list = (body) => async () => body;
  assert.deepEqual(await dockerShellAnswerOn(8888, { dockerGet: list(null) }), { ok: false });
  assert.deepEqual(await dockerShellAnswerOn(8888, { dockerGet: async () => { throw new Error('timeout'); } }), { ok: false });
  assert.deepEqual(await dockerShellAnswerOn(8888, { dockerGet: list([]) }), { ok: true, what: null });
  const jupyter = [{ Command: 'tini -- start-notebook.sh', Image: 'jupyter/base-notebook', Ports: [{ PublicPort: 8888, Type: 'tcp', IP: '0.0.0.0' }] }];
  assert.equal((await dockerShellAnswerOn(8888, { dockerGet: list(jupyter) })).what, 'a jupyter/base-notebook container');
});

// Pinning (Bugbot, #1521): an IPv6 wildcard is probed only at IPv6 addresses, since a v6-only one takes no IPv4 and
// /proc doesn't say which kind it is. With ::1 held by a more specific socket and no global IPv6, it can't be probed,
// so it's refused, though IPv4 addresses exist.
test('debuggerOnPort probes an IPv6 wildcard only over IPv6, and refuses one it can\'t reach that way (Bugbot, #1521)', async () => {
  const { debuggerOnPort } = require('./preview-runs');
  const header = 'sl local rem st tx rx tr tm retr uid timeout inode\n';
  const v6 = (hex, inode) => `   0: ${hex}:22B8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0\n`;
  const io = (rows) => ({
    readdirSync: (p) => (p === '/proc' ? ['9'] : p === '/proc/9/fd' ? ['3', '4'] : []),
    readlinkSync: (p) => ({ '/proc/9/fd/3': 'socket:[61]', '/proc/9/fd/4': 'socket:[62]', '/proc/9/cwd': '/home/u' }[p] || ''),
    readFileSync: (f) => {
      if (f.endsWith('/net/tcp6')) return header + rows;
      if (f.endsWith('/net/tcp')) return header;
      if (f === '/proc/9/cmdline') return 'node\0app.js\0';
      throw new Error('ENOENT');
    },
  });
  const base = { dockerShell: async () => null, dockerBindings: async () => [], dockerSocketExists: () => false };
  const loop6 = '00000000000000000000000001000000';
  const any6 = '00000000000000000000000000000000';
  // ::1 the app's, :: another listener; IPv4 addresses only: unprobeable, refused.
  const probed = [];
  const r = await debuggerOnPort(8888, { ...base, ...io(v6(loop6, 61) + v6(any6, 62)), boxAddresses: () => ({ v4: ['10.0.0.5'], v6: [] }), probe: async (h) => { probed.push(h); return false; } });
  assert.match(r.reason, /listens on every address, but more specific listeners take each address/);
  assert.ok(!probed.includes('127.0.0.1') && !probed.includes('10.0.0.5'), `probed over IPv4: ${probed}`);
  // With a global IPv6 address, the wildcard is probed there.
  const at = [];
  assert.deepEqual(await debuggerOnPort(8888, { ...base, ...io(v6(loop6, 61) + v6(any6, 62)), boxAddresses: () => ({ v4: ['10.0.0.5'], v6: ['2600:1f18::5'] }), probe: async (h) => { at.push(h); return false; } }), { ok: true });
  assert.ok(at.includes('2600:1f18::5'), `probed at ${at}`);
});

// Pinning (#1520): a run nobody has polled for the lease is stopped, so a CLI killed outright doesn't leave it
// up and vouched for; a run its CLI polls lives on.
test('sweepLeases stops a run nobody has asked about for the lease, and keeps one that is polled', () => {
  const { PreviewRuns } = require('./preview-runs');
  let now = 1_000_000;
  const killed = [];
  const runs = new PreviewRuns({ launcher: '/usr/bin/false', home: os.tmpdir(), stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), cgroupParent: os.tmpdir(), now: () => now, leaseMs: 60_000, killImpl: (pid, sig) => { killed.push(pid); } });
  const rec = (id) => ({ id, pid: 4242, checkout: '/c', logFd: -1, logPath: '/nonexistent', startedAt: now, lastSeen: now });
  runs.roots.set('aaaaaaaaaaaa', rec('aaaaaaaaaaaa'));
  runs.roots.set('bbbbbbbbbbbb', rec('bbbbbbbbbbbb'));
  now += 45_000;
  runs.status('bbbbbbbbbbbb'); // its CLI polls
  now += 30_000;
  runs.sweepLeases();
  assert.deepEqual([...runs.roots.keys()], ['bbbbbbbbbbbb'], 'the unpolled run stopped, the polled one kept');
  assert.equal(runs.ended.get('aaaaaaaaaaaa').exit, 'lease expired');
  now += 61_000;
  runs.sweepLeases();
  assert.equal(runs.roots.size, 0);
});

test('establishedRows finds the socket that accepted a connection, by its whole 4-tuple', async () => {
  const net = require('node:net');
  const { establishedRows } = require('./preview-runs');
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = net.connect(srv.address().port, '127.0.0.1');
  await new Promise((r) => c.on('connect', r));
  await new Promise((r) => setTimeout(r, 50));
  try {
    const dial = { host: c.remoteAddress, port: srv.address().port, peerHost: c.localAddress, peerPort: c.localPort };
    const rows = establishedRows(dial);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    const fds = fs.readdirSync('/proc/self/fd').map((fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ''; } });
    assert.ok(fds.includes(`socket:[${rows[0].inode}]`), 'the accepting socket is this process\'s');
    assert.deepEqual(establishedRows({ ...dial, peerPort: 1 }), []);
    assert.deepEqual(establishedRows({ ...dial, peerHost: '127.0.0.2' }), []);
  } finally {
    c.destroy();
    srv.close();
  }
});

// Pinning (Bugbot and Devin, #1667): ports alone can name another connection's socket. A wildcard listener's other
// client on the same source port, from another address, is not the relay's dial.
const TCP_HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const tcpRow = (sl, local, rem, inode) => `   ${sl}: ${local} ${rem} 01 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`;
test('establishedRows tells apart two connections on the same ports from different addresses', () => {
  const { establishedRows } = require('./preview-runs');
  // 127.0.0.1:5173 <- 127.0.0.1:40000 (the relay) and 10.0.0.5:5173 <- 10.0.0.9:40000 (someone else).
  const tcp = TCP_HEAD + tcpRow(0, '0100007F:1435', '0100007F:9C40', '111') + tcpRow(1, '0500000A:1435', '0900000A:9C40', '222');
  const read = (path) => { if (path === '/proc/net/tcp') return tcp; throw new Error('ENOENT'); };
  assert.deepEqual(establishedRows({ host: '127.0.0.1', port: 5173, peerHost: '127.0.0.1', peerPort: 40000 }, read).map((r) => r.inode), ['111']);
  assert.deepEqual(establishedRows({ host: '::ffff:10.0.0.5', port: 5173, peerHost: '::ffff:10.0.0.9', peerPort: 40000 }, read).map((r) => r.inode), ['222']);
  assert.deepEqual(establishedRows({ host: '127.0.0.1', port: 5173, peerHost: '10.0.0.9', peerPort: 40000 }, read), []);
});

// Pinning (#1667): a vouched run slow to accept (a cold compile) isn't refused for it. Until the
// accept, the dial's row has no socket (inode 0), so the check waits, with backoff, up to ACCEPT_WAIT_MS, and still
// vouches only a holder it has seen.
test('acceptedConfined waits, with backoff, for a vouched run slow to accept, and gives up only at its bound', async () => {
  const { PreviewRuns, ACCEPT_WAIT_MS } = require('./preview-runs');
  assert.ok(ACCEPT_WAIT_MS >= 3_000 && ACCEPT_WAIT_MS <= 10_000, 'well inside the orchestrator\'s 15 s wait for the dial back');
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-slow-'));
  const runs = new PreviewRuns({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-slow-state-')) });
  runs.roots.set('r1', { pid: 500, startTime: '42', checkout: fs.realpathSync(checkout), launcher: { features: ['tcp-allowlist'] } });
  const statLine = (pid, comm, start) => `${pid} (${comm}) ${['S', '1', ...Array(17).fill('0'), start].join(' ')}`;
  let clock = 0;
  const slept = [];
  let acceptAt = 3000; // the server blocks 3 s before it accepts
  const io = {
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    readFileSync: (p) => {
      if (p === '/proc/net/tcp') return TCP_HEAD + tcpRow(0, '0100007F:1435', '0100007F:9C40', clock >= acceptAt ? '111' : '0');
      if (p === '/proc/500/stat') return statLine(500, 'node', '42');
      throw new Error('ENOENT');
    },
    readdirSync: (p) => (p === '/proc' ? ['500'] : p === '/proc/500/fd' ? ['3'] : []),
    readlinkSync: () => 'socket:[111]',
  };
  const dial = { host: '127.0.0.1', port: 5173, peerHost: '127.0.0.1', peerPort: 40000 };
  try {
    assert.deepEqual(await runs.acceptedConfined(dial, checkout, io), { ok: true });
    assert.ok(clock >= 3000 && clock < 4500, `accepted after ${clock} ms`);
    assert.deepEqual(slept.slice(0, 4), [25, 50, 100, 200]);
    assert.ok(slept.every((ms) => ms <= 1000), `backoff capped at 1 s: ${slept}`);
    // Never accepted: refused at the bound, as too slow, not as unconfined.
    clock = 0; slept.length = 0; acceptAt = Infinity;
    const r = await runs.acceptedConfined(dial, checkout, io);
    assert.equal(r.ok, false);
    assert.equal(r.slow, true);
    assert.match(r.reason, /didn't accept the connection within 10 s/);
    assert.equal(clock, ACCEPT_WAIT_MS);
    // A shorter budget from the relay (what's left of its open) bounds it, and a longer one can't stretch it.
    for (const [waitMs, waited] of [[4000, 4000], [60_000, ACCEPT_WAIT_MS]]) {
      clock = 0;
      const short = await runs.acceptedConfined(dial, checkout, { ...io, waitMs });
      assert.equal(short.slow, true);
      assert.equal(clock, waited);
    }
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('acceptedConfined refuses a dial whose socket an unvouched process holds too, even beside the confined run (Bugbot and Devin, #1667)', async () => {
  const { PreviewRuns } = require('./preview-runs');
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-'));
  const runs = new PreviewRuns({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-state-')) });
  runs.roots.set('r1', { pid: 500, startTime: '42', checkout: fs.realpathSync(checkout), launcher: { features: ['tcp-allowlist'] } });
  const tcp = TCP_HEAD + tcpRow(0, '0100007F:1435', '0100007F:9C40', '111');
  // Fields 3 on: state, ppid, then up to field 22, starttime.
  const statLine = (pid, comm, start) => `${pid} (${comm}) ${['S', '1', ...Array(17).fill('0'), start].join(' ')}`;
  const stat = { 500: statLine(500, 'node', '42'), 600: statLine(600, 'sh', '77') };
  const fdsOf = { 500: ['3'], 600: [] };
  const io = {
    readFileSync: (p) => {
      if (p === '/proc/net/tcp') return tcp;
      const m = /^\/proc\/(\d+)\/stat$/.exec(p);
      if (m && stat[m[1]]) return stat[m[1]];
      throw new Error('ENOENT');
    },
    readdirSync: (p) => { if (p === '/proc') return Object.keys(fdsOf); const m = /^\/proc\/(\d+)\/fd$/.exec(p); return m ? fdsOf[m[1]] : []; },
    readlinkSync: () => 'socket:[111]',
  };
  const dial = { host: '127.0.0.1', port: 5173, peerHost: '127.0.0.1', peerPort: 40000 };
  try {
    assert.deepEqual(await runs.acceptedConfined(dial, checkout, io), { ok: true });
    fdsOf[600] = ['4'];
    assert.match((await runs.acceptedConfined(dial, checkout, io)).reason, /isn't a vouched termag preview run/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('acceptedConfined: a dial accepted by a run of a repository in a multi-repo workspace passes for the workspace, and only one level down (Devin, #1823)', async () => {
  const { PreviewRuns } = require('./preview-runs');
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-multi-')));
  const runs = new PreviewRuns({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-multi-state-')) });
  const statLine = (pid, comm, start) => `${pid} (${comm}) ${['S', '1', ...Array(17).fill('0'), start].join(' ')}`;
  const io = {
    readFileSync: (p) => {
      if (p === '/proc/net/tcp') return TCP_HEAD + tcpRow(0, '0100007F:1435', '0100007F:9C40', '111');
      if (p === '/proc/500/stat') return statLine(500, 'node', '42');
      throw new Error('ENOENT');
    },
    readdirSync: (p) => (p === '/proc' ? ['500'] : p === '/proc/500/fd' ? ['3'] : []),
    readlinkSync: () => 'socket:[111]',
    waitMs: 0,
  };
  const dial = { host: '127.0.0.1', port: 5173, peerHost: '127.0.0.1', peerPort: 40000 };
  const runOf = (checkout) => runs.roots.set('r1', { pid: 500, startTime: '42', checkout, launcher: { features: ['tcp-allowlist'] } });
  try {
    fs.writeFileSync(path.join(ws, '.termag-workspace'), 'marker\n');
    const wsRoot = path.join(ws, '.worktrees', 'feat');
    fs.mkdirSync(path.join(wsRoot, 'app'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'app'));
    runOf(path.join(ws, 'app'));
    assert.deepEqual(await runs.acceptedConfined(dial, ws, io), { ok: true });
    assert.match((await runs.acceptedConfined(dial, wsRoot, io)).reason, /isn't a vouched termag preview run of this checkout/);
    runOf(path.join(wsRoot, 'app'));
    assert.deepEqual(await runs.acceptedConfined(dial, wsRoot, io), { ok: true });
    assert.match((await runs.acceptedConfined(dial, ws, io)).reason, /isn't a vouched termag preview run of this checkout/);
    // Without the marker, a repository in a folder isn't the folder's run.
    fs.rmSync(path.join(ws, '.termag-workspace'));
    runOf(path.join(ws, 'app'));
    assert.match((await runs.acceptedConfined(dial, ws, io)).reason, /isn't a vouched termag preview run of this checkout/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
