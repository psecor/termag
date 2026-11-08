import { describe, expect, it, vi } from 'vitest';

vi.mock('./credentialStore', () => ({ readGithubAccess: vi.fn(async () => null) }));

const { createRepoEnvironmentReader, parseRepoEnvironment, parseEnvironmentData, repoSetupFor, repoSizesFor, resolveEnvironmentDefinition } = await import('./repoEnvironment');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('parseRepoEnvironment: resources and repos, and nothing it can\'t use is an error', () => {
  it('reads resources, which may be left out', () => {
    expect(parseRepoEnvironment('{"resources":"medium"}')).toEqual({ sizes: { size: 'medium' }, repos: null, warnings: [] });
    expect(parseRepoEnvironment('{}')).toEqual({ sizes: { size: null }, repos: null, warnings: [] });
  });

  it('leaves out a value that is not a size, with a warning naming it', () => {
    const { sizes, warnings } = parseRepoEnvironment('{"resources":"huge"}', 'acme/app');
    expect(sizes).toEqual({ size: null });
    expect(warnings).toEqual([`acme/app's .termag/environment.json: "resources" is "huge", not one of small, medium, large or { "vcpu", "memoryGiB" }, so it was ignored`]);
    expect(parseRepoEnvironment('{"resources":"Small"}').warnings).toHaveLength(1);
    expect(parseRepoEnvironment('{"resources":4}').warnings[0]).toContain('"resources" is 4');
  });

  it('reads requirements, { vcpu, memoryGiB }, as minimums', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":4,"memoryGiB":32}}')).toEqual({ sizes: { size: { vcpu: 4, memoryGiB: 32 } }, repos: null, warnings: [] });
  });

  it('leaves out requirements out of range or malformed, with the reason', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":16,"memoryGiB":32}}', 'acme/app')).toEqual({
      sizes: { size: null }, repos: null, warnings: [`acme/app's .termag/environment.json: "resources" 16 vCPU is over the 8 vCPU limit, so it was ignored`],
    });
    expect(parseRepoEnvironment('{"resources":{"vcpu":4}}').warnings[0]).toContain('"memoryGiB" must be a whole number of at least 1');
    expect(parseRepoEnvironment('{"resources":[4,32]}').warnings[0]).toContain('not one of small, medium, large or { "vcpu", "memoryGiB" }');
  });

  it('reads diskGiB beside vcpu and memoryGiB, or on its own, which leaves the size to the default', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":4,"memoryGiB":32,"diskGiB":200}}')).toEqual({
      sizes: { size: { vcpu: 4, memoryGiB: 32 }, diskGiB: 200 }, repos: null, warnings: [],
    });
    expect(parseRepoEnvironment('{"resources":{"diskGiB":250}}')).toEqual({ sizes: { size: null, diskGiB: 250 }, repos: null, warnings: [] });
  });

  it('leaves out a diskGiB out of range or not a whole number, with the reason, and keeps the size', () => {
    expect(parseRepoEnvironment('{"resources":{"vcpu":4,"memoryGiB":32,"diskGiB":500}}', 'acme/app')).toEqual({
      sizes: { size: { vcpu: 4, memoryGiB: 32 } }, repos: null,
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

  it('reads only resources and repos: keys the schema does not name are ignored without a word, and the rest are checked against it', () => {
    expect(parseRepoEnvironment('{"$schema":"x","resources":"medium","install":"npm ci","start":"npm run dev","size":"large","ports":[{"name":"web","port":3000}]}')).toEqual({
      sizes: { size: 'medium' }, repos: null, warnings: [],
    });
    // A key the schema names, malformed: a warning, and still never a failure.
    expect(parseRepoEnvironment('{"resources":"medium","ports":[3000]}', 'acme/app')).toEqual({
      sizes: { size: 'medium' }, repos: null, warnings: ["acme/app's .termag/environment.json: ports.0 must be object (docs/environment.schema.json)"],
    });
    expect(parseRepoEnvironment('{"install":"npm ci"}')).toEqual({ sizes: { size: null }, repos: null, warnings: [] });
  });

  it.each([['not json', 'not valid JSON'], ['["small"]', 'not a JSON object'], ['"small"', 'not a JSON object'], ['null', 'not a JSON object']])(
    'ignores a malformed file (%s) with one warning', (text, why) => {
      expect(parseRepoEnvironment(text)).toEqual({ sizes: { size: null }, repos: null, warnings: [expect.stringContaining(why)] });
    },
  );
});

/** A GitHub that answers the default branch's head and the file at each commit, recording each call. */
function github(opts: { head?: () => { status: number; body: string }; files?: Record<string, { status: number; body: string }>; branches?: Record<string, string> } = {}) {
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
    const branch = /\/commits\/([^?]+)$/.exec(url)?.[1];
    if (branch) {
      const sha = opts.branches?.[decodeURIComponent(branch)];
      return new Response(sha ?? '{"message":"No commit found"}', { status: sha ? 200 : 422 });
    }
    const ref = new URL(url).searchParams.get('ref') ?? '';
    const f = files[ref] ?? { status: 404, body: '{"message":"Not Found"}' };
    return new Response(f.body, { status: f.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, setHead: (sha: string) => { head = sha; }, files };
}

describe("an environment's definition: inline, or a pointer read from its branch", () => {
  const POINTER = { name: 'full-stack', kind: 'pointer' as const, file: { repo: 'acme/app', branch: 'release/1', path: '.termag/full stack/environment.json' } };
  const BRANCH_SHA = 'b'.repeat(40);

  it("reads a pointer's file at its branch's head, with the file's repository among the repos", async () => {
    const gh = github({ branches: { 'release/1': BRANCH_SHA }, files: { [BRANCH_SHA]: { status: 200, body: JSON.stringify({ $schema: 'x', resources: 'large', repos: [{ repo: 'acme/api', path: 'api' }] }) } } });
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => 'gho_tok', apiBase: 'https://gh.test' });
    expect(await resolveEnvironmentDefinition('u1', POINTER, reader)).toEqual({
      repos: [{ repo: 'acme/app', branch: 'release/1' }, { repo: 'acme/api', path: 'api' }], sizes: { size: 'large' }, warnings: [],
      // The file as read, which the project's create freezes.
      text: JSON.stringify({ $schema: 'x', resources: 'large', repos: [{ repo: 'acme/api', path: 'api' }] }),
    });
    expect(gh.calls[0].url).toBe('https://gh.test/repos/acme/app/commits/release/1');
    expect(gh.calls[1].url).toBe(`https://gh.test/repos/acme/app/contents/.termag/full%20stack/environment.json?ref=${BRANCH_SHA}`);
    expect(reader.cachedKeys()).toEqual([`acme/app@${BRANCH_SHA}:.termag/full stack/environment.json`]);
  });

  it("keeps the file's own repository where the file lists it, and reads the default branch with no branch named", async () => {
    const gh = github({ files: { [SHA1]: { status: 200, body: JSON.stringify({ repos: [{ repo: 'acme/web' }, { repo: 'Acme/App', path: 'core' }] }) } } });
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    const r = await resolveEnvironmentDefinition('u1', { ...POINTER, file: { ...POINTER.file, branch: null } }, reader);
    expect(r.repos).toEqual([{ repo: 'acme/web' }, { repo: 'acme/app', path: 'core' }]);
    expect(gh.calls[0].url).toBe('https://gh.test/repos/acme/app/commits/HEAD');
  });

  it('is a warning, never a failure, when the file is malformed, missing or out of sight: the project still gets the file\'s repository', async () => {
    const bad = github({ branches: { 'release/1': BRANCH_SHA }, files: { [BRANCH_SHA]: { status: 200, body: '{"resources":"xl","repos":[{"repo":"nope"}]}' } } });
    const r1 = await resolveEnvironmentDefinition('u1', POINTER, createRepoEnvironmentReader({ fetchImpl: bad.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' }));
    expect(r1.repos).toEqual([{ repo: 'acme/app', branch: 'release/1' }]);
    expect(r1.warnings).toEqual([expect.stringContaining('"repos": "nope" is not a GitHub repository'), expect.stringContaining('"resources" is "xl"')]);
    const none = github({ branches: { 'release/1': BRANCH_SHA }, files: {} });
    expect(await resolveEnvironmentDefinition('u1', POINTER, createRepoEnvironmentReader({ fetchImpl: none.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' }))).toEqual({
      repos: [{ repo: 'acme/app', branch: 'release/1' }], sizes: null,
      warnings: ["full-stack's file, acme/app:release/1:.termag/full stack/environment.json, is not there, so it was left out"],
    });
    const nobranch = github({ branches: {} });
    expect((await resolveEnvironmentDefinition('u1', POINTER, createRepoEnvironmentReader({ fetchImpl: nobranch.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' }))).warnings)
      .toEqual([expect.stringContaining("on release/1, which GitHub doesn't show you")]);
  });

  it("keeps the 8-repository cap and unique checkout directories once the file's own repository is added (Bugbot, #985)", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ repo: `acme/r${i}` }));
    const full = github({ branches: { 'release/1': BRANCH_SHA }, files: { [BRANCH_SHA]: { status: 200, body: JSON.stringify({ repos: eight }) } } });
    const r1 = await resolveEnvironmentDefinition('u1', POINTER, createRepoEnvironmentReader({ fetchImpl: full.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' }));
    expect(r1.repos).toHaveLength(8);
    expect(r1.repos[0]).toEqual({ repo: 'acme/app', branch: 'release/1' });
    expect(r1.repos.map(r => r.repo)).not.toContain('acme/r7');
    expect(r1.warnings).toEqual([expect.stringContaining('acme/r7 was left out')]);

    // A listed repository checked out as "app" would share the file's own repository's directory.
    const clash = github({ branches: { 'release/1': BRANCH_SHA }, files: { [BRANCH_SHA]: { status: 200, body: JSON.stringify({ repos: [{ repo: 'acme/api', path: 'app' }, { repo: 'acme/web' }] }) } } });
    const r2 = await resolveEnvironmentDefinition('u1', POINTER, createRepoEnvironmentReader({ fetchImpl: clash.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' }));
    expect(r2.repos).toEqual([{ repo: 'acme/app', branch: 'release/1' }, { repo: 'acme/web' }]);
    expect(r2.warnings).toEqual([expect.stringContaining('acme/api was left out')]);
  });

  it('reads an inline definition as it is stored, with no GitHub call', async () => {
    const gh = github();
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    expect(await resolveEnvironmentDefinition('u1', { name: 'inl', kind: 'inline', definition: { resources: { vcpu: 4, memoryGiB: 32 }, repos: ['acme/app'] } }, reader))
      .toEqual({ repos: [{ repo: 'acme/app' }], sizes: { size: { vcpu: 4, memoryGiB: 32 } }, warnings: [] });
    expect(gh.calls).toEqual([]);
  });

  it("parses the design's examples: termag's own file and webapp's", () => {
    const termag = { resources: { vcpu: 4, memoryGiB: 32 }, setup: 'bash .cursor/install.sh', run: 'bash .cursor/start.sh', ports: [{ name: 'frontend', port: 5174, health: '/termag/' }], seed: 'bash scripts/e2e/seed.sh' };
    expect(parseEnvironmentData(termag, 'termag')).toEqual({ sizes: { size: { vcpu: 4, memoryGiB: 32 } }, repos: null, warnings: [] });
    const webapp = {
      resources: { vcpu: 4, memoryGiB: 32 }, setup: 'bash .termag/setup.sh', run: 'DEV_NONINTERACTIVE=1 make dev', slots: { max: 8 },
      env: { DEV_INSTANCE: '${slot}' }, envFile: 'dev-stack/.env.override', host: '127.0.0.${slot}',
      ports: [{ name: 'app', port: 80, health: '/' }, { name: 'assets', port: { base: 3002, step: 10 } }], secrets: ['APP_API_KEY'],
      repos: [{ repo: 'example-org/webapp' }, { repo: 'example-org/frontend', path: 'frontend' }],
    };
    expect(parseEnvironmentData(webapp, 'webapp')).toEqual({
      sizes: { size: { vcpu: 4, memoryGiB: 32 } }, repos: [{ repo: 'example-org/webapp' }, { repo: 'example-org/frontend', path: 'frontend' }], warnings: [],
    });
  });
});

describe('the reader: the default branch\'s head, then the file at that commit, cached by commit', () => {
  it('reads the file at the head commit with the owner\'s token, as raw content', async () => {
    const gh = github();
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => 'gho_tok', apiBase: 'https://gh.test' });
    expect(await reader.read('u1', 'https://github.com/Acme/App.git')).toEqual({
      repo: 'acme/app', commit: SHA1, sizes: { size: 'medium' }, repos: null, warnings: [],
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
    expect(await reader.read('u1', 'acme/app')).toEqual({ repo: 'acme/app', commit: SHA2, sizes: null, repos: null, warnings: [] });
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
    expect(await reader.read('u1', 'acme/secret')).toEqual({ repo: 'acme/secret', commit: null, sizes: null, repos: null, warnings: [] });
  });

  it('warns, and caches nothing, when GitHub fails or does not answer', async () => {
    const down = createRepoEnvironmentReader({
      fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
      loadToken: async () => null, apiBase: 'https://gh.test',
    });
    expect(await down.read('u1', 'acme/app')).toEqual({
      repo: 'acme/app', commit: null, sizes: null, repos: null, unread: true,
      warnings: ["couldn't read acme/app's .termag/environment.json (GitHub could not be reached), so it was left out"],
    });
    const gh = github({ files: { [SHA1]: { status: 500, body: 'oops' } } });
    const flaky = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    const flakyRead = await flaky.read('u1', 'acme/app');
    expect(flakyRead?.warnings).toEqual([expect.stringContaining('GitHub answered 500')]);
    // The commit is known and the file isn't: unread says so, as the pool's repos cache reads it.
    expect(flakyRead).toMatchObject({ commit: SHA1, unread: true });
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

describe('parseRepoEnvironment: setupEnabled and flavor', () => {
  it('reads setupEnabled true and false, beside resources', () => {
    expect(parseRepoEnvironment('{"setupEnabled":false}')).toEqual({ sizes: { size: null }, repos: null, setupEnabled: false, warnings: [] });
    expect(parseRepoEnvironment('{"resources":"medium","setupEnabled":true}')).toEqual({ sizes: { size: 'medium' }, repos: null, setupEnabled: true, warnings: [] });
  });

  it('leaves out a setupEnabled that isn\'t a boolean with a warning of its own, never failing the size', () => {
    const got = parseRepoEnvironment('{"resources":"small","setupEnabled":"false"}', 'acme/app');
    expect(got.sizes).toEqual({ size: 'small' });
    expect(got.setupEnabled).toBeUndefined();
    expect(got.warnings).toEqual([]);
    expect(got.setupWarnings).toEqual([expect.stringContaining('acme/app\'s .termag/environment.json: "setupEnabled" is "false", not true or false')]);
  });

  it('ignores a flavor, the box\'s image, with a warning: it isn\'t supported yet', () => {
    const got = parseRepoEnvironment('{"resources":"small","flavor":"lean"}', 'acme/app');
    expect(got.sizes).toEqual({ size: 'small' });
    expect(got).not.toHaveProperty('flavor');
    expect(got.warnings).toEqual([expect.stringContaining('acme/app\'s .termag/environment.json: "flavor" isn\'t supported yet, so it was ignored')]);
  });
});

describe('repoSetupFor: setup off only when every repository says so', () => {
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

  it('is off for one repository that says so, naming it', async () => {
    serve({ 'acme/bare': '{"setupEnabled":false}' });
    expect(await repoSetupFor('u1', ['https://github.com/acme/bare'])).toEqual({ setupEnabled: false, repos: ['acme/bare'], warnings: [], readWarnings: [] });
  });

  it('is on when the repositories disagree, and says why', async () => {
    serve({ 'acme/bare': '{"setupEnabled":false}', 'acme/full': '{"resources":"small"}' });
    const got = await repoSetupFor('u1', ['acme/bare', 'acme/full']);
    expect(got.setupEnabled).toBe(true);
    expect(got.repos).toEqual([]);
    expect(got.warnings).toEqual([expect.stringContaining('acme/bare turns termag setup off and acme/full does not')]);
  });

  it('is nothing with no repository, no file, or no setupEnabled in it', async () => {
    serve({ 'acme/none': null, 'acme/sized': '{"resources":"small"}' });
    expect(await repoSetupFor('u1', [])).toEqual({ setupEnabled: null, repos: [], warnings: [], readWarnings: [] });
    expect(await repoSetupFor('u1', ['acme/none', 'acme/sized'])).toEqual({ setupEnabled: null, repos: [], warnings: [], readWarnings: [] });
  });

  it('carries a bad setupEnabled\'s warning, not the size\'s (repoSizesFor says those)', async () => {
    serve({ 'acme/typo': '{"resources":"huge","setupEnabled":"no"}' });
    const got = await repoSetupFor('u1', ['acme/typo']);
    expect(got.setupEnabled).toBeNull();
    expect(got.warnings).toEqual([expect.stringContaining('"setupEnabled" is "no"')]);
    expect(got.readWarnings).toEqual([expect.stringContaining('"resources"')]);
  });

  it('carries why a file could not be read, for a caller that did not read the sizes (Bugbot, #983)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const got = await repoSetupFor('u1', ['acme/down']);
    expect(got.setupEnabled).toBeNull();
    expect(got.warnings).toEqual([]);
    expect(got.readWarnings).toEqual([expect.stringContaining("couldn't read acme/down's .termag/environment.json (GitHub answered 500")]);
  });
});
// Bugbot on #998 (e1fbcadb): a pointer's resolve already read its file, so it hands the text on, and the project's
// create freezes that instead of reading the same GitHub file again.
describe("a pointer's resolve keeps the file's text", () => {
  it('returns the text it read with the repos and size, only when asked', async () => {
    const SHA = 'c'.repeat(40);
    const body = JSON.stringify({ resources: 'small', setup: 'make' });
    const gh = github({ branches: { main: SHA }, files: { [SHA]: { status: 200, body } } });
    const reader = createRepoEnvironmentReader({ fetchImpl: gh.fetchImpl, loadToken: async () => null, apiBase: 'https://gh.test' });
    const r = await resolveEnvironmentDefinition('u1', { name: 'e', kind: 'pointer', file: { repo: 'acme/app', branch: 'main', path: 'e.json' } }, reader);
    expect(r.text).toBe(body);
    const plain = await reader.read('u1', 'acme/app', 'e.json', 'main');
    expect(plain).not.toHaveProperty('text');
  });
});

