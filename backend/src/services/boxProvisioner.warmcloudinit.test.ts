import { describe, it, expect } from 'vitest';
import { buildCloudInit, buildWarmCloudInit } from './boxProvisioner';

const WARM = {
  termagUrl: 'ws://termag.example.com:3040/termag/ws/agent',
  agentToken: 'tmag_pool_test',
  poolSpecHash: 'a1b2c3d4e5f6',
};

const COLD = {
  termagUrl: WARM.termagUrl,
  agentToken: 'tmag_cold_test',
  gitUserEmail: 'someone@example.com',
  gitUserName: 'Some One',
  remoteUnixUser: 'alice',
};

describe('buildWarmCloudInit: nothing the claim would have to undo', () => {
  // A warm box keeps the AMI's baked `termag` user. Everything asserted absent
  // here is present in the cold template, and is exactly the work that makes a
  // rename-at-claim take tens of seconds instead of one round trip: it needs
  // every process the user owns stopped, the home directory moved, and six
  // toolchain directories swept. The cold template is asserted alongside each
  // one so this cannot pass by the strings having been renamed.
  it('renames no user', () => {
    expect(buildWarmCloudInit(WARM)).not.toContain('usermod');
    expect(buildCloudInit(COLD)).toContain('usermod');
  });

  it('renames no group', () => {
    expect(buildWarmCloudInit(WARM)).not.toContain('groupmod');
    expect(buildCloudInit(COLD)).toContain('groupmod');
  });

  it('carries no owner unix name', () => {
    expect(buildWarmCloudInit(WARM)).not.toContain('UNIX_USER');
    expect(buildWarmCloudInit(WARM)).not.toContain('alice');
    expect(buildCloudInit(COLD)).toContain('UNIX_USER');
  });

  it('carries no git identity, which the claim sets over the box-claim RPC', () => {
    expect(buildWarmCloudInit(WARM)).not.toContain('git config');
    expect(buildWarmCloudInit(WARM)).not.toContain('someone@example.com');
    expect(buildCloudInit(COLD)).toContain('git config');
  });

  it('needs no pyenv linker fix, because no home directory moved', () => {
    expect(buildWarmCloudInit(WARM)).not.toContain('ld.so.conf.d');
    expect(buildCloudInit(COLD)).toContain('ld.so.conf.d');
  });
});

describe('buildWarmCloudInit: the pool marker', () => {
  it('roots every path at the baked user home, which a pool box never leaves', () => {
    expect(buildWarmCloudInit(WARM)).toContain('BOX_HOME=/home/termag');
  });

  it('writes the spec hash to the state directory', () => {
    const out = buildWarmCloudInit(WARM);
    expect(out).toContain('install -o termag -g termag -m 600 /tmp/pool.json "$BOX_HOME/.termag/pool.json"');
    expect(out).toContain('"poolSpecHash": "a1b2c3d4e5f6"');
  });

  it('versions the marker, because the box and the orchestrator move independently', () => {
    expect(buildWarmCloudInit(WARM)).toContain('"schema": 1');
  });

  it('tightens the state directory before writing a file into it', () => {
    const out = buildWarmCloudInit(WARM);
    const mkdir = out.indexOf('install -d -o termag -g termag -m 700 "$BOX_HOME/.termag"');
    const marker = out.indexOf('"$BOX_HOME/.termag/pool.json"');
    expect(mkdir).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(mkdir);
  });
});

describe('buildWarmCloudInit: the agent', () => {
  it('flags the config warm, which is how the agent knows to poll the on-warm status file', () => {
    expect(buildWarmCloudInit(WARM)).toContain('"warm": true');
  });

  it('leaves the cold path unflagged', () => {
    expect(buildCloudInit(COLD)).not.toContain('"warm"');
  });

  it('drops the token where the agent looks for it, owned by the baked user', () => {
    expect(buildWarmCloudInit(WARM)).toContain(
      'install -o termag -g termag -m 600 /tmp/agent.config.json "$BOX_HOME/src/termag/agent/agent.config.json"',
    );
    expect(buildWarmCloudInit(WARM)).toContain('"token": "tmag_pool_test"');
  });

  it('starts the agent as the baked user with linger enabled', () => {
    const out = buildWarmCloudInit(WARM);
    expect(out).toContain('loginctl enable-linger termag');
    expect(out).toContain('sudo -u termag XDG_RUNTIME_DIR=/run/user/$BOX_UID systemctl --user enable --now termag-agent.service');
  });

  it('starts the on-warm unit nowhere, because the backend starts it once the agent is up', () => {
    expect(buildWarmCloudInit(WARM)).not.toContain('termag-on-warm.service');
  });
});
