import { describe, it, expect } from 'vitest';
import { buildCloudInit } from './boxProvisioner';

const BASE = {
  termagUrl: 'ws://termag.internal:3040/termag/ws/agent',
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
