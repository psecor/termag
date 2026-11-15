import { describe, it, expect } from 'vitest';
import { sortUserProjectViews, userProjectView, type UserProjectRow } from './userProjectViews';

const T = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

function row(over: Partial<UserProjectRow> = {}): UserProjectRow {
  return { id: 'up1', name: 'termag', archivedAt: null, createdAt: T(0), repos: [], filesSpace: null, checkouts: [], ...over };
}

const checkout = (id: string, minute: number, over: Partial<UserProjectRow['checkouts'][number]> = {}) => ({
  id, instanceId: `box-${id}`, archived: false, lastActiveAt: T(minute),
  instance: { name: `${id}-box`, status: 'ready' }, _count: { workstreams: 1 }, ...over,
});

describe('a project\'s view', () => {
  it('lists its repositories in order, named from their URLs', () => {
    const view = userProjectView(row({
      repos: [
        { repoKey: 'example-org/termag-desktop', url: 'git@github.com:example-org/termag-desktop.git', defaultBranch: null, position: 1 },
        { repoKey: 'example-org/termag', url: 'https://github.com/example-org/termag.git', defaultBranch: 'main', position: 0 },
      ],
    }));
    expect(view.repos).toEqual([
      { repoKey: 'example-org/termag', name: 'termag', url: 'https://github.com/example-org/termag.git', defaultBranch: 'main', iconId: null, iconSrc: null },
      { repoKey: 'example-org/termag-desktop', name: 'termag-desktop', url: 'git@github.com:example-org/termag-desktop.git', defaultBranch: null, iconId: null, iconSrc: null },
    ]);
  });

  it("says what its icon is, inline: automatic with each repository's detected one, the letters, or an image", () => {
    const png = { mimeType: 'image/png', data: Buffer.from('png') };
    const at = (position: number, iconId: string | null) => ({
      repoKey: `o/r${position}`, url: `https://github.com/o/r${position}.git`, defaultBranch: 'main', position, iconId, icon: iconId ? png : null,
    });
    const repos = [at(0, 'fav'), at(1, null), at(2, 'third')];
    const auto = userProjectView(row({ repos }));
    expect(auto.icon).toEqual({ choice: 'auto', imageId: null, src: null });
    expect(auto.repos.map(r => [r.iconId, r.iconSrc])).toEqual([['fav', 'data:image/png;base64,cG5n'], [null, null], ['third', null]]);
    expect(userProjectView(row({ repos, iconChoice: 'letter', iconId: null })).icon).toEqual({ choice: 'letter', imageId: null, src: null });
    expect(userProjectView(row({ repos, iconChoice: 'image', iconId: 'up', icon: png })).icon)
      .toEqual({ choice: 'image', imageId: 'up', src: 'data:image/png;base64,cG5n' });
    // Its image deleted (the foreign key set null): automatic again.
    expect(userProjectView(row({ repos, iconChoice: 'image', iconId: null, icon: null })).icon).toEqual({ choice: 'auto', imageId: null, src: null });
  });

  it('is as active as its newest checkout, and lists its checkouts most recent first with their boxes and live sessions', () => {
    const view = userProjectView(row({
      checkouts: [
        checkout('a', 5),
        checkout('b', 9, { archived: true, _count: { workstreams: 3 } }),
        checkout('c', 2, { instanceId: null, instance: null, _count: { workstreams: 0 } }),
      ],
    }));
    expect(view.lastActiveAt).toBe(T(9).toISOString());
    expect(view.checkouts).toEqual([
      { projectId: 'b', instanceId: 'box-b', boxName: 'b-box', boxStatus: 'ready', sessions: 3, archived: true },
      { projectId: 'a', instanceId: 'box-a', boxName: 'a-box', boxStatus: 'ready', sessions: 1, archived: false },
      { projectId: 'c', instanceId: null, boxName: null, boxStatus: null, sessions: 0, archived: false },
    ]);
  });

  it('is as active as its creation with no checkouts, and says archived and Project files', () => {
    const view = userProjectView(row({ createdAt: T(4), archivedAt: T(6), filesSpace: { name: 'pat-termag' } }));
    expect([view.lastActiveAt, view.archived, view.filesSpace, view.checkouts]).toEqual([T(4).toISOString(), true, { name: 'pat-termag' }, []]);
    expect(userProjectView(row()).filesSpace).toBeNull();
  });

  it('sorts projects most recently active first', () => {
    const views = [
      userProjectView(row({ id: 'old', checkouts: [checkout('x', 1)] })),
      userProjectView(row({ id: 'new', checkouts: [checkout('y', 8)] })),
      userProjectView(row({ id: 'empty', createdAt: T(5) })),
    ];
    expect(sortUserProjectViews(views).map(v => v.id)).toEqual(['new', 'empty', 'old']);
  });
});
