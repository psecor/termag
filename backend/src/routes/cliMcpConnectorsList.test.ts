import { describe, expect, it, vi } from 'vitest';

// The desktop's MCP list (prismaCliMcpConnectors) holds MCP servers only: a
// connector of kind "api" (Google) is for the API broker, and its /c/<id> is refused.
vi.mock('../db', () => ({ prisma: { user: { findUnique: async () => ({ id: 'u1', googleEmail: 'pat@example.com', unixUsername: 'pat' }) } } }));
const row = (id: string, name: string, oauthMetadata: unknown) => ({
  id, userId: 'u1', name, upstream: `https://${name}.example`, authType: 'oauth', headerTemplates: null, oauthMetadata,
  linkStatus: 'linked', linkError: null, oauthScopes: null, createdAt: new Date(), updatedAt: new Date(),
});
vi.mock('../services/mcpConnectorStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpConnectorStore')>()),
  pasteLinkAllowed: async () => false,
  listConnectors: async () => [row('c1', 'linear', { issuer: 'https://linear.example', scopes: [] }), row('cg', 'google', { api: 'google', issuer: 'https://accounts.google.com', scopes: [] })],
}));

const { prismaCliMcpConnectors } = await import('./cliMcpConnectors');

describe('prismaCliMcpConnectors', () => {
  it('lists MCP servers and leaves out API connectors', async () => {
    const list = await prismaCliMcpConnectors.list({ id: 'u1', googleEmail: 'pat@example.com', unixUsername: 'pat', displayName: 'Pat' });
    expect(list?.connectors.map(c => c.name)).toEqual(['linear']);
  });
});
