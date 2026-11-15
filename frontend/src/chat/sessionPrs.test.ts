import { describe, expect, it } from 'vitest';
import type { PrRow } from '../services/api';
import type { AskView } from './asks';
import { sessionPrRefs } from './sessionPrs';

const pr = (repo: string, number: number) => ({ key: `${repo}#${number}`, number, url: `https://github.com/${repo}/pull/${number}`, branch: null });
const ask = (thread: string, prs: AskView['prs']) => ({ thread, title: `Ask ${thread}`, prs });

describe('sessionPrRefs', () => {
  it('lists all PRs from all asks, including finished asks and several PRs from one thread', () => {
    expect(sessionPrRefs(null, [ask('one', [pr('org/repo', 1), pr('org/repo', 2)]), ask('two', [pr('org/other', 1)])]))
      .toEqual([
        { key: 'org/repo#1', repo: 'org/repo', number: 1, ask: { thread: 'one', title: 'Ask one' } },
        { key: 'org/repo#2', repo: 'org/repo', number: 2, ask: { thread: 'one', title: 'Ask one' } },
        { key: 'org/other#1', repo: 'org/other', number: 1, ask: { thread: 'two', title: 'Ask two' } },
      ]);
  });

  it('keeps the session PR first and deduplicates follow-ups and asks by repository without case', () => {
    const own = { repo: 'Org/Repo', number: 2 } as PrRow;
    const refs = sessionPrRefs(own, [ask('one', [pr('org/repo', 1), pr('org/repo', 2)]), ask('two', [pr('ORG/REPO', 1)])]);
    expect(refs.map(p => p.key)).toEqual(['org/repo#2', 'org/repo#1']);
    expect(refs[0].ask).toBeNull();
    expect(refs[1].ask?.thread).toBe('one');
  });

  it('does not invent PRs for unknown asks or malformed links', () => {
    expect(sessionPrRefs(null, [ask('empty', []), ask('bad', [{ ...pr('org/repo', 1), url: 'not a PR' }, pr('org/repo', 0)])])).toEqual([]);
  });
});
