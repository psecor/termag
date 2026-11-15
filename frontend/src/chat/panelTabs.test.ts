import { describe, expect, it } from 'vitest';
import {
  addLauncher, agentTabOf, agentTabsOnScreen, closePanelTab, fitPanelTabs, initialPanelTabs, openAgentTab, openTool, parseAgentTabs, parsePanelTabs,
  type PanelTab, type PanelTabs,
  orderPanelTabs, placeTabs,
} from './panelTabs';

const kinds = (s: PanelTabs) => s.tabs.map(t => t.kind);
const activeKind = (s: PanelTabs) => s.tabs.find(t => t.id === s.active)?.kind;

describe('parsePanelTabs', () => {
  it('keeps known kinds, one tab per tool, and drops the rest', () => {
    const raw = JSON.stringify([
      { id: 'a', kind: 'terminal' }, { id: 'b', kind: 'launcher' }, { id: 'c', kind: 'terminal' },
      { id: 'd', kind: 'logs' }, { id: 'a', kind: 'files' }, { kind: 'browser' }, null, { id: 'e', kind: 'browser' },
    ]);
    expect(parsePanelTabs(raw)).toEqual([{ id: 'a', kind: 'terminal' }, { id: 'b', kind: 'launcher' }, { id: 'e', kind: 'browser' }]);
  });

  it('is null for nothing, garbage or an empty list', () => {
    expect(parsePanelTabs(null)).toBeNull();
    expect(parsePanelTabs('{')).toBeNull();
    expect(parsePanelTabs('{"a":1}')).toBeNull();
    expect(parsePanelTabs('[]')).toBeNull();
  });
});

describe('the panel tabs', () => {
  it('open on the tool last shown, giving it a tab when it has none', () => {
    const kept = [{ id: 'a', kind: 'terminal' as const }];
    expect(initialPanelTabs(kept, 'terminal')).toEqual({ tabs: kept, active: 'a' });
    const s = initialPanelTabs(kept, 'files');
    expect(kinds(s)).toEqual(['terminal', 'files']);
    expect(activeKind(s)).toBe('files');
    // With nothing kept, a new tab's launcher: the panel never picks a tool for you.
    expect(kinds(initialPanelTabs(null, 'browser'))).toEqual(['launcher']);
    expect(kinds(initialPanelTabs([], 'terminal'))).toEqual(['launcher']);
  });

  it('turn a launcher into the tool picked from it', () => {
    const s = addLauncher(initialPanelTabs([{ id: 't0', kind: 'terminal' }], 'terminal'));
    expect(kinds(s)).toEqual(['terminal', 'launcher']);
    const next = openTool(s, 'files', s.active);
    expect(kinds(next)).toEqual(['terminal', 'files']);
    expect(next.active).toBe(s.active);
  });

  it('never give a tool a second tab: picking one that is open shows it and drops the launcher', () => {
    const s = addLauncher(initialPanelTabs([{ id: 't0', kind: 'terminal' }], 'terminal'));
    const next = openTool(s, 'terminal', s.active);
    expect(kinds(next)).toEqual(['terminal']);
    expect(activeKind(next)).toBe('terminal');
    // Asked for from outside (no launcher): the same.
    expect(kinds(openTool(next, 'terminal'))).toEqual(['terminal']);
    expect(kinds(openTool(next, 'browser'))).toEqual(['terminal', 'browser']);
  });

  it('close to the right-hand neighbour, else the left, and leave a launcher when the last goes', () => {
    let s: PanelTabs = { tabs: [{ id: 'a', kind: 'files' }, { id: 'b', kind: 'terminal' }, { id: 'c', kind: 'browser' }], active: 'b' };
    s = closePanelTab(s, 'b', ['a', 'b', 'c']);
    expect(s.active).toBe('c');
    s = closePanelTab(s, 'c', ['a', 'c']);
    expect(s.active).toBe('a');
    s = closePanelTab(s, 'a', ['a']);
    expect(kinds(s)).toEqual(['launcher']);
    expect(s.active).toBe(s.tabs[0].id);
  });

  it('leave a launcher when the last tab shown closes, though hidden ones remain', () => {
    // Files is hidden beside a session with no space; Terminal is the only tab shown.
    const s: PanelTabs = { tabs: [{ id: 'f', kind: 'files' }, { id: 't', kind: 'terminal' }], active: 't' };
    const next = closePanelTab(s, 't', ['t']);
    expect(kinds(next)).toEqual(['files', 'launcher']);
    expect(activeKind(next)).toBe('launcher');
  });

  it('keep the shown tab when another closes', () => {
    const s: PanelTabs = { tabs: [{ id: 'a', kind: 'files' }, { id: 'b', kind: 'terminal' }], active: 'a' };
    expect(closePanelTab(s, 'b', ['a', 'b'])).toEqual({ tabs: [{ id: 'a', kind: 'files' }], active: 'a' });
  });
});

describe('agent tabs (docs/simple-ui-subagents.md)', () => {
  const agent = { chat: 'p1|main', id: 'toolu_1', title: 'Run the test suite' };
  it('are kept with their subagent, one per subagent, and nothing else of theirs', () => {
    const raw = JSON.stringify([
      { id: 'a', kind: 'agent', agent },
      { id: 'b', kind: 'agent', agent: { ...agent, title: 'Again' } },
      { id: 'c', kind: 'agent', agent: { chat: 'p1|main' } },
      { id: 'd', kind: 'agent', agent: { ...agent, id: 'x'.repeat(500) } },
      { id: 'e', kind: 'terminal' },
    ]);
    expect(parsePanelTabs(raw)).toEqual([{ id: 'a', kind: 'agent', agent }, { id: 'e', kind: 'terminal' }]);
  });

  it('open beside the tab shown, show the one a subagent has, and take over a launcher on screen', () => {
    const state: PanelTabs = { tabs: [{ id: 't', kind: 'terminal' }, { id: 'f', kind: 'files' }], active: 't' };
    const opened = openAgentTab(state, agent);
    expect(opened.tabs.map(t => t.kind)).toEqual(['terminal', 'agent', 'files']);
    expect(opened.tabs.find(t => t.id === opened.active)?.agent).toEqual(agent);
    const again = openAgentTab({ ...opened, active: 'f' }, { ...agent, title: 'Renamed' });
    expect(again.tabs).toHaveLength(3);
    expect(again.tabs.find(t => t.id === again.active)?.agent?.title).toBe('Renamed');
    // The panel opens on the agent tab it last showed, not on a tool tab it adds.
    expect(initialPanelTabs(opened.tabs, 'browser', opened.active, 'p1|main')).toEqual({ tabs: opened.tabs, active: opened.active });
    expect(initialPanelTabs(opened.tabs, 'terminal', 'gone', 'p1|main').active).toBe('t');
    // Beside another chat that tab is hidden: the panel opens on its tool.
    expect(initialPanelTabs(opened.tabs, 'terminal', opened.active, 'p2|main').active).toBe('t');
    const fresh = initialPanelTabs(null, 'terminal');
    const fromLauncher = openAgentTab(fresh, agent);
    expect(fromLauncher.tabs).toEqual([{ id: fresh.active, kind: 'agent', agent }]);
  });
});

describe('the subagent tab each chat had on screen', () => {
  const a: PanelTab = { id: 'a', kind: 'agent', agent: { chat: 'p1|main', id: 'toolu_1', title: 'One' } };
  const a2: PanelTab = { id: 'a2', kind: 'agent', agent: { chat: 'p1|main', id: 'toolu_3', title: 'Three' } };
  const b: PanelTab = { id: 'b', kind: 'agent', agent: { chat: 'p2|main', id: 'toolu_2', title: 'Two' } };
  const t: PanelTab = { id: 't', kind: 'terminal' };
  const tabs = [t, a, a2, b];

  it("keeps one per chat: the one on screen beside it, leaving another chat's alone", () => {
    expect(agentTabsOnScreen([], tabs, 'a', 'p1|main')).toEqual(['a']);
    expect(agentTabsOnScreen(['a'], tabs, 'b', 'p2|main')).toEqual(['b', 'a']);
    // A tool shown beside p2 drops p2's, not p1's.
    expect(agentTabsOnScreen(['b', 'a'], tabs, 't', 'p2|main')).toEqual(['a']);
    // Another of p1's subagents replaces its first.
    expect(agentTabsOnScreen(['b', 'a'], tabs, 'a2', 'p1|main')).toEqual(['a2', 'b']);
    // Beside no chat (a space, subagents off), nothing changes.
    expect(agentTabsOnScreen(['b', 'a'], tabs, 't', null)).toEqual(['b', 'a']);
  });

  it('forgets a closed tab, a tab that is no subagent, and a second for one chat', () => {
    expect(agentTabsOnScreen(['gone', 't', 'a', 'a2'], tabs, 't', 'p2|main')).toEqual(['a']);
  });

  it("finds a chat's among the tabs kept, and none for a chat with none or no tabs", () => {
    expect(agentTabOf(['b', 'a'], tabs, 'p1|main')).toBe('a');
    expect(agentTabOf(['b', 'a'], tabs, 'p2|main')).toBe('b');
    expect(agentTabOf(['b', 'a'], tabs, 'p3|main')).toBeNull();
    expect(agentTabOf(['b', 'a'], [t], 'p1|main')).toBeNull();
    expect(agentTabOf(['a'], null, 'p1|main')).toBeNull();
    expect(agentTabOf(['a'], tabs, null)).toBeNull();
  });

  it('reads a list of ids, or the bare id kept before, and nothing from a damaged record', () => {
    expect(parseAgentTabs(null)).toEqual([]);
    expect(parseAgentTabs(JSON.stringify(['a', 'b', 'a', 3, '']))).toEqual(['a', 'b']);
    expect(parseAgentTabs('tmwe8qgqu1')).toEqual(['tmwe8qgqu1']);
    expect(parseAgentTabs(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseAgentTabs('x'.repeat(201))).toEqual([]);
  });
});

describe('fitPanelTabs', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  // + and its gap, and the tab on screen (150 px) and its gap: 182 px before the other tabs.
  const before = 28 + 2 + 150 + 2;

  it('labels every tab while the others each have room for a label', () => {
    expect(fitPanelTabs(ids.slice(0, 3), 'b', before + 2 * 98, 150)).toEqual({ compact: false, hidden: [] });
    expect(fitPanelTabs(ids.slice(0, 3), 'b', before + 2 * 98 - 1, 150)).toEqual({ compact: true, hidden: [] });
  });

  it('shows the others as icons, then the ones that still do not fit in the menu, keeping the tab on screen', () => {
    expect(fitPanelTabs(ids, 'g', before + 7 * 34, 150)).toEqual({ compact: true, hidden: [] });
    // Room for "N more" and two icons: the first two others stay, the rest go, never g.
    expect(fitPanelTabs(ids, 'g', before + 46 + 2 * 34, 150)).toEqual({ compact: true, hidden: ['c', 'd', 'e', 'f', 'h'] });
    expect(fitPanelTabs(ids, 'a', 100, 150)).toEqual({ compact: true, hidden: ['b', 'c', 'd', 'e', 'f', 'g', 'h'] });
  });

  it('labels every tab before the strip is measured', () => {
    expect(fitPanelTabs(ids, 'a', 0, 0)).toEqual({ compact: false, hidden: [] });
  });
});

describe('one tab order for every place (project-files-enabled)', () => {
  const T: PanelTab = { id: 'tt', kind: 'terminal' };
  const B: PanelTab = { id: 'bb', kind: 'browser' };
  const A: PanelTab = { id: 'aa', kind: 'agent', agent: { chat: 'p2|main', id: 'x', title: 'Other chat' } };
  const F1: PanelTab = { id: 'f1', kind: 'file', file: { space: 'notes', path: 'a.md' } };
  const F2: PanelTab = { id: 'f2', kind: 'file', file: { space: 'notes', path: 'b.md' } };
  const here = (t: PanelTab) => t.kind !== 'agent';

  it("shows a place's tabs in the kept order, its file tabs where they were put and new ones last", () => {
    expect(placeTabs([T, A, B], here, [F1, F2]).map(t => t.id)).toEqual(['tt', 'bb', 'f1', 'f2']);
    expect(placeTabs([{ id: 'f2', kind: 'file' }, T, { id: 'gone', kind: 'file' }, B], here, [F1, F2]).map(t => t.id)).toEqual(['f2', 'tt', 'bb', 'f1']);
    expect(placeTabs([{ id: 'f2', kind: 'file' }, T], here, [F2])[0]).toBe(F2);
  });

  it('puts the tabs shown in a new order, leaving the hidden where they are, and keeps a file tab as its id', () => {
    const shown = placeTabs([T, A, B], here, [F1]);
    const moved = orderPanelTabs([T, A, B], shown, ['f1', 'tt', 'bb']);
    expect(moved).toEqual([{ id: 'f1', kind: 'file' }, A, T, B]);
    expect(placeTabs(moved, here, [F1]).map(t => t.id)).toEqual(['f1', 'tt', 'bb']);
    // Back.
    expect(placeTabs(orderPanelTabs(moved, placeTabs(moved, here, [F1]), ['tt', 'bb', 'f1']), here, [F1]).map(t => t.id)).toEqual(['tt', 'bb', 'f1']);
    // Nothing moves, or no order of exactly those tabs: the same list.
    expect(orderPanelTabs(moved, placeTabs(moved, here, [F1]), ['f1', 'tt', 'bb'])).toBe(moved);
    expect(orderPanelTabs(moved, placeTabs(moved, here, [F1]), ['f1', 'tt'])).toBe(moved);
    expect(orderPanelTabs(moved, placeTabs(moved, here, [F1]), ['f1', 'f1', 'bb'])).toBe(moved);
  });

  it('keeps file tabs in the stored order, ids only', () => {
    expect(parsePanelTabs(JSON.stringify([{ id: 'f1', kind: 'file' }, { id: 'tt', kind: 'terminal' }, { id: 'Bad/Id', kind: 'file' }, { id: 'f1', kind: 'file' }])))
      .toEqual([{ id: 'f1', kind: 'file' }, { id: 'tt', kind: 'terminal' }]);
  });
});
