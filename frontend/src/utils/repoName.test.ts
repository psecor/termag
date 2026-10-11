import { describe, it, expect } from 'vitest';
import { nameFromRepo } from './repoName';

// Documents the behaviour the Welcome wizard has shipped with: the server's
// suggestProjectName alphabet is [A-Za-z0-9_-], so dots become dashes.
describe('nameFromRepo', () => {
  it('takes the repo basename and drops .git and trailing slashes', () => {
    expect(nameFromRepo('https://github.com/example-org/webapp.git')).toBe('webapp');
    expect(nameFromRepo('git@github.com:org/weird_name-1/')).toBe('weird_name-1');
  });
  it('maps characters outside the name alphabet to dashes', () => {
    expect(nameFromRepo('https://github.com/org/my.repo')).toBe('my-repo');
  });
  it('falls back to "project" when there is no usable basename', () => {
    expect(nameFromRepo('')).toBe('project');
    expect(nameFromRepo('https://x/y/we ird!!')).toBe('project');
  });
});
