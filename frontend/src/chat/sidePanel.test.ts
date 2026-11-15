import { describe, expect, it } from 'vitest';
import {
  clampSidePanelWidth,
  DEFAULT_SIDE_PANEL,
  DEFAULT_SIDE_PANEL_PREFS,
  DEFAULT_SIDE_PANEL_TAB,
  isSidePanelShortcut,
  readOpenSidePanels,
  readSidePanel,
  readSidePanelTabs,
  shownSidePanelTab,
  SIDE_PANEL_KEY,
  SIDE_PANEL_MIN_WIDTH,
  SIDE_PANEL_OPEN_KEY,
  SIDE_PANEL_OPEN_MAX,
  SIDE_PANEL_TABS_KEY,
  SIDE_PANEL_TABS_MAX,
  sidePanelPlace,
  sidePanelFileAt,
  sidePanelTabAt,
  sidePanelTabs,
  dockedSidePanelWidth,
  sidePanelBody,
  withSidePanelOpen,
  withSidePanelTab,
  writeOpenSidePanels,
  writeSidePanel,
  writeSidePanelTabs,
  type SidePanelPlaceTab,
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
  it('starts at the default width, shut on Terminal, and remembers the width written, never open or a tab', () => {
    const s = memory();
    expect(readSidePanel(s)).toEqual(DEFAULT_SIDE_PANEL_PREFS);
    expect(DEFAULT_SIDE_PANEL).toEqual({ open: false, tab: 'terminal', width: 480 });
    writeSidePanel(s, { open: true, tab: 'browser', width: 612 } as never);
    expect(readSidePanel(s)).toEqual({ width: 612 });
    expect(JSON.parse(s.getItem(SIDE_PANEL_KEY)!)).toEqual({ width: 612 });
  });

  it('falls back on a damaged record, and on no storage', () => {
    const s = memory();
    s.setItem(SIDE_PANEL_KEY, '{not json');
    expect(readSidePanel(s)).toEqual(DEFAULT_SIDE_PANEL_PREFS);
    s.setItem(SIDE_PANEL_KEY, JSON.stringify({ open: 'yes', tab: 'shell', width: 'wide' }));
    expect(readSidePanel(s)).toEqual(DEFAULT_SIDE_PANEL_PREFS);
    expect(readSidePanel(null)).toEqual(DEFAULT_SIDE_PANEL_PREFS);
  });

  it('ignores the open and the tab of a record from when they were one for every session', () => {
    const s = memory();
    s.setItem(SIDE_PANEL_KEY, JSON.stringify({ open: true, tab: 'browser', width: 500 }));
    expect(readSidePanel(s)).toEqual({ width: 500 });
    expect(readOpenSidePanels(s)).toEqual([]);
    expect(readSidePanelTabs(s)).toEqual([]);
    expect(sidePanelTabAt(readSidePanelTabs(s), 'session:p|main')).toBe(DEFAULT_SIDE_PANEL_TAB);
  });

  it('swallows a storage that throws', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readSidePanel(throwing)).toEqual(DEFAULT_SIDE_PANEL_PREFS);
    expect(() => writeSidePanel(throwing, DEFAULT_SIDE_PANEL_PREFS)).not.toThrow();
    expect(readOpenSidePanels(throwing)).toEqual([]);
    expect(() => writeOpenSidePanels(throwing, ['session:p|main'])).not.toThrow();
    expect(readSidePanelTabs(throwing)).toEqual([]);
    expect(() => writeSidePanelTabs(throwing, [{ place: 'session:p|main', tab: 'browser' }])).not.toThrow();
  });
});

describe('sidePanelPlace', () => {
  it('names a session by project and workstream, then the agents in no space, an automation, a space', () => {
    expect(sidePanelPlace({ session: { projectId: 'p1', workstream: 'main' } })).toBe('session:p1|main');
    expect(sidePanelPlace({ session: { projectId: 'p1', workstream: 'feature-x' } })).toBe('session:p1|feature-x');
    expect(sidePanelPlace({ agents: true })).toBe('agents');
    expect(sidePanelPlace({ automation: 'a1' })).toBe('automation:a1');
    expect(sidePanelPlace({ space: 'notes' })).toBe('space:notes');
    expect(sidePanelPlace({})).toBeNull();
    expect(sidePanelPlace({ session: null, agents: false, automation: null, space: '' })).toBeNull();
  });
});

describe('the places the panel is open in', () => {
  it('opens one place without touching another, and shuts it again', () => {
    let places = withSidePanelOpen([], 'session:a|main', true);
    expect(places).toEqual(['session:a|main']);
    places = withSidePanelOpen(places, 'session:b|main', true);
    expect(places).toEqual(['session:b|main', 'session:a|main']);
    places = withSidePanelOpen(places, 'session:b|main', false);
    expect(places).toEqual(['session:a|main']);
    expect(withSidePanelOpen(places, 'session:c|main', false)).toEqual(['session:a|main']);
  });

  it('keeps the newest SIDE_PANEL_OPEN_MAX, a revisit making a place the newest again', () => {
    let places: string[] = [];
    for (let i = 0; i < SIDE_PANEL_OPEN_MAX; i++) places = withSidePanelOpen(places, `session:p${i}|main`, true);
    expect(places).toHaveLength(SIDE_PANEL_OPEN_MAX);
    // p0, the oldest, is visited, so p1 is the oldest now.
    places = withSidePanelOpen(places, 'session:p0|main', true);
    places = withSidePanelOpen(places, 'session:new|main', true);
    expect(places).toHaveLength(SIDE_PANEL_OPEN_MAX);
    expect(places[0]).toBe('session:new|main');
    expect(places).toContain('session:p0|main');
    expect(places).not.toContain('session:p1|main');
  });

  it('reads back what was written, and nothing but places from a damaged or overlong record', () => {
    const s = memory();
    expect(readOpenSidePanels(s)).toEqual([]);
    writeOpenSidePanels(s, ['session:a|main', 'space:notes']);
    expect(readOpenSidePanels(s)).toEqual(['session:a|main', 'space:notes']);
    s.setItem(SIDE_PANEL_OPEN_KEY, '{not json');
    expect(readOpenSidePanels(s)).toEqual([]);
    s.setItem(SIDE_PANEL_OPEN_KEY, JSON.stringify({ 'session:a|main': true }));
    expect(readOpenSidePanels(s)).toEqual([]);
    s.setItem(SIDE_PANEL_OPEN_KEY, JSON.stringify(['session:a|main', 3, null, '', 'session:a|main', 'x'.repeat(401), 'agents']));
    expect(readOpenSidePanels(s)).toEqual(['session:a|main', 'agents']);
    s.setItem(SIDE_PANEL_OPEN_KEY, JSON.stringify(Array.from({ length: SIDE_PANEL_OPEN_MAX + 10 }, (_, i) => `session:p${i}|main`)));
    expect(readOpenSidePanels(s)).toHaveLength(SIDE_PANEL_OPEN_MAX);
    expect(readOpenSidePanels(null)).toEqual([]);
  });
});

describe('the tab each place shows', () => {
  it('opens a place with none remembered on Terminal, and one on the tab it last showed', () => {
    expect(DEFAULT_SIDE_PANEL_TAB).toBe('terminal');
    expect(sidePanelTabAt([], 'session:a|main')).toBe('terminal');
    expect(sidePanelTabAt([], null)).toBe('terminal');
    const tabs = withSidePanelTab([], 'session:a|main', 'browser');
    expect(sidePanelTabAt(tabs, 'session:a|main')).toBe('browser');
    expect(sidePanelTabAt(tabs, 'session:b|main')).toBe('terminal');
    expect(sidePanelTabAt(tabs, null)).toBe('terminal');
  });

  it('changes one place\'s tab without touching another', () => {
    let tabs = withSidePanelTab([], 'session:a|main', 'browser');
    tabs = withSidePanelTab(tabs, 'session:b|main', 'pr');
    expect(tabs).toEqual([{ place: 'session:b|main', tab: 'pr' }, { place: 'session:a|main', tab: 'browser' }]);
    tabs = withSidePanelTab(tabs, 'session:a|main', 'review');
    expect(tabs).toEqual([{ place: 'session:a|main', tab: 'review' }, { place: 'session:b|main', tab: 'pr' }]);
    expect(sidePanelTabAt(tabs, 'session:b|main')).toBe('pr');
  });

  it('keeps the newest SIDE_PANEL_TABS_MAX, a revisit making a place the newest again', () => {
    let tabs: SidePanelPlaceTab[] = [];
    for (let i = 0; i < SIDE_PANEL_TABS_MAX; i++) tabs = withSidePanelTab(tabs, `session:p${i}|main`, 'browser');
    expect(tabs).toHaveLength(SIDE_PANEL_TABS_MAX);
    // p0, the oldest, is visited (its own tab again), so p1 is the oldest now.
    tabs = withSidePanelTab(tabs, 'session:p0|main', sidePanelTabAt(tabs, 'session:p0|main'));
    tabs = withSidePanelTab(tabs, 'session:new|main', 'files');
    expect(tabs).toHaveLength(SIDE_PANEL_TABS_MAX);
    expect(tabs[0]).toEqual({ place: 'session:new|main', tab: 'files' });
    expect(sidePanelTabAt(tabs, 'session:p0|main')).toBe('browser');
    // The one that fell off opens on the default again.
    expect(tabs.some(t => t.place === 'session:p1|main')).toBe(false);
    expect(sidePanelTabAt(tabs, 'session:p1|main')).toBe('terminal');
  });

  it('reads back what was written, and nothing but known tabs of places from a damaged or overlong record', () => {
    const s = memory();
    expect(readSidePanelTabs(s)).toEqual([]);
    writeSidePanelTabs(s, [{ place: 'session:a|main', tab: 'browser' }, { place: 'space:notes', tab: 'files' }]);
    expect(readSidePanelTabs(s)).toEqual([{ place: 'session:a|main', tab: 'browser' }, { place: 'space:notes', tab: 'files' }]);
    s.setItem(SIDE_PANEL_TABS_KEY, '{not json');
    expect(readSidePanelTabs(s)).toEqual([]);
    s.setItem(SIDE_PANEL_TABS_KEY, JSON.stringify({ 'session:a|main': 'browser' }));
    expect(readSidePanelTabs(s)).toEqual([]);
    s.setItem(SIDE_PANEL_TABS_KEY, JSON.stringify([
      { place: 'session:a|main', tab: 'share' }, null, 'agents', { place: 3, tab: 'files' }, { place: '', tab: 'files' },
      { place: 'session:b|main', tab: 'shell' }, { place: 'session:a|main', tab: 'files' }, { place: 'x'.repeat(401), tab: 'files' },
      { place: 'agents', tab: 'files' },
    ]));
    expect(readSidePanelTabs(s)).toEqual([{ place: 'session:a|main', tab: 'share' }, { place: 'agents', tab: 'files' }]);
    s.setItem(SIDE_PANEL_TABS_KEY, JSON.stringify(Array.from({ length: SIDE_PANEL_TABS_MAX + 10 }, (_, i) => ({ place: `session:p${i}|main`, tab: 'pr' }))));
    expect(readSidePanelTabs(s)).toHaveLength(SIDE_PANEL_TABS_MAX);
    expect(readSidePanelTabs(null)).toEqual([]);
  });

  it('remembers every tab the panel has', () => {
    const s = memory();
    const all = ['files', 'terminal', 'browser', 'share', 'pr', 'review'] as const;
    writeSidePanelTabs(s, all.map(tab => ({ place: `session:${tab}|main`, tab })));
    expect(readSidePanelTabs(s).map(t => t.tab)).toEqual([...all]);
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
    expect(sidePanelTabs()).toEqual(['terminal', 'browser']);
  });

  it('shows Terminal when the remembered Browser tab is not offered', () => {
    expect(shownSidePanelTab('browser')).toBe('browser');
    expect(shownSidePanelTab('terminal')).toBe('terminal');
  });

  it('offers Files first where there is a space, and only Files beside no session', () => {
    expect(sidePanelTabs({ files: true, session: true })).toEqual(['files', 'terminal', 'browser']);
    expect(sidePanelTabs({ files: true, session: false })).toEqual(['files']);
    expect(sidePanelTabs({ files: false, session: true })).toEqual(['terminal', 'browser']);
  });

  it('offers Share last, beside a session that may be shared, and only with the browser pane on', () => {
    const shared = { files: true, session: true, share: true };
    expect(sidePanelTabs(shared)).toEqual(['files', 'terminal', 'browser', 'share']);
    expect(sidePanelTabs({ files: false, session: true, share: false })).toEqual(['terminal', 'browser']);
    expect(sidePanelTabs({ files: true, session: false, share: true })).toEqual(['files']);
  });

  it('shows a remembered Share where it is offered, and Terminal for it where it is not', () => {
    expect(shownSidePanelTab('share', { files: false, session: true, share: true })).toBe('share');
    expect(shownSidePanelTab('share', { files: false, session: true, share: false })).toBe('terminal');
  });

  it('shows Files beside a file whatever was remembered, and Terminal for a remembered Files beside an agent with no space', () => {
    const file = { files: true, session: false };
    expect(shownSidePanelTab('terminal', file)).toBe('files');
    expect(shownSidePanelTab('browser', file)).toBe('files');
    expect(shownSidePanelTab('files', { files: false, session: true })).toBe('terminal');
    expect(shownSidePanelTab('files', { files: true, session: true })).toBe('files');
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

describe('the file tab a place last showed (project-files-enabled)', () => {
  it('is kept with its tool, read back, and dropped when the place shows a tool', () => {
    const s = memory();
    let tabs = withSidePanelTab([], 'session:p|main', 'files', 'n1');
    expect(tabs).toEqual([{ place: 'session:p|main', tab: 'files', file: 'n1' }]);
    writeSidePanelTabs(s, tabs);
    expect(readSidePanelTabs(s)).toEqual(tabs);
    expect(sidePanelFileAt(readSidePanelTabs(s), 'session:p|main')).toBe('n1');
    expect(sidePanelFileAt(readSidePanelTabs(s), 'space:notes')).toBeNull();
    tabs = withSidePanelTab(tabs, 'session:p|main', 'terminal');
    expect(tabs).toEqual([{ place: 'session:p|main', tab: 'terminal' }]);
    expect(sidePanelFileAt(tabs, 'session:p|main')).toBeNull();
  });

  it('ignores a file id that is no tab id', () => {
    const s = memory();
    s.setItem(SIDE_PANEL_TABS_KEY, JSON.stringify([{ place: 'a', tab: 'files', file: '../x' }, { place: 'b', tab: 'files', file: 7 }]));
    expect(readSidePanelTabs(s)).toEqual([{ place: 'a', tab: 'files' }, { place: 'b', tab: 'files' }]);
  });
});
