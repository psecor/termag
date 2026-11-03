// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteAction } from '../utils/searchPalette';
import { resetScreenCommandsForTests, useProvideScreenCommands, useScreenCommands } from './screenCommands';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seen: readonly PaletteAction[] = [];
let renders = 0;
function Reader() {
  seen = useScreenCommands();
  renders += 1;
  return null;
}
function Provider({ commands }: { commands: PaletteAction[] | null }) {
  useProvideScreenCommands(commands);
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetScreenCommandsForTests();
  renders = 0;
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const render = (provider: React.ReactNode) => act(() => root.render(<>{provider}<Reader /></>));

describe('screen commands', () => {
  it('lists what the mounted screen provides, and nothing once it unmounts', () => {
    render(<Provider commands={[{ id: 'archive', label: 'Archive session', run: () => {} }]} />);
    expect(seen.map(c => c.label)).toEqual(['Archive session']);
    render(null);
    expect(seen).toEqual([]);
  });

  it("runs the latest render's run, and a re-render that changes nothing on screen republishes nothing", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Provider commands={[{ id: 'archive', label: 'Archive session', run: first }]} />);
    const before = renders;
    render(<Provider commands={[{ id: 'archive', label: 'Archive session', run: second }]} />);
    // One render for the parent's own re-render, none for a republish.
    expect(renders).toBe(before + 1);
    seen[0].run();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('republishes when what a command says changes', () => {
    render(<Provider commands={[{ id: 'archive', label: 'Archive session', run: () => {} }]} />);
    render(<Provider commands={[{ id: 'archive', label: 'Archiving…', disabled: true, run: () => {} }]} />);
    expect(seen[0]).toMatchObject({ label: 'Archiving…', disabled: true });
  });
});
