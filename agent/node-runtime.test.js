const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise the shipped ExecStart, replacing only the agent payload. Selecting
// an uninstalled default used to exit 127 before reaching that payload.
const root = path.resolve(__dirname, '..');
const unit = fs.readFileSync(path.join(root, 'deploy/termag-agent.service'), 'utf8');
const command = unit.match(/^ExecStart=\/bin\/bash -c '(.*)'$/m)[1];

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termag node '));
  t.after(() => {
    try {
      const calls = path.join(home, 'nvm-calls');
      if (fs.existsSync(calls)) {
        for (const call of fs.readFileSync(calls, 'utf8').trim().split('\n')) {
          assert.ok(['source --no-use', 'which default', 'which node'].includes(call), `unexpected nvm command: ${call}`);
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  const checkout = path.join(home, 'src/termag');
  const agent = path.join(checkout, 'agent');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(bin);
  // A hermetic PATH: no accidental system Node can rescue a broken resolver.
  for (const tool of ['/usr/bin/dirname', '/usr/bin/sort', '/bin/bash', '/bin/mv']) {
    fs.symlinkSync(tool, path.join(bin, path.basename(tool)));
  }
  const launcher = path.join(root, 'agent/run-node.sh');
  fs.copyFileSync(launcher, path.join(agent, 'run-node.sh'));
  fs.writeFileSync(path.join(agent, 'agent.js'), `
    const { execFileSync } = require('node:child_process');
    console.log(JSON.stringify({ selected: process.env.SELECTED_NODE,
      child: execFileSync('node', ['-p', 'process.env.SELECTED_NODE'], {encoding:'utf8'}).trim(),
      args: process.argv.slice(2) }));
  `);
  const nvm = path.join(home, '.nvm');
  fs.mkdirSync(nvm);
  // A local-only nvm interface. No install/alias/remote command is permitted.
  fs.writeFileSync(path.join(nvm, 'nvm.sh'), `
    printf 'source %s\\n' "$*" >> "$HOME/nvm-calls"
    nvm() {
      printf '%s\\n' "$*" >> "$HOME/nvm-calls"
      case "$*" in
        'which default') [ -x "$NVM_DIR/default/bin/node" ] || return 3; printf '%s\\n' "$NVM_DIR/default/bin/node" ;;
        'which node') [ -x "$NVM_DIR/versions/node/v24.21.0/bin/node" ] || return 3; printf '%s\\n' "$NVM_DIR/versions/node/v24.21.0/bin/node" ;;
        *) echo "unexpected nvm command: $*" >&2; return 99 ;;
      esac
    }
    if [ "\${1:-}" != --no-use ] && [ -x "$NVM_DIR/default/bin/node" ]; then
      export PATH="$NVM_DIR/default/bin:$PATH"
    fi
  `);
  function install(dir, label) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh\nexport SELECTED_NODE=${label}\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  }
  function run(printNode = false) {
    return spawnSync('/bin/bash', printNode
      ? [path.join(agent, 'run-node.sh'), '--print-node'] : ['-c', command], {
      cwd: home, encoding: 'utf8',
      env: { HOME: home, PATH: bin, TERM: 'dumb' },
    });
  }
  function clone() {
    fs.mkdirSync(path.join(checkout, 'deploy'), { recursive: true });
    fs.copyFileSync(path.join(root, 'deploy/termag-project-clone'), path.join(checkout, 'deploy/termag-project-clone'));
    fs.chmodSync(path.join(checkout, 'deploy/termag-project-clone'), 0o755);
    fs.copyFileSync(path.join(agent, 'agent.js'), path.join(agent, 'project-clone.js'));
    const jq = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' });
    assert.equal(jq.status, 0, 'jq is required for clone failure-state assertions');
    fs.symlinkSync(jq.stdout.trim(), path.join(bin, 'jq'));
    const state = path.join(home, '.termag/clones/p1.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify({ status: 'pending' }));
    const unit = fs.readFileSync(path.join(root, 'deploy/termag-project-clone@.service'), 'utf8');
    const cmd = unit.match(/^ExecStart=\/bin\/bash -c '(.*)'$/m)[1].replace('%i', 'p1');
    const result = spawnSync('/bin/bash', ['-c', cmd], {
      cwd: home, encoding: 'utf8', env: { HOME: home, PATH: bin, TERM: 'dumb' },
    });
    return { ...result, state: JSON.parse(fs.readFileSync(state, 'utf8')) };
  }
  return { home, checkout, nvm, bin, install, run, clone };
}

test('agent starts with installed Node when nvm default is missing; children inherit it', t => {
  const f = fixture(t);
  f.install(path.join(f.nvm, 'versions/node/v24.21.0/bin'), 'fallback');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    selected: 'fallback', child: 'fallback',
    args: [path.join(f.checkout, 'agent/agent.config.json')],
  });
  const preflight = f.run(true);
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(preflight.stdout.trim(), path.join(f.nvm, 'versions/node/v24.21.0/bin/node'));
});

test('agent respects an installed nvm default rather than upgrading to latest', t => {
  const f = fixture(t);
  f.install(path.join(f.nvm, 'default/bin'), 'default');
  f.install(path.join(f.nvm, 'versions/node/v24.21.0/bin'), 'fallback');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).selected, 'default');
});

test('checkout Node takes precedence and is available to child processes', t => {
  const f = fixture(t);
  f.install(path.join(f.checkout, 'node/bin'), 'checkout');
  f.install(path.join(f.nvm, 'default/bin'), 'default');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).selected, 'checkout');
  assert.equal(JSON.parse(result.stdout).child, 'checkout');
});

test('a system Node works on a host without nvm', t => {
  const f = fixture(t);
  fs.rmSync(f.nvm, { recursive: true });
  f.install(f.bin, 'system');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).selected, 'system');
});

test('no installed runtime fails explicitly before starting the agent', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 127);
  assert.match(result.stderr, /no usable Node.js/i);
  assert.equal(result.stdout, '');
  assert.equal(f.run(true).status, 127);
});

test('an executable but broken default falls back to a working installed Node', t => {
  const f = fixture(t);
  f.install(path.join(f.nvm, 'default/bin'), 'default');
  fs.writeFileSync(path.join(f.nvm, 'default/bin/node'), '#!/bin/sh\nexit 127\n');
  f.install(path.join(f.nvm, 'versions/node/v24.21.0/bin'), 'fallback');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).selected, 'fallback');
});

for (const newest of ['broken', 'empty']) {
  test(`agent skips the ${newest} newest install and tries older Node versions in numeric order`, t => {
    const f = fixture(t);
    f.install(path.join(f.nvm, 'versions/node/v24.9.0/bin'), 'older');
    f.install(path.join(f.nvm, 'versions/node/v24.16.0/bin'), 'working');
    const bin = path.join(f.nvm, 'versions/node/v24.21.0/bin');
    fs.mkdirSync(bin, { recursive: true });
    if (newest === 'broken') fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selected, 'working');
    assert.equal(JSON.parse(result.stdout).child, 'working');
  });
}

test('agent and durable clone unit resolve the same fallback and child PATH', t => {
  const f = fixture(t);
  f.install(path.join(f.nvm, 'versions/node/v24.21.0/bin'), 'fallback');
  const agent = f.run();
  const clone = f.clone();
  assert.equal(agent.status, 0, agent.stderr);
  assert.equal(clone.status, 0, clone.stderr);
  assert.equal(JSON.parse(clone.stdout).selected, JSON.parse(agent.stdout).selected);
  assert.equal(JSON.parse(clone.stdout).child, 'fallback');
  assert.deepEqual(JSON.parse(clone.stdout).args, ['run', 'p1']);
});

test('durable clone still records failure when no runtime is usable', t => {
  const f = fixture(t);
  const clone = f.clone();
  assert.equal(clone.status, 1, clone.stderr);
  assert.equal(clone.state.status, 'failed');
  assert.match(clone.state.error, /node/i);
});
