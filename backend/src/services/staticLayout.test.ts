import { describe, expect, it } from 'vitest';
import { STATIC_LAYOUT_CAPABILITY, WORKSPACE_STATIC_ROOT_CAPABILITY, staticCheckoutDir, staticCheckoutRoot, staticLayoutDecision, staticRepoName } from './staticLayout';

const project = {
  environmentId: 'env1', kind: 'normal', dir: null,
  repoUrl: 'https://github.com/acme/web.git',
  environmentFile: { name: 'web', text: JSON.stringify({ repos: [{ repo: 'acme/web' }] }) },
};
const box = { userId: 'u1', kind: 'ec2' };
const caps = ['project-clone-v1', STATIC_LAYOUT_CAPABILITY];

describe('the static layout', () => {
  it("puts a checkout at ~/code/<name> under the box home, never ~/src (the box image's)", () => {
    expect(staticCheckoutDir('/home/ada', 'web')).toBe('/home/ada/code/web');
    expect(staticCheckoutDir('/home/ada/', 'web.js')).toBe('/home/ada/code/web.js');
    expect(staticCheckoutRoot('/home/ada/')).toBe('/home/ada/code');
    for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a b', 'x'.repeat(101)]) expect(staticCheckoutDir('/home/ada', bad)).toBeNull();
  });

  it("names a repository's checkout by the definition's path for it, else by the repository's name", () => {
    expect(staticRepoName(project)).toBe('web');
    const withPath = { ...project, environmentFile: { name: 'web', text: JSON.stringify({ repos: [{ repo: 'acme/web', path: 'web-app' }] }) } };
    expect(staticRepoName(withPath)).toBe('web-app');
    // A path for another repository, or a file that isn't JSON, leaves the name.
    expect(staticRepoName({ ...project, environmentFile: { text: JSON.stringify({ repos: [{ repo: 'acme/api', path: 'x' }] }) } })).toBe('web');
    expect(staticRepoName({ ...project, repoUrl: null })).toBeNull();
  });

  it("keeps the project's own directory when the definition can't be read: its path for the repository is unknown", () => {
    // A pointer whose file couldn't be pinned when the project was made (projectEnvironment.ts freezeEnvironmentFile).
    expect(staticRepoName({ ...project, environmentFile: { name: 'web', repo: 'acme/web', path: '.termag/environment.json' } })).toBeNull();
    expect(staticRepoName({ ...project, environmentFile: { text: 'not json' } })).toBeNull();
    expect(staticRepoName({ ...project, environmentFile: null })).toBeNull();
    // A definition that lists no repos (a pointer's file in its own repository): no path, so the repository's name.
    expect(staticRepoName({ ...project, environmentFile: { repo: 'acme/web', path: 'x.json', text: JSON.stringify({ setup: 'true' }) } })).toBe('web');
  });

  it("is a box made from an environment's: its first project, from an environment, on a managed box whose agent can", () => {
    expect(staticLayoutDecision(project, box, caps, 0)).toEqual({ use: true });
    expect(staticLayoutDecision({ ...project, environmentId: null }, box, caps, 0)).toEqual({ use: false, why: 'no-environment' });
    expect(staticLayoutDecision({ ...project, kind: 'automation' }, box, caps, 0)).toEqual({ use: false, why: 'automation' });
    expect(staticLayoutDecision(project, box, caps, 1)).toEqual({ use: false, why: 'not-first' });
    expect(staticLayoutDecision(project, { userId: 'u1', kind: 'external' }, caps, 0)).toEqual({ use: false, why: 'not-managed' });
    expect(staticLayoutDecision(project, box, ['project-clone-v1'], 0)).toEqual({ use: false, why: 'old-agent' });
    // A multi-repo project's root needs the workspace capability.
    expect(staticLayoutDecision(project, box, caps, 0, WORKSPACE_STATIC_ROOT_CAPABILITY)).toEqual({ use: false, why: 'old-agent' });
    expect(staticLayoutDecision(project, box, [WORKSPACE_STATIC_ROOT_CAPABILITY], 0, WORKSPACE_STATIC_ROOT_CAPABILITY)).toEqual({ use: true });
  });

  it('keeps a project whose checkout is already static there, whatever else is on the box now', () => {
    expect(staticLayoutDecision({ ...project, dir: '/home/ada/code/web' }, box, caps, 3)).toEqual({ use: true });
  });
});
