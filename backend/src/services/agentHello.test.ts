import { describe, it, expect } from 'vitest';
import { MAX_CAPABILITIES, parseAgentHello, parseHostSample } from './agentHello';

const SHA = 'a3f1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0';

describe('parseAgentHello', () => {
  it('accepts a full payload', () => {
    expect(parseAgentHello({
      type: 'hello',
      unixUser: 'psecor',
      home: '/home/psecor',
      hostname: 'box-01',
      agentVersion: '1.0.0',
      agentCommit: SHA,
      warm: true,
    })).toEqual({
      unixUser: 'psecor',
      home: '/home/psecor',
      hostname: 'box-01',
      agentVersion: '1.0.0',
      agentCommit: SHA,
      warm: true,
      capabilities: [],
      agentCommitAt: null,
      host: null,
    });
  });

  it('nulls the optional fields when they are absent', () => {
    expect(parseAgentHello({ type: 'hello', unixUser: 'psecor', home: '/home/psecor' }))
      .toEqual({
        unixUser: 'psecor',
        home: '/home/psecor',
        hostname: null,
        agentVersion: null,
        agentCommit: null,
        warm: false,
        capabilities: [],
        agentCommitAt: null,
        host: null,
      });
  });

  it('trims surrounding whitespace', () => {
    expect(parseAgentHello({
      type: 'hello', unixUser: ' psecor ', home: ' /home/psecor ', hostname: ' box-01 ',
    })).toEqual({
      unixUser: 'psecor',
      home: '/home/psecor',
      hostname: 'box-01',
      agentVersion: null,
      agentCommit: null,
      warm: false,
      capabilities: [],
      agentCommitAt: null,
      host: null,
    });
  });

  it('rejects a non-hello type', () => {
    expect(parseAgentHello({ type: 'terminal-data', unixUser: 'psecor', home: '/home/psecor' }))
      .toBe(null);
  });

  it('rejects a missing home', () => {
    expect(parseAgentHello({ type: 'hello', unixUser: 'psecor' })).toBe(null);
  });

  it('rejects a relative home', () => {
    expect(parseAgentHello({ type: 'hello', unixUser: 'psecor', home: 'home/psecor' }))
      .toBe(null);
  });

  it('rejects a home with a .. segment', () => {
    expect(parseAgentHello({ type: 'hello', unixUser: 'psecor', home: '/home/psecor/../root' }))
      .toBe(null);
  });

  it('rejects a newline in unixUser', () => {
    expect(parseAgentHello({ type: 'hello', unixUser: 'pse\ncor', home: '/home/psecor' }))
      .toBe(null);
  });

  it('rejects a NUL byte in home', () => {
    expect(parseAgentHello({ type: 'hello', unixUser: 'psecor', home: '/home/pse\0cor' }))
      .toBe(null);
  });

  it('rejects an over-long home', () => {
    expect(parseAgentHello({
      type: 'hello', unixUser: 'psecor', home: `/home/${'a'.repeat(512)}`,
    })).toBe(null);
  });

  it('rejects an over-long unixUser', () => {
    expect(parseAgentHello({
      type: 'hello', unixUser: 'a'.repeat(513), home: '/home/psecor',
    })).toBe(null);
  });

  it('rejects an empty unixUser', () => {
    expect(parseAgentHello({ type: 'hello', unixUser: '   ', home: '/home/psecor' }))
      .toBe(null);
  });

  it('treats a non-boolean warm as not warm', () => {
    expect(parseAgentHello({
      type: 'hello', unixUser: 'psecor', home: '/home/psecor', warm: 'true',
    })).toEqual({
      unixUser: 'psecor',
      home: '/home/psecor',
      hostname: null,
      agentVersion: null,
      agentCommit: null,
      warm: false,
      capabilities: [],
      agentCommitAt: null,
      host: null,
    });
  });

  it('nulls a non-string hostname', () => {
    expect(parseAgentHello({
      type: 'hello', unixUser: 'psecor', home: '/home/psecor', hostname: 42, agentVersion: null,
    })).toEqual({
      unixUser: 'psecor',
      home: '/home/psecor',
      hostname: null,
      agentVersion: null,
      agentCommit: null,
      warm: false,
      capabilities: [],
      agentCommitAt: null,
      host: null,
    });
  });

  it('rejects a non-object message', () => {
    expect(parseAgentHello(null)).toBe(null);
    expect(parseAgentHello('hello')).toBe(null);
    expect(parseAgentHello(['hello'])).toBe(null);
  });

  it('keeps a full lower-case sha as the commit and nulls anything else', () => {
    const hello = (agentCommit: unknown) =>
      parseAgentHello({ type: 'hello', unixUser: 'psecor', home: '/home/psecor', agentCommit })?.agentCommit;
    expect(hello(SHA)).toBe(SHA);
    expect(hello(SHA.slice(0, 12))).toBe(null);
    expect(hello(SHA.toUpperCase())).toBe(null);
    expect(hello('HEAD')).toBe(null);
    expect(hello(`${SHA}\n`)).toBe(null);
    expect(hello(42)).toBe(null);
    expect(hello(undefined)).toBe(null);
  });

  it('keeps well-formed capabilities and drops the rest', () => {
    expect(parseAgentHello({
      type: 'hello', unixUser: 'psecor', home: '/home/psecor',
      capabilities: ['credentials-v1', 42, 'Bad Name', '../x', 'x'.repeat(65)],
    })?.capabilities).toEqual(['credentials-v1']);
    expect(parseAgentHello({
      type: 'hello', unixUser: 'psecor', home: '/home/psecor', capabilities: 'credentials-v1',
    })?.capabilities).toEqual([]);
  });

  it('keeps every capability a fully set-up box sends, the browser pane ones last', () => {
    // A box's hello as of October 2026 (agent/agent.js sendHello). Under the
    // old cap of 32 the last three were dropped, and the orchestrator refused
    // preview-share guests on a box whose agent could host them.
    const box = [
      'credentials-v1', 'github-broker-v1', 'telemetry-v1', 'telemetry-replay-v1', 'agent-telemetry-v1',
      'mcp-broker-v1', 'fireworks-v1', 'tmux-create-command-v1', 'box-update-v1', 'ask-v1', 'ask-cancel-v1', 'ask-chat-v1',
      'host-sample-v1', 'unsaved-work-v1', 'software-inventory-v1', 'briefing-v1', 'chat-runner-v1', 'chat-durable-v1',
      'chat-trust-v1', 'chat-auto-v1', 'chat-live-v1', 'chat-interrupt-v1', 'chat-orchestrator-v1', 'chat-backend-v1',
      'chat-images-v1', 'claude-login-v1', 'worktree-pr-v1', 'worktree-fetch-v1', 'read-image-v1', 'claude-trust-folder-v1',
      'browser-pane-v1', 'browser-pane-guest-v1', 'browser-pane-profiles-v1', 'claude-runner-wrapper-v2',
    ];
    expect(parseAgentHello({ type: 'hello', unixUser: 'psecor', home: '/home/psecor', capabilities: box })?.capabilities).toEqual(box);
  });

  it(`keeps at most ${MAX_CAPABILITIES} capabilities`, () => {
    const many = Array.from({ length: MAX_CAPABILITIES + 5 }, (_, i) => `cap-${i}-v1`);
    expect(parseAgentHello({ type: 'hello', unixUser: 'psecor', home: '/home/psecor', capabilities: many })?.capabilities)
      .toEqual(many.slice(0, MAX_CAPABILITIES));
  });
});

describe('parseHostSample', () => {
  it('keeps whole percentages, a finite load and a count; anything else is null, an absent object is null', () => {
    expect(parseHostSample({ diskUsedPct: 93, memUsedPct: 14, load1: 11.764, keptCheckouts: 2 })).toEqual({ diskUsedPct: 93, memUsedPct: 14, load1: 11.76, keptCheckouts: 2, cores: null, memTotalMb: null, sshSessions: null, openTunnels: null });
    expect(parseHostSample({ sshSessions: 2 })).toMatchObject({ sshSessions: 2 });
    expect(parseHostSample({ sshSessions: 0 })).toMatchObject({ sshSessions: 0 });
    expect(parseHostSample({ sshSessions: -1 })).toMatchObject({ sshSessions: null });
    expect(parseHostSample({ cores: 2, memTotalMb: 3793 })).toMatchObject({ cores: 2, memTotalMb: 3793 });
    expect(parseHostSample({ cores: 0, memTotalMb: -5 })).toMatchObject({ cores: null, memTotalMb: null });
    expect(parseHostSample({ diskUsedPct: 101, memUsedPct: -1, load1: 'high', keptCheckouts: 1.5 })).toEqual({ diskUsedPct: null, memUsedPct: null, load1: null, keptCheckouts: null, cores: null, memTotalMb: null, sshSessions: null, openTunnels: null });
    expect(parseHostSample(undefined)).toBeNull();
    expect(parseHostSample('93%')).toBeNull();
  });
  it('keeps the open port forwards and leaves out the t3 relays: the desktop holds one while connected (docs/port-forward.md)', () => {
    expect(parseHostSample({ tunnels: { t3: 1, port: 3 } })).toMatchObject({ openTunnels: 3 });
    expect(parseHostSample({ tunnels: { t3: 0, port: 0 } })).toMatchObject({ openTunnels: 0 });
    expect(parseHostSample({ tunnels: { port: 2 } })).toMatchObject({ openTunnels: 2 });
    expect(parseHostSample({ tunnels: { t3: 2, port: 0 } })).toMatchObject({ openTunnels: 0 });
    for (const tunnels of [undefined, null, 5, [1, 2], {}, { t3: 'x', port: 1.5 }, { t3: 2 }, { t3: 2, port: -1 }]) {
      expect(parseHostSample({ tunnels }), JSON.stringify(tunnels)).toMatchObject({ openTunnels: null });
    }
  });
  it('rides on the hello, and an older agent without it parses as before', () => {
    const base = { type: 'hello', unixUser: 'ada', home: '/home/ada' };
    expect(parseAgentHello(base)?.host).toBeNull();
    expect(parseAgentHello({ ...base, host: { diskUsedPct: 50, memUsedPct: 20, load1: 1, keptCheckouts: 0 } })?.host).toEqual({ diskUsedPct: 50, memUsedPct: 20, load1: 1, keptCheckouts: 0, cores: null, memTotalMb: null, sshSessions: null, openTunnels: null });
  });
});

describe('agentCommitAt', () => {
  it('takes a plausible commit date beside the commit and nulls nonsense or an absent one', () => {
    const base = { type: 'hello', unixUser: 'ada', home: '/home/ada' };
    expect(parseAgentHello({ ...base, agentCommitAt: '2026-10-09T22:04:03-07:00' })?.agentCommitAt).toEqual(new Date('2026-10-09T22:04:03-07:00'));
    expect(parseAgentHello({ ...base, agentCommitAt: 'yesterday' })?.agentCommitAt).toBeNull();
    expect(parseAgentHello({ ...base, agentCommitAt: '1999-01-01T00:00:00Z' })?.agentCommitAt).toBeNull();
    expect(parseAgentHello({ ...base, agentCommitAt: '2099-01-01T00:00:00Z' })?.agentCommitAt).toBeNull();
    expect(parseAgentHello(base)?.agentCommitAt).toBeNull();
  });
});
