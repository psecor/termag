import { describe, expect, it } from 'vitest';
import type { SpaceBoxGrant, SpaceView } from '../services/api';
import {
  boxSpaceIndex, canStartChatIn, COLLAPSED_SPACES_KEY, ensureSpace, grantBox, groupBySpace, groupKey, initialSpaceChoice, pickableSpaces, readCollapsedSpaces, slugifySpaceName,
  spaceChoiceError, spaceOfBox, spaceTriggerLabel, toggleCollapsedSpace, type SpaceGrantApi,
} from './chatSpaces';
import { SPACE_NAME_RE } from '../utils/spaces';

function space(name: string, role: SpaceView['role'] = 'owner', readOnly = false): SpaceView {
  return { id: `id-${name}`, name, description: null, createdAt: '2026-10-19T00:00:00Z', usedBytes: 0, quotaBytes: 1, role, readOnly };
}

function grant(id: string, children: string[] = []): SpaceBoxGrant {
  return { id, name: id, kind: 'ec2', status: 'ready', ownerEmail: null, mine: true, children: children.map(c => ({ id: c, name: c, via: id })) };
}

function fakeApi() {
  const calls: string[] = [];
  let failCreate: Error | null = null;
  let failAdd: Error | null = null;
  const api: SpaceGrantApi = {
    async create(name) { calls.push(`create ${name}`); if (failCreate) throw failCreate; },
    async addBox(s, box) { calls.push(`addBox ${s} ${box}`); if (failAdd) throw failAdd; },
  };
  return { api, calls, failCreate: (e: Error | null) => { failCreate = e; }, failAdd: (e: Error | null) => { failAdd = e; } };
}

describe('pickableSpaces', () => {
  it('offers spaces the user can edit, by name, never read-only ones', () => {
    const got = pickableSpaces([space('zeta'), space('alpha', 'editor'), space('view', 'viewer'), space('frozen', 'owner', true)]);
    expect(got.map(s => s.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('canStartChatIn', () => {
  it('is true only for spaces the user can edit and that are not read-only', () => {
    const spaces = [space('notes'), space('mine', 'editor'), space('view', 'viewer'), space('frozen', 'owner', true)];
    expect(canStartChatIn('notes', spaces)).toBe(true);
    expect(canStartChatIn('mine', spaces)).toBe(true);
    expect(canStartChatIn('view', spaces)).toBe(false);
    expect(canStartChatIn('frozen', spaces)).toBe(false);
    expect(canStartChatIn('gone', spaces)).toBe(false);
  });
});

describe('initialSpaceChoice', () => {
  it('preselects ?space= only when the user can use it', () => {
    const spaces = [space('notes'), space('ro', 'viewer')];
    expect(initialSpaceChoice('notes', spaces)).toEqual({ kind: 'existing', name: 'notes' });
    expect(initialSpaceChoice('ro', spaces)).toEqual({ kind: 'none' });
    expect(initialSpaceChoice('gone', spaces)).toEqual({ kind: 'none' });
    expect(initialSpaceChoice(null, spaces)).toEqual({ kind: 'none' });
  });

  it('falls back to the remembered space, while the user can still use it', () => {
    const spaces = [space('notes'), space('docs'), space('ro', 'viewer')];
    expect(initialSpaceChoice(null, spaces, 'docs')).toEqual({ kind: 'existing', name: 'docs' });
    expect(initialSpaceChoice('notes', spaces, 'docs')).toEqual({ kind: 'existing', name: 'notes' });
    expect(initialSpaceChoice('gone', spaces, 'docs')).toEqual({ kind: 'existing', name: 'docs' });
    expect(initialSpaceChoice(null, spaces, 'ro')).toEqual({ kind: 'none' });
    expect(initialSpaceChoice(null, spaces, 'gone')).toEqual({ kind: 'none' });
  });
});

describe('spaceChoiceError', () => {
  const spaces = [space('notes'), space('ro', 'viewer')];

  it('lets no space through', () => {
    expect(spaceChoiceError({ kind: 'none' }, spaces)).toBe('');
  });

  it('wants an existing space the user can edit', () => {
    expect(spaceChoiceError({ kind: 'existing', name: 'notes' }, spaces)).toBe('');
    expect(spaceChoiceError({ kind: 'existing', name: 'ro' }, spaces)).toBe('Pick a space');
  });

  it('checks a new name against the backend\'s rule and the user\'s own spaces', () => {
    expect(spaceChoiceError({ kind: 'new', name: '' }, spaces)).toBe('Name the new space');
    expect(spaceChoiceError({ kind: 'new', name: 'Bad Name' }, spaces)).toMatch(/a-z, 0-9/);
    expect(spaceChoiceError({ kind: 'new', name: 'notes' }, spaces)).toMatch(/already have a space named notes/);
    expect(spaceChoiceError({ kind: 'new', name: 'fresh' }, spaces)).toBe('');
  });

  it('does not refuse a new space this page already created', () => {
    expect(spaceChoiceError({ kind: 'new', name: 'notes' }, spaces, new Set(['notes']))).toBe('');
  });
});

describe('ensureSpace and grantBox', () => {
  it('does nothing for no space', async () => {
    const f = fakeApi();
    expect(await ensureSpace({ kind: 'none' }, new Set(), f.api, () => {})).toBeNull();
    await grantBox(null, 'box1', f.api);
    expect(f.calls).toEqual([]);
  });

  it('uses an existing space without creating it', async () => {
    const f = fakeApi();
    const s = await ensureSpace({ kind: 'existing', name: 'notes' }, new Set(), f.api, () => {});
    await grantBox(s, 'box1', f.api);
    expect(f.calls).toEqual(['addBox notes box1']);
  });

  it('creates a new space once, and a retry after a failed grant reuses it', async () => {
    const f = fakeApi();
    const created = new Set<string>();
    const choice = { kind: 'new' as const, name: 'fresh' };
    f.failAdd(new Error('boom'));
    const s = await ensureSpace(choice, created, f.api, n => created.add(n));
    await expect(grantBox(s, 'box1', f.api)).rejects.toThrow('boom');
    f.failAdd(null);
    const again = await ensureSpace(choice, created, f.api, n => created.add(n));
    await grantBox(again, 'box1', f.api);
    expect(f.calls).toEqual(['create fresh', 'addBox fresh box1', 'addBox fresh box1']);
  });

  it('records nothing when the create is refused', async () => {
    const f = fakeApi();
    const created = new Set<string>();
    f.failCreate(new Error('taken'));
    await expect(ensureSpace({ kind: 'new', name: 'taken' }, created, f.api, n => created.add(n))).rejects.toThrow('taken');
    expect(created.size).toBe(0);
  });
});

describe('boxSpaceIndex', () => {
  it('maps each box to its spaces, explicit before inherited, each by name', () => {
    const index = boxSpaceIndex([
      { space: 'zeta', boxes: [grant('b1', ['child'])] },
      { space: 'alpha', boxes: [grant('b1'), grant('b2')] },
      { space: 'mid', boxes: [grant('child')] },
    ]);
    expect(index.get('b1')).toEqual(['alpha', 'zeta']);
    expect(index.get('b2')).toEqual(['alpha']);
    expect(index.get('child')).toEqual(['mid', 'zeta']);
    expect(index.has('nobox')).toBe(false);
  });
});

describe('groupBySpace', () => {
  const rows = [
    { key: 'a', instanceId: 'b1' },
    { key: 'b', instanceId: 'b2' },
    { key: 'c', instanceId: null },
    { key: 'd', instanceId: 'b1' },
    { key: 'e', instanceId: 'b3' },
  ];

  it('groups by the box\'s first space, by name, then No space, keeping row order', () => {
    const index = new Map([['b1', ['notes']], ['b2', ['assets', 'notes']]]);
    const groups = groupBySpace(rows, index);
    expect(groups.map(g => [g.space, g.rows.map(r => r.row.key)])).toEqual([
      ['assets', ['b']],
      ['notes', ['a', 'd']],
      [null, ['c', 'e']],
    ]);
    expect(groups[0].rows[0].alsoIn).toEqual(['notes']);
  });

  it('is one No space group when nothing has a space', () => {
    const groups = groupBySpace(rows, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0].space).toBeNull();
  });

  it('has no No space group when every chat has a space', () => {
    expect(groupBySpace([{ instanceId: 'b1' }], new Map([['b1', ['notes']]])).map(g => g.space)).toEqual(['notes']);
  });
});

describe('spaceTriggerLabel', () => {
  it('names the current choice, and a new space only once it has text', () => {
    expect(spaceTriggerLabel({ kind: 'none' })).toBe('No space');
    expect(spaceTriggerLabel({ kind: 'existing', name: 'notes' })).toBe('notes');
    expect(spaceTriggerLabel({ kind: 'new', name: '' })).toBe('New space');
    expect(spaceTriggerLabel({ kind: 'new', name: '  ' })).toBe('New space');
    expect(spaceTriggerLabel({ kind: 'new', name: 'team-notes' })).toBe('team-notes');
  });
});

describe('slugifySpaceName', () => {
  it('turns what was typed into a space name', () => {
    expect(slugifySpaceName('Team Notes')).toBe('team-notes');
    expect(slugifySpaceName('my_space  2!')).toBe('my-space-2');
    expect(slugifySpaceName('  -lead')).toBe('lead');
    expect(slugifySpaceName('a'.repeat(50))).toHaveLength(40);
  });

  it('keeps a trailing dash while typing, and the name drops it', async () => {
    expect(slugifySpaceName('team ')).toBe('team-');
    expect(spaceChoiceError({ kind: 'new', name: 'team-' }, [])).toBe('');
    const f = fakeApi();
    expect(await ensureSpace({ kind: 'new', name: 'team-' }, new Set(), f.api, () => {})).toBe('team');
    expect(f.calls).toEqual(['create team']);
  });
});

describe('spaceOfBox', () => {
  it('names the box\'s first space and notes the rest', () => {
    const index = new Map([['box-a', ['mine', 'theirs']], ['box-b', []]]);
    expect(spaceOfBox('box-a', index)).toEqual({ space: 'mine', alsoIn: ['theirs'] });
    expect(spaceOfBox('box-b', index)).toBeNull();
    expect(spaceOfBox('box-c', index)).toBeNull();
    expect(spaceOfBox(null, index)).toBeNull();
  });
});

describe('collapsed space groups', () => {
  function memory(initial?: string) {
    const items = new Map<string, string>(initial === undefined ? [] : [[COLLAPSED_SPACES_KEY, initial]]);
    return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, items };
  }

  it('reads nothing folded from empty, missing or broken storage', () => {
    expect(readCollapsedSpaces(null).size).toBe(0);
    expect(readCollapsedSpaces(memory()).size).toBe(0);
    expect(readCollapsedSpaces(memory('{nope')).size).toBe(0);
    expect(readCollapsedSpaces(memory('{"a":1}')).size).toBe(0);
    expect([...readCollapsedSpaces(memory('["a",2,"b"]'))]).toEqual(['a', 'b']);
  });

  it('folds and unfolds a group, and keeps it across reads', () => {
    const store = memory();
    const folded = toggleCollapsedSpace(new Set(), groupKey('mine'), store);
    expect([...folded]).toEqual(['mine']);
    const both = toggleCollapsedSpace(folded, groupKey(null), store);
    expect([...readCollapsedSpaces(store)].sort()).toEqual([groupKey(null), 'mine'].sort());
    expect([...toggleCollapsedSpace(both, 'mine', store)]).toEqual([groupKey(null)]);
    expect([...readCollapsedSpaces(store)]).toEqual([groupKey(null)]);
  });

  it('keys No space apart from every space name', () => {
    expect(SPACE_NAME_RE.test(groupKey(null))).toBe(false);
  });

  it('keeps the fold for the page when storage throws', () => {
    const broken = { setItem: () => { throw new Error('quota'); } };
    expect([...toggleCollapsedSpace(new Set(), 'mine', broken)]).toEqual(['mine']);
  });
});
