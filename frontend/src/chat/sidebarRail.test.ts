// @vitest-environment jsdom
// The sidebar's rail (chat/sidebarRail.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isRailShortcut, needsCount, railDot, railLabel, railShortcutLabel, resetSidebarRailForTests, setSidebarCollapsed, SIDEBAR_RAIL_KEY, toggleSidebarCollapsed,
} from './sidebarRail';

const key = (over: Partial<KeyboardEvent>) => ({ code: 'Backslash', key: '\\', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe('the collapse shortcut', () => {
  it('is ⌘\\ on a Mac and Ctrl+\\ elsewhere, nothing else', () => {
    expect(isRailShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isRailShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isRailShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isRailShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isRailShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isRailShortcut(key({}), true)).toBe(false);
    expect(isRailShortcut(key({ metaKey: true, code: 'KeyB', key: 'b' }), true)).toBe(false);
    expect([railShortcutLabel(true), railShortcutLabel(false)]).toEqual(['⌘\\', 'Ctrl+\\']);
  });
});

describe('collapsed, kept per browser', () => {
  beforeEach(() => { localStorage.clear(); resetSidebarRailForTests(); });
  it('remembers it', () => {
    setSidebarCollapsed(true);
    expect(localStorage.getItem(SIDEBAR_RAIL_KEY)).toBe('1');
    toggleSidebarCollapsed();
    expect(localStorage.getItem(SIDEBAR_RAIL_KEY)).toBe('0');
  });
});

describe("a project's live dot and name", () => {
  it('is amber while one needs you, the accent while one works, none when quiet', () => {
    expect(railDot(['working', 'approval'])).toBe('needs');
    expect(railDot(['error'])).toBe('needs');
    expect(railDot(['done', 'working'])).toBe('working');
    expect(railDot(['done', 'off'])).toBeNull();
    expect(railDot([])).toBeNull();
  });

  it('counts what needs you, and says it in the name', () => {
    expect(needsCount(['approval', 'unread', 'working', 'error'])).toBe(3);
    expect(railLabel('termag', ['approval', 'working', 'working'])).toBe('termag, 1 needs you, 2 working');
    expect(railLabel('termag', ['done'])).toBe('termag');
  });
});
