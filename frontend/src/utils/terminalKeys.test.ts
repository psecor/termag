import { describe, expect, it } from 'vitest';
import { customKeySequence, SHIFT_ENTER_SEQUENCE } from './terminalKeys';

const key = (over: Partial<Parameters<typeof customKeySequence>[0]>) => ({
  type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over,
});

describe('customKeySequence', () => {
  it('maps Shift+Enter to ESC CR so agent CLIs insert a newline instead of submitting', () => {
    expect(customKeySequence(key({ shiftKey: true }))).toBe(SHIFT_ENTER_SEQUENCE);
    expect(SHIFT_ENTER_SEQUENCE).toBe('\x1b\r');
  });

  it('leaves plain Enter to xterm', () => {
    expect(customKeySequence(key({}))).toBeNull();
  });

  it('leaves Enter with any other modifier to xterm (Alt+Enter already sends ESC CR itself)', () => {
    expect(customKeySequence(key({ shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(customKeySequence(key({ shiftKey: true, altKey: true }))).toBeNull();
    expect(customKeySequence(key({ shiftKey: true, metaKey: true }))).toBeNull();
    expect(customKeySequence(key({ altKey: true }))).toBeNull();
  });

  it('only acts on keydown, so keyup and keypress never send a second copy', () => {
    expect(customKeySequence(key({ type: 'keyup', shiftKey: true }))).toBeNull();
    expect(customKeySequence(key({ type: 'keypress', shiftKey: true }))).toBeNull();
  });

  it('ignores other keys', () => {
    expect(customKeySequence(key({ key: 'Tab', shiftKey: true }))).toBeNull();
    expect(customKeySequence(key({ key: 'v', shiftKey: true }))).toBeNull();
  });
});
