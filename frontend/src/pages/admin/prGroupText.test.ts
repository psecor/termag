import { describe, it, expect } from 'vitest';
import { groupToText, textToGroup } from './prGroupText';

describe('repo group text', () => {
  it('round-trips members and exclusions', () => {
    const g = { members: [{ kind: 'repo' as const, value: 'acme/app' }, { kind: 'topic' as const, value: 'sdk', org: 'example-org' }, { kind: 'topic' as const, value: 'x', org: 'other' }, { kind: 'pattern' as const, value: 'acme/*-sdk' }], excluded: ['acme/old'] };
    const text = groupToText(g);
    expect(text).toBe('repo acme/app\ntopic sdk\ntopic x other\npattern acme/*-sdk\nexclude acme/old');
    expect(textToGroup(text)).toEqual({ members: [g.members[0], { kind: 'topic', value: 'sdk' }, g.members[2], g.members[3]], excluded: ['acme/old'] });
  });
  it('skips blanks and comments, and reports the bad line', () => {
    expect(textToGroup('# sdks\n\nrepo a/b\n')).toEqual({ members: [{ kind: 'repo', value: 'a/b' }], excluded: [] });
    expect(textToGroup('repo a/b\nteam sdk')).toEqual({ error: 'line 2: kind must be repo, topic, pattern or exclude' });
    expect(textToGroup('repo a/b extra')).toEqual({ error: 'line 1: repo takes one value' });
    expect(textToGroup('exclude a/b')).toEqual({ error: 'a group needs at least one repo, topic or pattern' });
  });
});
