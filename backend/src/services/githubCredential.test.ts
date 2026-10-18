import { describe, it, expect, vi } from 'vitest';
import {
  connectGithub,
  CredentialInputError,
  GITHUB_REJECTED_SENTENCE,
  githubGet,
  looksLikeGithubToken,
  missingScopes,
  recheckGithub,
} from './githubCredential';
import type { GithubSecret } from './credentialStore';
import { repoOrgs, TOKEN_TYPE_SENTENCE } from './githubRepos';

const SENTINEL = 'gho_SENTINELsentinelSENTINEL0123456789';
const PAT = 'github_pat_11AAAAAAA0123456789abcdef';
const GHU = `ghu_${'a'.repeat(20)}`;

describe('token checks', () => {
  it('accepts gh token shapes and nothing else', () => {
    expect(looksLikeGithubToken(SENTINEL)).toBe(true);
    expect(looksLikeGithubToken(PAT)).toBe(true);
    expect(looksLikeGithubToken(GHU)).toBe(false);
    expect(looksLikeGithubToken('gho_short')).toBe(false);
    expect(looksLikeGithubToken(`${SENTINEL}\nextra`)).toBe(false);
    expect(looksLikeGithubToken(42)).toBe(false);
  });

  it('needs repo and read:org on classic tokens; fine-grained tokens report no scopes', () => {
    expect(missingScopes(['repo', 'read:org'])).toEqual([]);
    expect(missingScopes(['repo', 'admin:org'])).toEqual([]);
    expect(missingScopes(['repo', 'write:org'])).toEqual([]);
    expect(missingScopes([])).toEqual([]);
    expect(missingScopes(['read:org', 'gist'])).toEqual(['repo']);
    expect(missingScopes(['repo', 'gist'])).toEqual(['read:org']);
    expect(missingScopes(['gist'])).toEqual(['repo', 'read:org']);
  });
});

function fakeGithub(opts: { scopes?: string; userStatus?: number } = {}) {
  const calls: Array<{ method: string; url: string; auth: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    calls.push({ method, url, auth });
    if (url.endsWith('/user')) {
      if (opts.userStatus && opts.userStatus !== 200) return new Response('{}', { status: opts.userStatus });
      return new Response(JSON.stringify({ login: 'octocat', id: 583231 }), {
        headers: { 'x-oauth-scopes': opts.scopes ?? 'repo, read:org, gist' },
      });
    }
    return new Response('{}', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function memoryStore(initial: GithubSecret | null = null) {
  let value = initial;
  return {
    get value() { return value; },
    write: async (v: GithubSecret) => { value = v; },
  };
}

describe('connectGithub', () => {
  it('stores only the token and identity, and creates no SSH key on GitHub', async () => {
    const gh = fakeGithub();
    const store = memoryStore();
    const got = await connectGithub(SENTINEL, { ...store, fetchImpl: gh.fetchImpl });
    expect(got).toEqual({ login: 'octocat', label: '@octocat' });
    const orgs = Object.fromEntries(repoOrgs().map(org => [org, { status: 'error' as const, retryAfter: null }]));
    expect(store.value).toEqual({ login: 'octocat', githubUserId: 583231, token: SENTINEL, orgs });
    expect(gh.calls.map(c => c.url).sort()).toEqual([
      'https://api.github.com/user',
      ...repoOrgs().map(org => `https://api.github.com/orgs/${org}/repos?per_page=1`),
    ].sort());
    expect(gh.calls.some(c => c.url.includes('/user/keys'))).toBe(false);
  });

  it('stores a fine-grained github_pat_, which reports no scopes', async () => {
    const gh = fakeGithub({ scopes: '' });
    const store = memoryStore();
    const got = await connectGithub(PAT, { ...store, fetchImpl: gh.fetchImpl });
    expect(got).toEqual({ login: 'octocat', label: '@octocat' });
    expect(store.value).toMatchObject({ login: 'octocat', githubUserId: 583231, token: PAT });
    expect(gh.calls.every(c => c.auth === `Bearer ${PAT}`)).toBe(true);
  });

  it('refuses ghu_ with the one-owner sentence and does not call GitHub', async () => {
    const gh = fakeGithub();
    const store = memoryStore();
    const err = await connectGithub(GHU, { ...store, fetchImpl: gh.fetchImpl }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialInputError);
    expect(err.message).toBe(TOKEN_TYPE_SENTENCE);
    expect(err.message).toBe('This token type sees one owner only; paste the output of `gh auth token`');
    expect(err.message).not.toContain(GHU);
    expect(gh.calls).toHaveLength(0);
    expect(store.value).toBeNull();
  });

  it('refuses a classic token without repo', async () => {
    const gh = fakeGithub({ scopes: 'read:org' });
    const store = memoryStore();
    const err = await connectGithub(SENTINEL, { ...store, fetchImpl: gh.fetchImpl }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialInputError);
    expect(err.message).toContain('-s repo');
    expect(err.message).not.toContain(SENTINEL);
    expect(store.value).toBeNull();
  });

  it('refuses a classic token without read:org, which gh on the box needs', async () => {
    const gh = fakeGithub({ scopes: 'repo, gist' });
    const store = memoryStore();
    const err = await connectGithub(SENTINEL, { ...store, fetchImpl: gh.fetchImpl }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialInputError);
    expect(err.message).toContain('-s read:org');
    expect(err.message).not.toContain(SENTINEL);
    expect(store.value).toBeNull();
  });

  it('turns a rejected token into an input error without echoing it', async () => {
    const gh = fakeGithub({ userStatus: 401 });
    const err = await connectGithub(SENTINEL, { ...memoryStore(), fetchImpl: gh.fetchImpl }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialInputError);
    expect(err.message).not.toContain(SENTINEL);
  });

  it('stores sso-required when an org answers 403 with X-GitHub-SSO', async () => {
    const orgs = [...repoOrgs()];
    const ssoOrg = orgs[0]!;
    const ssoUrl = `https://github.com/orgs/${ssoOrg}/sso?authorization_request=1`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat', id: 583231 }), {
          headers: { 'x-oauth-scopes': 'repo, read:org' },
        });
      }
      if (url.includes(`/orgs/${ssoOrg}/repos`)) {
        return new Response(JSON.stringify({ message: 'sso' }), {
          status: 403,
          headers: { 'X-GitHub-SSO': `required; url=${ssoUrl}` },
        });
      }
      return new Response('[]', { status: 200 });
    });
    const store = memoryStore();
    await connectGithub(SENTINEL, { ...store, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(store.value?.orgs?.[ssoOrg]).toEqual({ status: 'sso-required', ssoUrl });
    for (const org of orgs.slice(1)) expect(store.value?.orgs?.[org]).toEqual({ status: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + orgs.length);
    expect(JSON.stringify(store.value?.orgs)).not.toContain(SENTINEL);
  });

  it('stores nothing when a probe is 401 and throws the rejected-token sentence', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat', id: 583231 }), {
          headers: { 'x-oauth-scopes': 'repo, read:org' },
        });
      }
      return new Response(JSON.stringify({ message: 'bad' }), { status: 401 });
    });
    const store = memoryStore();
    const err = await connectGithub(SENTINEL, { ...store, fetchImpl: fetchImpl as unknown as typeof fetch }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialInputError);
    expect(err.message).toBe(GITHUB_REJECTED_SENTENCE);
    expect(err.message).toBe('GitHub rejected that token. Run `gh auth login` on your laptop and try again.');
    expect(err.message).not.toContain(SENTINEL);
    expect(store.value).toBeNull();
  });

  it('returns 304 without throwing and does not put the token on the result', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"abc"' } }));
    const res = await githubGet('https://api.github.com/user/repos?per_page=100', SENTINEL, {
      etag: '"abc"',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ status: 304, etag: '"abc"', headers: { etag: '"abc"' }, body: null });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'termag',
      Authorization: `Bearer ${SENTINEL}`,
      'If-None-Match': '"abc"',
    });
    expect(init.headers).not.toBeInstanceOf(Headers);
  });

  it('refuses something that is not a token without calling GitHub', async () => {
    const gh = fakeGithub();
    const err = await connectGithub('not-a-token', { ...memoryStore(), fetchImpl: gh.fetchImpl }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialInputError);
    expect(gh.calls).toHaveLength(0);
  });
});

describe('recheckGithub', () => {
  it('rewrites org access and leaves the row in place when the probe is 401', async () => {
    const orgs = [...repoOrgs()];
    const ssoOrg = orgs[0]!;
    const ssoUrl = `https://github.com/orgs/${ssoOrg}/sso?authorization_request=1`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat2', id: 9 }), {
          headers: { 'x-oauth-scopes': 'repo, read:org' },
        });
      }
      if (url.includes(`/orgs/${ssoOrg}/repos`)) {
        return new Response('{}', { status: 403, headers: { 'X-GitHub-SSO': `required; url=${ssoUrl}` } });
      }
      return new Response('[]');
    });
    let written: GithubSecret | null = null;
    const mark = new Uint8Array([1]);
    await recheckGithub({
      readSnapshot: async () => ({ secret: { login: 'octocat', githubUserId: 1, token: SENTINEL }, ciphertext: mark }),
      replaceIfUnchanged: async (ciphertext, secret) => {
        if (ciphertext !== mark) return false;
        written = secret;
        return true;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(written).toEqual({
      login: 'octocat2',
      githubUserId: 9,
      token: SENTINEL,
      orgs: {
        ...Object.fromEntries(orgs.map(org => [org, { status: 'ok' as const }])),
        [ssoOrg]: { status: 'sso-required', ssoUrl },
      },
    });

    let writes = 0;
    const denied = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat', id: 1 }), {
          headers: { 'x-oauth-scopes': 'repo, read:org' },
        });
      }
      return new Response('{}', { status: 401 });
    });
    const err = await recheckGithub({
      readSnapshot: async () => ({
        secret: { login: 'octocat', githubUserId: 1, token: SENTINEL, orgs: { [ssoOrg]: { status: 'ok' } } },
        ciphertext: new Uint8Array([2]),
      }),
      replaceIfUnchanged: async () => { writes += 1; return true; },
      fetchImpl: denied as unknown as typeof fetch,
    }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialInputError);
    expect(err.message).toBe(GITHUB_REJECTED_SENTENCE);
    expect(err.message).not.toContain(SENTINEL);
    expect(writes).toBe(0);
  });
});
