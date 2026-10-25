import { describe, expect, it } from 'vitest';
import { isNewSessionShortcut, newSessionShortcutLabel } from './shortcuts';

const key = (over: Partial<KeyboardEvent>) =>
  ({ code: 'KeyO', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, ...over }) as KeyboardEvent;

describe('isNewSessionShortcut', () => {
  it('is Shift+O with Ctrl or ⌘', () => {
    expect(isNewSessionShortcut(key({ metaKey: true }))).toBe(true);
    expect(isNewSessionShortcut(key({ ctrlKey: true }))).toBe(true);
  });

  it('needs Shift and Ctrl or ⌘, and no Alt', () => {
    expect(isNewSessionShortcut(key({ metaKey: true, shiftKey: false }))).toBe(false);
    expect(isNewSessionShortcut(key({}))).toBe(false);
    expect(isNewSessionShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('goes by the key, not the character it types', () => {
    expect(isNewSessionShortcut(key({ code: 'KeyP', metaKey: true }))).toBe(false);
  });
});

describe('newSessionShortcutLabel', () => {
  it('names the platform’s keys', () => {
    expect(newSessionShortcutLabel('MacIntel')).toBe('⌘⇧O');
    expect(newSessionShortcutLabel('iPhone')).toBe('⌘⇧O');
    expect(newSessionShortcutLabel('Win32')).toBe('Ctrl+Shift+O');
    expect(newSessionShortcutLabel(undefined)).toBe('Ctrl+Shift+O');
  });
});
