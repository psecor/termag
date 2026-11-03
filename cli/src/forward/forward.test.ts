import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer, Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../args.js';
import { bearerFor, session } from '../commands.js';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { run } from '../main.js';
import type { Exec } from '../system.js';
import { installFakeForward, type FakeForward } from '../test/fakeForward.js';
import { startFakeOrchestrator, type FakeOrchestrator } from '../test/fakeOrchestrator.js';
import { startForward, type Forward, type ForwardOptions } from './forwarder.js';
import { parsePortSpecs } from './ports.js';
import { RENEW_VALID_FOR_MS } from './renew.js';

let home: string;
let orch: FakeOrchestrator;
let fwd: FakeForward;
let out: string[];
let err: string[];
let forwards: Forward[];
let blockers: Server[];

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host },
    home,
    hostname: 'laptop.local',
    interactive: true,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: (url) => { void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 5000,
    ...overrides,
  };
}

/** A port nothing listens on, on either loopback family, a moment ago. */
async function freePort(): Promise<number> {
  for (;;) {
    const s = createServer();
    await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
    const port = (s.address() as { port: number }).port;
    await new Promise(resolve => s.close(resolve));
    if (port >= 1024) return port;
  }
}

const hasIpv6 = await new Promise<boolean>((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '::1', () => s.close(() => resolve(true)));
});

let tokenCalls = 0;
async function start(specs: string[], extra: Partial<ForwardOptions> = {}): Promise<{ forward: Forward; ports: number[] }> {
  const s = session(ctx(), { host: undefined } as ParsedArgs);
  const bearer = bearerFor(ctx(), s);
  const forward = await startForward({
    host: orch.host,
    box: { id: 'i1', name: 'devbox' },
    ports: parsePortSpecs(specs),
    token: (o) => { tokenCalls++; return bearer(o); },
    notify: line => err.push(line),
    retryDelayMs: 10,
    ...extra,
  });
  forwards.push(forward);
  return { forward, ports: forward.listening.map(l => l.local) };
}

/** A local client of a forward: what it read, and when the box's side ended. */
function client(port: number, host = '127.0.0.1') {
  const socket = connect({ port, host, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  socket.on('data', c => chunks.push(c));
  const ended = new Promise<void>(resolve => socket.once('end', () => resolve()));
  const closed = new Promise<boolean>(resolve => socket.once('close', hadError => resolve(hadError)));
  socket.on('error', () => {});
  return { socket, ended, closed, text: () => Buffer.concat(chunks).toString(), bytes: () => chunks.reduce((n, c) => n + c.length, 0) };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const echoRoundTrip = async (port: number, host?: string) => {
  const c = client(port, host);
  c.socket.write(`ping ${host ?? ''}`);
  await until(() => c.text() === `ping ${host ?? ''}`);
  c.socket.end();
  await c.ended;
  return c;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-forward-'));
  orch = await startFakeOrchestrator();
  fwd = installFakeForward(orch);
  out = [];
  err = [];
  forwards = [];
  blockers = [];
  tokenCalls = 0;
  expect(await run(['login'], ctx())).toBe(0);
  out = [];
  err = [];
});

afterEach(async () => {
  for (const f of forwards) await f.stop();
  for (const b of blockers) await new Promise(resolve => b.close(resolve));
  await orch.close();
  rmSync(home, { recursive: true, force: true });
});

describe('listeners', () => {
  it('bind 127.0.0.1 and ::1, never a wildcard, and relay from both', async () => {
    const port = await freePort();
    const { forward } = await start([`3000:${port}`]);
    const expected = hasIpv6 ? [`127.0.0.1:${port}`, `[::1]:${port}`] : [`127.0.0.1:${port}`];
    expect(forward.listening).toEqual([{ port: 3000, local: port, name: 'devbox:3000', addresses: expected }]);
    await echoRoundTrip(port, '127.0.0.1');
    if (hasIpv6) await echoRoundTrip(port, '::1');
    expect(fwd.dials.map(d => d.port)).toEqual(hasIpv6 ? [3000, 3000] : [3000]);
  });

  it('name the holder of a port in use, from lsof, and bind nothing', async () => {
    const taken = await freePort();
    const other = await freePort();
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(taken, '127.0.0.1', resolve));
    blockers.push(blocker);
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return {
        code: 0,
        stderr: '',
        stdout: 'COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n'
          + `vite    4242 alice   23u  IPv4 0x1234      0t0  TCP 127.0.0.1:${taken} (LISTEN)\n`
          + `vite    4242 alice   24u  IPv6 0x1235      0t0  TCP [::1]:${taken} (LISTEN)\n`,
      };
    };
    const error = await start([`${other}`, `3000:${taken}`], { exec }).catch(e => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(`Local port ${taken} is already in use by vite (pid 4242, user alice); stop it, or use another local port: termag forward devbox 3000:${taken + 1}`);
    expect(calls).toEqual([['lsof', '-nP', `-iTCP:${taken}`, '-sTCP:LISTEN']]);
    // The port that did bind was let go.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(other, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  });

  it('end what an earlier listener accepted while lsof names the holder, and report the conflict promptly', async () => {
    const taken = await freePort();
    const other = await freePort();
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(taken, '127.0.0.1', resolve));
    blockers.push(blocker);
    // A browser on the port that did bind, holding its connection open, during the lookup.
    let c!: ReturnType<typeof client>;
    let gone = false;
    const exec: Exec = async () => {
      c = client(other);
      void c.closed.then(() => { gone = true; });
      c.socket.write('hi');
      await until(() => c.text() === 'hi' || gone);
      return { code: 127, stdout: '', stderr: '' };
    };
    const began = Date.now();
    const error = await Promise.race([
      start([`${other}`, `3000:${taken}`], { exec }).catch(e => e),
      new Promise(resolve => setTimeout(() => resolve('still waiting on the browser'), 2000)),
    ]);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(`Local port ${taken} is already in use`);
    expect(Date.now() - began).toBeLessThan(1500);
    await Promise.race([c.ended, c.closed]);
  });

  it('say only "in use" when lsof is missing', async () => {
    const taken = await freePort();
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(taken, '127.0.0.1', resolve));
    blockers.push(blocker);
    const exec: Exec = async () => ({ code: 127, stdout: '', stderr: '' });
    await expect(start([`3000:${taken}`], { exec })).rejects.toThrow(`Local port ${taken} is already in use; stop it`);
  });

  it('refuse local ports below 1024 and repeated local ports', () => {
    expect(() => parsePortSpecs(['80'])).toThrow('local port 80 is below 1024; pick a local port of 1024 or more; e.g. 80:8080');
    expect(parsePortSpecs(['80:8080', '5173'])).toEqual([{ port: 80, local: 8080 }, { port: 5173, local: 5173 }]);
    expect(() => parsePortSpecs(['3000', '4000:3000'])).toThrow('Local port 3000 is named twice');
    expect(() => parsePortSpecs(['70000'])).toThrow('the box port must be a number from 1 to 65535');
    expect(() => parsePortSpecs(['3000:'])).toThrow('is not <port>[:<local>]');
  });
});

describe('each connection', () => {
  it('dials with a fresh bearer in the Authorization header and the subprotocol, never a token in the URL', async () => {
    orch.accessTtlS = 30; // inside the refresh margin, so every connection refreshes
    expect(await run(['login'], ctx())).toBe(0);
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    await echoRoundTrip(port);
    await echoRoundTrip(port);
    expect(tokenCalls).toBe(2);
    expect(fwd.dials).toHaveLength(2);
    for (const d of fwd.dials) {
      expect(d.authorization).toMatch(/^Bearer eyJfake\./);
      expect(d.protocol).toBe('termag-forward.v2,termag-forward.v1');
      expect(d.url).toBe('/termag/api/cli/v1/boxes/i1/forward/3000');
    }
    expect(fwd.dials[0].authorization).not.toBe(fwd.dials[1].authorization);
    const tokens = [...orch.accessTokens.keys(), ...orch.tokens.keys()];
    for (const url of [...fwd.urls, ...orch.requests.map(r => r.path)]) {
      expect(url).not.toMatch(/token=/);
      for (const t of tokens) expect(url).not.toContain(t);
    }
  });

  it('refreshes an access token the orchestrator refuses before its clock says so, once, and the connection goes through', async () => {
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    await echoRoundTrip(port);
    const used = fwd.dials[0].authorization;
    orch.accessTokens.clear(); // its signing key retired
    await echoRoundTrip(port);
    expect(fwd.dials.map(d => d.authorization === used)).toEqual([true, true, false]);
    expect(fwd.conns).toHaveLength(2);
    expect(err).toEqual([]);
  });

  it('relays two concurrent connections on one port independently', async () => {
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    const a = client(port);
    const b = client(port);
    a.socket.write('aaa');
    b.socket.write('bbb');
    await until(() => a.text() === 'aaa' && b.text() === 'bbb');
    a.socket.write('AAA');
    await until(() => a.text() === 'aaaAAA');
    expect(b.text()).toBe('bbb');
    a.socket.end();
    b.socket.end();
    await Promise.all([a.ended, b.ended]);
    expect(fwd.conns).toHaveLength(2);
    expect(await Promise.all(fwd.conns.map(c => c.closed))).toEqual([1000, 1000]);
  });

  it('carries the local peer\'s half-close as fin, and the box\'s fin back as an end', async () => {
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    c.socket.write('half');
    c.socket.end();
    await c.ended;
    expect(c.text()).toBe('half');
    await until(() => fwd.conns[0]?.closeCode !== null);
    expect(fwd.conns[0].gotFin).toBe(true);
    expect(fwd.conns[0].closeCode).toBe(1000);
    expect(await c.closed).toBe(false);
  });

  it('keeps the local write side open after the box half-closes', async () => {
    fwd.behaviour.set(3000, 'speak-then-fin');
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    await c.ended;
    expect(c.text()).toBe(fwd.banner);
    c.socket.write('still talking');
    await until(() => Buffer.concat(fwd.conns[0]?.received ?? []).toString() === 'still talking');
    c.socket.end();
    expect(await fwd.conns[0].closed).toBe(1000);
    expect(await c.closed).toBe(false);
  });

  it('pauses the WebSocket for a slow local reader, so what is in flight stays bounded', async () => {
    fwd.behaviour.set(3000, 'firehose');
    fwd.total = 64 * 1024 * 1024;
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    c.socket.pause();
    await until(() => fwd.conns.length === 1 && fwd.conns[0].sent > 0);
    // Let the pipe fill up, then check it stopped well short of the whole stream.
    let last = -1;
    await until(() => { const s = fwd.conns[0].sent; const settled = s === last; last = s; return settled && s > 1024 * 1024; }, 10_000);
    await new Promise(resolve => setTimeout(resolve, 200));
    const inFlight = fwd.conns[0].sent;
    expect(inFlight).toBeLessThan(24 * 1024 * 1024);
    expect(forward.totals().bytesDown).toBeLessThan(24 * 1024 * 1024);
    c.socket.resume();
    await until(() => c.bytes() === fwd.total, 20_000);
    expect(forward.totals().bytesDown).toBe(fwd.total);
  }, 30_000);

  it('pings the orchestrator while paused for a slow local reader, whose heartbeat would otherwise find no pong', async () => {
    fwd.behaviour.set(3000, 'firehose');
    fwd.total = 64 * 1024 * 1024;
    const { ports: [port] } = await start(['3000:' + await freePort()], { pingMs: 20 });
    const c = client(port);
    c.socket.pause();
    // Paused: the box end stops sending once the pipe stops reading.
    let last = -1;
    await until(() => { const s = fwd.conns[0]?.sent ?? 0; const settled = s === last; last = s; return settled && s > 1024 * 1024; }, 10_000);
    const before = fwd.conns[0].pings;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(fwd.conns[0].pings - before).toBeGreaterThanOrEqual(5);
    c.socket.destroy();
  }, 15_000);

  it('closes promptly when the local peer goes away while the WebSocket is paused for it', async () => {
    fwd.behaviour.set(3000, 'firehose');
    fwd.total = 64 * 1024 * 1024;
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    c.socket.pause();
    // Fill the local socket until the pipe pauses the WebSocket (the box stops sending), then go (curl … | head).
    let last = -1;
    await until(() => { const s = fwd.conns[0]?.sent ?? 0; const settled = s === last; last = s; return settled && s > 1024 * 1024; }, 10_000);
    c.socket.destroy();
    // Unless the pipe resumes to read the box's close frame, both ends wait out ws's 30 s close timeout.
    const code = await Promise.race([fwd.conns[0].closed, new Promise(resolve => setTimeout(() => resolve('timed out'), 2000))]);
    expect(code).toBe(1011);
    await until(() => forward.totals().connections === 1, 1000);
    expect(forward.totals().failed).toBe(0);
  }, 15_000);

  it('pauses the local socket while the box reads nothing', async () => {
    fwd.behaviour.set(3000, 'stall');
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    const chunk = Buffer.alloc(64 * 1024, 1);
    let written = 0;
    // Write as fast as the socket takes it; it stops taking once the forward pauses it.
    await new Promise<void>((resolve) => {
      const pump = () => {
        while (written < 64 * 1024 * 1024) {
          written += chunk.length;
          if (!c.socket.write(chunk)) { c.socket.once('drain', pump); break; }
        }
      };
      pump();
      setTimeout(resolve, 1500);
    });
    expect(forward.totals().bytesUp).toBeLessThan(24 * 1024 * 1024);
    expect(written).toBeLessThan(48 * 1024 * 1024);
    c.socket.destroy();
  }, 10_000);
});

describe('retries and refusals', () => {
  it('retries once on tunnel_failed, and the connection then works', async () => {
    fwd.queue.set(3000, [{ refuse: { status: 502, code: 'tunnel_failed' } }]);
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    await echoRoundTrip(port);
    expect(fwd.dials).toHaveLength(2);
    expect(err).toEqual([]);
  });

  it('retries once on a 503 draining', async () => {
    fwd.queue.set(3000, [{ refuse: { status: 503, code: 'draining' } }]);
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    await echoRoundTrip(port);
    expect(fwd.dials).toHaveLength(2);
  });

  it('retries once on close 1012 before a byte moved', async () => {
    fwd.queue.set(3000, [{ closeAfterOpen: 1012 }]);
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    await until(() => fwd.conns.length === 1);
    c.socket.write('after the redial');
    await until(() => c.text() === 'after the redial');
    expect(fwd.dials).toHaveLength(2);
    c.socket.end();
    await c.ended;
  });

  // A request written on connect sits in the local socket while the first tunnel
  // opens and closes; the redial must get every byte of it.
  const REQUEST = 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n' + 'x'.repeat(200_000);
  it.each([
    ['1012 right after the open', { closeAfterOpen: 1012 }],
    ['tunnel_failed', { refuse: { status: 502, code: 'tunnel_failed' } }],
    ['a 503 draining', { refuse: { status: 503, code: 'draining' } }],
  ] as const)('hands the redial after %s the request the client wrote on connect, intact', async (_what, action) => {
    for (let i = 0; i < 20; i++) {
      fwd.queue.set(3000, [action]);
      fwd.dials.length = 0;
      fwd.conns.length = 0;
      const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
      const c = client(port);
      c.socket.write(REQUEST);
      await until(() => c.text().length === REQUEST.length);
      expect(c.text()).toBe(REQUEST);
      expect(fwd.dials).toHaveLength(2);
      c.socket.end();
      await c.ended;
      await forward.stop();
    }
  });

  it('gives up after the one retry, with one notice for the wave', async () => {
    fwd.queue.set(3000, Array.from({ length: 4 }, () => ({ refuse: { status: 502, code: 'tunnel_failed' } })));
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    await client(port).ended;
    await client(port).ended;
    expect(fwd.dials).toHaveLength(4);
    expect(err).toEqual([`devbox:3000 (localhost:${port}): tunnel_failed: the orchestrator couldn't open a tunnel to devbox in time`]);
    expect(forward.totals()).toMatchObject({ connections: 2, failed: 2 });
    // The listener survived: the next connection gets through.
    await echoRoundTrip(port);
  });

  it('does not retry port_refused, and prints the code with the port\'s name and the agent\'s reason', async () => {
    fwd.queue.set(5432, [{ refuse: { status: 403, code: 'port_refused', error: 'port 5432 is owned by uid 0 (postgres)' } }]);
    const { ports: [port] } = await start([], { ports: [{ port: 5432, local: await freePort(), name: 'postgres' }] });
    await client(port).ended;
    expect(fwd.dials).toHaveLength(1);
    expect(err).toEqual([`postgres (localhost:${port}): port_refused: devbox refused to forward port 5432: port 5432 is owned by uid 0 (postgres)`]);
  });

  it('says once, then when it recovers, that a live connection dropped', async () => {
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    const a = client(port);
    const b = client(port);
    a.socket.write('x');
    b.socket.write('y');
    await until(() => a.text() === 'x' && b.text() === 'y');
    for (const conn of fwd.conns) conn.ws.close(1012);
    await Promise.all([a.closed, b.closed]);
    await until(() => err.length > 0);
    expect(err).toEqual(['a connection to devbox:3000 dropped: the orchestrator restarted (a deploy); listeners stay up and new connections dial again']);
    await echoRoundTrip(port);
    expect(err.at(-1)).toBe('connections to devbox work again');
  });

  it('resets a connection closed at the 12 h limit (4408), says so for its port, and keeps listening', async () => {
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    c.socket.write('x');
    await until(() => c.text() === 'x');
    fwd.conns[0].ws.close(4408, 'This forward reached its 12 h limit; reconnect');
    expect(await c.closed).toBe(true);
    await until(() => err.length > 0);
    expect(err).toEqual([`devbox:3000 (localhost:${port}): a connection reached the orchestrator's 12 h limit and was closed; a new connection will work (listeners stay up)`]);
    await echoRoundTrip(port);
    expect(fwd.dials).toHaveLength(2);
    expect(forward.totals()).toMatchObject({ connections: 2, failed: 1 });
  });

  it('takes a local reset in its stride: no notice, no failure', async () => {
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    c.socket.write('x');
    await until(() => c.text() === 'x');
    c.socket.resetAndDestroy();
    expect(await fwd.conns[0].closed).toBe(1011);
    await until(() => forward.totals().connections === 1 && fwd.conns[0].closeCode !== null);
    await echoRoundTrip(port);
    expect(err).toEqual([]);
    expect(forward.totals()).toMatchObject({ connections: 2, failed: 0 });
  });

  it('notes an unreachable orchestrator once, and keeps listening', async () => {
    const { forward, ports: [port] } = await start(['3000:' + await freePort()], { host: 'http://127.0.0.1:9/termag' });
    await client(port).ended;
    await client(port).ended;
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^can't reach the orchestrator at http:\/\/127\.0\.0\.1:9\/termag \(ECONNREFUSED\); listeners stay up/);
    expect(forward.listening).toHaveLength(1);
  });
});

const refusedOn = (port: number) => new Promise<string>((resolve) => {
  const s: Socket = connect({ port, host: '127.0.0.1' });
  s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? ''));
  s.once('connect', () => { s.destroy(); resolve('connected'); });
});

/** Rejects once `ms` pass first: a release that waits on a socket it never ended would hang the test instead. */
const within = <T>(p: Promise<T>, ms: number, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} still waiting after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
};

describe('a port being released', () => {
  it('leaves nothing listening on a port that close() or stop() releases while add() still binds it', async () => {
    const { forward, ports: [a] } = await start([`3000:${await freePort()}`]);
    const b = await freePort();
    const adding = forward.add(parsePortSpecs([`4000:${b}`])).catch((e: unknown) => e);
    await forward.close(b);
    expect(await adding).toMatchObject({ message: `Local port ${b} was closed while it was being bound` });
    expect(forward.listening.map(l => l.local)).toEqual([a]);
    expect(await refusedOn(b)).toBe('ECONNREFUSED');
    await echoRoundTrip(a);

    const c = await freePort();
    const adding2 = forward.add(parsePortSpecs([`5000:${c}`])).catch((e: unknown) => e);
    await within(forward.stop(), 1500, 'stop()');
    expect(await adding2).toMatchObject({ message: 'The forward has stopped' });
    expect(forward.listening).toEqual([]);
    expect(await refusedOn(c)).toBe('ECONNREFUSED');
  });
});

describe('add and close', () => {
  it('add a port while the others keep listening, and close one alone, its live connection with 1000', async () => {
    const a = await freePort();
    const { forward } = await start([`3000:${a}`]);
    const b = await freePort();
    const [added] = await forward.add(parsePortSpecs([`4000:${b}`]));
    expect(added).toMatchObject({ port: 4000, local: b, name: 'devbox:4000' });
    expect(forward.listening.map(l => l.local)).toEqual([a, b]);
    await echoRoundTrip(b);
    const c = client(b);
    c.socket.write('x');
    await until(() => c.text() === 'x');
    await forward.close(b);
    expect(await fwd.conns.at(-1)!.closed).toBe(1000);
    expect(forward.listening.map(l => l.local)).toEqual([a]);
    expect(await refusedOn(b)).toBe('ECONNREFUSED');
    await echoRoundTrip(a);
  });

  it('add all or nothing: a port in use closes only what that call bound', async () => {
    const a = await freePort();
    const { forward } = await start([`3000:${a}`]);
    const [b, taken] = [await freePort(), await freePort()];
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(taken, '127.0.0.1', resolve));
    blockers.push(blocker);
    const e = await forward.add(parsePortSpecs([`4000:${b}`, `5000:${taken}`])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe('conflict');
    expect(forward.listening.map(l => l.local)).toEqual([a]);
    expect(await refusedOn(b)).toBe('ECONNREFUSED');
    await echoRoundTrip(a);
    await expect(forward.add(parsePortSpecs([`3001:${a}`]))).rejects.toThrow(`Local port ${a} is already forwarded`);
    await echoRoundTrip(a);
  });
});

describe('the access token, renewed in band on v2', () => {
  /** Open `n` connections on `port` and see each echo once; they stay open. */
  async function openConns(port: number, n: number) {
    const cs = [];
    for (let i = 0; i < n; i++) {
      const c = client(port);
      c.socket.write(`hi ${i}`);
      await until(() => c.text() === `hi ${i}`);
      cs.push(c);
    }
    return cs;
  }

  it('asks once per interval however many connections are open, and sends each renewal to every one', async () => {
    orch.accessTtlS = 600; // under RENEW_VALID_FOR_MS: every ask mints a new token
    expect(await run(['login'], ctx())).toBe(0);
    err = [];
    const asked: Array<{ rejected?: string; validForMs?: number } | undefined> = [];
    const s = session(ctx(), { host: undefined } as ParsedArgs);
    const bearer = bearerFor(ctx(), s);
    const { ports: [a, b] } = await start(['3000:' + await freePort(), '3001:' + await freePort()], {
      renewEveryMs: 300,
      token: (o) => { asked.push(o); return bearer(o); },
    });
    const cs = [...await openConns(a, 2), ...await openConns(b, 1)];
    const dials = asked.length;
    expect(dials).toBe(3);
    expect(fwd.conns.map(c => c.protocol)).toEqual(Array(3).fill('termag-forward.v2'));
    await until(() => fwd.conns.every(c => c.tokens.length >= 2), 5000);
    // One ask per renewal, not one per connection; each connection got the same tokens.
    const renewals = fwd.conns[0].tokens.length;
    expect(asked.length - dials).toBeLessThanOrEqual(renewals + 1);
    for (const c of fwd.conns) expect(c.tokens.slice(0, 2)).toEqual(fwd.conns[0].tokens.slice(0, 2));
    expect(new Set(fwd.conns[0].tokens).size).toBe(fwd.conns[0].tokens.length);
    // Every ask, a dial's or the renewer's, wants a token good past the next ask.
    for (const o of asked) expect(o?.validForMs).toBe(RENEW_VALID_FOR_MS);
    // The tokens are the orchestrator's: none reached the box's bytes, and the bytes still flow.
    cs[0].socket.write(' again');
    await until(() => cs[0].text() === 'hi 0 again');
    for (const c of fwd.conns) {
      expect(c.strayText).toEqual([]);
      expect(Buffer.concat(c.received).toString()).not.toContain('"t":"token"');
    }
    expect(err).toEqual([]);
  });

  it('sends nothing while the token held has more than the margin left', async () => {
    orch.accessTtlS = 2 * RENEW_VALID_FOR_MS / 1000; // 30 min: the cached token is still good for the asks below
    expect(await run(['login'], ctx())).toBe(0);
    const { ports: [port] } = await start(['3000:' + await freePort()], { renewEveryMs: 30 });
    await openConns(port, 1);
    const asks = tokenCalls;
    await until(() => tokenCalls >= asks + 3);
    expect(fwd.conns[0].tokens).toEqual([]);
  });

  it('never sends a token frame to an orchestrator that picked v1, nor asks for renewals', async () => {
    fwd.v1Only = true;
    orch.accessTtlS = 600;
    expect(await run(['login'], ctx())).toBe(0);
    const { ports: [port] } = await start(['3000:' + await freePort()], { renewEveryMs: 20 });
    await openConns(port, 2);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(fwd.conns.map(c => c.protocol)).toEqual(['termag-forward.v1', 'termag-forward.v1']);
    expect(tokenCalls).toBe(2);
    expect(fwd.conns.flatMap(c => [...c.tokens, ...c.strayText])).toEqual([]);
  });

  it('says for its port when a connection closed 4402, its token expired unrenewed, and keeps listening', async () => {
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    const [c] = await openConns(port, 1);
    fwd.conns[0].ws.close(4402, 'Access token expired and was not renewed; reconnect');
    expect(await c.closed).toBe(true);
    await until(() => err.length > 0);
    expect(err).toEqual([`devbox:3000 (localhost:${port}): a connection was closed: its access token expired before a renewed one reached the orchestrator; a new connection gets a fresh one (listeners stay up)`]);
    await echoRoundTrip(port);
    expect(forward.totals()).toMatchObject({ connections: 2, failed: 1 });
  });

  it('after a second `termag login`, keeps the old sign-in\'s connections on their tokens, and says why when they expire', async () => {
    orch.accessTtlS = 600; // every ask mints
    expect(await run(['login'], ctx())).toBe(0);
    err = [];
    const { ports: [port] } = await start(['3000:' + await freePort()], { renewEveryMs: 50 });
    const [oldC] = await openConns(port, 1);
    await until(() => fwd.conns[0].tokens.length >= 1);
    // Another sign-in on this machine: the stored login, and so every token from now on, is the new one's.
    expect(await run(['login'], ctx())).toBe(0);
    err = [];
    const sent = fwd.conns[0].tokens.length;
    const [newC] = await openConns(port, 1);
    await until(() => fwd.conns[1].tokens.length >= 2);
    // The old connection got none of the new sign-in's tokens (the orchestrator would refuse them, 4406), and still works.
    expect(fwd.conns[0].tokens).toHaveLength(sent);
    expect(fwd.conns[0].closeCode).toBeNull();
    oldC.socket.write('!');
    await until(() => oldC.text() === 'hi 0!');
    // Its token reaches exp: the orchestrator closes it 4402, and the CLI says it was the earlier sign-in.
    fwd.conns[0].ws.close(4402, 'Access token expired and was not renewed; reconnect');
    await oldC.closed;
    await until(() => err.length > 0);
    expect(err).toEqual([`devbox:3000 (localhost:${port}): a connection opened under an earlier sign-in reached its access token's expiry and was closed: a later \`termag login\` replaced that sign-in, which can't renew it; new connections use the new one (listeners stay up)`]);
    newC.socket.write('?');
    await until(() => newC.text() === 'hi 0?');
  });

  it('says a refused renewal (4406) is a refusal, not an expiry', async () => {
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    const [c] = await openConns(port, 1);
    fwd.conns[0].ws.close(4406, 'Renewed access token refused (another sign-in, or not valid); reconnect');
    await c.closed;
    await until(() => err.length > 0);
    expect(err).toEqual([`devbox:3000 (localhost:${port}): a connection was closed: the orchestrator refused its renewed access token (from a different sign-in?); a new connection gets a fresh token (listeners stay up)`]);
  });

  it('tells a CLI the orchestrator no longer takes on v1 to update', async () => {
    const { ports: [port] } = await start(['3000:' + await freePort()]);
    fwd.queue.set(3000, [{ refuse: { status: 426, code: 'cli_outdated', error: 'This termag is too old for the forward: run `termag update`' } }]);
    await client(port).ended;
    await until(() => err.length > 0);
    expect(err).toEqual([`devbox:3000 (localhost:${port}): cli_outdated: this termag is too old for the forward: run \`termag update\``]);
  });

  it('renews the connections of a port add() bound, as it does the others', async () => {
    orch.accessTtlS = 600; // every ask mints
    expect(await run(['login'], ctx())).toBe(0);
    err = [];
    const { forward, ports: [a] } = await start(['3000:' + await freePort()], { renewEveryMs: 50 });
    const [b] = (await forward.add(parsePortSpecs([`4000:${await freePort()}`]))).map(l => l.local);
    await openConns(a, 1);
    await openConns(b, 1);
    expect(fwd.conns.map(c => c.port)).toEqual([3000, 4000]);
    await until(() => fwd.conns.every(c => c.tokens.length >= 2));
    expect(fwd.conns[1].tokens.slice(0, 2)).toEqual(fwd.conns[0].tokens.slice(0, 2));
    expect(fwd.conns.map(c => c.closeCode)).toEqual([null, null]);
    expect(err).toEqual([]);
  });

  it('sends no renewal to a port close() is releasing, and counts its close as no failure', async () => {
    orch.accessTtlS = 600;
    expect(await run(['login'], ctx())).toBe(0);
    err = [];
    // The renewer's ask is held open until the test lets it go.
    let gate: (() => void) | null = null;
    const s = session(ctx(), { host: undefined } as ParsedArgs);
    const bearer = bearerFor(ctx(), s);
    let dials = 0;
    const { forward, ports: [a, b] } = await start(['3000:' + await freePort(), '4000:' + await freePort()], {
      renewEveryMs: 50,
      token: async (o) => {
        if (++dials > 2) await new Promise<void>(resolve => { gate = resolve; });
        return bearer(o);
      },
    });
    await openConns(a, 1);
    await openConns(b, 1);
    await until(() => gate !== null);
    // The ask is in flight: port b begins its release, then the ask returns.
    const closing = forward.close(b);
    gate!();
    await closing;
    await until(() => fwd.conns[0].tokens.length >= 1);
    expect(fwd.conns[1].tokens).toEqual([]);
    expect(fwd.conns[1].closeCode).toBe(1000);
    expect(forward.totals().failed).toBe(0);
    expect(err).toEqual([]);
  });

  it('says so again for a renewal that fails after one went through', async () => {
    let fail = false;
    const s = session(ctx(), { host: undefined } as ParsedArgs);
    const bearer = bearerFor(ctx(), s);
    let asks = 0;
    const { ports: [port] } = await start(['3000:' + await freePort()], {
      renewEveryMs: 20,
      renewRetryMs: 20,
      token: (o) => { asks++; return fail ? Promise.reject(new Error('offline')) : bearer(o); },
    });
    await openConns(port, 1);
    const line = "can't renew the access token of open connections (offline); trying again, and each lasts until its token expires";
    fail = true;
    await until(() => err.length === 1);
    fail = false;
    const back = asks;
    await until(() => asks >= back + 2);
    fail = true;
    await until(() => err.length === 2);
    expect(err).toEqual([line, line]);
  });

  it('says once when a renewal fails, and keeps the connection', async () => {
    let fail = false;
    const s = session(ctx(), { host: undefined } as ParsedArgs);
    const bearer = bearerFor(ctx(), s);
    const { ports: [port] } = await start(['3000:' + await freePort()], {
      renewEveryMs: 20,
      token: (o) => (fail ? Promise.reject(new Error('offline')) : bearer(o)),
    });
    const [c] = await openConns(port, 1);
    fail = true;
    await until(() => err.length > 0);
    expect(err).toEqual(["can't renew the access token of open connections (offline); trying again, and each lasts until its token expires"]);
    c.socket.write('!');
    await until(() => c.text() === 'hi 0!');
  });
});

describe('stop (Ctrl-C)', () => {
  it('stops accepting, closes live connections with 1000, and counts both ways', async () => {
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    const c = client(port);
    c.socket.write('12345');
    await until(() => c.text() === '12345');
    const totals = await forward.stop();
    expect(await fwd.conns[0].closed).toBe(1000);
    expect(totals).toEqual({ connections: 1, failed: 0, bytesUp: 5, bytesDown: 5 });
    await c.ended;
    const refused = await new Promise<string>((resolve) => {
      const s: Socket = connect({ port, host: '127.0.0.1' });
      s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? ''));
      s.once('connect', () => { s.destroy(); resolve('connected'); });
    });
    expect(refused).toBe('ECONNREFUSED');
  });

  it('leaves no timer behind once the connections have closed', async () => {
    const { forward, ports: [port] } = await start(['3000:' + await freePort()]);
    await echoRoundTrip(port);
    const c = client(port);
    c.socket.write('x');
    await until(() => c.text() === 'x');
    const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    const before = timers();
    await forward.stop();
    // The bin sets exitCode and lets the event loop run dry: a leftover grace timer holds the exit up by 2.5 s.
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it('does not dial for a connection whose token arrives after it', async () => {
    let release!: (t: string) => void;
    const token = () => { tokenCalls++; return new Promise<string>(resolve => { release = resolve; }); };
    const { forward, ports: [port] } = await start(['3000:' + await freePort()], { token });
    const c = client(port);
    await until(() => tokenCalls === 1);
    await forward.stop();
    await c.ended;
    release('late');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fwd.dials).toEqual([]);
  });
});

describe('termag forward', () => {
  it('probes, listens, relays and prints the totals on Ctrl-C', async () => {
    const local = await freePort();
    let interrupt!: () => void;
    const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
    const running = run(['forward', 'devbox', `3000:${local}`], ctx({ untilInterrupted: () => interrupted }));
    await until(() => out.some(l => l.startsWith('Forwarding')));
    expect(out[0]).toBe(`Forwarding localhost:${local} to devbox:3000 (127.0.0.1:${local}${hasIpv6 ? `, [::1]:${local}` : ''})`);
    await echoRoundTrip(local);
    interrupt();
    expect(await running).toBe(0);
    expect(out.at(-1)).toBe('Forwarded 1 connection: 5 B to devbox, 5 B from it.');
    const probes = orch.requests.filter(r => r.path === '/api/cli/v1/boxes/i1/forward');
    expect(probes).toHaveLength(1);
  });

  it('says calmly that the orchestrator predates the forward, with the ssh command to use meanwhile', async () => {
    fwd.probe = { status: 404, body: { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' } };
    const local = await freePort();
    expect(await run(['forward', 'devbox', '3000', `5173:${local}`], ctx())).toBe(1);
    expect(err).toEqual([`termag: termag-native forwarding isn't available for devbox yet: the orchestrator at ${orch.host} doesn't offer it, or it isn't turned on for you. `
      + `Meanwhile, \`termag ssh devbox -N -L 3000:localhost:3000 -L ${local}:localhost:5173\` forwards the same ports over SSM`]);
  });

  it.each([
    [501, 'box_outdated', "devbox's agent predates port forwarding; it needs an update before it can forward. Meanwhile, `termag ssh devbox -N -L 3000:localhost:3000` forwards the same ports over SSM"],
    [409, 'box_parked', 'devbox is stopped or hibernated, and a forward never starts it; run `termag box start devbox` and try again'],
    [409, 'box_not_ready', "devbox isn't ready yet (its agent hasn't connected); try again in a minute"],
    [403, 'forbidden', "forwarding needs this device signed in with `termag login`; a box's own credentials can't forward"],
  ])('explains a %i %s from the probe', async (status, code, message) => {
    fwd.probe = { status, body: { error: 'server text', code } };
    expect(await run(['forward', 'devbox', '3000'], ctx())).toBe(1);
    expect(err).toEqual([`termag: ${message}`]);
  });

  it.each([
    ['At most 128 forwarded connections to one box'],
    ['This orchestrator is carrying as many forwarded connections as it takes; try again shortly'],
  ])('passes on which limit a 429 too_many_tunnels hit: %s', async (error) => {
    fwd.probe = { status: 429, body: { error, code: 'too_many_tunnels' } };
    expect(await run(['forward', 'devbox', '3000'], ctx())).toBe(1);
    expect(err).toEqual([`termag: the orchestrator refused another connection to devbox: ${error}`]);
  });

  it('asks again once while the orchestrator drains', async () => {
    let n = 0;
    orch.override.set('/api/cli/v1/boxes/i1/forward', (res) => {
      n++;
      if (n === 1) res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'draining', code: 'draining' }));
      else res.writeHead(501, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'old', code: 'box_outdated' }));
    });
    expect(await run(['forward', 'devbox', '3000'], ctx())).toBe(1);
    expect(n).toBe(2);
  });

  it('needs a box and a port, and a box it knows', async () => {
    expect(await run(['forward', 'devbox'], ctx())).toBe(2);
    expect(await run(['forward', 'nope', '3000'], ctx())).toBe(3);
    expect(err.at(-1)).toMatch(/No box named "nope"/);
  });
});
