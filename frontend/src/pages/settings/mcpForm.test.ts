import { describe, expect, it } from 'vitest';
import { connectorStatus, formatHeaderLines, linkResult, parseHeaderLines, referencedSecretNames, serverParam, suggestName } from './mcpForm';

describe('parseHeaderLines', () => {
  it('reads Name: value lines, lowercasing names and keeping colons in values', () => {
    expect(parseHeaderLines('Authorization: Bearer {{secret.token}}\n\nX-Url: https://a:b\n')).toEqual({
      headers: { authorization: 'Bearer {{secret.token}}', 'x-url': 'https://a:b' }, error: null,
    });
  });

  it('says which line is not a header', () => {
    expect(parseHeaderLines('Authorization Bearer x').error).toBe('"Authorization Bearer x" is not "Header-Name: value"');
  });

  it('round-trips through formatHeaderLines', () => {
    const headers = { authorization: 'Bearer {{secret.token}}', 'x-team': 't' };
    expect(parseHeaderLines(formatHeaderLines(headers)).headers).toEqual(headers);
  });
});

describe('referencedSecretNames', () => {
  it('lists each secret once, in first-use order', () => {
    expect(referencedSecretNames({ a: '{{secret.b}} {{ secret.a }}', c: '{{secret.b}}' })).toEqual(['b', 'a']);
  });
});

describe('serverParam', () => {
  it('reads a connector id or an https URL', () => {
    expect(serverParam('?server=c1abc')).toEqual({ connectorId: 'c1abc', upstream: null });
    expect(serverParam('?server=https%3A%2F%2Fmcp.example.com%2Fmcp')).toEqual({ connectorId: null, upstream: 'https://mcp.example.com/mcp' });
    expect(serverParam('?server=javascript:alert(1)')).toEqual({ connectorId: null, upstream: null });
    expect(serverParam('')).toEqual({ connectorId: null, upstream: null });
  });
});

describe('suggestName', () => {
  it('names a connector after the host', () => {
    expect(suggestName('https://mcp.figma.com/mcp')).toBe('figma');
    expect(suggestName('https://mcp.atlassian.com/v1/sse')).toBe('atlassian');
    expect(suggestName('https://linear.app/mcp')).toBe('linear');
    expect(suggestName('nope')).toBe('');
  });
});

describe('linkResult', () => {
  it('reads the OAuth callback outcome', () => {
    expect(linkResult('?server=c1&linked=1')).toEqual({ linked: true, error: null });
    expect(linkResult('?server=c1&error=Linking%20failed')).toEqual({ linked: false, error: 'Linking failed' });
    expect(linkResult('?linked=1&error=x')).toEqual({ linked: false, error: 'x' });
    expect(linkResult('?server=c1')).toEqual({ linked: false, error: null });
  });
});

describe('connectorStatus', () => {
  it('is ready when every referenced secret is stored', () => {
    expect(connectorStatus({ authType: 'static', missingSecrets: [], secretNames: ['token'] })).toEqual({ label: 'ready', tone: 'good' });
  });

  it('names the missing secrets', () => {
    expect(connectorStatus({ authType: 'static', missingSecrets: ['token', 'team'], secretNames: [] }))
      .toEqual({ label: 'missing secret.token, secret.team', tone: 'warn' });
  });

  it('says when the stored secrets could not be read', () => {
    expect(connectorStatus({ authType: 'static', missingSecrets: [], secretNames: null })).toEqual({ label: 'secrets unreadable', tone: 'bad' });
  });

  it('is linked or not linked for an OAuth server, whatever its secrets say', () => {
    expect(connectorStatus({ authType: 'oauth', missingSecrets: [], secretNames: null, linkStatus: 'linked' })).toEqual({ label: 'linked', tone: 'good' });
    expect(connectorStatus({ authType: 'oauth', missingSecrets: [], secretNames: [], linkStatus: 'needs_link' })).toEqual({ label: 'not linked', tone: 'warn' });
  });
});
