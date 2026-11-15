import { describe, expect, it } from 'vitest';
import { KNOWN_MCP_SERVERS, mcpUseDetail, parseMcpUseBody } from './mcpUseEvent';

const use = (server: string) => ({ session: 's', server, tool: 'search-logs', outcome: 'ok' as const, claudeSession: null });

describe('parseMcpUseBody', () => {
  it('takes the names, the outcome and a Claude session id, and drops a malformed session id', () => {
    expect(parseMcpUseBody({ session: 'a-b-agent', server: 'metaterm', tool: 'list_sessions', outcome: 'error', claudeSession: 'not ok!' }))
      .toEqual({ session: 'a-b-agent', server: 'metaterm', tool: 'list_sessions', outcome: 'error', claudeSession: null });
  });

  it('refuses anything that is not a name, or an unknown outcome', () => {
    for (const body of [null, [], { server: 'x', tool: 'y', outcome: 'ok' }, { session: 's', server: 'a/b', tool: 'y', outcome: 'ok' },
      { session: 's', server: 'x', tool: 'y z', outcome: 'ok' }, { session: 's', server: 'x', tool: 'y', outcome: 'fine' },
      { session: 's', server: 'x'.repeat(65), tool: 'y', outcome: 'ok' }]) {
      expect(parseMcpUseBody(body)).toHaveProperty('error');
    }
  });
});

describe('mcpUseDetail', () => {
  it('names termag\'s own servers and the catalog\'s, with the tool', () => {
    for (const s of KNOWN_MCP_SERVERS) expect(mcpUseDetail(use(s), [])).toMatchObject({ server: s, tool: 'search-logs' });
    expect(mcpUseDetail(use('acme'), ['acme'])).toEqual({ server: 'acme', tool: 'search-logs', outcome: 'ok', claudeSession: null });
  });

  it('records any other server as other, with no tool', () => {
    expect(mcpUseDetail(use('acme'), ['other-catalog-entry'])).toEqual({ server: 'other', outcome: 'ok', claudeSession: null });
  });
});
