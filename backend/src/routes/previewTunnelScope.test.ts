// A preview link's dial-back is authenticated as t3's and a forward's are
// (routes/cliT3.ts handleAgentTunnelUpgrade, the `agentTunnel` row of
// services/agentTokenScopes.ts): the box's own agent token, never the preview
// fleet's `preview-agent` one, which serves no preview link.
import { describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { default: WebSocket, WebSocketServer } = await import('ws');
const { handleAgentTunnelUpgrade } = await import('./cliT3');
const { AgentTunnels } = await import('../services/agentTunnels');
const { TOKEN_SITES } = await import('../services/agentTokenScopes');

describe('the preview dial-back and token scopes', () => {
  it('is the agentTunnel row, one for t3, port and preview: agent only', () => {
    expect(TOKEN_SITES.agentTunnel).toEqual(['agent']);
  });

  it('accepts a preview dial-back with the box\'s agent token, and refuses a preview-agent one', async () => {
    const sent: string[] = [];
    const tunnels = new AgentTunnels({ send: async (_b, _t, p) => { sent.push(p.tunnelId as string); return { ok: true, port: 5173 }; } });
    const tokens: Record<string, { token: { scope: string }; instance: { id: string } | null }> = {
      tmag_agent: { token: { scope: 'agent' }, instance: { id: 'box-1' } },
      tmag_fleet: { token: { scope: 'preview-agent' }, instance: { id: 'box-1' } },
    };
    const wss = new WebSocketServer({ noServer: true });
    const srv = http.createServer();
    srv.on('upgrade', (req, socket, head) => {
      void handleAgentTunnelUpgrade(req, socket, head, { tunnels, validateAgentToken: async (raw) => tokens[raw] ?? null, wss });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const at = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/termag/ws/agent-tunnel`;
    const dial = (id: string, token: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(`${at}?id=${id}`, { headers: { authorization: `Bearer ${token}` } });
      ws.once('open', () => resolve(101));
      ws.once('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
    });
    try {
      const opening = tunnels.openPreview('box-1', 'alice', 5173, null);
      await new Promise(r => setTimeout(r, 10));
      expect(await dial(sent[0], 'tmag_fleet')).toBe(403);
      expect(await dial(sent[0], 'tmag_agent')).toBe(101);
      const t = await opening;
      expect(t.port).toBe(5173);
      t.stream.destroy();
    } finally {
      srv.closeAllConnections();
      await new Promise<void>(r => srv.close(() => r()));
    }
  });
});
