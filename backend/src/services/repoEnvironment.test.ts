import { describe, expect, it, vi } from 'vitest';

vi.mock('./credentialStore', () => ({ readGithubAccess: vi.fn(async () => null) }));

const { createRepoEnvironmentReader, parseRepoEnvironment, repoSizesFor } = await import('./repoEnvironment');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('parseRepoEnvironment: resources only, and nothing it can\'t use is an error', () => {
  it('reads resources, which may be left out', () => {
    expect(parseRepoEnvironment('{"resources":"medium"}')).toEqual({ sizes: { size: 'medium' }, warnings: [] });
    expect(parseRepoEnvironment('{}')).toEqual({ sizes: { size: null }, warnings: [] });
  });

  it('leaves out a value that is not a size, with a warning naming it', () => {
    const { sizes, warnings } = parseRepoEnvironment('{"resources":"huge"}', 'acme/app');
    expect(sizes).toEqual({ size: null });
    expect(warnings).toEqual([`acme/app's .termag/environment.json: "resources" is "huge", not one of small, medium, large or { "vcpu", "memoryGiB" }, so it was ignored`]);
    expect(parseRepoEnvironment('{"resources":"Small"}').warnings).toHaveLength(1);
    expect(parseRepoEnvironment('{"resources":4}').warnings[0]).toContain('"resources" is 4');
  });

  it('reads requirements, { vcpu, memoryGiB }, as minimums', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":4,"memoryGiB":32}}')).toEqual({ sizes: { size: { vcpu: 4, memoryGiB: 32 } }, warnings: [] });
  });

  it('leaves out requirements out of range or malformed, with the reason', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":16,"memoryGiB":32}}', 'acme/app')).toEqual({
      sizes: { size: null }, warnings: [`acme/app's .termag/environment.json: "resources" 16 vCPU is over the 8 vCPU limit, so it was ignored`],
    });
    expect(parseRepoEnvironment('{"resources":{"vcpu":4}}').warnings[0]).toContain('"memoryGiB" must be a whole number of at least 1');
    expect(parseRepoEnvironment('{"resources":[4,32]}').warnings[0]).toContain('not one of small, medium, large or { "vcpu", "memoryGiB" }');
  });

  it('reads diskGiB beside vcpu and memoryGiB, or on its own, which leaves the size to the default', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":4,"memoryGiB":32,"diskGiB":200}}')).toEqual({
      sizes: { size: { vcpu: 4, memoryGiB: 32 }, diskGiB: 200 }, warnings: [],
    });
    expect(parseRepoEnvironment('{"resources":{"diskGiB":250}}')).toEqual({ sizes: { size: null, diskGiB: 250 }, warnings: [] });
  });

  it('leaves out a diskGiB out of range or not a whole number, with the reason, and keeps the size', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":4,"memoryGiB":32,"diskGiB":500}}', 'acme/app')).toEqual({
      sizes: { size: { vcpu: 4, memoryGiB: 32 } },
      warnings: [`acme/app's .termag/environment.json: "resources" "diskGiB" is 500, not a whole number of GB from 50 to 300, so it was ignored`],
    });
    expect(parseRepoEnvironment('{"resources":{"diskGiB":"200"}}').warnings[0]).toContain('"diskGiB" is "200"');
    expect(parseRepoEnvironment('{"resources":{"diskGiB":120.5}}').sizes).toEqual({ size: null });
  });

  it('keeps a good diskGiB when the vcpu and memoryGiB beside it are not', () => {
    const { sizes, warnings } = parseRepoEnvironment('{"resources":{"vcpu":16,"memoryGiB":32,"diskGiB":200}}');
    expect(sizes).toEqual({ size: null, diskGiB: 200 });
    expect(warnings).toEqual([expect.stringContaining('16 vCPU is over the 8 vCPU limit')]);
  });

  it('reads only resources: every other key is reserved (install, start, ports) and ignored without a word', () => {
    expect(parseRepoEnvironment('{"resources":"medium","install":"npm ci","start":"npm run dev","ports":[3000],"size":"large"}')).toEqual({
      sizes: { size: 'medium' }, warnings: [],
    });
    expect(parseRepoEnvironment('{"install":"npm ci"}')).toEqual({ sizes: { size: null }, warnings: [] });
  });

  it.each([['not json', 'not valid JSON'], ['["small"]', 'not a JSON object'], ['"small"', 'not a JSON object'], ['null', 'not a JSON object']])(
    'ignores a malformed file (%s) with one warning', (text, why) => {
      expect(parseRepoEnvironment(text)).toEqual({ sizes: { size: null }, warnings: [expect.stringContaining(why)] });
    },
  );
});

/** A GitHub that answers the default branch's head and the file at each commit, recording each call. */
function github(opts: { head?: () => { status: number; body: string }; files?: Record<string, { status: number; body: string }> } = {}) {
  const calls: Array<{ url: string; auth: string | null; accept: string | null }> = [];
  let head = SHA1;
  const files: Record<string, { status: number; body: string }> = opts.files ?? { [SHA1]: { status: 200, body: '{"resources":"medium"}' } };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization ?? null, accept: headers.Accept ?? null });
    if (url.endsWith('/commits/HEAD')) {
      const h = opts.head ? opts.head() : { status: 200, body: head };
      return new Response(h.body, { status: h.status });
    }
    const ref = new URL(url).searchParams.get('ref') ?? '';
    const f = files[ref] ?? { status: 404, body: '{"message":"Not Found"}' };
    return new Response(f.body, { status: f.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, setHead: (sha: string) => { head = sha; }, files };
}

describe('the reader: the default branch\'s head, then the file at that commit, cached by commit', () => {
  it('reads the file at the head commit with the owner\'s token, as raw content', async () => {
    const gh = github();
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => 'gho_tok', apiBase: 'https://gh.test' });
    expect(await reader.read('u1', 'https://github.com/Acme/App.git')).toEqual({
      repo: 'acme/app', commit: SHA1, sizes: { size: 'medium' }, warnings: [],
    });
    expect(gh.calls).toEqual([
      { url: 'https://gh.test/repos/acme/app/commits/HEAD', auth: 'Bearer gho_tok', accept: 'application/vnd.github.sha' },
      { url: `https://gh.test/repos/acme/app/contents/.termag/environment.json?ref=${SHA1}`, auth: 'Bearer gho_tok', accept: 'application/vnd.github.raw' },
    ]);
  });

  it('reads a public repository with no token when the owner has none', async () => {
    const gh = github();
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    expect((await reader.read('u1', 'acme/app'))?.sizes).toEqual({ size: 'medium' });
    expect(gh.calls.every(c => c.auth === null)).toBe(true);
  });

  it('caches by commit: the same head reads the file once, and a new head reads it again', async () => {
    const gh = github({ files: { [SHA1]: { status: 200, body: '{"resources":"medium"}' }, [SHA2]: { status: 200, body: '{"resources":"large"}' } } });
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => 'gho_tok', apiBase: 'https://gh.test' });
    await reader.read('u1', 'acme/app');
    expect((await reader.read('u2', 'acme/app'))?.sizes?.size).toBe('medium');
    expect(gh.calls.filter(c => c.url.includes('/contents/'))).toHaveLength(1);
    // The head is asked every time, with each owner's own credential: a push to the file applies to the next box.
    expect(gh.calls.filter(c => c.url.endsWith('/commits/HEAD'))).toHaveLength(2);
    gh.setHead(SHA2);
    expect((await reader.read('u1', 'acme/app'))?.sizes?.size).toBe('large');
    expect(reader.cachedKeys()).toEqual([`acme/app@${SHA1}`, `acme/app@${SHA2}`]);
  });

  it('caches a commit with no file too, and its warnings with a malformed one', async () => {
    const gh = github({ files: { [SHA1]: { status: 200, body: '{"resources":"xl"}' } } });
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    const first = await reader.read('u1', 'acme/app');
    expect(first).toMatchObject({ sizes: { size: null }, warnings: [expect.stringContaining('"resources" is "xl"')] });
    expect(await reader.read('u1', 'acme/app')).toEqual(first);
    gh.setHead(SHA2);
    expect(await reader.read('u1', 'acme/app')).toEqual({ repo: 'acme/app', commit: SHA2, sizes: null, warnings: [] });
    await reader.read('u1', 'acme/app');
    expect(gh.calls.filter(c => c.url.includes('/contents/'))).toHaveLength(2);
  });

  it('drops the oldest commit past its limit', async () => {
    let n = 0;
    const gh = github({ head: () => ({ status: 200, body: String(++n % 10).repeat(40) }) });
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test', cacheEntries: 2 });
    for (let i = 0; i < 3; i++) await reader.read('u1', 'acme/app');
    expect(reader.cachedKeys()).toEqual([`acme/app@${'2'.repeat(40)}`, `acme/app@${'3'.repeat(40)}`]);
  });

  it('is nothing to read for a repository that is not on GitHub', async () => {
    const gh = github();
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    expect(await reader.read('u1', 'https://gitlab.com/acme/app')).toBeNull();
    expect(gh.calls).toEqual([]);
  });

  it('is no setting and no warning for a repository GitHub doesn\'t show this owner', async () => {
    const gh = github({ head: () => ({ status: 404, body: '{}' }) });
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    expect(await reader.read('u1', 'acme/secret')).toEqual({ repo: 'acme/secret', commit: null, sizes: null, warnings: [] });
  });

  it('warns, and caches nothing, when GitHub fails or does not answer', async () => {
    const down = createRepoEnvironmentReader({
      fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
      loadToken: async () => null, apiBase: 'https://gh.test',
    });
    expect(await down.read('u1', 'acme/app')).toEqual({
      repo: 'acme/app', commit: null, sizes: null,
      warnings: ["couldn't read acme/app's .termag/environment.json (GitHub could not be reached), so it was left out"],
    });
    const gh = github({ files: { [SHA1]: { status: 500, body: 'oops' } } });
    const flaky = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    expect((await flaky.read('u1', 'acme/app'))?.warnings).toEqual([expect.stringContaining('GitHub answered 500')]);
    expect(flaky.cachedKeys()).toEqual([]);
    const slow = createRepoEnvironmentReader({
      fetchImpl: ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as typeof fetch,
      loadToken: async () => null, apiBase: 'https://gh.test', timeoutMs: 10,
    });
    expect((await slow.read('u1', 'acme/app'))?.warnings).toEqual([expect.stringContaining('did not answer in time')]);
  });

  it('reads without a token when the owner\'s credential cannot be loaded', async () => {
    const gh = github();
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => { throw new Error('store off'); }, apiBase: 'https://gh.test' });
    expect((await reader.read('u1', 'acme/app'))?.sizes?.size).toBe('medium');
  });
});

describe('repoSizesFor: a multi-repo project takes the largest of its repositories\' sizes', () => {
  // Each repository's environment.json at its own head, from a stubbed GitHub.
  const serve = (files: Record<string, string | null>) => {
    let n = 0;
    const heads = new Map(Object.keys(files).map(r => [r, String(++n).repeat(40)]));
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const m = /\/repos\/([^/]+\/[^/]+)\/(commits\/HEAD|contents\/)/.exec(String(input))!;
      if (m[2] === 'commits/HEAD') return new Response(heads.get(m[1]) ?? '', { status: heads.has(m[1]) ? 200 : 404 });
      const body = files[m[1]];
      return body === null ? new Response('{}', { status: 404 }) : new Response(body, { status: 200 });
    }));
  };

  it('takes the most vCPUs and the most memory across them: 4/32 and 8/16 make 8/32, large\'s shape', async () => {
    serve({ 'acme/web': '{"resources":{"vcpu":4,"memoryGiB":32}}', 'acme/api': '{"resources":{"vcpu":8,"memoryGiB":16}}' });
    expect(await repoSizesFor('u1', ['https://github.com/acme/web', 'https://github.com/acme/api'])).toEqual({ sizes: { size: 'large' }, warnings: [] });
  });

  it('mixes presets and requirements: medium (4/16) and 4/32 make 4/32; small and medium make medium', async () => {
    serve({ 'acme/a': '{"resources":"medium"}', 'acme/b': '{"resources":{"vcpu":4,"memoryGiB":32}}', 'acme/c': '{"resources":"small"}' });
    expect((await repoSizesFor('u1', ['acme/a', 'acme/b'])).sizes).toEqual({ size: { vcpu: 4, memoryGiB: 32 } });
    expect((await repoSizesFor('u1', ['acme/c', 'acme/a'])).sizes).toEqual({ size: 'medium' });
  });

  it('leaves a malformed file out with its warning, and takes the others\'; a repository with no file adds nothing', async () => {
    serve({ 'acme/ok': '{"resources":"medium"}', 'acme/bad': '{"resources":"huge"}', 'acme/none': null });
    const got = await repoSizesFor('u1', ['acme/bad', 'acme/ok', 'acme/none']);
    expect(got.sizes).toEqual({ size: 'medium' });
    expect(got.warnings).toEqual([expect.stringContaining('acme/bad\'s .termag/environment.json: "resources" is "huge"')]);
  });

  it('takes the largest diskGiB across them, beside the largest size', async () => {
    // Repositories of their own: the reader caches by repository and commit across tests.
    serve({ 'acme/d1': '{"resources":{"vcpu":4,"memoryGiB":16,"diskGiB":150}}', 'acme/d2': '{"resources":{"diskGiB":250}}', 'acme/d3': '{"resources":"small"}' });
    expect((await repoSizesFor('u1', ['acme/d1', 'acme/d2', 'acme/d3'])).sizes).toEqual({ size: 'medium', diskGiB: 250 });
    expect((await repoSizesFor('u1', ['acme/d3'])).sizes).toStrictEqual({ size: 'small' });
  });

  it('is nothing for no repository, or none with a file', async () => {
    serve({ 'acme/none': null });
    expect(await repoSizesFor('u1', [])).toEqual({ sizes: null, warnings: [] });
    expect(await repoSizesFor('u1', ['acme/none'])).toEqual({ sizes: null, warnings: [] });
  });
});
