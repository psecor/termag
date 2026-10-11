import { describe, expect, it } from 'vitest';
import { repoKey as frontendRepoKey } from '../../../frontend/src/utils/repoPick';
import { repoKey } from './projectTemplates';

describe('repoKey', () => {
  it('matches the frontend on https, ssh, .git, a trailing slash, and a reject', () => {
    expect([
      'https://github.com/example-org/webapp',
      'git@github.com:example-org/research.git',
      'https://github.com/Example-Org/Webapp.git',
      'https://github.com/o/r/',
      'https://gitlab.com/o/r',
    ].map(url => [frontendRepoKey(url), repoKey(url)])).toEqual([
      ['example-org/webapp', 'example-org/webapp'],
      ['example-org/research', 'example-org/research'],
      ['example-org/webapp', 'example-org/webapp'],
      ['o/r', 'o/r'],
      [null, null],
    ]);
  });
});
