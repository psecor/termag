import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Using an environment: a project made from one holds
// exactly the repositories its definition resolves to, a single-repository
// project for one and a multi-repo project for more, and nothing else can be
// named alongside it.

vi.mock('../db', () => ({ prisma: {} }));
const { parseDefinition, parseEnvironmentInput, projectSourceFor, withEnvironmentRepos } = await import('./environments');

// These fixtures use acme/… repositories: count acme as one of our orgs here (environments.ts reposOutsideOrgs).
beforeAll(() => { vi.stubEnv('GITHUB_REPO_ORGS', 'example-org,example-team,acme'); });
afterAll(() => { vi.unstubAllEnvs(); });


const meta = { createdAt: new Date(), updatedAt: new Date(), createdByUserId: 'u1', updatedByUserId: 'u1', visibility: 'personal' as const, ownerUserId: 'u1' };
const FULL_STACK = { ...meta, id: 'e1', name: 'full-stack', kind: 'inline' as const, definition: { repos: [{ repo: 'example-org/webapp' }, { repo: 'example-org/web', branch: 'next', path: 'frontend' }] } };
// What a project made from it records for the box's steps (environmentFileRecord, services/projectEnvironment.ts).
const FULL_STACK_FILE = { name: 'full-stack', text: JSON.stringify(FULL_STACK.definition), editedBy: 'u1' };
const SOLO = { ...meta, id: 'e2', name: 'solo', kind: 'pointer' as const, file: { repo: 'acme/app', branch: 'dev', path: 'env.json' } };
const EMPTY = { ...meta, id: 'e3', name: 'empty', kind: 'pointer' as const, file: { repo: 'gitlab/x', branch: null, path: 'env.json' } };
const store = { byName: async (n: string) => [FULL_STACK, SOLO, EMPTY].find(e => e.name === n.trim().toLowerCase()) ?? null };
const resolve = vi.fn(async (_user: string, env: { name: string }) => (
  env.name === 'full-stack' ? { repos: FULL_STACK.definition.repos, sizes: null, warnings: [] }
    : env.name === 'solo' ? { repos: [{ repo: 'acme/app', branch: 'dev', path: 'ignored' }], sizes: null, warnings: ["solo's file, acme/app:dev:env.json, is not there, so it was left out"] }
    : { repos: [], sizes: null, warnings: ["empty's file names gitlab/x, which is not a GitHub repository"] }));

describe('projectSourceFor', () => {
  it('makes two or more repositories a multi-repo project, each at its path and branch, in order', () => {
    expect(projectSourceFor(FULL_STACK.definition.repos)).toEqual({
      repos: [
        { url: 'https://github.com/example-org/webapp' },
        { url: 'https://github.com/example-org/web', name: 'frontend', defaultBranch: 'next' },
      ],
    });
  });

  it('makes one repository a single-repository project on its branch', () => {
    expect(projectSourceFor([{ repo: 'acme/app', branch: 'dev', path: 'ignored' }])).toEqual({ repoUrl: 'https://github.com/acme/app', defaultBranch: 'dev' });
  });
});

describe('withEnvironmentRepos', () => {
  it('passes a create with no environment through untouched', async () => {
    const input = { name: 'p', repoUrl: 'https://github.com/acme/app' };
    expect(await withEnvironmentRepos(store, 'u1', input, resolve)).toEqual({ input, warnings: [] });
  });

  it("replaces the environment's name with the repositories it resolves to, for the creator, and records its definition for the box's steps", async () => {
    expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'Full-Stack', environmentRepos: [{ repo: 'example-org/webapp' }, { repo: 'example-org/web', branch: 'next' }] }, resolve)).toEqual({
      input: { name: 'p', ...projectSourceFor(FULL_STACK.definition.repos), environmentFile: FULL_STACK_FILE }, warnings: [], environmentId: 'e1',
    });
    expect(resolve).toHaveBeenLastCalledWith('u1', FULL_STACK);
  });

  it("makes a pointer whose file isn't there a project of the file's repository, with the warning", async () => {
    expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'solo', environmentRepos: [{ repo: 'acme/app', branch: 'dev' }] }, resolve)).toEqual({
      input: {
        name: 'p', repoUrl: 'https://github.com/acme/app', defaultBranch: 'dev',
        // A pointer: frozen at creation (projects.ts freezeEnvironmentFile), else read from the box's checkout.
        environmentFile: { name: 'solo', repo: 'acme/app', branch: 'dev', path: 'env.json', editedBy: 'u1' },
      },
      warnings: [expect.stringContaining('is not there')], environmentId: SOLO.id,
    });
  });

  it('refuses an environment that resolves to no repository', async () => {
    expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'empty', environmentRepos: [] }, resolve)).toMatchObject({ status: 400, body: { code: 'environment_no_repos' } });
  });

  describe('environmentRepos: every create is held to the checkouts the person was shown, resolved once (Full access or not)', () => {
    // As GET /resolved listed them: example-org/web on the definition's branch, next.
    const shown = [{ repo: 'example-org/webapp' }, { repo: 'example-org/web', branch: 'next' }];

    it('applies it when the one resolution is what they were shown, and drops environmentRepos from the create', async () => {
      resolve.mockClear();
      const result = await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', chatTrusted: true, environmentRepos: shown }, resolve);
      expect(result).toEqual({ input: { name: 'p', chatTrusted: true, ...projectSourceFor(FULL_STACK.definition.repos), environmentFile: FULL_STACK_FILE }, warnings: [], environmentId: 'e1' });
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('refuses with 409 when the environment now resolves to other repositories, so the trust is never recorded for them', async () => {
      for (const environmentRepos of [[shown[0]], [shown[0], { repo: 'evil/repo' }], [...shown].reverse()]) {
        expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', chatTrusted: true, environmentRepos }, resolve))
          .toMatchObject({ status: 409, body: { code: 'environment_repos_changed' } });
      }
    });

    it("refuses with 409 when a repository's branch differs from the one shown, so trust never follows an edit to another branch", async () => {
      for (const environmentRepos of [
        [shown[0], { repo: 'example-org/web', branch: 'evil' }],
        [shown[0], { repo: 'example-org/web' }],
        ['example-org/webapp', 'example-org/web'],
        [{ repo: 'example-org/webapp', branch: 'main' }, shown[1]],
      ]) {
        expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', chatTrusted: true, environmentRepos }, resolve))
          .toMatchObject({ status: 409, body: { code: 'environment_repos_changed' } });
      }
    });

    it('takes a bare owner/name for a repository on its default branch', async () => {
      expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', chatTrusted: true, environmentRepos: ['example-org/webapp', shown[1]] }, resolve))
        .toMatchObject({ warnings: [] });
    });

    it('refuses it with no list of what was shown', async () => {
      for (const environmentRepos of [undefined, 'example-org/webapp', [1], [{ repo: 1 }], [{ repo: 'a/b', branch: 2 }]]) {
        expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', chatTrusted: true, environmentRepos }, resolve))
          .toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      }
    });

    it('needs the list without Full access too: any later ask of the project runs them without asking', async () => {
      expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', chatTrusted: false }, resolve))
        .toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', environmentRepos: [shown[0]] }, resolve))
        .toMatchObject({ status: 409, body: { code: 'environment_repos_changed' } });
      expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'full-stack', environmentRepos: shown }, resolve))
        .toEqual({ input: { name: 'p', ...projectSourceFor(FULL_STACK.definition.repos), environmentFile: FULL_STACK_FILE }, warnings: [], environmentId: 'e1' });
    });
  });

  it('refuses an environment alongside repositories of its own', async () => {
    for (const extra of [{ repoUrl: 'https://github.com/acme/app' }, { repos: [] }, { defaultBranch: 'main' }]) {
      expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'solo', ...extra }, resolve)).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    }
  });

  it('answers 404 environment_not_found for a name there is none of', async () => {
    expect(await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'nope' }, resolve)).toEqual({
      status: 404, body: { error: 'There is no environment named "nope"', code: 'environment_not_found' },
    });
  });
});

// Bugbot on #998 (e1fbcadb): the project's record carries the text the resolve read, so createProjectFor's freeze
// (freezeEnvironmentFile, which keeps a record that has text) never reads the file a second time.
describe("a pointer environment's record", () => {
  it('carries the text its resolve read', async () => {
    const text = '{"setup":"make"}';
    const resolve = vi.fn(async () => ({ repos: [{ repo: 'acme/app', branch: 'dev' }], sizes: null, warnings: [], text }));
    const got = await withEnvironmentRepos(store, 'u1', { name: 'p', environment: 'solo', environmentRepos: [{ repo: 'acme/app', branch: 'dev' }] }, resolve);
    expect(got).toMatchObject({ input: { environmentFile: { name: 'solo', repo: 'acme/app', branch: 'dev', path: 'env.json', text } } });
  });
});

describe('a definition holding a secret (Bugbot, #985)', () => {
  // Built, so the repo's own secret scan doesn't take the fixture for one.
  const key = `AKIA${'A'.repeat(16)}`;
  const repos = [{ repo: 'acme/web' }];

  it("is refused before it's stored, naming the kind and not the value, wherever in the definition it sits", () => {
    for (const definition of [{ repos, env: { AWS_ACCESS_KEY_ID: key } }, { repos, setup: { install: `export K=${key} && npm ci` } }, JSON.stringify({ repos, env: { K: key } })]) {
      const r = parseDefinition(definition);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('AWS access key id');
      expect(!r.ok && r.error).not.toContain(key);
    }
    expect(parseEnvironmentInput({ name: 'leaky', kind: 'inline', definition: { repos, env: { K: key } } })).toMatchObject({ ok: false });
  });

  it('leaves a definition without one alone, names of variables included', () => {
    expect(parseDefinition({ repos, env: { AWS_ACCESS_KEY_ID: 'from-the-box' } })).toMatchObject({ ok: true });
  });
});
