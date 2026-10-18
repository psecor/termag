import { describe, expect, it, vi } from 'vitest';
import { hitTarget, isSearchShortcut, resolveWorkstream, retryUntil, rowTarget, searchShortcutLabel } from './workspaceTarget';

const row = { kind: 'normal' as const, url: null, projectId: 'p1', workstream: 'main', status: 'idle' as const, ring: null };
const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe('rowTarget', () => {
  it('opens the agent pane of the workstream', () => {
    expect(rowTarget({ ...row, workstream: 'fix' })).toEqual({ kind: 'pane', projectId: 'p1', workstream: 'fix', pane: 'agent' });
  });

  it('opens the review dock when the row is about its review', () => {
    expect(rowTarget({ ...row, ring: 'done' })).toMatchObject({ pane: 'review' });
    expect(rowTarget({ ...row, ring: 'reviewing' })).toMatchObject({ pane: 'review' });
  });

  it('a waiting agent wins over its review', () => {
    expect(rowTarget({ ...row, status: 'waiting', ring: 'done' })).toMatchObject({ pane: 'agent' });
  });

  it('a cloud session opens its page, or nothing without one', () => {
    expect(rowTarget({ ...row, kind: 'cloud', url: 'https://claude.ai/x' })).toEqual({ kind: 'external', url: 'https://claude.ai/x' });
    expect(rowTarget({ ...row, kind: 'cloud', url: null })).toEqual({ kind: 'none' });
  });
});

describe('hitTarget', () => {
  it('focuses the pane the text was in', () => {
    expect(hitTarget({ projectId: 'p1', workstream: 'main', role: 'ctrl' })).toMatchObject({ pane: 'ctrl' });
    expect(hitTarget({ projectId: 'p1', workstream: 'main', role: 'review' })).toMatchObject({ pane: 'review' });
    expect(hitTarget({ projectId: 'p1', workstream: 'ws', role: 'data' })).toEqual({ kind: 'pane', projectId: 'p1', workstream: 'ws', pane: 'agent' });
  });
});

describe('isSearchShortcut', () => {
  it('takes ⌘K and Ctrl+Shift+K', () => {
    expect(isSearchShortcut(key('k', { metaKey: true }))).toBe(true);
    expect(isSearchShortcut(key('K', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('leaves Ctrl+K to the terminal and ignores other chords', () => {
    expect(isSearchShortcut(key('k', { ctrlKey: true }))).toBe(false);
    expect(isSearchShortcut(key('k'))).toBe(false);
    expect(isSearchShortcut(key('k', { metaKey: true, altKey: true }))).toBe(false);
    expect(isSearchShortcut(key('j', { metaKey: true }))).toBe(false);
  });
});

describe('searchShortcutLabel', () => {
  it('names ⌘K on Apple platforms', () => {
    for (const p of ['MacIntel', 'macOS', 'iPhone', 'iPad']) expect(searchShortcutLabel(p)).toBe('⌘K');
  });

  it('names Ctrl+Shift+K everywhere else, where plain Ctrl+K reaches the terminal', () => {
    for (const p of ['Linux x86_64', 'Linux', 'Win32', 'Windows', '', undefined]) expect(searchShortcutLabel(p)).toBe('Ctrl+Shift+K');
  });
});

describe('resolveWorkstream', () => {
  const list = [{ name: 'live' }, { name: 'gone', archived: true }];
  it('keeps a live workstream and falls back to main otherwise', () => {
    expect(resolveWorkstream(list, 'live')).toBe('live');
    expect(resolveWorkstream(list, 'gone')).toBe('main');
    expect(resolveWorkstream(list, 'deleted')).toBe('main');
    expect(resolveWorkstream([], 'main')).toBe('main');
  });
});

describe('retryUntil', () => {
  it('retries until the attempt succeeds, then stops', () => {
    vi.useFakeTimers();
    let n = 0;
    retryUntil(() => ++n === 3, 100, 2000);
    vi.advanceTimersByTime(1000);
    expect(n).toBe(3);
    vi.useRealTimers();
  });

  it('gives up after the window, and cancel stops it early', () => {
    vi.useFakeTimers();
    let n = 0;
    retryUntil(() => { n++; return false; }, 100, 500);
    vi.advanceTimersByTime(5000);
    expect(n).toBe(5);
    let m = 0;
    const cancel = retryUntil(() => { m++; return false; }, 100, 2000);
    vi.advanceTimersByTime(250);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(m).toBe(2);
    vi.useRealTimers();
  });
});
