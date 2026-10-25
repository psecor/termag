// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpaceView } from '../../services/api';
import { SPACE_COLORS, spaceColor } from '../../chat/spaceColors';
import { ChatSpacesProvider, type SharedChatSpaces } from '../../chat/useChatSpaces';
import { ChatSpaceChip } from './SpaceSwatch';

const mine: SpaceView = { id: '1', name: 'mine', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

function render(instanceId: string | null, value: Partial<SharedChatSpaces>) {
  const shared: SharedChatSpaces = { enabled: true, loaded: true, current: true, spaces: [mine], index: new Map([['box-a', ['mine', 'other']]]), colorOf: spaceColor, ...value };
  act(() => root.render(<ChatSpacesProvider value={shared}><ChatSpaceChip instanceId={instanceId} /></ChatSpacesProvider>));
  return host.querySelector<HTMLElement>('.chat-title-space');
}

describe('ChatSpaceChip', () => {
  it('names the box\'s space in its colour, noting the others', () => {
    const chip = render('box-a', { colorOf: () => SPACE_COLORS[2] })!;
    expect(chip.textContent).toBe('mine');
    expect(chip.title).toBe('In space mine, also in other');
    expect(chip.style.getPropertyValue('--space-color')).toBe(SPACE_COLORS[2].hex);
    expect(chip.querySelector<HTMLElement>('.space-swatch')?.style.getPropertyValue('--space-color')).toBe(SPACE_COLORS[2].hex);
  });

  it('says No space, neutral, once the user has spaces', () => {
    const chip = render('box-b', {})!;
    expect(chip.textContent).toBe('No space');
    expect(chip.dataset.space).toBe('none');
    expect(chip.style.getPropertyValue('--space-color')).toBe('');
  });

  it('does not say No space for a box the index has not loaded yet', () => {
    // A new session: its box appeared, and the reload that would place it is in flight.
    expect(render('box-new', { current: false })).toBeNull();
    expect(render('box-a', { current: false })?.textContent).toBe('mine');
  });

  it('shows nothing while spaces are off, loading, or the user has none', () => {
    expect(render('box-a', { enabled: false })).toBeNull();
    expect(render('box-a', { loaded: false })).toBeNull();
    expect(render('box-b', { spaces: [], index: new Map() })).toBeNull();
  });
});
