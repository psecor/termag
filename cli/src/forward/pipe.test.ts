import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { FIRST_FRAME, FRAME_RAMP_IDLE_MS, MAX_FRAME, pipe } from './pipe.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

/** A pipe from a local TCP connection to a WebSocket, and the frame sizes its server end receives. */
async function piped(now: () => number): Promise<{ local: Socket; frames: number[]; received: () => number }> {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
  await once(wss, 'listening');
  const frames: number[] = [];
  wss.on('connection', (s) => s.on('message', (d: Buffer, isBinary) => { if (isBinary) frames.push(d.length); }));
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, { perMessageDeflate: false });
  await once(ws, 'open');
  ws.pause();
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const local = connect((server.address() as AddressInfo).port, '127.0.0.1');
  const [sock] = (await once(server, 'connection')) as [Socket];
  pipe(sock, ws, { now });
  cleanups.push(() => { ws.terminate(); local.destroy(); sock.destroy(); server.close(); wss.close(); });
  return { local, frames, received: () => frames.reduce((a, b) => a + b, 0) };
}

async function until(ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('pipe framing', () => {
  it("starts a burst's frames small and doubles them up to 64 KiB, and starts again after a pause", async () => {
    let clock = 1_000_000;
    const p = await piped(() => clock);
    const KiB = 1024;
    expect([FIRST_FRAME, MAX_FRAME]).toEqual([4 * KiB, 64 * KiB]);
    // One write the size of a big first read: the sizes below assume it arrives as one chunk.
    p.local.write(Buffer.alloc(60 * KiB, 1));
    await until(() => p.received() === 60 * KiB);
    expect(p.frames.slice(0, 2)).toEqual([4 * KiB, 8 * KiB]);
    expect(Math.max(...p.frames)).toBeLessThanOrEqual(MAX_FRAME);
    const ramped = p.frames.length;
    clock += FRAME_RAMP_IDLE_MS;
    p.local.write(Buffer.alloc(8 * KiB, 2));
    await until(() => p.received() === 68 * KiB);
    expect(p.frames.slice(ramped)).toEqual([4 * KiB, 4 * KiB]);
  });
});
