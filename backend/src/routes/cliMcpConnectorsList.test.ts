import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// What the mcp-upstream-allowlist flag serves, or NOT_LOADED when the orchestrator never loaded it.
const NOT_LOADED = Symbol('not loaded');
let allowlistFlag: unknown = ['https://linear.example'];
vi.mock('../services/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/featureFlags')>()),
  isLdEnabled: () => true,
  jsonVariationOrUnknown: async (key: string, _user: unknown, fallback: unknown) => (
    key !== 'mcp-upstream-allowlist' ? { value: fallback } : allowlistFlag === NOT_LOADED ? null : { value: allowlistFlag }),
}));

const { prismaCliMcpConnectors } = await import('./cliMcpConnectors');

const USER = { id: 'u1', googleEmail: 'pat@example.com', unixUsername: 'pat', displayName: 'Pat' };

describe('prismaCliMcpConnectors', () => {
  beforeEach(() => { allowlistFlag = ['https://linear.example']; });

  it('lists MCP servers and leaves out API connectors', async () => {
    const list = await prismaCliMcpConnectors.list(USER);
    expect(list?.connectors.map(c => c.name)).toEqual(['linear']);
  });

  it('reports a linked connector on the allowlist as ready, with no reason', async () => {
    expect((await prismaCliMcpConnectors.list(USER)).connectors[0]).toMatchObject({ status: 'ready', blocked: null });
  });

  it('reports a linked connector off the allowlist as blocked, with why', async () => {
    allowlistFlag = ['https://other.example'];
    expect((await prismaCliMcpConnectors.list(USER)).connectors[0]).toMatchObject({ status: 'blocked', blocked: "This MCP server isn't on termag's allowlist" });
  });

  it('reports every connector blocked when termag never loaded its allowlist', async () => {
    allowlistFlag = NOT_LOADED;
    expect((await prismaCliMcpConnectors.list(USER)).connectors[0]).toMatchObject({ status: 'blocked', blocked: "termag couldn't load its MCP server allowlist" });
  });
});
