import { describe, expect, it } from 'vitest';
import { MOVE_NOTE, moveAutomationFolders, movedOf, needsMove, type FolderMoveDeps, type MovableRow } from './folderMove';

/** One space's files, as the bucket holds them; `failDelete` paths stay put. */
function fakeSpace(files: string[], failDelete: string[] = []) {
  const paths = new Set(files);
  const calls: string[] = [];
  return {
    paths, calls,
    objects: {
      listPaths: async (prefix: string) => [...paths].filter(p => p.startsWith(prefix)),
      exists: async (p: string) => paths.has(p),
      copy: async (from: string, to: string) => { calls.push(`copy ${from} ${to}`); if (!paths.has(from)) throw new Error(`no ${from}`); paths.add(to); },
      remove: async (ps: string[]) => { calls.push(`rm ${ps.join(' ')}`); for (const p of ps) if (!failDelete.includes(p)) paths.delete(p); return ps.filter(p => failDelete.includes(p)); },
    },
  };
}

const row = (extra: Partial<MovableRow> = {}): MovableRow => ({ id: 'a1', projectId: 'p1', userId: 'u1', spaceName: 'team', spaceFolder: 'automations/triage', ...extra });

function deps(rows: MovableRow[], space: ReturnType<typeof fakeSpace> | null, busy: boolean[] = []) {
  const folders: Record<string, string> = {};
  const events: Array<{ path: string; note: string; actor: string }> = [];
  const d: FolderMoveDeps = {
    rows: async () => rows,
    busy: async () => busy.shift() ?? false,
    space: async () => space ? { id: 's1', objects: space.objects } : null,
    setFolder: async (id, f) => { folders[id] = f; },
    event: async (_s, actor, path, note) => { events.push({ path, note, actor }); },
  };
  return { d, folders, events };
}

const OLD = ['automations/triage/memory/MEMORY.md', 'automations/triage/state.json', 'automations/triage/README.md', 'automations/triage/runs/run-1.md', 'automations/triage/runs/run-2-manual.md'];

describe('which rows and files move', () => {
  it('moves rows in a space that are not in their fixed folder yet', () => {
    expect(needsMove(row())).toBe(true);
    expect(needsMove(row({ spaceFolder: null }))).toBe(true);
    expect(needsMove(row({ spaceFolder: '.termag/automations/a1' }))).toBe(false);
    expect(needsMove(row({ spaceName: null }))).toBe(false);
  });

  it("moves termag's own files only: notes, state, README and run logs, not outputs or people's files", () => {
    expect(movedOf('automations/triage', [...OLD, 'automations/triage/outputs/run-1/report.html', 'automations/triage/mine.md', 'automations/triage/runs/old/x.md', 'automations/triage2/state.json']))
      .toEqual(['README.md', 'memory/MEMORY.md', 'runs/run-1.md', 'runs/run-2-manual.md', 'state.json']);
  });
});

describe('moveAutomationFolders', () => {
  it('a dry run says what it would move and touches nothing', async () => {
    const space = fakeSpace(OLD);
    const { d, folders } = deps([row()], space);
    expect(await moveAutomationFolders(d, { apply: false })).toEqual([{
      id: 'a1', result: 'would_move', from: 'automations/triage', to: '.termag/automations/a1',
      files: ['README.md', 'memory/MEMORY.md', 'runs/run-1.md', 'runs/run-2-manual.md', 'state.json'],
    }]);
    expect(space.calls).toEqual([]);
    expect(folders).toEqual({});
  });

  it('copies, points the row at the fixed folder, deletes the old files and records the move', async () => {
    const space = fakeSpace([...OLD, 'automations/triage/outputs/run-1/report.html']);
    const { d, folders, events } = deps([row()], space);
    const [o] = await moveAutomationFolders(d, { apply: true });
    expect(o).toMatchObject({ result: 'moved', to: '.termag/automations/a1' });
    expect([...space.paths].sort()).toEqual([
      '.termag/automations/a1/README.md', '.termag/automations/a1/memory/MEMORY.md', '.termag/automations/a1/runs/run-1.md',
      '.termag/automations/a1/runs/run-2-manual.md', '.termag/automations/a1/state.json', 'automations/triage/outputs/run-1/report.html',
    ]);
    expect(folders).toEqual({ a1: '.termag/automations/a1' });
    expect(events).toEqual([{ path: 'automations/triage/ -> .termag/automations/a1/', note: MOVE_NOTE, actor: 'u1' }]);
    // The row flips only once every copy is across, and before anything is deleted.
    expect(space.calls.findIndex(c => c.startsWith('rm'))).toBe(OLD.length);
  });

  it('an unbackfilled row moves from the project-id path the one-file mirror used', async () => {
    const space = fakeSpace(['automations/p1/memory/MEMORY.md']);
    const { d } = deps([row({ spaceFolder: null })], space);
    expect(await moveAutomationFolders(d, { apply: true })).toEqual([{ id: 'a1', result: 'moved', from: 'automations/p1', to: '.termag/automations/a1', files: ['memory/MEMORY.md'] }]);
  });

  it('a row with nothing to move still gets its fixed folder, and no event', async () => {
    const { d, folders, events } = deps([row()], fakeSpace([]));
    expect((await moveAutomationFolders(d, { apply: true }))[0]).toMatchObject({ result: 'moved', files: [] });
    expect(folders).toEqual({ a1: '.termag/automations/a1' });
    expect(events).toEqual([]);
  });

  it('skips a busy automation, before and during the copy, and leaves its row and files whole', async () => {
    const before = fakeSpace(OLD);
    const one = deps([row()], before, [true]);
    expect(await moveAutomationFolders(one.d, { apply: true })).toEqual([{ id: 'a1', result: 'skipped', reason: 'busy' }]);
    expect(before.calls).toEqual([]);

    const during = fakeSpace(OLD);
    const two = deps([row()], during, [false, true]);
    expect(await moveAutomationFolders(two.d, { apply: true })).toEqual([{ id: 'a1', result: 'skipped', reason: 'busy' }]);
    expect([...during.paths].sort()).toEqual([...OLD].sort());
    expect(two.folders).toEqual({});
  });

  it('never overwrites files already at the fixed path', async () => {
    const space = fakeSpace([...OLD, '.termag/automations/a1/memory/MEMORY.md']);
    const { d, folders } = deps([row()], space);
    expect(await moveAutomationFolders(d, { apply: true })).toEqual([{ id: 'a1', result: 'refused', reason: 'target_exists', paths: ['.termag/automations/a1/memory/MEMORY.md'] }]);
    expect(space.calls).toEqual([]);
    expect(folders).toEqual({});
  });

  it('a space that is gone is skipped; a failing copy leaves the row on its old folder', async () => {
    expect(await moveAutomationFolders(deps([row()], null).d, { apply: true })).toEqual([{ id: 'a1', result: 'skipped', reason: 'space_gone' }]);
    const space = fakeSpace(OLD);
    space.objects.copy = async () => { throw new Error('AccessDenied'); };
    const { d, folders } = deps([row()], space);
    expect(await moveAutomationFolders(d, { apply: true })).toEqual([{ id: 'a1', result: 'failed', reason: 'AccessDenied' }]);
    expect(folders).toEqual({});
  });

  it('says so when an old file could not be deleted, after the row moved', async () => {
    const space = fakeSpace(OLD, ['automations/triage/state.json']);
    const { d, folders } = deps([row()], space);
    expect(await moveAutomationFolders(d, { apply: true })).toEqual([{ id: 'a1', result: 'failed', reason: 'moved, but could not delete automations/triage/state.json' }]);
    expect(folders).toEqual({ a1: '.termag/automations/a1' });
  });

  it('is done on a second run', async () => {
    const space = fakeSpace(OLD);
    const rows = [row()];
    const { d, folders } = deps(rows, space);
    await moveAutomationFolders(d, { apply: true });
    rows[0].spaceFolder = folders.a1;
    expect(await moveAutomationFolders(d, { apply: true })).toEqual([]);
  });
});
