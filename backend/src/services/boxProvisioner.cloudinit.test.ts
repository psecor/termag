import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCloudInit } from './boxProvisioner';
import { fitsManagedKeyBudget, managedBlock } from './sshKeys';

const BASE = {
  termagUrl: 'ws://termag.example.com:3040/termag/ws/agent',
  agentToken: 'tmag_test',
  gitUserEmail: 'someone@example.com',
  gitUserName: 'Some One',
  remoteUnixUser: 'alice',
};

describe('buildCloudInit: pyenv linker registration (step 4b)', () => {
  // Step 4's /home/termag sweep uses `grep -I`, which skips binaries, so
  // CPython's ELF RUNPATH survives the rename and python3 cannot start. This
  // step is the fix, and it has to be in the orchestrator's cloud-init and not
  // only in terraform/box/cloudinit.sh.tftpl — the orchestrator is the path
  // that actually launches boxes.
  it('registers pyenv lib dirs with the dynamic linker', () => {
    const out = buildCloudInit(BASE);
    expect(out).toContain('/etc/ld.so.conf.d/pyenv.conf');
    expect(out).toContain('ldconfig');
  });

  it('globs pyenv versions rather than pinning one', () => {
    // Pinning 3.13 would silently stop working on the next pyenv bump.
    const out = buildCloudInit(BASE);
    expect(out).toContain('.pyenv/versions/*/lib');
    expect(out).not.toMatch(/\.pyenv\/versions\/3\.\d+/);
  });

  it('cannot abort the boot if it fails', () => {
    // Steps 5-8 write the agent token and start the agent. Anything before them
    // must be guarded, or a failure strands the box with no agent running —
    // which surfaces only as "Box never connected within 15 minutes".
    const out = buildCloudInit(BASE);
    expect(out).toMatch(/\|\| echo "WARNING: step 4b failed/);
  });

  it('runs after the rename, so it picks up the owner\'s home', () => {
    const out = buildCloudInit(BASE);
    const rename = out.indexOf('Step 2: rename user');
    const step4b = out.indexOf('step 4b');
    expect(rename).toBeGreaterThan(-1);
    expect(step4b).toBeGreaterThan(rename);
  });
});

describe('buildCloudInit: baked path rewrite (steps 3+4)', () => {
  // Walking the home at boot (`find -lname` over all of it, `grep -rIl` over the
  // toolchain dirs) cost 4.5-15.5 minutes on a lazily-restored EBS volume and
  // raced the 15-minute stuck-provisioning sweep. The bake now indexes what to
  // rewrite (packer/scripts/index-home-paths.sh) and installs the boot half as
  // /usr/local/sbin/termag-rewrite-home-paths; cloud-init only calls it.
  const CALL = '/usr/local/sbin/termag-rewrite-home-paths /home/termag "/home/$UNIX_USER"';

  it('rewrites from the bake-time index instead of walking the home', () => {
    const out = buildCloudInit(BASE);
    expect(out).toContain(CALL);
    expect(out).not.toContain('grep -rIl');
    expect(out).not.toMatch(/find "\/home\/\$UNIX_USER" -type l/);
  });

  it('cannot abort the boot when the script or the index is missing', () => {
    // Steps 5-8 write the agent token and start the agent; nothing before them
    // may fail the boot, or the box strands with no agent running.
    const out = buildCloudInit(BASE);
    expect(out).toContain('if [ -x /usr/local/sbin/termag-rewrite-home-paths ]; then');
    expect(out).toMatch(/termag-rewrite-home-paths \/home\/termag "\/home\/\$UNIX_USER" \\\n\s+\|\| echo "WARNING: path rewrite reported a problem \(non-fatal\)"/);
    expect(out).toMatch(/else\n\s+echo "WARNING: \/usr\/local\/sbin\/termag-rewrite-home-paths is missing/);
  });

  it('runs after the rename and before the linker step', () => {
    const out = buildCloudInit(BASE);
    const rename = out.indexOf('Step 2: rename user');
    const rewrite = out.indexOf(CALL);
    const step4b = out.indexOf('step 4b');
    expect(rename).toBeGreaterThan(-1);
    expect(rewrite).toBeGreaterThan(rename);
    expect(step4b).toBeGreaterThan(rewrite);
  });

  it('matches terraform/box/cloudinit.sh.tftpl, the template this is a port of', () => {
    const tftpl = readFileSync(join(__dirname, '../../../terraform/box/cloudinit.sh.tftpl'), 'utf8');
    expect(tftpl).toContain(CALL);
    expect(tftpl).not.toContain('grep -rIl');
    expect(tftpl).not.toMatch(/find "\/home\/\$UNIX_USER" -type l/);
  });
});

describe('buildCloudInit: rename without a tree walk (step 2)', () => {
  // `usermod -m` renames the home and then stats every file under it to fix
  // ownership that does not change here; on a lazily-restored volume that was
  // 4 minutes of a quick-start box's cold boot. The template moves the
  // directory with mv and lets usermod touch only the passwd record.
  const MV = 'mv /home/termag "/home/$UNIX_USER"';
  const USERMOD = 'usermod -l "$UNIX_USER" -d "/home/$UNIX_USER" termag';

  it('moves the home with mv and never passes -m to usermod', () => {
    const out = buildCloudInit(BASE);
    expect(out).toContain(MV);
    expect(out).toContain(USERMOD);
    expect(out).not.toMatch(/usermod [^\n]*-m termag/);
  });

  it('renames the directory before usermod points the record at it', () => {
    const out = buildCloudInit(BASE);
    expect(out.indexOf(MV)).toBeGreaterThan(-1);
    expect(out.indexOf(MV)).toBeLessThan(out.indexOf(USERMOD));
    expect(out.indexOf(USERMOD)).toBeLessThan(out.indexOf('groupmod -n "$UNIX_USER" termag'));
  });

  it('skips the rename when the owner is already the baked user', () => {
    const out = buildCloudInit(BASE);
    expect(out).toContain('if [ "$UNIX_USER" != termag ]; then');
  });

  it('matches terraform/box/cloudinit.sh.tftpl', () => {
    const tftpl = readFileSync(join(__dirname, '../../../terraform/box/cloudinit.sh.tftpl'), 'utf8');
    expect(tftpl).toContain(MV);
    expect(tftpl).toContain(USERMOD);
    expect(tftpl).not.toMatch(/usermod [^\n]*-m termag/);
  });
});

describe('buildCloudInit: owner SSH keys (step 4c)', () => {
  const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBAbYOa2X2cb3APrq0kCH4nqKhJ7K02+SmcLB3Y5DcE2 alice@laptop';
  const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBAbYOa2X2cb3APrq0kCH4nqKhJ7K02+SmcLB3Y5DcE2 alice's 'desk'";

  // Step 4c alone, pointed at a temp home and owned by whoever runs the test.
  // `failing` shadows that command on PATH with one that exits 1.
  function runStep4c(
    vars: Parameters<typeof buildCloudInit>[0],
    existing: string | null,
    failing?: string,
  ): { content: string; sshEntries: string[] } {
    const out = buildCloudInit(vars);
    const step = out.slice(out.indexOf('# ── Step 4c'), out.indexOf('# ── Step 5'));
    const home = mkdtempSync(join(tmpdir(), 'step4c-'));
    try {
      if (existing !== null) {
        mkdirSync(join(home, '.ssh'), { recursive: true });
        writeFileSync(join(home, '.ssh', 'authorized_keys'), existing, { mode: 0o600 });
      }
      let path = process.env.PATH ?? '';
      if (failing) {
        const bin = join(home, 'fake-bin');
        mkdirSync(bin);
        writeFileSync(join(bin, failing), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        path = `${bin}:${path}`;
      }
      const script = `set -euo pipefail\nUNIX_USER="$(id -un)"\n${step.split('/home/$UNIX_USER').join(home)}`;
      execFileSync('bash', ['-c', script], { stdio: 'pipe', env: { ...process.env, PATH: path } });
      const ak = join(home, '.ssh', 'authorized_keys');
      if (!failing && (existing !== null || (vars.ownerAuthorizedKeys ?? []).length > 0)) {
        expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700);
        expect(statSync(ak).mode & 0o777).toBe(0o600);
      }
      let content = '<missing>';
      try { content = readFileSync(ak, 'utf8'); } catch { /* no file */ }
      let sshEntries: string[] = [];
      try { sshEntries = readdirSync(join(home, '.ssh')).sort(); } catch { /* no dir */ }
      return { content, sshEntries };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('writes the owner\'s keys as the managed block', () => {
    expect(runStep4c({ ...BASE, ownerAuthorizedKeys: [KEY_A, KEY_B] }, null).content)
      .toBe(managedBlock([KEY_A, KEY_B]));
  });

  it('keeps hand-added keys and replaces a stale managed block', () => {
    const hand = 'ssh-rsa AAAAhand hand@added\n';
    expect(runStep4c({ ...BASE, ownerAuthorizedKeys: [KEY_B] }, hand + managedBlock([KEY_A])).content)
      .toBe(hand + managedBlock([KEY_B]));
  });

  it('starts the block on its own line when the file lacks a trailing newline', () => {
    const hand = 'ssh-rsa AAAAhand hand@added';
    expect(runStep4c({ ...BASE, ownerAuthorizedKeys: [KEY_A] }, hand).content)
      .toBe(`${hand}\n${managedBlock([KEY_A])}`);
  });

  it('skips the step, and creates no file, when the owner has no keys', () => {
    const out = buildCloudInit(BASE);
    expect(out).toContain("MANAGED_KEYS_B64=''");
    expect(out).toContain('owner has no registered SSH keys, skipping');
    expect(runStep4c(BASE, null).content).toBe('<missing>');
  });

  it('embeds the keys base64-encoded so a quote in a comment cannot break the script', () => {
    const out = buildCloudInit({ ...BASE, ownerAuthorizedKeys: [KEY_B] });
    const line = out.split('\n').find((l) => l.startsWith('MANAGED_KEYS_B64='))!;
    expect(line).toMatch(/^MANAGED_KEYS_B64='[A-Za-z0-9+/=]*'$/);
    expect(out).not.toContain(KEY_B);
  });

  it('cannot abort the boot if it fails', () => {
    const out = buildCloudInit({ ...BASE, ownerAuthorizedKeys: [KEY_A] });
    expect(out).toMatch(/\|\| echo "WARNING: step 4c failed/);
  });

  // The agent rewrites the file later as the owner, so a half-written file
  // left behind by root (and owned by root) would lock it out for good.
  it.each(['base64', 'chown', 'mv'])('leaves an existing file untouched when %s fails', (cmd) => {
    const before = `ssh-rsa AAAAhand hand@added\n${managedBlock([KEY_A])}`;
    expect(runStep4c({ ...BASE, ownerAuthorizedKeys: [KEY_B] }, before, cmd))
      .toEqual({ content: before, sshEntries: ['authorized_keys'] });
  });

  it('creates no file when it fails on a box without one', () => {
    expect(runStep4c({ ...BASE, ownerAuthorizedKeys: [KEY_A] }, null, 'base64'))
      .toEqual({ content: '<missing>', sshEntries: [] });
  });

  it('runs after the rename and before the agent token is written', () => {
    const out = buildCloudInit({ ...BASE, ownerAuthorizedKeys: [KEY_A] });
    const step4c = out.indexOf('step 4c');
    expect(step4c).toBeGreaterThan(out.indexOf('Step 2: rename user'));
    expect(step4c).toBeLessThan(out.indexOf('Step 5: drop the agent'));
  });

  it('fits the largest allowed key set in EC2\'s 16 KB user_data limit', () => {
    const rsa = `ssh-rsa ${'A'.repeat(540)} ${'c'.repeat(200)}`;
    const keys: string[] = [];
    while (fitsManagedKeyBudget([...keys, rsa])) keys.push(rsa);
    const out = buildCloudInit({ ...BASE, ownerAuthorizedKeys: keys });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(16 * 1024);
  });
});
