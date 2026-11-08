import { describe, it, expect } from 'vitest';
import { chooseTerminalSlot, FIRST_EXTRA_TERMINAL_SLOT, terminalTabLabel } from './terminalSlots';
import { MAX_TERMINAL_SLOTS, terminalSessionNames } from './tmux';

const names = (project: string) => terminalSessionNames('alice', project, 'main');

describe('chooseTerminalSlot', () => {
  it('takes the lowest free slot, which is 2 — slot 1 is the ctrl pane and is never chosen', () => {
    const live = new Set<string>();
    expect(chooseTerminalSlot(live, names('myproj'))).toEqual({ slot: 2 });
    live.add('alice-myproj-ctrl');
    expect(chooseTerminalSlot(live, names('myproj'))).toEqual({ slot: 2 });
  });

  it('skips live slots and reuses a slot whose pane is gone', () => {
    const live = new Set(['alice-myproj-ctrl', 'alice-myproj-ctrl-2', 'alice-myproj-ctrl-4']);
    expect(chooseTerminalSlot(live, names('myproj'))).toEqual({ slot: 3 });
    // A killed slot's number comes straight back: a shell holds nothing.
    live.delete('alice-myproj-ctrl-2');
    expect(chooseTerminalSlot(live, names('myproj'))).toEqual({ slot: 2 });
  });

  it('is full when every extra slot is live', () => {
    const all = new Set(terminalSessionNames('alice', 'myproj', 'main'));
    expect(chooseTerminalSlot(all, names('myproj'))).toEqual({ full: true });
    all.delete('alice-myproj-ctrl-7');
    expect(chooseTerminalSlot(all, names('myproj'))).toEqual({ slot: 7 });
  });

  it('matches names positionally: names[i] is slot i+1', () => {
    expect(FIRST_EXTRA_TERMINAL_SLOT).toBe(2);
    expect(MAX_TERMINAL_SLOTS).toBe(8);
    const all = names('myproj');
    expect(all[0]).toBe('alice-myproj-ctrl');
    expect(all[1]).toBe('alice-myproj-ctrl-2');
    expect(all[7]).toBe('alice-myproj-ctrl-8');
  });
});

describe('terminalTabLabel', () => {
  it('names the ctrl pane and numbers the extras', () => {
    expect(terminalTabLabel(1)).toBe('ctrl');
    expect(terminalTabLabel(2)).toBe('term 2');
  });
});
