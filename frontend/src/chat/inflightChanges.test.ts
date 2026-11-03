import { describe, expect, it } from 'vitest';
import { MAX_LISTED, endsToolCall, fileKind, inflightGroups, noPrChangesText } from './inflightChanges';

describe('endsToolCall', () => {
  it("is a tool's result, or the turn's", () => {
    expect(endsToolCall({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })).toBe(true);
    expect(endsToolCall({ type: 'result', subtype: 'success' })).toBe(true);
  });
  it('is not a prompt, a reply, a tool call starting, or anything malformed', () => {
    expect(endsToolCall({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(false);
    expect(endsToolCall({ type: 'user', message: { content: 'hi' } })).toBe(false);
    expect(endsToolCall({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit' }] } })).toBe(false);
    expect(endsToolCall(null)).toBe(false);
    expect(endsToolCall('result')).toBe(false);
  });
});

describe('inflightGroups', () => {
  const base = { available: true as const, branch: 'topic', upstream: null, against: 'origin/main', commits: 0, truncated: false, partial: false, worktree: null };
  it('lists what is not committed, then what is not pushed, with their totals, and skips an empty group', () => {
    const groups = inflightGroups({
      ...base, commits: 2,
      uncommitted: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1 }, { path: 'img.png', status: '?', additions: null, deletions: null }],
      committed: [{ path: 'b.ts', status: 'A', additions: 5, deletions: 0 }],
    });
    expect(groups.map(g => [g.key, g.label, g.files.length, g.additions, g.deletions])).toEqual([
      ['uncommitted', 'Not committed', 2, 3, 1],
      ['committed', 'Not pushed', 1, 5, 0],
    ]);
    expect(inflightGroups({ ...base, uncommitted: [], committed: [{ path: 'b.ts', status: 'A', additions: 1, deletions: 0 }] }).map(g => g.key)).toEqual(['committed']);
  });
  it('marks a group the box cut at its limit, and only that one', () => {
    const many = Array.from({ length: MAX_LISTED }, (_, i) => ({ path: `f${i}`, status: '?', additions: 1, deletions: 0 }));
    const groups = inflightGroups({ ...base, truncated: true, uncommitted: many, committed: [{ path: 'b.ts', status: 'A', additions: 1, deletions: 0 }] });
    expect(groups.map(g => [g.key, g.cut])).toEqual([['uncommitted', true], ['committed', false]]);
    expect(inflightGroups({ ...base, truncated: false, uncommitted: many, committed: [] })[0].cut).toBe(false);
  });
  it("keeps commits whose files the box couldn't list as a group with none", () => {
    const [g] = inflightGroups({ ...base, partial: true, commits: 3, uncommitted: [], committed: [] });
    expect([g.key, g.unlisted, g.files]).toEqual(['committed', 3, []]);
  });
  it('has none when the box could not say, or nothing is in flight', () => {
    expect(inflightGroups({ available: false, reason: 'outdated-agent' })).toEqual([]);
    expect(inflightGroups(null)).toEqual([]);
    expect(inflightGroups({ ...base, uncommitted: [], committed: [] })).toEqual([]);
  });
});

describe('fileKind', () => {
  it("is git's letter, an untracked file shown as added", () => {
    expect(['M', 'A', 'D', 'R', 'C', 'T', '?', 'U'].map(fileKind)).toEqual(['M', 'A', 'D', 'R', 'C', 'T', 'A', 'M']);
  });
});

describe('noPrChangesText', () => {
  it('says why a session with no PR lists nothing', () => {
    const none = { available: true as const, branch: 'main', upstream: null, against: null, commits: 0, committed: [], uncommitted: [], truncated: false, partial: false, worktree: null };
    expect(noPrChangesText(false, null)).toBe('Its pull request’s changes show here.');
    expect(noPrChangesText(true, null)).toBe('Reading its changes…');
    expect(noPrChangesText(true, none)).toBe('No changes yet');
    expect(noPrChangesText(true, { available: false, reason: 'offline' })).toBe('Its box is off, so its changes can’t be read');
    expect(noPrChangesText(true, { available: false, reason: 'outdated-agent' })).toBe('Its box can’t list changes until it updates');
    expect(noPrChangesText(true, { available: false, reason: 'unreadable' })).toBe('Couldn’t read its changes from the box');
  });
});
