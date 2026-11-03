/**
 * Every place that authenticates with an AgentToken decides which scopes it
 * accepts in one table (agentTokenScopes.ts), so a new scope can't slip
 * through a site that only checked "not admin", and a new site can't ship
 * without deciding. This holds the code to that: a token's scope is read only
 * to hand it to acceptsScope, every validateAgentToken caller and every
 * gateway is known, each names only its own rows, and each row has one owner.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptsScope, TOKEN_SITES, type TokenSite } from './agentTokenScopes';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const files = sources(SRC)
  .map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }))
  .filter((f) => f.path !== 'services/agentTokenScopes.ts');

/**
 * Each file that calls validateAgentToken, and the site rows it checks with.
 * Files that only pass the call through (the definition, the CLI store's
 * interface and its Prisma half, the routes that reach it through the store)
 * check nothing themselves: their tokens are judged where the row is named.
 */
const CALLERS: Record<string, TokenSite[]> = {
  'index.ts': ['agentSocket'],
  'middleware/admin.ts': ['admin'],
  'middleware/auth.ts': ['agentRoutes'],
  'routes/agentTokens.ts': [],
  'routes/cliApi.ts': [],
  'routes/cliT3.ts': ['agentTunnel'],
  'routes/cliWs.ts': [],
  'routes/gatewayCheck.ts': [],
  'routes/status.ts': ['status'],
  'services/cliStore.ts': ['cliBox'],
  'services/cliStorePrisma.ts': [],
};

const GATEWAYS: Record<string, TokenSite> = {
  'routes/githubAuthz.ts': 'githubBroker',
  'routes/claudeAuthz.ts': 'claudeGateway',
  'routes/fireworksAuthz.ts': 'fireworksGateway',
  'routes/mcpAuthz.ts': 'mcpGateway',
};

/** The first argument of each `fn(` call in `text`, unquoted when it's a string literal. */
function firstArgs(text: string, fn: string): string[] {
  return [...text.matchAll(new RegExp(`\\b${fn}\\(\\s*([^,)]*)`, 'g'))]
    .map((m) => m[1].trim().replace(/^'(\w+)'$/, '$1'))
    .sort();
}

describe('agent token scopes', () => {
  it('accepts what each site accepted before the table existed', () => {
    expect(TOKEN_SITES).toEqual({
      agentSocket: ['agent'], agentRoutes: ['agent'], status: ['agent'], admin: ['admin'], cliBox: ['agent'], agentTunnel: ['agent'],
      githubBroker: ['agent'], claudeGateway: ['agent'], fireworksGateway: ['agent'], mcpGateway: ['agent'],
    });
    expect(acceptsScope('agentRoutes', 'agent')).toBe(true);
    expect(acceptsScope('agentRoutes', 'admin')).toBe(false);
    expect(acceptsScope('admin', 'agent')).toBe(false);
    expect(acceptsScope('githubBroker', 'preview-agent')).toBe(false);
  });

  it("reads a token's scope only to hand it to acceptsScope", () => {
    // Any other read is a check the table doesn't see: `!==`, a reversed or
    // loose comparison, a switch, or `.endsWith('agent')`, which
    // 'preview-agent' passes. Bracket access and destructuring count too.
    const handed = /\bacceptsScope\([\w']+,\s*[\w.?]*\btoken\??\.scope\)/g;
    const read = new RegExp([
      String.raw`\btoken\??\.scope\b`,
      String.raw`\btoken(?:\?\.)?\[\s*['"\x60]scope`,
      String.raw`\{[^{}]*\bscope\b[^{}]*\}\s*=\s*[\w.?]*\btoken\b`,
      String.raw`\btoken\s*:\s*\{[^{}:]*\bscope\s*[,}]`,
    ].join('|'));
    const reading = files.filter((f) => {
      let text = f.text.replace(handed, '');
      // validateAgentToken copies the row's scope into the result its callers check.
      if (f.path === 'routes/agentTokens.ts') text = text.replace('scope: token.scope,', '');
      return read.test(text);
    }).map((f) => f.path);
    expect(reading).toEqual([]);
  });

  it('every validateAgentToken caller is known; a new one decides its scopes here first', () => {
    const calling = files.filter((f) => /\bvalidateAgentToken\(/.test(f.text)).map((f) => f.path).sort();
    expect(calling).toEqual(Object.keys(CALLERS).sort());
  });

  it('every file names exactly its own rows, and every gateway is known', () => {
    for (const f of files) {
      // gatewayCheck's boxForToken checks the row its gateway bound with boxForTokenAt.
      const checks = f.path === 'routes/gatewayCheck.ts' ? ['site'] : CALLERS[f.path] ?? [];
      expect(firstArgs(f.text, 'acceptsScope'), `${f.path}: acceptsScope rows`).toEqual([...checks].sort());
      expect(firstArgs(f.text, 'boxForTokenAt'), `${f.path}: boxForTokenAt rows`).toEqual(GATEWAYS[f.path] ? [GATEWAYS[f.path]] : []);
    }
  });

  it('every row belongs to exactly one site', () => {
    const owners = [...Object.values(CALLERS).flat(), ...Object.values(GATEWAYS)].sort();
    expect(owners).toEqual(Object.keys(TOKEN_SITES).sort());
  });

  it('only gatewayCheck reaches boxForToken unbound', () => {
    // The gateway services call the bound one they were handed (deps.boxForToken).
    const unbound = files.filter((f) => /(?<!deps\.)\bboxForToken\(/.test(f.text)).map((f) => f.path);
    expect(unbound).toEqual(['routes/gatewayCheck.ts']);
  });
});
