import { describe, expect, it, vi } from 'vitest';
import {
  applySecretsPatch, assertPatchFitsAuth, defaultConnectors, getMcpBrokerUrl, isPublicAddress, mcpCredentialProvider, McpConnectorError, parseUpstream,
  CONNECTOR_NAME, connectorNaming, connectorSlug, referencedSecrets, relinkMessage, renderHeaders, upstreamTestAllow, validateConnectorName,
  validateHeaderTemplates, validateSecretsPatch, validateUpstream,
} from './mcpConnectors';

const resolveTo = (...addresses: string[]) => async () => addresses;

describe('validateConnectorName', () => {
  it('takes a lowercase name that works as an mcpServers key and a tool prefix', () => {
    expect(validateConnectorName('figma')).toBe('figma');
    expect(validateConnectorName('a-1')).toBe('a-1');
  });

  it.each(['', 'Figma', '1abc', 'a_b', 'a b', 'a'.repeat(42), 'x.y', null])('refuses %j', (name) => {
    expect(() => validateConnectorName(name)).toThrow(McpConnectorError);
  });
});

describe('connectorSlug', () => {
  // Claude Code's rule first (anything but a letter, digit, _ or - becomes _),
  // then what CONNECTOR_NAME, and so every box's termag-credentials, accepts.
  it.each([
    ['Claude Docs', 'claude-docs'],
    ['figma', 'figma'],
    ['GitHub', 'github'],
    ['my_server', 'my-server'],
    ['  Acme  /  Billing (prod)  ', 'acme-billing-prod'],
    ['Café Menu', 'caf-menu'],
    ['1Password', 'mcp-1password'],
    ['--x--', 'x'],
    ['a'.repeat(60), 'a'.repeat(41)],
    [`${'a'.repeat(40)} b`, 'a'.repeat(40)],
  ])('%j -> %j', (display, slug) => {
    expect(connectorSlug(display)).toBe(slug);
    expect(slug).toMatch(CONNECTOR_NAME);
  });

  it('is null when nothing usable is left', () => {
    expect(connectorSlug('日本語')).toBeNull();
    expect(connectorSlug('  ')).toBeNull();
    expect(connectorSlug('!!!')).toBeNull();
  });

  it('leaves every valid connector name as it is, so existing connectors keep their mcp__<name>__ tool prefix', () => {
    for (const name of ['figma', 'a-1', 'new-relic', 'x'.repeat(41), 'a--b', 'a-']) {
      expect(CONNECTOR_NAME.test(name)).toBe(true);
      expect(connectorSlug(name)).toBe(name);
    }
  });
});

describe('connectorNaming', () => {
  it('keeps the display text, trimmed, and derives the slug from it', () => {
    expect(connectorNaming('  Claude Docs ')).toEqual({ name: 'claude-docs', displayName: 'Claude Docs' });
  });

  it('stores no display name when the text is the slug itself', () => {
    expect(connectorNaming('figma')).toEqual({ name: 'figma', displayName: null });
  });

  it.each([null, 42, '', '   ', '日本語', 'a'.repeat(81), 'tab\there', 'new\nline'])('refuses %j', (raw) => {
    expect(() => connectorNaming(raw)).toThrow(McpConnectorError);
  });
});

describe('the credential provider for a connector', () => {
  it('fits the credential store provider rule with a 25-character cuid', () => {
    expect(mcpCredentialProvider('c'.repeat(25))).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
  });
});

describe('parseUpstream', () => {
  it('normalises the host and keeps the path exactly, naming the port for Envoy', () => {
    expect(parseUpstream('https://MCP.Example.com/mcp')).toEqual({
      url: 'https://mcp.example.com/mcp', envoyTarget: 'https://mcp.example.com:443/mcp',
    });
    expect(parseUpstream('https://mcp.example.com/')).toEqual({
      url: 'https://mcp.example.com', envoyTarget: 'https://mcp.example.com:443',
    });
    expect(parseUpstream('https://mcp.example.com/v1/sse/')).toMatchObject({ url: 'https://mcp.example.com/v1/sse/' });
  });

  it('resolves dot-segments, encoded or not, before storing', () => {
    expect(parseUpstream('https://mcp.example.com/a/%2e%2e/b').url).toBe('https://mcp.example.com/b');
    expect(parseUpstream('https://mcp.example.com/a/../../b').url).toBe('https://mcp.example.com/b');
  });

  it('drops a fragment', () => {
    expect(parseUpstream('https://mcp.example.com/mcp#x').url).toBe('https://mcp.example.com/mcp');
  });

  it.each([
    ['http://mcp.example.com/mcp', 'https'],
    ['ftp://mcp.example.com', 'https'],
    ['https://user:pw@mcp.example.com/mcp', 'user name'],
    ['https://mcp.example.com/mcp?key=1', 'query'],
    ['https://10.0.0.1/mcp', 'IP address'],
    ['https://[::1]/mcp', 'IP address'],
    ['https://mcp.example.com:8443/mcp', 'port'],
    ['https://localhost/mcp', 'fully qualified'],
    ['https://mcp.example.com/a%2Fb', 'encoded slashes'],
    ['not a url', 'https'],
  ])('refuses %s', (url, why) => {
    expect(() => parseUpstream(url)).toThrow(why);
  });

  it('lets the e2e allowlist name an exact host and port, and nothing else', () => {
    const allow = upstreamTestAllow({ MCP_UPSTREAM_TEST_ALLOW: ' 127.0.0.1:18443 , Localhost:9000' });
    expect(parseUpstream('https://127.0.0.1:18443/mcp', allow).envoyTarget).toBe('https://127.0.0.1:18443/mcp');
    expect(parseUpstream('https://localhost:9000', allow).envoyTarget).toBe('https://localhost:9000');
    expect(() => parseUpstream('https://127.0.0.1:18444/mcp', allow)).toThrow('IP address');
  });
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:808:808', '::ffff:8.8.8.8', '2001:4860:4860::8888'])('takes %s', (a) => {
    expect(isPublicAddress(a)).toBe(true);
  });

  it.each([
    '10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1',
    '::ffff:169.254.169.254', '64:ff9b::a00:1', 'not-an-ip',
    // 6to4 relay anycast, the AS112 blocks, Teredo, IPv4-compatible and AS112 v6.
    '192.88.99.1', '192.31.196.1', '192.52.193.1', '192.175.48.1', '2001:0:4136:e378::1', '::a00:1',
    '2001:4:112::1', '2620:4f:8000::1',
    // IPv4-mapped in hex and long form, as resolvers and URL write them.
    '::ffff:a00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:0a00:0001', '::FFFF:7F00:1', 'fe80::1%eth0',
  ])('refuses %s', (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });
});

describe('validateUpstream', () => {
  it('takes a host whose every address is public', async () => {
    await expect(validateUpstream('https://mcp.example.com/mcp', { resolve: resolveTo('8.8.8.8', '2606:4700::1111'), allow: new Set() }))
      .resolves.toMatchObject({ url: 'https://mcp.example.com/mcp' });
  });

  it('refuses a host with any private address (a rebinding set), or none, or one that does not resolve', async () => {
    await expect(validateUpstream('https://mcp.example.com', { resolve: resolveTo('8.8.8.8', '169.254.169.254'), allow: new Set() }))
      .rejects.toThrow('private or reserved');
    await expect(validateUpstream('https://mcp.example.com', { resolve: resolveTo(), allow: new Set() })).rejects.toThrow('does not resolve');
    await expect(validateUpstream('https://mcp.example.com', { resolve: async () => { throw new Error('ENOTFOUND'); }, allow: new Set() }))
      .rejects.toThrow('does not resolve');
  });

  it('skips DNS for an allowlisted e2e upstream', async () => {
    await expect(validateUpstream('https://localhost:9000/mcp', { resolve: resolveTo('127.0.0.1'), allow: new Set(['localhost:9000']) }))
      .resolves.toMatchObject({ envoyTarget: 'https://localhost:9000/mcp' });
  });
});

describe('header templates', () => {
  it('lowercases names and finds the secrets referenced', () => {
    const t = validateHeaderTemplates({ Authorization: 'Bearer {{secret.token}}', 'X-Org': '{{ secret.org }}-{{secret.token}}' });
    expect(t).toEqual({ authorization: 'Bearer {{secret.token}}', 'x-org': '{{ secret.org }}-{{secret.token}}' });
    expect(referencedSecrets(t)).toEqual(['org', 'token']);
  });

  it.each([
    [{}, 'at least one'],
    [[], 'object'],
    [{ host: 'x' }, 'cannot be set'],
    [{ 'x-termag-mcp-upstream': 'https://evil' }, 'cannot be set'],
    [{ 'x-envoy-original-path': '/' }, 'cannot be set'],
    [{ 'content-length': '1' }, 'cannot be set'],
    [{ 'bad header': 'x' }, 'not a valid header name'],
    [{ ':authority': 'x' }, 'not a valid header name'],
    [{ a: 'x\r\nhost: evil' }, 'one line'],
    [{ a: '{{env.HOME}}' }, 'only placeholder'],
    [{ a: 1 }, 'string'],
    [{ Auth: 'a', auth: 'b' }, 'twice'],
  ])('refuses %j', (raw, why) => {
    expect(() => validateHeaderTemplates(raw)).toThrow(why);
  });

  it('renders only {{secret.<name>}}, and refuses a missing or empty secret instead of sending an empty value', () => {
    const t = { authorization: 'Bearer {{secret.token}}', 'x-org': 'org-{{ secret.org }}' };
    expect(renderHeaders(t, { token: 'abc', org: 'o1' })).toEqual({ authorization: 'Bearer abc', 'x-org': 'org-o1' });
    expect(() => renderHeaders(t, { token: 'abc' })).toThrow('secret "org" is not set');
    expect(() => renderHeaders(t, { token: '', org: 'o' })).toThrow('secret "token" is not set');
  });

  it('refuses headers longer than Envoy takes once secrets are filled in', () => {
    const big = 'x'.repeat(8000);
    expect(renderHeaders({ a: 'Bearer {{secret.t}}' }, { t: big })).toEqual({ a: `Bearer ${big}` });
    expect(() => renderHeaders({ a: '{{secret.t}}{{secret.t}}' }, { t: big })).toThrow('header "a" is longer than 8192');
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`h${i}`, '{{secret.t}}']));
    expect(() => renderHeaders(many, { t: big })).toThrow('longer than 32768 characters in all');
  });

  it('never interprets a placeholder inside a secret value', () => {
    expect(renderHeaders({ a: '{{secret.x}}' }, { x: '{{secret.y}}', y: 'leak' })).toEqual({ a: '{{secret.y}}' });
  });
});

describe('secrets patches', () => {
  it('sets, replaces and deletes by name', () => {
    const patch = validateSecretsPatch({ token: 'new', old: null, gone: '' });
    expect(applySecretsPatch({ token: 't', old: 'o', keep: 'k' }, patch)).toEqual({ token: 'new', keep: 'k' });
  });

  it.each([[{ 'a b': 'x' }, 'valid secret name'], [{ a: 'x\ny' }, 'one line'], [{ a: 5 }, 'string'], ['x', 'object']])('refuses %j', (raw, why) => {
    expect(() => validateSecretsPatch(raw)).toThrow(why);
  });
});

describe('getMcpBrokerUrl', () => {
  it('takes an https URL only, without a trailing slash', () => {
    expect(getMcpBrokerUrl({ MCP_BROKER_URL: 'https://mcp-broker.example.test/' })).toBe('https://mcp-broker.example.test');
    expect(getMcpBrokerUrl({ MCP_BROKER_URL: 'http://x' })).toBeNull();
    expect(getMcpBrokerUrl({})).toBeNull();
  });

  it('takes a scheme and authority only, as boxes do', () => {
    expect(getMcpBrokerUrl({ MCP_BROKER_URL: 'https://mcp-broker.example.test:8443' })).toBe('https://mcp-broker.example.test:8443');
    expect(getMcpBrokerUrl({ MCP_BROKER_URL: 'https://Broker.Example.test' })).toBe('https://broker.example.test');
    for (const bad of [
      'https://mcp-broker.example.test/mcp', 'https://mcp-broker.example.test/c/', 'https://u:p@mcp-broker.example.test',
      'https://mcp-broker.example.test?x=1', 'https://mcp-broker.example.test?', 'https://mcp-broker.example.test#f',
      'https://[2001:db8::1]', 'not a url', 'https://',
    ]) expect(getMcpBrokerUrl({ MCP_BROKER_URL: bad }), bad).toBeNull();
  });
});

describe('defaultConnectors', () => {
  // The value the mcp-default-connectors flag serves.
  const json = (v: unknown) => defaultConnectors(v, {});

  it('is empty when the flag is off (null) or serves an empty array', () => {
    expect(json(null)).toEqual([]);
    expect(json(undefined)).toEqual([]);
    expect(json([])).toEqual([]);
  });

  it('reads {name, upstream} entries, normalising the URL as a stored upstream', () => {
    expect(json([
      { name: 'acme', upstream: 'https://MCP.Acme.example/mcp' },
      { name: 'docs', upstream: 'https://docs.example/' },
    ])).toEqual([
      { name: 'acme', upstream: 'https://mcp.acme.example/mcp' },
      { name: 'docs', upstream: 'https://docs.example' },
    ]);
  });

  it('keeps a comma in a URL path, which the old name=url format split on', () => {
    expect(json([{ name: 'acme', upstream: 'https://mcp.acme.example/a,b/mcp' }]))
      .toEqual([{ name: 'acme', upstream: 'https://mcp.acme.example/a,b/mcp' }]);
  });

  it('offers nothing for a value that is not an array, a JSON string included', () => {
    expect(json('acme=https://mcp.acme.example/mcp')).toEqual([]);
    expect(json('[{"name":"acme","upstream":"https://mcp.acme.example/mcp"}]')).toEqual([]);
    expect(json({ name: 'acme', upstream: 'https://mcp.acme.example/mcp' })).toEqual([]);
  });

  it('skips bad entries and repeats, keeping the rest', () => {
    expect(json([
      'acme', null, ['x'], { upstream: 'https://no-name.example/mcp' }, { name: 'Bad', upstream: 'https://a.example/mcp' },
      { name: 'plain', upstream: 'http://a.example/mcp' }, { name: 'nourl' },
      { name: 'ok', upstream: 'https://a.example/mcp' }, { name: 'ok', upstream: 'https://b.example/mcp' },
      { name: 'again', upstream: 'https://a.example/mcp' }, { name: 'two', upstream: 'https://b.example/mcp' },
    ])).toEqual([{ name: 'ok', upstream: 'https://a.example/mcp' }, { name: 'two', upstream: 'https://b.example/mcp' }]);
  });

  it('reads an optional label, the display name Settings shows; name stays the connector name', () => {
    expect(json([{ name: 'claude-docs', label: ' Claude Docs ', upstream: 'https://docs.example/mcp' }]))
      .toEqual([{ name: 'claude-docs', label: 'Claude Docs', upstream: 'https://docs.example/mcp' }]);
  });

  it('skips an entry whose label is not usable display text, or whose name is display text', () => {
    expect(json([
      { name: 'a', label: 42, upstream: 'https://a.example/mcp' },
      { name: 'b', label: '', upstream: 'https://b.example/mcp' },
      { name: 'Claude Docs', upstream: 'https://c.example/mcp' },
      { name: 'ok', label: 'OK', upstream: 'https://d.example/mcp' },
    ])).toEqual([{ name: 'ok', label: 'OK', upstream: 'https://d.example/mcp' }]);
  });

  it('names an entry by its name in the unknown-key warning, whether or not it has a label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      json([
        { name: 'warn-labelled', label: 'Warn Labelled', upstream: 'https://wl.example/mcp', extra: 1 },
        { name: 'warn-plain', upstream: 'https://wp.example/mcp', extra: 1 },
      ]);
      expect(warn.mock.calls.map(c => c[0])).toEqual([
        '[MCP] mcp-default-connectors flag: "warn-labelled": ignoring unknown key extra',
        '[MCP] mcp-default-connectors flag: "warn-plain": ignoring unknown key extra',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores unknown keys (say, from a value written for a newer termag) and still offers the server', () => {
    expect(json([{ name: 'acme', upstream: 'https://mcp.acme.example/mcp', headers: { 'x-project': 'default' } }]))
      .toEqual([{ name: 'acme', upstream: 'https://mcp.acme.example/mcp' }]);
  });
});

describe('relinkMessage', () => {
  it('names the server and deep-links its Settings row', () => {
    expect(relinkMessage('figma', 'c1', 'https://termag.example/termag'))
      .toBe('MCP server "figma" is not linked. Link it at https://termag.example/termag/settings/mcp?server=c1');
  });
});

describe('assertPatchFitsAuth', () => {
  it('lets a static connector take headers and secrets', () => {
    expect(() => assertPatchFitsAuth('static', { auth: { type: 'static', headers: { a: 'b' } }, secrets: { t: 'x' } })).not.toThrow();
  });

  it('refuses secrets or headers on an oauth connector instead of ignoring them', () => {
    expect(() => assertPatchFitsAuth('oauth', { secrets: { t: 'x' } })).toThrow(McpConnectorError);
    expect(() => assertPatchFitsAuth('oauth', { auth: { type: 'oauth', headers: {} } })).toThrow(McpConnectorError);
    expect(() => assertPatchFitsAuth('oauth', { auth: { type: 'oauth' } })).not.toThrow();
    expect(() => assertPatchFitsAuth('oauth', undefined)).not.toThrow();
  });
});
