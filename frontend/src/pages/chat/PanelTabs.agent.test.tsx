// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PANEL_AGENT_TAB_KEY, PANEL_TABS_KEY, parsePanelTabs } from '../../chat/panelTabs';
import type { SidePanelTab } from '../../chat/sidePanel';
import { usePanelTabs, type AgentAsk, type PanelTabsUi } from './PanelTabs';

let root: Root;
let host: HTMLDivElement;
let ui: PanelTabsUi | null = null;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

function Panel({ ask, chat, tool = 'terminal', toolAsk = null, carried = false }: {
  ask: AgentAsk | null; chat: string; tool?: SidePanelTab; toolAsk?: { tab: SidePanelTab; n: number } | null; carried?: boolean;
}) {
  ui = usePanelTabs(true, ['terminal', 'files', 'browser'], tool, () => {}, toolAsk, undefined, chat, ask, undefined, carried);
  return null;
}

const agent = { chat: 'p1|main', id: 'toolu_1', title: 'Run the tests' };

describe('an agent tab the panel opens with', () => {
  it('is kept, and the panel opens on it again', () => {
    act(() => root.render(<Panel ask={{ agent, n: 1 }} chat="p1|main" />));
    expect(ui!.active).toMatchObject({ kind: 'agent', agent });
    const kept = parsePanelTabs(localStorage.getItem(PANEL_TABS_KEY));
    expect(kept).toEqual([expect.objectContaining({ kind: 'agent', agent })]);
    expect(JSON.parse(localStorage.getItem(PANEL_AGENT_TAB_KEY)!)).toEqual([ui!.active.id]);
    // A reload, no ask: the same tab.
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Panel ask={null} chat="p1|main" />));
    expect(ui!.active).toMatchObject({ kind: 'agent', agent });
  });

  it('is not offered beside another chat, where the panel shows the tool it last showed', () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'f', kind: 'files' }, { id: 'tt', kind: 'terminal' }]));
    act(() => root.render(<Panel ask={{ agent, n: 1 }} chat="p1|main" />));
    act(() => root.render(<Panel ask={null} chat="p2|main" />));
    expect(ui!.shown.some(t => t.kind === 'agent')).toBe(false);
    expect(ui!.active.kind).toBe('terminal');
    // A reload beside the other chat opens on that tool too.
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Panel ask={null} chat="p2|main" />));
    expect(ui!.active.kind).toBe('terminal');
  });

  it('is on screen again back beside its chat, from another that showed its own tool', () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'tt', kind: 'terminal' }]));
    act(() => root.render(<Panel ask={{ agent, n: 1 }} chat="p1|main" />));
    // The other chat last showed Browser, which has no tab yet: it gets one, shown there.
    act(() => root.render(<Panel ask={null} chat="p2|main" tool="browser" />));
    expect(ui!.active.kind).toBe('browser');
    expect(ui!.shown.map(t => t.kind)).toEqual(['terminal', 'browser']);
    act(() => root.render(<Panel ask={null} chat="p1|main" tool="terminal" />));
    expect(ui!.active).toMatchObject({ kind: 'agent', agent });
    expect(JSON.parse(localStorage.getItem(PANEL_AGENT_TAB_KEY)!)).toEqual([ui!.active.id]);
    // A tool asked for beside its own chat still shows that tool, and that chat no longer comes back to its subagent.
    act(() => root.render(<Panel ask={null} chat="p1|main" tool="files" />));
    expect(ui!.active.kind).toBe('files');
    expect(JSON.parse(localStorage.getItem(PANEL_AGENT_TAB_KEY)!)).toEqual([]);
  });

  it('is on screen again back beside its chat, whatever was picked beside another, after a reload too', () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'tt', kind: 'terminal' }, { id: 'bb', kind: 'browser' }]));
    act(() => root.render(<Panel ask={{ agent, n: 1 }} chat="p1|main" />));
    const x = ui!.active.id;
    // Beside another chat: Browser picked there, then that chat's own subagent.
    act(() => root.render(<Panel ask={null} chat="p2|main" />));
    act(() => ui!.show('bb'));
    expect(ui!.active.kind).toBe('browser');
    const other = { chat: 'p2|main', id: 'toolu_2', title: 'Read the docs' };
    act(() => root.render(<Panel ask={{ agent: other, n: 2 }} chat="p2|main" />));
    const y = ui!.active.id;
    expect(ui!.active).toMatchObject({ kind: 'agent', agent: other });
    act(() => root.render(<Panel ask={null} chat="p1|main" />));
    expect(ui!.active.id).toBe(x);
    act(() => root.render(<Panel ask={null} chat="p2|main" />));
    expect(ui!.active.id).toBe(y);
    // A reload beside either chat opens on its own subagent.
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Panel ask={null} chat="p1|main" />));
    expect(ui!.active.id).toBe(x);
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Panel ask={null} chat="p2|main" />));
    expect(ui!.active.id).toBe(y);
  });

  it("gives way to Files carried by a pick in the panel's explorer, which is that chat's tab from then on", () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'ff', kind: 'files' }, { id: 'tt', kind: 'terminal' }]));
    act(() => root.render(<Panel ask={{ agent, n: 1 }} chat="p1|main" />));
    act(() => root.render(<Panel ask={null} chat="p2|main" tool="files" />));
    expect(ui!.active.kind).toBe('files');
    // Picked in Files beside p2: p1, whose subagent was on screen, opens on Files under the click.
    act(() => root.render(<Panel ask={null} chat="p1|main" tool="files" carried />));
    expect(ui!.active.id).toBe('ff');
    act(() => root.render(<Panel ask={null} chat="p1|main" tool="files" />));
    expect(ui!.active.id).toBe('ff');
    // And stays so: back from p2, p1 is on Files, not its subagent.
    act(() => root.render(<Panel ask={null} chat="p2|main" tool="files" />));
    act(() => root.render(<Panel ask={null} chat="p1|main" tool="files" />));
    expect(ui!.active.id).toBe('ff');
  });

  it('gives way to a tool asked for on the move, as a share link or a review link asks', () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'bb', kind: 'browser' }, { id: 'tt', kind: 'terminal' }]));
    act(() => root.render(<Panel ask={{ agent, n: 1 }} chat="p1|main" />));
    act(() => root.render(<Panel ask={null} chat="p2|main" tool="browser" />));
    expect(ui!.active.kind).toBe('browser');
    act(() => root.render(<Panel ask={null} chat="p1|main" tool="browser" toolAsk={{ tab: 'browser', n: 1 }} />));
    expect(ui!.active.id).toBe('bb');
  });

  it('opens on the subagent kept as one bare id, from before each chat kept its own', () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'tt', kind: 'terminal' }, { id: 'ax', kind: 'agent', agent }]));
    localStorage.setItem(PANEL_AGENT_TAB_KEY, 'ax');
    act(() => root.render(<Panel ask={null} chat="p1|main" />));
    expect(ui!.active.id).toBe('ax');
  });
});
