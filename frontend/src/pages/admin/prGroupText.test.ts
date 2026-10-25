import { describe, it, expect } from 'vitest';
import { groupSummary, groupToText, textToGroup } from './prGroupText';

describe('repo group text', () => {
  it('round-trips members and exclusions', () => {
    const g = { members: [{ kind: 'repo' as const, value: 'acme/app' }, { kind: 'topic' as const, value: 'sdk', org: 'example-org' }, { kind: 'topic' as const, value: 'x', org: 'other' }, { kind: 'pattern' as const, value: 'acme/*-sdk' }], excluded: ['acme/old'] };
    const text = groupToText(g);
    expect(text).toBe('repo acme/app\ntopic sdk\ntopic x other\npattern acme/*-sdk\nexclude acme/old');
    expect(textToGroup(text)).toEqual({ members: [g.members[0], { kind: 'topic', value: 'sdk' }, g.members[2], g.members[3]], excluded: ['acme/old'] });
  });
  it('skips blanks and comments, and reports the bad line', () => {
    expect(textToGroup('# sdks\n\nrepo a/b\n')).toEqual({ members: [{ kind: 'repo', value: 'a/b' }], excluded: [] });
    expect(textToGroup('repo a/b\nteam sdk')).toEqual({ error: 'line 2: kind must be repo, topic, pattern, path, share, key or exclude' });
    expect(textToGroup('repo a/b extra')).toEqual({ error: 'line 1: repo takes one value' });
    expect(textToGroup('exclude a/b')).toEqual({ error: 'a group needs at least one repo, topic, pattern or path' });
  });

  it('collects path, share and key lines into one path member per repo, and round-trips them', () => {
    const text = 'repo acme/sdk\npath acme/mono internal/ai/**\nkey acme/mono aic\npath acme/mono docs/ai/**\nshare acme/mono 25%\npath acme/core pkgs/ai/**';
    const g = textToGroup(text);
    expect(g).toEqual({ excluded: [], members: [
      { kind: 'repo', value: 'acme/sdk' },
      { kind: 'path', value: 'acme/mono', paths: ['internal/ai/**', 'docs/ai/**'], minShare: 0.25, keys: ['AIC'] },
      { kind: 'path', value: 'acme/core', paths: ['pkgs/ai/**'], minShare: 0.2, keys: [] },
    ] });
    if ('error' in g) throw new Error(g.error);
    expect(groupToText(g)).toBe('repo acme/sdk\npath acme/mono internal/ai/**\npath acme/mono docs/ai/**\nshare acme/mono 25%\nkey acme/mono AIC\npath acme/core pkgs/ai/**');
    expect(textToGroup(groupToText(g))).toEqual(g);
    expect(groupSummary(g)).toBe('repo acme/sdk · acme/mono by path (2 globs, ≥25%, or AIC-) · acme/core by path (1 glob, ≥20%)');
  });
  it('rejects a share or key without paths, a bad share, and a path line without a glob', () => {
    expect(textToGroup('key acme/mono AIC')).toEqual({ error: 'acme/mono: share and key lines need at least one path line' });
    expect(textToGroup('path acme/mono a/**\nshare acme/mono lots')).toEqual({ error: 'line 2: share is a percent, 0 to 100' });
    expect(textToGroup('path acme/mono')).toEqual({ error: 'line 1: expected "path <owner/name> <glob>"' });
  });
});
