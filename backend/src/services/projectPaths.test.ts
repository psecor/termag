import { describe, it, expect } from 'vitest';
import { projectDirUnder, resolveProjectRoot } from './projectPaths';
import { projectDir, projectDirFor } from './tmux';

describe('resolveProjectRoot', () => {
  it('falls back to /home/<user> when hostHome is absent', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor' })).toBe('/home/psecor');
  });

  it('falls back to /home/<user> when hostHome is null', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: null })).toBe('/home/psecor');
  });

  it('uses an absolute hostHome', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '/Users/psecor' }))
      .toBe('/Users/psecor');
  });

  it('strips a single trailing slash', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '/Users/psecor/' }))
      .toBe('/Users/psecor');
  });

  it('strips several trailing slashes', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '/Users/psecor///' }))
      .toBe('/Users/psecor');
  });

  it('keeps root / as /', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '/' })).toBe('/');
  });

  it('keeps /// as /', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '///' })).toBe('/');
  });

  it('ignores an empty hostHome', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '' })).toBe('/home/psecor');
  });

  it('ignores a whitespace-only hostHome', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '   ' })).toBe('/home/psecor');
  });

  it('ignores a relative hostHome', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: 'home/psecor' }))
      .toBe('/home/psecor');
  });

  it('trims whitespace around an absolute hostHome', () => {
    expect(resolveProjectRoot({ ownerUnixUser: 'psecor', hostHome: '  /opt/box  ' }))
      .toBe('/opt/box');
  });
});

describe('projectDirUnder', () => {
  it('puts the main workstream at the project root', () => {
    expect(projectDirUnder('/home/psecor', 'termag')).toBe('/home/psecor/termag/projects/termag');
  });

  it('treats an explicit main the same as the default', () => {
    expect(projectDirUnder('/home/psecor', 'termag', 'main'))
      .toBe('/home/psecor/termag/projects/termag');
  });

  it('puts a non-main workstream under .worktrees', () => {
    expect(projectDirUnder('/home/psecor', 'termag', 'warm'))
      .toBe('/home/psecor/termag/projects/termag/.worktrees/warm');
  });

  it('does not double the slash under root /', () => {
    expect(projectDirUnder('/', 'termag')).toBe('/termag/projects/termag');
  });

  it('does not double the slash under root / for a non-main workstream', () => {
    expect(projectDirUnder('/', 'termag', 'warm'))
      .toBe('/termag/projects/termag/.worktrees/warm');
  });
});

describe('projectDir', () => {
  it('returns the historical main-workstream path', () => {
    expect(projectDir('psecor', 'termag')).toBe('/home/psecor/termag/projects/termag');
  });

  it('returns the historical worktree path', () => {
    expect(projectDir('psecor', 'termag', 'warm'))
      .toBe('/home/psecor/termag/projects/termag/.worktrees/warm');
  });
});

describe('projectDirFor', () => {
  it('matches projectDir for a project with no instance', () => {
    expect(projectDirFor({ name: 'termag', user: { unixUsername: 'psecor' } }))
      .toBe('/home/psecor/termag/projects/termag');
  });

  it('matches projectDir for an instance that reported no home', () => {
    expect(projectDirFor({
      name: 'termag', user: { unixUsername: 'psecor' }, instance: { hostHome: null },
    }, 'warm')).toBe('/home/psecor/termag/projects/termag/.worktrees/warm');
  });

  it('uses the home the box reported', () => {
    expect(projectDirFor({
      name: 'termag', user: { unixUsername: 'psecor' }, instance: { hostHome: '/home/ubuntu' },
    })).toBe('/home/ubuntu/termag/projects/termag');
  });

  it('uses the home the box reported for a non-main workstream', () => {
    expect(projectDirFor({
      name: 'termag', user: { unixUsername: 'psecor' }, instance: { hostHome: '/home/ubuntu/' },
    }, 'warm')).toBe('/home/ubuntu/termag/projects/termag/.worktrees/warm');
  });
});
