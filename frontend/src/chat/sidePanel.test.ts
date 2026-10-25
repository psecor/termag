import { describe, expect, it } from 'vitest';
import {
  clampSidePanelWidth,
  DEFAULT_SIDE_PANEL,
  isSidePanelShortcut,
  readSidePanel,
  shownSidePanelTab,
  SIDE_PANEL_KEY,
  SIDE_PANEL_MIN_WIDTH,
  sidePanelTabs,
  dockedSidePanelWidth,
  sidePanelBody,
  writeSidePanel,
} from './sidePanel';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

describe('readSidePanel / writeSidePanel', () => {
  it('starts shut on Terminal at the default width, and remembers what was written', () => {
    const s = memory();
    expect(readSidePanel(s)).toEqual(DEFAULT_SIDE_PANEL);
    writeSidePanel(s, { open: true, tab: 'browser', width: 612 });
    expect(readSidePanel(s)).toEqual({ open: true, tab: 'browser', width: 612 });
  });

  it('falls back field by field on a damaged record, and on no storage', () => {
    const s = memory();
    s.setItem(SIDE_PANEL_KEY, '{not json');
    expect(readSidePanel(s)).toEqual(DEFAULT_SIDE_PANEL);
    s.setItem(SIDE_PANEL_KEY, JSON.stringify({ open: 'yes', tab: 'shell', width: 'wide' }));
    expect(readSidePanel(s)).toEqual(DEFAULT_SIDE_PANEL);
    s.setItem(SIDE_PANEL_KEY, JSON.stringify({ open: true }));
    expect(readSidePanel(s)).toEqual({ ...DEFAULT_SIDE_PANEL, open: true });
    expect(readSidePanel(null)).toEqual(DEFAULT_SIDE_PANEL);
  });

  it('swallows a storage that throws', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readSidePanel(throwing)).toEqual(DEFAULT_SIDE_PANEL);
    expect(() => writeSidePanel(throwing, DEFAULT_SIDE_PANEL)).not.toThrow();
  });
});

describe('clampSidePanelWidth', () => {
  it('keeps the panel above its minimum and the chat above its own', () => {
    expect(clampSidePanelWidth(100, 1400)).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(clampSidePanelWidth(500.4, 1400)).toBe(500);
    expect(clampSidePanelWidth(1300, 1400)).toBe(1400 - 360);
  });

  it('gives the panel its minimum when the window cannot hold both', () => {
    expect(clampSidePanelWidth(500, 500)).toBe(SIDE_PANEL_MIN_WIDTH);
  });
});

describe('tabs', () => {
  it('offers Browser only where the browser pane is on', () => {
    expect(sidePanelTabs(false)).toEqual(['terminal']);
    expect(sidePanelTabs(true)).toEqual(['terminal', 'browser']);
  });

  it('shows Terminal when the remembered Browser tab is not offered', () => {
    expect(shownSidePanelTab('browser', false)).toBe('terminal');
    expect(shownSidePanelTab('browser', true)).toBe('browser');
    expect(shownSidePanelTab('terminal', true)).toBe('terminal');
  });

  it('remembers Files', () => {
    const s = memory();
    writeSidePanel(s, { open: true, tab: 'files', width: 480 });
    expect(readSidePanel(s).tab).toBe('files');
  });

  it('offers Files first where there is a space, and only Files beside no session', () => {
    expect(sidePanelTabs(true, { files: true, session: true })).toEqual(['files', 'terminal', 'browser']);
    expect(sidePanelTabs(true, { files: true, session: false })).toEqual(['files']);
    expect(sidePanelTabs(true, { files: false, session: true })).toEqual(['terminal', 'browser']);
  });

  it('shows Files beside a file whatever was remembered, and Terminal for a remembered Files beside an agent with no space', () => {
    const file = { files: true, session: false };
    expect(shownSidePanelTab('terminal', true, file)).toBe('files');
    expect(shownSidePanelTab('browser', true, file)).toBe('files');
    expect(shownSidePanelTab('files', true, { files: false, session: true })).toBe('terminal');
    expect(shownSidePanelTab('files', true, { files: true, session: true })).toBe('files');
  });
});

describe('isSidePanelShortcut', () => {
  const key = (over: Partial<KeyboardEvent>) => ({ code: 'KeyB', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

  it('is Ctrl+Alt+B or Cmd+Option+B', () => {
    expect(isSidePanelShortcut(key({ ctrlKey: true, altKey: true }))).toBe(true);
    expect(isSidePanelShortcut(key({ metaKey: true, altKey: true }))).toBe(true);
  });

  it('leaves tmux\'s Ctrl+B prefix, Shift variants and other keys alone', () => {
    expect(isSidePanelShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isSidePanelShortcut(key({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isSidePanelShortcut(key({ altKey: true }))).toBe(false);
    expect(isSidePanelShortcut(key({ code: 'KeyN', ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe('sidePanelBody', () => {
  it('attaches only to a set-up session that has a ctrl shell', () => {
    expect(sidePanelBody({ hasAgent: true, held: false })).toBe('ready');
    expect(sidePanelBody({ hasAgent: true, held: true })).toBe('setup');
    expect(sidePanelBody({ hasAgent: false, held: false })).toBe('no-shell');
  });
});

describe('dockedSidePanelWidth', () => {
  it('paints the remembered width until the main column is measured, then clamps to it', () => {
    expect(dockedSidePanelWidth(480, null)).toBe(480);
    // A 1024 px window: 744 px of main column beside the 280 px list.
    expect(dockedSidePanelWidth(480, 744)).toBe(744 - 360);
    expect(dockedSidePanelWidth(480, 1160)).toBe(480);
  });
});
