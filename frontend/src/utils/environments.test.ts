import type { EnvironmentView } from '../services/api';
import { describe, expect, it } from 'vitest';
import { definitionError, describeEvent, draftFromEnvironment, draftInput, emptyEnvironmentDraft, environmentCommands, environmentLine, environmentMatches, environmentRepos, matchesEnvironment, pointerLabel, repoName, shareBlocker, visibilityGroups } from './environments';

const INLINE = { name: 'full-stack', kind: 'inline' as const, definition: { resources: 'large', repos: [{ repo: 'example-org/webapp' }] } };
const POINTER = { name: 'full-stack', kind: 'pointer' as const, file: { repo: 'example-org/webapp', branch: 'main', path: '.termag/full-stack/environment.json' } };

describe('the environment form', () => {
  it('sends an inline definition as typed, for the server to check against the schema', () => {
    const d = { ...emptyEnvironmentDraft(), name: ' full-stack ', definition: '{"repos":["a/b"]}' };
    expect(draftInput(d)).toEqual({ name: 'full-stack', kind: 'inline', definition: '{"repos":["a/b"]}' });
  });

  it('sends a pointer as owner/name, leaving an empty branch and path to the server', () => {
    const d = { ...emptyEnvironmentDraft(), name: 'x', kind: 'pointer' as const, fileRepo: 'https://github.com/Example-Org/Webapp.git' };
    expect(draftInput(d)).toEqual({ name: 'x', kind: 'pointer', file: { repo: 'example-org/webapp' } });
    expect(draftInput({ ...d, fileBranch: ' main ', filePath: 'env.json' })).toEqual({ name: 'x', kind: 'pointer', file: { repo: 'example-org/webapp', branch: 'main', path: 'env.json' } });
  });

  it('round-trips both forms, and says when the JSON is not an object', () => {
    expect(JSON.parse(draftFromEnvironment(INLINE).definition)).toEqual(INLINE.definition);
    expect(draftInput(draftFromEnvironment(POINTER))).toEqual({ name: 'full-stack', kind: 'pointer', file: { repo: 'example-org/webapp', branch: 'main', path: '.termag/full-stack/environment.json' } });
    expect(definitionError('{"a":1}')).toBeNull();
    expect(definitionError('[1]')).toMatch(/JSON object/);
    expect(definitionError('{ nope')).toMatch(/Not valid JSON/);
    expect(definitionError(emptyEnvironmentDraft().definition)).toBeNull();
    expect(repoName('git@github.com:Acme/Web.git')).toBe('acme/web');
  });

  it('writes a pointer repo : branch : path, and shows the commands that create from it', () => {
    expect(pointerLabel(POINTER.file)).toBe('example-org/webapp : main : .termag/full-stack/environment.json');
    expect(pointerLabel({ ...POINTER.file, branch: null })).toBe('example-org/webapp : default branch : .termag/full-stack/environment.json');
    expect(environmentCommands('full-stack')).toEqual([
      'termag project create <box>/<name> --agent claude --environment full-stack',
      'termag project create <box>/<name> --agent claude --new-box --environment full-stack',
    ]);
  });
});

describe('the audit log', () => {
  it('says what a create made and what a delete removed', () => {
    expect(describeEvent({ action: 'environment.create', before: null, after: INLINE })).toEqual(['Inline definition (resources, repos)']);
    expect(describeEvent({ action: 'environment.delete', before: POINTER, after: null })).toEqual(['File example-org/webapp : main : .termag/full-stack/environment.json']);
  });

  it("lists an inline definition's changes key by key", () => {
    const after = { name: 'stack', kind: 'inline' as const, definition: { resources: 'medium', repos: INLINE.definition.repos, base: 'empty' } };
    expect(describeEvent({ action: 'environment.update', before: INLINE, after })).toEqual([
      'Renamed full-stack → stack',
      'resources: "large" → "medium"',
      'Added base: "empty"',
    ]);
  });

  it('lists a repos edit repository by repository', () => {
    const before = { ...INLINE, definition: { repos: [{ repo: 'a/web', path: 'frontend' }, 'a/old'] } };
    const after = { ...INLINE, definition: { repos: [{ repo: 'a/web', path: 'frontend', branch: 'main' }, { repo: 'a/api' }] } };
    expect(describeEvent({ action: 'environment.update', before, after })).toEqual([
      'a/web (in frontend/) → a/web (branch main, in frontend/)', 'Added a/api', 'Removed a/old',
    ]);
  });

  it('says when an environment moves between forms, or its pointer changes', () => {
    expect(describeEvent({ action: 'environment.update', before: INLINE, after: POINTER })).toEqual([
      'Inline definition (resources, repos) → File example-org/webapp : main : .termag/full-stack/environment.json',
    ]);
    expect(describeEvent({ action: 'environment.update', before: POINTER, after: { ...POINTER, file: { ...POINTER.file, branch: null } } })).toEqual([
      'File example-org/webapp : main : .termag/full-stack/environment.json → example-org/webapp : default branch : .termag/full-stack/environment.json',
    ]);
  });
});

describe("New session's environment dialog", () => {
  const base = { name: 'x' } as const;
  it("says what an environment clones: an inline definition's repositories, a pointer's file", () => {
    expect(environmentLine({ ...base, kind: 'inline', definition: { repos: [{ repo: 'acme/web' }, 'acme/api'] } })).toBe('acme/web, acme/api');
    expect(environmentLine({ ...base, kind: 'inline', definition: { repos: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'] } })).toBe('a/1, a/2, a/3 and 2 more');
    expect(environmentLine({ ...base, kind: 'inline', definition: { resources: 'large' } })).toBe('Names no repository');
    expect(environmentLine({ ...base, kind: 'pointer', file: { repo: 'acme/shop', branch: 'env', path: '.termag/shop.json' } }))
      .toBe('From acme/shop : env : .termag/shop.json');
  });
});

describe("New session's environment dialog: search", () => {
  const env = (name: string, repos: string[]): EnvironmentView => ({
    id: name, name, kind: 'inline', definition: { repos }, createdAt: '', updatedAt: '', createdBy: null, updatedBy: null, visibility: 'personal' as const, owner: null,
  });
  const many = Array.from({ length: 60 }, (_, i) => env(`env-${String(i + 1).padStart(2, '0')}`, [`acme/repo-${i + 1}`]));
  const shop: EnvironmentView = {
    id: 'shop', name: 'shop', kind: 'pointer', file: { repo: 'Acme/Storefront', branch: null, path: '.termag/environment.json' },
    createdAt: '', updatedAt: '', createdBy: null, updatedBy: null, visibility: 'personal' as const, owner: null,
  };

  it("lists an environment's repositories: an inline definition's, a pointer's file's", () => {
    expect(environmentRepos(env('a', ['acme/web', 'acme/api']))).toEqual(['acme/web', 'acme/api']);
    expect(environmentRepos({ name: 'b', kind: 'inline', definition: { repos: [{ repo: 'acme/x' }, 'acme/y', 7] } })).toEqual(['acme/x', 'acme/y']);
    expect(environmentRepos(shop)).toEqual(['Acme/Storefront']);
  });

  it('matches by name or by repository, ignoring case and surrounding space', () => {
    expect(matchesEnvironment(shop, '')).toBe(true);
    expect(matchesEnvironment(shop, ' SHO ')).toBe(true);
    expect(matchesEnvironment(shop, 'storefront')).toBe(true);
    expect(matchesEnvironment(shop, 'acme/store')).toBe(true);
    expect(matchesEnvironment(shop, 'web')).toBe(false);
  });

  it('lists every match, in list order, with no limit', () => {
    expect(environmentMatches(many, { query: '', selected: null }).rows).toEqual(many);
    expect(environmentMatches(many, { query: 'env-1', selected: null }).rows.map(e => e.name))
      .toEqual(['env-10', 'env-11', 'env-12', 'env-13', 'env-14', 'env-15', 'env-16', 'env-17', 'env-18', 'env-19']);
    expect(environmentMatches(many, { query: 'zzz', selected: null }).rows).toEqual([]);
  });

  it('pins the selected environment only when the search filters it out', () => {
    // Unfiltered it is in the list, however far down: not pinned.
    expect(environmentMatches(many, { query: '', selected: 'env-60' }).pinned).toBeNull();
    expect(environmentMatches(many, { query: 'repo-60', selected: 'env-60' }).pinned).toBeNull();
    expect(environmentMatches(many, { query: 'env-1', selected: 'env-42' }).pinned?.name).toBe('env-42');
    expect(environmentMatches(many, { query: 'zzz', selected: 'env-42' }).pinned?.name).toBe('env-42');
    // A selected name the list doesn't have (a deleted environment) pins nothing.
    expect(environmentMatches(many, { query: 'env-1', selected: 'gone' }).pinned).toBeNull();
  });
});

describe('personal and shared', () => {
  it('groups personal first, then shared, each in list order, leaving out an empty group', () => {
    const list = [{ name: 'b', visibility: 'shared' as const }, { name: 'a', visibility: 'personal' as const }, { name: 'c', visibility: 'shared' as const }];
    expect(visibilityGroups(list).map(g => [g.label, g.items.map(e => e.name)])).toEqual([['Personal', ['a']], ['Shared', ['b', 'c']]]);
    expect(visibilityGroups(list.filter(e => e.visibility === 'shared')).map(g => g.label)).toEqual(['Shared']);
  });
  it('says the rule for sharing an inline draft, and leaves a pointer to the server', () => {
    expect(shareBlocker({ kind: 'inline' })).toMatch(/runs from a file on a repository's default branch, not inline JSON/);
    expect(shareBlocker({ kind: 'pointer' })).toBeNull();
  });
  it('describes a switch, and says what a new one was made', () => {
    expect(describeEvent({ action: 'environment.visibility', before: { ...POINTER, visibility: 'personal' }, after: { ...POINTER, visibility: 'shared' } })).toEqual(['Personal → Shared']);
    expect(describeEvent({ action: 'environment.create', before: null, after: { ...POINTER, visibility: 'personal' } }))
      .toEqual(['File example-org/webapp : main : .termag/full-stack/environment.json, personal']);
  });
});
