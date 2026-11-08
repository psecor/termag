import { describe, expect, it } from 'vitest';
import { barKeyBytes, controlByte, TERMINAL_BAR_KEYS, withStickyCtrl } from './terminalKeyBar';
import { KEY_LABELS } from '../chat/keyLabels';
import { quickKeys } from '../chat/quickKeys';

const plain = { ctrl: false, appCursor: false };

describe('TERMINAL_BAR_KEYS', () => {
  it('is the bar the design asks for, in order', () => {
    expect(TERMINAL_BAR_KEYS.map(k => k.label)).toEqual(['Esc', 'Tab', 'Ctrl', '↑', '↓', '←', '→', '^C', '|', '~', '/']);
    expect(TERMINAL_BAR_KEYS.filter(k => k.modifier).map(k => k.id)).toEqual(['ctrl']);
  });

  it('shares its labels with the phone client\'s key bar', () => {
    const phone = quickKeys('claude', 'idle', null).map(k => k.label);
    for (const shared of [KEY_LABELS.escape, KEY_LABELS.up, KEY_LABELS.down, KEY_LABELS.interrupt]) {
      expect(phone).toContain(shared.label);
      expect(TERMINAL_BAR_KEYS.map(k => k.label)).toContain(shared.label);
    }
  });
});

describe('barKeyBytes', () => {
  it('sends the bytes a terminal keyboard would', () => {
    expect(barKeyBytes('escape', plain)).toBe('\x1b');
    expect(barKeyBytes('tab', plain)).toBe('\t');
    expect(barKeyBytes('interrupt', plain)).toBe('\x03');
    expect(barKeyBytes('pipe', plain)).toBe('|');
    expect(barKeyBytes('tilde', plain)).toBe('~');
    expect(barKeyBytes('slash', plain)).toBe('/');
    expect(barKeyBytes('ctrl', plain)).toBeNull();
  });

  it('sends arrows as CSI, or SS3 in application cursor mode', () => {
    expect(['up', 'down', 'right', 'left'].map(id => barKeyBytes(id as 'up', plain))).toEqual(['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
    expect(barKeyBytes('up', { ctrl: false, appCursor: true })).toBe('\x1bOA');
  });

  it('applies an armed Ctrl to the bar\'s own keys', () => {
    const ctrl = { ctrl: true, appCursor: true };
    expect(barKeyBytes('left', ctrl)).toBe('\x1b[1;5D');
    expect(barKeyBytes('slash', ctrl)).toBe('\x1f');
    expect(barKeyBytes('tilde', ctrl)).toBe('\x1e');
    expect(barKeyBytes('pipe', ctrl)).toBe('|');
    expect(barKeyBytes('escape', ctrl)).toBe('\x1b');
  });
});

describe('controlByte', () => {
  it('maps letters either case, and the punctuation xterm maps', () => {
    expect(controlByte('c')).toBe('\x03');
    expect(controlByte('C')).toBe('\x03');
    expect(controlByte('a')).toBe('\x01');
    expect(controlByte('z')).toBe('\x1a');
    expect(controlByte('[')).toBe('\x1b');
    expect(controlByte('\\')).toBe('\x1c');
    expect(controlByte(']')).toBe('\x1d');
    expect(controlByte(' ')).toBe('\x00');
    expect(controlByte('?')).toBe('\x7f');
  });

  it('leaves what Ctrl does nothing to', () => {
    expect(controlByte('!')).toBeNull();
    expect(controlByte('é')).toBeNull();
    expect(controlByte('ab')).toBeNull();
  });
});

describe('withStickyCtrl', () => {
  it('turns the next typed key into its control byte', () => {
    expect(withStickyCtrl('c')).toBe('\x03');
    expect(withStickyCtrl('r')).toBe('\x12');
    expect(withStickyCtrl('D')).toBe('\x04');
  });

  it('applies to the first character of a predictive burst only', () => {
    expect(withStickyCtrl('cd')).toBe('\x03d');
  });

  it('passes escape sequences and Ctrl-less characters through', () => {
    expect(withStickyCtrl('\x1b[A')).toBe('\x1b[A');
    expect(withStickyCtrl('!')).toBe('!');
    expect(withStickyCtrl('')).toBe('');
  });
});
