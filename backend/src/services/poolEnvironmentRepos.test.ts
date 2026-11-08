import { describe, it, expect, vi } from 'vitest';
import type { EnvironmentRecord } from './environments';
import type { RepoEnvironmentReader } from './repoEnvironment';
import { createPoolEnvironmentRepos } from './poolEnvironmentRepos';
import { notifyPoolCredentialChange } from './poolCredential';

const meta = { createdAt: new Date(0), updatedAt: new Date(0), createdByUserId: 'u1', updatedByUserId: 'u1', ownerUserId: 'u1' };
const envs: Record<string, EnvironmentRecord> = {
  shared: { ...meta, id: 'shared', name: 'termag', kind: 'pointer', visibility: 'shared', file: { repo: 'example-org/termag', branch: null, path: '.termag/environment.json' } },
  personal: { ...meta, id: 'personal', name: 'mine', kind: 'inline', visibility: 'personal', definition: { repos: ['example-org/termag'] } },
};

function reader(): RepoEnvironmentReader {
  return {
    read: vi.fn(async (_u: string, repo: string) => ({ repo, commit: 'a'.repeat(40), sizes: null, repos: [{ repo: 'Example-Org/Webapp' }], warnings: [] })),
    cachedKeys: () => [], text: async () => ({ error: 'unused' }), defaultBranch: async () => ({ error: 'unused' }),
  } as unknown as RepoEnvironmentReader;
}

describe('createPoolEnvironmentRepos', () => {
  it("lists a shared environment's repositories, its file's own first, lower case", async () => {
    const repos = createPoolEnvironmentRepos({ store: { get: async id => envs[id] ?? null }, reader: reader() });
    expect(await repos('shared')).toEqual(['example-org/termag', 'example-org/webapp']);
  });

  it('has none for a personal or missing environment', async () => {
    const repos = createPoolEnvironmentRepos({ store: { get: async id => envs[id] ?? null }, reader: reader() });
    expect(await repos('personal')).toBeNull();
    expect(await repos('gone')).toBeNull();
  });

  it("caches each environment's GitHub resolve for a minute", async () => {
    let t = 0;
    const r = reader();
    const repos = createPoolEnvironmentRepos({ store: { get: async id => envs[id] ?? null }, reader: r, now: () => t });
    await repos('shared'); await repos('shared');
    expect(r.read).toHaveBeenCalledTimes(1);
    t = 61_000; await repos('shared');
    expect(r.read).toHaveBeenCalledTimes(2);
  });

  it('reads the environment on every lookup: one made personal, or deleted, has no repositories at once', async () => {
    let env: EnvironmentRecord | null = envs.shared;
    const repos = createPoolEnvironmentRepos({ store: { get: async () => env }, reader: reader() });
    expect(await repos('shared')).toEqual(['example-org/termag', 'example-org/webapp']);
    env = { ...envs.shared, visibility: 'personal' };
    expect(await repos('shared')).toBeNull();
    env = null;
    expect(await repos('shared')).toBeNull();
  });

  it('resolves again when the environment changed, within the minute', async () => {
    const r = reader();
    let env: EnvironmentRecord = envs.shared;
    const repos = createPoolEnvironmentRepos({ store: { get: async () => env }, reader: r });
    await repos('shared');
    env = { ...envs.shared, updatedAt: new Date(1000), file: { ...envs.shared.file, path: 'other/environment.json' } } as EnvironmentRecord;
    await repos('shared');
    expect(r.read).toHaveBeenCalledTimes(2);
  });

  it('does not cache a list it could not read in full, so a recovery is seen at once', async () => {
    const r = reader();
    // GitHub unreachable, then back: the first resolve has only the file's own repository.
    (r.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ repo: 'example-org/termag', commit: null, sizes: null, repos: null, unread: true, warnings: ["couldn't read example-org/termag's .termag/environment.json (GitHub could not be reached), so it was left out"] });
    const repos = createPoolEnvironmentRepos({ store: { get: async id => envs[id] ?? null }, reader: r });
    expect(await repos('shared')).toEqual(['example-org/termag']);
    expect(await repos('shared')).toEqual(['example-org/termag', 'example-org/webapp']);
  });

  it('does not cache a read GitHub answered without the repository (no credential, or one that cannot see it)', async () => {
    const r = reader();
    (r.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ repo: 'example-org/termag', commit: null, sizes: null, repos: null, warnings: [] });
    const repos = createPoolEnvironmentRepos({ store: { get: async id => envs[id] ?? null }, reader: r });
    expect(await repos('shared')).toEqual(['example-org/termag']);
    expect(await repos('shared')).toEqual(['example-org/termag', 'example-org/webapp']);
  });

  it('forgets every environment when the pool credential is set or deleted', async () => {
    const r = reader();
    const repos = createPoolEnvironmentRepos({ store: { get: async id => envs[id] ?? null }, reader: r, forgetOnCredentialChange: true });
    await repos('shared');
    notifyPoolCredentialChange();
    await repos('shared');
    expect(r.read).toHaveBeenCalledTimes(2);
    repos.stop();
  });
});
