import { describe, expect, it } from 'vitest';
import { notificationSequence, osc777, osc9, tmuxPassthrough } from './notify.js';

describe('notify', () => {
  it('builds OSC 777 and OSC 9 with control characters and semicolons stripped', () => {
    expect(osc777('termag', 'termag/tui is waiting')).toBe('\x1b]777;notify;termag;termag/tui is waiting\x07');
    expect(osc9('a;b\x1bc')).toBe('\x1b]9;a b c\x07');
  });
  it('wraps for tmux only when TMUX is set, doubling ESC inside', () => {
    const plain = notificationSequence('t', 'b', {});
    expect(plain.startsWith('\x1b]777;')).toBe(true);
    expect(plain).not.toContain('\x1bPtmux;');
    const wrapped = notificationSequence('t', 'b', { TMUX: '/tmp/x,1,0' });
    expect(wrapped.startsWith('\x1bPtmux;\x1b\x1b]777;')).toBe(true);
    expect(wrapped.endsWith('\x1b\\')).toBe(true);
    expect(tmuxPassthrough('\x1bX')).toBe('\x1bPtmux;\x1b\x1bX\x1b\\');
  });
});
