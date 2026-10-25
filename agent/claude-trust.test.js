'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { claudeConfigPath, trustKeys, trustFolder, lockPath, lockedWrite, writeTrust } = require('./claude-trust');

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'termag-claude-trust-')));
}

/** A fresh termag project: git init plus the two seed files. */
function seededProject(root) {
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# proj\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  return dir;
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const hasFlock = (() => { try { execFileSync('flock', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('claudeConfigPath follows CLAUDE_CONFIG_DIR, else ~/.claude.json', () => {
  assert.equal(claudeConfigPath({}, '/home/ada'), '/home/ada/.claude.json');
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/ada'), '/cfg/.claude.json');
});

test('lockPath is the lock termag-credentials and termag-reconcile take', () => {
  assert.equal(lockPath('/home/ada'), '/home/ada/.config/termag/claude-json.lock');
});

test('trustKeys refuses relative, missing and non-directory paths', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'f'), '');
  assert.throws(() => trustKeys('rel/dir'), /absolute/);
  assert.throws(() => trustKeys(''), /path required/);
  assert.throws(() => trustKeys(`${dir}\nx`), /path required/);
  assert.throws(() => trustKeys(path.join(dir, 'missing')), /ENOENT/);
  assert.throws(() => trustKeys(path.join(dir, 'f')), /not a directory/);
  assert.deepEqual(trustKeys(`${dir}/`), [dir]);
});

test('trustKeys adds the real path of a symlinked project dir', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.deepEqual(trustKeys(path.join(dir, 'link')), [path.join(dir, 'link'), path.join(dir, 'real')]);
});

test('check "empty" trusts a freshly seeded project and nothing with more in it', async () => {
  const root = tmpDir();
  const proj = seededProject(root);
  const configPath = path.join(root, '.claude.json');
  const write = async (c, k) => writeTrust(c, k);
  assert.equal(await trustFolder(proj, { check: 'empty', configPath, write }), true);
  assert.deepEqual(read(configPath).projects[proj], { hasTrustDialogAccepted: true });

  // An old checkout left behind by un-archive or Start empty, or any startup config.
  for (const extra of ['.mcp.json', '.claude', 'src']) {
    const other = seededProject(fs.mkdtempSync(path.join(root, 'x-')));
    fs.mkdirSync(path.join(other, extra));
    await assert.rejects(trustFolder(other, { check: 'empty', configPath, write }), /not an empty project/);
    assert.equal(read(configPath).projects[other], undefined);
  }
});

test('check "owner" trusts only the project\'s own tree, and an unknown check nothing', async () => {
  const root = tmpDir();
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.mcp.json'), '{}');
  const configPath = path.join(root, '.claude.json');
  const write = async (c, k) => writeTrust(c, k);
  await assert.rejects(trustFolder(proj, { check: 'owner', ownTree: async () => false, configPath, write }), /own tree/);
  await assert.rejects(trustFolder(proj, { check: 'owner', configPath, write }), /own tree/);
  await assert.rejects(trustFolder(proj, { configPath, write }), /check must be/);
  assert.equal(fs.existsSync(configPath), false);
  let asked;
  assert.equal(await trustFolder(proj, { check: 'owner', ownTree: async (d) => { asked = d; return true; }, configPath, write }), true);
  assert.equal(asked, proj);
});

test('writeTrust keeps every other key and the file mode, and does not rewrite a trusted folder', () => {
  const dir = tmpDir();
  const project = path.join(dir, 'proj');
  const configPath = path.join(dir, '.claude.json');
  fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark', projects: { '/other': { hasTrustDialogAccepted: true }, [project]: { allowedTools: ['x'] } } }), { mode: 0o600 });
  assert.equal(writeTrust(configPath, [project]), true);
  const after = read(configPath);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.projects['/other'], { hasTrustDialogAccepted: true });
  assert.deepEqual(after.projects[project], { allowedTools: ['x'], hasTrustDialogAccepted: true });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.claude.json']);
  assert.equal(writeTrust(configPath, [project]), false, 'already trusted: no write');
});

test('writeTrust leaves a config it cannot parse alone', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, '.claude.json');
  fs.writeFileSync(configPath, '{"theme": "dark",');
  assert.throws(() => writeTrust(configPath, [dir]), /cannot read/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"theme": "dark",');
});

test('lockedWrite writes under the shared flock, and waits for another holder', { skip: !hasFlock && 'no flock(1) here' }, async () => {
  const dir = tmpDir();
  const configPath = path.join(dir, '.claude.json');
  const lock = path.join(dir, 'lock', 'claude-json.lock');
  assert.equal(await lockedWrite(configPath, [dir], { lock }), true);
  assert.deepEqual(read(configPath).projects[dir], { hasTrustDialogAccepted: true });
  assert.equal(await lockedWrite(configPath, [dir], { lock }), false);

  // Another writer holds the lock for a moment: the write waits for it rather than racing it.
  const { spawn } = require('node:child_process');
  const holder = spawn('flock', [lock, 'sleep', '1']);
  await new Promise((r) => setTimeout(r, 200));
  const started = Date.now();
  assert.equal(await lockedWrite(configPath, [path.join(dir, 'lock')], { lock }), true);
  assert.ok(Date.now() - started >= 500, 'waited for the holder');
  holder.kill();
});

test('lockedWrite falls back to an unlocked write where flock(1) is missing', async () => {
  const dir = tmpDir();
  const configPath = path.join(dir, '.claude.json');
  const exec = async () => { const e = new Error('spawn flock ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.equal(await lockedWrite(configPath, [dir], { lock: path.join(dir, 'l'), exec }), true);
  assert.deepEqual(read(configPath).projects[dir], { hasTrustDialogAccepted: true });
});
