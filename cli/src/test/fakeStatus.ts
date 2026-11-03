import { WebSocketServer, type WebSocket } from 'ws';
import type { FakeOrchestrator } from './fakeOrchestrator.js';

/**
 * The CLI's status socket on the fake orchestrator (backend routes/cliWs.ts
 * and index.ts): the same bearer check as its HTTP routes, the current
 * statuses replayed on connect, then whatever a test pushes.
 */
export interface FakeStatus {
  /** Sent to each new connection, as the server replays every current status. */
  replay: unknown[];
  conns: WebSocket[];
  push: (frame: unknown) => void;
}

export function installFakeStatus(orch: FakeOrchestrator): FakeStatus {
  const fake: FakeStatus = {
    replay: [],
    conns: [],
    push: (frame) => { for (const ws of fake.conns) ws.send(JSON.stringify(frame)); },
  };
  const wss = new WebSocketServer({ noServer: true });
  orch.upgrade = (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/termag/api/cli/v1/ws/status') { socket.destroy(); return; }
    const raw = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const device = orch.tokens.get(orch.accessTokens.get(raw) ?? '');
    if (!(device && !device.revoked) && !orch.boxTokens.has(raw)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.conns.push(ws);
      ws.on('close', () => { fake.conns = fake.conns.filter(c => c !== ws); });
      for (const frame of fake.replay) ws.send(JSON.stringify(frame));
    });
  };
  return fake;
}
