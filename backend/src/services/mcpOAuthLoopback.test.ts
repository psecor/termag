import { describe, expect, it } from 'vitest';
import { LOOPBACK_REDIRECT_URI, loopbackAllowed, normaliseServerUrl, parsePastedRedirect } from './mcpOAuthLoopback';

describe('normaliseServerUrl', () => {
  it('keeps scheme, host and path, lowercases scheme and host, and drops a trailing slash, query, fragment and default port', () => {
    expect(normaliseServerUrl('HTTPS://MCP.NewRelic.com:443/mcp/?x=1#y')).toBe('https://mcp.newrelic.com/mcp');
    expect(normaliseServerUrl('https://mcp.datadoghq.com/v1/mcp')).toBe('https://mcp.datadoghq.com/v1/mcp');
    expect(normaliseServerUrl('https://mcp.example.test:8443/')).toBe('https://mcp.example.test:8443');
  });

  it('keeps the path\'s case, since servers treat paths as case-sensitive', () => {
    expect(normaliseServerUrl('https://acme-be.glean.com/mcp/Default')).toBe('https://acme-be.glean.com/mcp/Default');
  });

  it('answers null for anything that is not an http(s) URL', () => {
    for (const v of ['', 'mcp.newrelic.com/mcp', 'ftp://x/y', 42, null, undefined, {}]) expect(normaliseServerUrl(v)).toBeNull();
  });
});

describe('loopbackAllowed (the mcp-oauth-loopback-servers flag)', () => {
  const upstream = 'https://mcp.newrelic.com/mcp';

  it('allows a server the list names, after normalising both sides', () => {
    expect(loopbackAllowed(['https://mcp.newrelic.com/mcp'], upstream)).toBe(true);
    expect(loopbackAllowed(['https://MCP.newrelic.com/mcp/'], upstream)).toBe(true);
    expect(loopbackAllowed(['https://mcp.datadoghq.com/v1/mcp', 'https://mcp.newrelic.com/mcp'], 'https://mcp.newrelic.com/mcp/')).toBe(true);
  });

  it('allows nobody when the flag serves null (its fallback), [] or something that is not a list', () => {
    for (const v of [null, undefined, [], 'https://mcp.newrelic.com/mcp', { url: upstream }, true]) expect(loopbackAllowed(v, upstream)).toBe(false);
  });

  it('allows only exact matches: another path, host or scheme is not on the list', () => {
    expect(loopbackAllowed(['https://mcp.newrelic.com/mcp'], 'https://mcp.newrelic.com/mcp/v2')).toBe(false);
    expect(loopbackAllowed(['https://mcp.newrelic.com'], upstream)).toBe(false);
    expect(loopbackAllowed(['https://evil.example/mcp'], upstream)).toBe(false);
    expect(loopbackAllowed(['http://mcp.newrelic.com/mcp'], upstream)).toBe(false);
  });

  it('skips entries that are not URL strings', () => {
    expect(loopbackAllowed([42, null, 'not a url', upstream], upstream)).toBe(true);
  });
});

describe('parsePastedRedirect', () => {
  const STATE = `${'n'.repeat(32)}.${'m'.repeat(43)}`;
  const at = (q: string) => `${LOOPBACK_REDIRECT_URI}?${q}`;

  it('reads code, state and iss from the localhost address, trimming whitespace', () => {
    expect(parsePastedRedirect(`  ${at(`code=abc&state=${STATE}&iss=https%3A%2F%2Fauth.example`)}\n`)).toEqual({
      ok: true, query: { code: 'abc', state: STATE, iss: 'https://auth.example' },
    });
  });

  it('accepts 127.0.0.1 and an address pasted without its http://', () => {
    expect(parsePastedRedirect(`http://127.0.0.1:53682/callback?code=abc&state=${STATE}`)).toMatchObject({ ok: true });
    expect(parsePastedRedirect(`localhost:53682/callback?code=abc&state=${STATE}`)).toMatchObject({ ok: true, query: { code: 'abc' } });
  });

  it('passes a provider error through, with its description, and no code', () => {
    expect(parsePastedRedirect(at(`error=access_denied&error_description=User+said+no&state=${STATE}`))).toEqual({
      ok: true, query: { error: 'access_denied', error_description: 'User said no', state: STATE },
    });
  });

  it('refuses an empty paste, another address, and one without state or code, never echoing what was pasted', () => {
    const bad = ['', '   ', 42, at('code=abc'), at(`state=${STATE}`), `https://localhost:53682/callback?code=abc&state=${STATE}`,
      `http://localhost:5368/callback?code=abc&state=${STATE}`, `http://localhost:53682/other?code=abc&state=${STATE}`,
      `http://evil.example:53682/callback?code=secretcode&state=${STATE}`, 'x'.repeat(9000)];
    for (const v of bad) {
      const out = parsePastedRedirect(v);
      expect(out.ok, String(v).slice(0, 80)).toBe(false);
      if (!out.ok) {
        expect(out.error).not.toContain('secretcode');
        expect(out.error).not.toContain(STATE);
      }
    }
  });
});
