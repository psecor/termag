import { describe, expect, it } from 'vitest';
import { filesProjectOf, filesToolOpenItems, initialFilesChoice, moveFailureText, moveHalfDoneText, openItemName, openItemTip, openItemWhere, usableSpaces, useSpaceErrorText, otherSpaces, readOpenFolded, writeOpenFolded, FILES_TOOL_OPEN_FOLDED_KEY } from './filesTool';
import type { OpenItem } from './openItems';

const file = (id: string, path: string): OpenItem => ({ id, kind: 'file', space: 'notes', path, openedAt: 1 });
const chat: OpenItem = { id: 'c', kind: 'chat', projectId: 'p', workstream: 'main', openedAt: 1 };
const tab: OpenItem = { id: 't', kind: 'explorer', space: 'notes', openedAt: 1 };

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}

describe('the Files tool', () => {
  it('lists file tabs and new tabs in the person\'s order, never sessions', () => {
    expect(filesToolOpenItems([file('a', 'x.md'), chat, tab, file('b', 'docs/y.md')]).map(i => i.id)).toEqual(['a', 't', 'b']);
  });

  it('names a file by its own name and says its folder; a new tab says its space', () => {
    expect(openItemName(file('a', 'docs/plans/run.md'))).toBe('run.md');
    expect(openItemWhere(file('a', 'docs/plans/run.md'))).toBe('docs/plans');
    expect(openItemWhere(file('a', 'run.md'))).toBeNull();
    expect(openItemName(tab)).toBe('New tab');
    expect(openItemWhere(tab)).toBe('notes');
    expect(openItemTip(file('a', 'run.md'))).toBe('notes:run.md');
  });

  it('names the agents in no space as Agents, never by its internal (none)', () => {
    const agents: OpenItem = { id: 'n', kind: 'explorer', space: '(none)', openedAt: 1 };
    expect(openItemName(agents)).toBe('Agents');
    expect(openItemWhere(agents)).toBeNull();
    expect(openItemTip(agents)).not.toContain('(none)');
  });

  it('keeps the Open list unfolded until folded, per browser', () => {
    const s = memory();
    expect(readOpenFolded(s)).toBe(false);
    writeOpenFolded(s, true);
    expect(s.m.get(FILES_TOOL_OPEN_FOLDED_KEY)).toBe('1');
    expect(readOpenFolded(s)).toBe(true);
    writeOpenFolded(s, false);
    expect(s.m.has(FILES_TOOL_OPEN_FOLDED_KEY)).toBe(false);
    expect(readOpenFolded(null)).toBe(false);
  });
});

describe('Project files | My files', () => {
  const projects = [{ id: 'up-t', filesSpace: 'dev-termag' }, { id: 'up-d', filesSpace: null }];
  it('shows the open session\'s project, one of the person\'s own', () => {
    expect(filesProjectOf({ sessionProject: 'up-t', projects, myFiles: 'dev-my-files' })).toBe('up-t');
    expect(filesProjectOf({ sessionProject: 'up-d', projects, myFiles: null })).toBe('up-d');
    expect(filesProjectOf({ sessionProject: 'someone-elses', projects, myFiles: null })).toBeNull();
  });

  it('beside a file, the project whose files it is in, or beside My files the project last shown', () => {
    expect(filesProjectOf({ space: 'dev-termag', projects, myFiles: 'dev-my-files' })).toBe('up-t');
    expect(filesProjectOf({ space: 'dev-my-files', projects, myFiles: 'dev-my-files', lastProject: 'up-d' })).toBe('up-d');
    expect(filesProjectOf({ space: 'dev-my-files', projects, myFiles: 'dev-my-files' })).toBeNull();
    expect(filesProjectOf({ space: 'team-notes', projects, myFiles: 'dev-my-files', lastProject: 'up-t' })).toBeNull();
    expect(filesProjectOf({ projects, myFiles: null })).toBeNull();
  });

  it('opens on Project files, or on the file page\'s own My files or other space', () => {
    expect(initialFilesChoice(null, projects[0], 'dev-my-files')).toEqual({ kind: 'project' });
    expect(initialFilesChoice('dev-termag', projects[0], 'dev-my-files')).toEqual({ kind: 'project' });
    expect(initialFilesChoice('dev-my-files', projects[0], 'dev-my-files')).toEqual({ kind: 'mine' });
    expect(initialFilesChoice('team-notes', projects[0], 'dev-my-files')).toEqual({ kind: 'other', space: 'team-notes' });
  });

  it('lists Other spaces without any project\'s files or My files, by name', () => {
    const spaces = [{ name: 'zeta' }, { name: 'dev-termag' }, { name: 'dev-my-files' }, { name: 'alpha' }];
    expect(otherSpaces(spaces, projects, 'dev-my-files')).toEqual(['alpha', 'zeta']);
    expect(otherSpaces(spaces, [], null)).toEqual(['alpha', 'dev-my-files', 'dev-termag', 'zeta']);
  });
});

describe('a move between Project files and My files', () => {
  const o = { name: 'run.png', path: 'screenshots/run.png', from: 'Project files' as const, to: 'My files' as const };
  it('says why each refusal left the file where it was', () => {
    expect(moveFailureText({ code: 'exists' }, o)).toBe('My files already has screenshots/run.png.');
    expect(moveFailureText({ code: 'destination_shared' }, o)).toBe("My files' screenshots/run.png is shared with everyone on termag. Make it private first, then move run.png again.");
    expect(moveFailureText({ code: 'changed_while_moving' }, o)).toContain('the newer version stayed in Project files');
    expect(moveFailureText({ code: 'changed' }, o)).toContain('Refresh');
    expect(moveFailureText({ code: 'memory_path' }, o)).toContain('.termag/');
    expect(moveFailureText({ code: 'file_not_found' }, o)).toBe("run.png isn't in Project files any more.");
    expect(moveFailureText({ code: 'quota_exceeded', error: 'My files is full' }, o)).toBe("Couldn't move run.png: My files is full");
    expect(moveFailureText(null, o)).toBe("Couldn't move run.png.");
  });

  it('never names a space by its name, only Project files and My files', () => {
    for (const code of ['exists', 'destination_shared', 'changed_while_moving', 'changed', 'memory_path', 'same_space', 'file_not_found', 'move_too_large']) {
      expect(moveFailureText({ code }, o)).not.toMatch(/\bspace\b/i);
    }
  });

  it('says a half-done move left it in both', () => {
    expect(moveHalfDoneText(o)).toBe("run.png is in My files now, but couldn't be removed from Project files, so it's in both.");
  });
});

describe('use an existing space', () => {
  it('offers the person\'s own, not the current one, by name', () => {
    const spaces = [{ name: 'zeta', role: 'owner' }, { name: 'team', role: 'editor' }, { name: 'mine', role: 'owner' }, { name: 'alpha', role: 'owner' }];
    expect(usableSpaces(spaces, 'mine')).toEqual(['alpha', 'zeta']);
    expect(usableSpaces(spaces, null)).toEqual(['alpha', 'mine', 'zeta']);
    expect(usableSpaces(spaces, null, ['zeta', 'mine'])).toEqual(['alpha']);
  });

  it('says why a choice was refused', () => {
    expect(useSpaceErrorText({ code: 'space_in_use' })).toContain("already a project's files or your My files");
    expect(useSpaceErrorText({ code: 'space_not_owned' })).toContain('you own');
    expect(useSpaceErrorText({ code: 'space_not_found' })).toContain("doesn't exist");
    expect(useSpaceErrorText({ error: 'Slow down' })).toBe('Slow down');
    expect(useSpaceErrorText(null)).toBe("Couldn't save that. Try again.");
  });
});
