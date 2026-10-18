import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { holdFramesUntilReady } from './socketHandoff';

const SETUP_MS = 20;
const DELIVERY_TIMEOUT_MS = 300;

const servers: WebSocketServer[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startServer(onConnection: (ws: WebSocket) => void): Promise<number> {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on('connection', onConnection);
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  return (wss.address() as AddressInfo).port;
}

function connect(port: number, onOpen: (client: WebSocket) => void): WebSocket {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  clients.push(client);
  client.on('open', () => onOpen(client));
  return client;
}

describe('holdFramesUntilReady', () => {
  it('delivers a frame that arrives while setup is still running', async () => {
    const received: string[] = [];
    let sawFrame: () => void = () => {};
    const frameSeen = new Promise<void>(resolve => { sawFrame = resolve; });

    const port = await startServer(ws => {
      void holdFramesUntilReady(ws, async () => {
        await delay(SETUP_MS);
        ws.on('message', raw => {
          received.push(raw.toString());
          sawFrame();
        });
      });
    });

    connect(port, client => client.send('hello-from-client'));
    await Promise.race([frameSeen, delay(DELIVERY_TIMEOUT_MS)]);

    expect(received).toEqual(['hello-from-client']);
  });

  it('loses the same frame when setup runs without holdFramesUntilReady', async () => {
    const received: string[] = [];

    const port = await startServer(async ws => {
      await delay(SETUP_MS);
      ws.on('message', raw => received.push(raw.toString()));
    });

    connect(port, client => client.send('hello-from-client'));
    await delay(DELIVERY_TIMEOUT_MS);

    expect(received).toEqual([]);
  });

  it('leaves the socket readable when setup rejects', async () => {
    const received: string[] = [];
    let sawBothFrames: () => void = () => {};
    const bothSeen = new Promise<void>(resolve => { sawBothFrames = resolve; });

    const port = await startServer(ws => {
      holdFramesUntilReady(ws, async () => {
        await delay(SETUP_MS);
        throw new Error('setup failed');
      }).catch(() => {
        ws.on('message', raw => {
          received.push(raw.toString());
          if (received.length === 2) sawBothFrames();
        });
        ws.send('listener-attached');
      });
    });

    connect(port, client => {
      client.send('sent-during-setup');
      client.on('message', raw => {
        if (raw.toString() === 'listener-attached') client.send('sent-after-rejection');
      });
    });

    await Promise.race([bothSeen, delay(DELIVERY_TIMEOUT_MS)]);

    expect(received).toEqual(['sent-during-setup', 'sent-after-rejection']);
  });
});
