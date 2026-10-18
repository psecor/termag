import { describe, expect, it } from 'vitest';
import { sendHeartbeat } from './attach.js';
import {
  HeartbeatGate, PrefixHandler, backoffDelay, describePrefix, handshakeRefusal, isFatalClose, parseServerFrame, terminalWsUrl,
} from './terminalSocket.js';

describe('terminalWsUrl', () => {
  it('targets the CLI terminal socket with session, project, workstream and size — never a token', () => {
    const u = new URL(terminalWsUrl('https://h/termag', { session: 'u-p-agent', projectId: 'p1', projectName: 'p', workstream: 'main', role: 'agent', instanceId: 'i-1' }, 120, 40));
    expect(u.protocol).toBe('wss:');
    expect(u.pathname).toBe('/termag/api/cli/v1/ws/terminal');
    expect(Object.fromEntries(u.searchParams)).toEqual({ session: 'u-p-agent', projectId: 'p1', workstream: 'main', cols: '120', rows: '40' });
  });
});

describe('parseServerFrame', () => {
  it('accepts output and exit, from strings or buffers', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'output', data: 'hi' }))).toEqual({ type: 'output', data: 'hi' });
    expect(parseServerFrame(Buffer.from(JSON.stringify({ type: 'exit' })))).toEqual({ type: 'exit' });
    expect(parseServerFrame(JSON.stringify({ type: 'output' }))).toBeNull();
    expect(parseServerFrame('garbage')).toBeNull();
    expect(parseServerFrame(42)).toBeNull();
  });
});

describe('PrefixHandler', () => {
  it('forwards plain input untouched', () => {
    const h = new PrefixHandler();
    expect(h.feed('ls -la\r')).toEqual([{ send: 'ls -la\r' }]);
  });
  it('turns prefix + key into an action, in typing order, and drops both bytes', () => {
    const h = new PrefixHandler();
    // text before a detach chord in the same read is delivered before it acts
    expect(h.feed('ab\x1cdcd')).toEqual([{ send: 'ab' }, { action: 'detach' }, { send: 'cd' }]);
    expect(h.feed('\x1c\t')).toEqual([{ action: 'flip' }]);
    expect(h.feed('\x1cn\x1cp')).toEqual([{ action: 'next' }, { action: 'prev' }]);
  });
  it('keeps pending state across chunks and sends a doubled prefix literally', () => {
    const h = new PrefixHandler();
    expect(h.feed('\x1c')).toEqual([]);
    expect(h.isPending).toBe(true);
    expect(h.feed('d')).toEqual([{ action: 'detach' }]);
    expect(h.feed('\x1c\x1c')).toEqual([{ send: '\x1c' }]);
  });
  it('drops an unknown chord and reports it in place', () => {
    const h = new PrefixHandler();
    expect(h.feed('a\x1czb')).toEqual([{ send: 'a' }, { unknown: true }, { send: 'b' }]);
  });
  it('honours a custom prefix', () => {
    const h = new PrefixHandler('\x1d');
    expect(h.feed('\x1cx\x1dd')).toEqual([{ send: '\x1cx' }, { action: 'detach' }]);
  });
});

describe('policy helpers', () => {
  it('describes control prefixes', () => {
    expect(describePrefix('\x1c')).toBe('C-\\');
    expect(describePrefix('\x01')).toBe('C-a');
    expect(describePrefix('\x1d')).toBe('C-]');
  });
  it('backs off on the browser schedule and caps at 30s', () => {
    expect([0, 1, 2, 7, 20].map(backoffDelay)).toEqual([0, 500, 1000, 30000, 30000]);
  });
  it('treats only unrecoverable 1008 reasons as fatal', () => {
    expect(isFatalClose(1008, 'login required')).toBe(true);
    expect(isFatalClose(1008, 'session forbidden')).toBe(true);
    expect(isFatalClose(1008, 'Agent not connected for box')).toBe(false);
    expect(isFatalClose(1011, 'login required')).toBe(false);
    expect(isFatalClose(1006, '')).toBe(false);
    // a credential the CLI socket stopped accepting
    expect(isFatalClose(1008, 'This device was signed out; run `termag login`')).toBe(true);
    expect(isFatalClose(1008, 'Box credential revoked')).toBe(true);
    // a project still cloning is worth retrying
    expect(isFatalClose(1008, 'project setup cloning')).toBe(false);
    // a parked box: wait for one that is starting, give up on the rest
    expect(isFatalClose(4409, 'box starting')).toBe(false);
    expect(isFatalClose(4409, 'box stopped')).toBe(true);
    expect(isFatalClose(4409, 'box hibernated')).toBe(true);
    // an access token that lapsed under an open socket: re-dial, never final
    expect(isFatalClose(4401, 'Access token expired; reconnect with a fresh one')).toBe(false);
  });
  it('heartbeat gate fires at most once per interval', () => {
    const g = new HeartbeatGate(30_000);
    expect(g.shouldSend(1000)).toBe(true);
    expect(g.shouldSend(2000)).toBe(false);
    expect(g.shouldSend(31_000)).toBe(true);
  });
});

describe('handshakeRefusal', () => {
  it('reads the HTTP status out of the ws client error and treats 401/403 as fatal', () => {
    expect(handshakeRefusal('Unexpected server response: 401')).toEqual({ status: 401, fatal: true });
    expect(handshakeRefusal('Unexpected server response: 403')).toEqual({ status: 403, fatal: true });
    expect(handshakeRefusal('Unexpected server response: 502')).toEqual({ status: 502, fatal: false });
    expect(handshakeRefusal('connect ECONNREFUSED 127.0.0.1:3070')).toBeNull();
    expect(handshakeRefusal(undefined)).toBeNull();
  });
});

describe('sendHeartbeat', () => {
  it('credits the project\'s own box, and null for the orchestrator host', async () => {
    const calls: unknown[][] = [];
    const api = { heartbeat: async (...a: unknown[]) => { calls.push(a); return { ok: true as const }; } };
    const t = { session: 'u-p-agent', projectId: 'p1', projectName: 'p', workstream: 'main', role: 'agent' as const };
    await sendHeartbeat(api, { ...t, instanceId: 'i-box' });
    await sendHeartbeat(api, { ...t, instanceId: null });
    expect(calls).toEqual([['p', 'i-box'], ['p', null]]);
  });
});
