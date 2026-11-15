import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWLIST_NOT_LOADED, NOT_ON_ALLOWLIST, parseAllowlistUrl, parseUpstreamAllowlist, UNLOADED_ALLOWLIST, upstreamAllowed, upstreamRefusal,
} from './mcpUpstreamAllowlist';

const list = (...entries: unknown[]) => parseUpstreamAllowlist(entries);

describe('parseUpstreamAllowlist', () => {
  it('allows nothing for a served value that is not an array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const v of [null, 'https://api.example.com', { a: 1 }, 3]) {
      expect(parseUpstreamAllowlist(v)).toEqual({ loaded: true, entries: [] });
    }
    warn.mockRestore();
  });

  it('ignores entries that do not parse, with one log line each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = list('https://ok.example.com/mcp', 'http://plain.example.com', 'not a url', 7, 'https://u:p@creds.example.com', 'https://q.example.com/?x=1');
    expect(parsed).toEqual({ loaded: true, entries: [{ host: 'ok.example.com', port: '443', path: '/mcp' }] });
    expect(warn).toHaveBeenCalledTimes(5);
    list('not a url');
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });

  it('lowercases the host, defaults the port and drops trailing slashes', () => {
    expect(parseAllowlistUrl('https://API.Example.com:8443/mcp//')).toEqual({ host: 'api.example.com', port: '8443', path: '/mcp' });
    expect(parseAllowlistUrl('https://api.example.com/')).toEqual({ host: 'api.example.com', port: '443', path: '' });
    expect(parseAllowlistUrl('https://api.example.com:443')).toEqual({ host: 'api.example.com', port: '443', path: '' });
  });
});

describe('upstreamAllowed', () => {
  it('allows nothing under an empty list or one never loaded', () => {
    expect(upstreamAllowed(list(), 'https://any.example.com/mcp')).toBe(false);
    expect(upstreamAllowed(UNLOADED_ALLOWLIST, 'https://any.example.com/mcp')).toBe(false);
  });

  it('allows any path under a host-only entry', () => {
    const l = list('https://api.example.com');
    expect(upstreamAllowed(l, 'https://api.example.com')).toBe(true);
    expect(upstreamAllowed(l, 'https://api.example.com/mcp/v2')).toBe(true);
    expect(upstreamAllowed(l, 'https://API.EXAMPLE.COM/mcp')).toBe(true);
  });

  it('matches a path entry on a / boundary, trailing slashes ignored on both sides', () => {
    for (const entry of ['https://api.example.com/mcp', 'https://api.example.com/mcp/']) {
      const l = list(entry);
      expect(upstreamAllowed(l, 'https://api.example.com/mcp')).toBe(true);
      expect(upstreamAllowed(l, 'https://api.example.com/mcp/')).toBe(true);
      expect(upstreamAllowed(l, 'https://api.example.com/mcp/sse')).toBe(true);
      expect(upstreamAllowed(l, 'https://api.example.com/mcpx')).toBe(false);
      expect(upstreamAllowed(l, 'https://api.example.com/')).toBe(false);
      expect(upstreamAllowed(l, 'https://api.example.com/other/mcp')).toBe(false);
    }
  });

  it('needs the same host and port, with no wildcards or suffix matching', () => {
    const l = list('https://api.example.com/mcp');
    expect(upstreamAllowed(l, 'https://api.example.com:443/mcp')).toBe(true);
    expect(upstreamAllowed(l, 'https://api.example.com:8443/mcp')).toBe(false);
    expect(upstreamAllowed(l, 'https://evil.api.example.com/mcp')).toBe(false);
    expect(upstreamAllowed(l, 'https://api.example.com.evil.example/mcp')).toBe(false);
    expect(upstreamAllowed(list('https://*.example.com'), 'https://api.example.com/mcp')).toBe(false);
  });

  it('refuses a connector URL that is not https', () => {
    expect(upstreamAllowed(list('https://api.example.com'), 'http://api.example.com/mcp')).toBe(false);
    expect(upstreamAllowed(list('https://api.example.com'), 'garbage')).toBe(false);
  });

  it('keeps the path case-sensitive', () => {
    expect(upstreamAllowed(list('https://api.example.com/MCP'), 'https://api.example.com/mcp')).toBe(false);
  });
});

describe('upstreamRefusal', () => {
  it('is null for an allowed URL, says it is not on the list otherwise, and says the list was not loaded when it was not', () => {
    const l = list('https://api.example.com');
    expect(upstreamRefusal(l, 'https://api.example.com/mcp')).toBeNull();
    expect(upstreamRefusal(l, 'https://other.example.com/mcp')).toBe(NOT_ON_ALLOWLIST);
    expect(upstreamRefusal(list(), 'https://api.example.com/mcp')).toBe(NOT_ON_ALLOWLIST);
    expect(upstreamRefusal(UNLOADED_ALLOWLIST, 'https://api.example.com/mcp')).toBe(ALLOWLIST_NOT_LOADED);
  });
});
