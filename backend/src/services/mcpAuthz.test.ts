import { describe, expect, it } from 'vitest';
import type { AuthzBox } from './gatewayAuthz';
import { decideMcpRequest, type McpAuthzDeps, type McpConnectorRecord } from './mcpAuthz';
import { McpNeedsLinkError } from './mcpOAuth';

const BOX: AuthzBox = { userId: 'u1', instanceId: 'i1', managed: true };
const FIGMA: McpConnectorRecord = {
  id: 'c1', userId: 'u1', name: 'figma', upstream: 'https://mcp.figma.example/mcp', authType: 'static',
  headerTemplates: { authorization: 'Bearer {{secret.token}}', 'x-team': 'team-1' },
};
const OTHER: McpConnectorRecord = { ...FIGMA, id: 'c2', userId: 'u2' };

function deps(over: Partial<McpAuthzDeps> = {}): McpAuthzDeps {
  return {
    boxForToken: async (t) => (t === 'tmag_good' ? BOX : null),
    flagOn: async () => true,
    connector: async (id) => [FIGMA, OTHER].find(c => c.id === id) ?? null,
    secrets: async () => ({ token: 'up-secret' }),
    accessToken: async () => { throw new McpNeedsLinkError('not linked'); },
    termagUrl: 'https://termag.example/termag',
    allow: new Set(),
    ...over,
  };
}

const AUTH = 'Bearer tmag_good';

describe('decideMcpRequest', () => {
  it("allows the owner's connector with the upstream target and its rendered headers", async () => {
    const d = await decideMcpRequest({ path: '/c/c1/mcp/x', authorization: AUTH }, deps());
    expect(d).toEqual({
      allow: true,
      audit: 'user=u1 instance=i1 connector=c1 /c/c1/mcp/x allowed',
      headers: {
        'x-termag-user': 'u1',
        'x-termag-instance': 'i1',
        'x-termag-mcp-connector': 'c1',
        'x-termag-mcp-relink': 'MCP server "figma" is not linked. Link it at https://termag.example/termag/settings/mcp?server=c1',
        'x-termag-mcp-upstream': 'https://mcp.figma.example:443/mcp',
        'x-termag-mcp-h-authorization': 'Bearer up-secret',
        'x-termag-mcp-h-x-team': 'team-1',
      },
    });
  });

  it('matches the connector at the path root and before a query', async () => {
    for (const path of ['/c/c1', '/c/c1/', '/c/c1?x=1']) {
      expect((await decideMcpRequest({ path, authorization: AUTH }, deps())).allow).toBe(true);
    }
  });

  it('refuses without a token, or with an unknown one, with 403 so Claude Code does not start OAuth', async () => {
    expect(await decideMcpRequest({ path: '/c/c1', authorization: undefined }, deps())).toMatchObject({ allow: false, status: 403, audit: 'no box token' });
    expect(await decideMcpRequest({ path: '/c/c1', authorization: 'Bearer nope' }, deps())).toMatchObject({ allow: false, status: 403, audit: 'unknown box token' });
  });

  it('refuses a box that is not managed', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({ boxForToken: async () => ({ ...BOX, managed: false }) }));
    expect(d).toMatchObject({ allow: false, status: 403 });
  });

  it('refuses while the flag is off, before looking at the connector', async () => {
    let looked = false;
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({
      flagOn: async () => false,
      connector: async () => { looked = true; return FIGMA; },
    }));
    expect(d).toMatchObject({ allow: false, status: 403, audit: 'user=u1 instance=i1 flag off' });
    expect(looked).toBe(false);
  });

  it("answers 404 for another user's connector exactly as for one that does not exist", async () => {
    const other = await decideMcpRequest({ path: '/c/c2/mcp', authorization: AUTH }, deps());
    const none = await decideMcpRequest({ path: '/c/zzz/mcp', authorization: AUTH }, deps());
    expect(other).toMatchObject({ allow: false, status: 404 });
    expect(none).toMatchObject({ allow: false, status: 404 });
    expect(other.allow === false && other.message).toBe(none.allow === false && none.message);
  });

  it('answers 404 for a path outside /c/<id>', async () => {
    for (const path of ['/', '/c/', '/mcp', '/c/C1', '/x/c/c1']) {
      expect(await decideMcpRequest({ path, authorization: AUTH }, deps())).toMatchObject({ allow: false, status: 404 });
    }
  });

  it('refuses with the Settings message when a secret is missing, never with an empty header', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({ secrets: async () => ({}) }));
    expect(d).toMatchObject({ allow: false, status: 403 });
    expect(d.allow === false && d.message).toContain('secret "token" is not set');
  });

  it('refuses an oauth connector with the link message until it is linked', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({ connector: async () => ({ ...FIGMA, authType: 'oauth' }) }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringContaining('is not linked') });
  });

  it('sends a linked oauth connector upstream with its access token and nothing from the templates', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({
      connector: async () => ({ ...FIGMA, authType: 'oauth' }),
      accessToken: async () => 'at-123',
    }));
    expect(d.allow).toBe(true);
    if (!d.allow) return;
    expect(d.headers['x-termag-mcp-h-authorization']).toBe('Bearer at-123');
    expect(d.headers['x-termag-mcp-h-x-team']).toBeUndefined();
    expect(d.audit).not.toContain('at-123');
  });

  it('refuses an oauth connector whose token could not be had, without the token error reaching the box', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({
      connector: async () => ({ ...FIGMA, authType: 'oauth' }),
      accessToken: async () => { throw new Error('ECONNRESET at idp'); },
    }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringContaining('could not get a token') });
    expect(d.allow === false && d.message).not.toContain('ECONNRESET');
  });

  it('refuses a stored upstream that no longer passes the rules', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({ connector: async () => ({ ...FIGMA, upstream: 'https://10.0.0.1/mcp' }) }));
    expect(d).toMatchObject({ allow: false, status: 403 });
  });

  it('gives an oauth connector with a now-invalid upstream the link message, not the upstream one', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH },
      deps({ connector: async () => ({ ...FIGMA, authType: 'oauth', upstream: 'https://10.0.0.1/mcp' }) }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringContaining('is not linked') });
  });

  it('re-checks stored header templates, so a row written under looser rules cannot set a reserved header', async () => {
    for (const headerTemplates of [{ host: 'evil.example' }, { 'x-termag-user': 'u2' }, { authorization: 'a\r\nx: y' }, {}, null]) {
      const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({ connector: async () => ({ ...FIGMA, headerTemplates }) }));
      expect(d, JSON.stringify(headerTemplates)).toMatchObject({ allow: false, status: 403 });
    }
  });

  it('refuses headers too long for Envoy with the Settings message', async () => {
    const d = await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps({ secrets: async () => ({ token: 'x'.repeat(9000) }) }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringContaining('longer than 8192') });
  });

  it('never puts a secret in an audit line', async () => {
    const all = [
      await decideMcpRequest({ path: '/c/c1', authorization: AUTH }, deps()),
      await decideMcpRequest({ path: '/c/c1', authorization: 'Bearer tmag_good' }, deps({ secrets: async () => ({ other: 'x' }) })),
    ];
    for (const d of all) expect(d.audit).not.toMatch(/up-secret|tmag_good/);
  });
});
