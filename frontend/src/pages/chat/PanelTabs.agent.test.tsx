// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PANEL_AGENT_TAB_KEY, PANEL_TABS_KEY, parsePanelTabs } from '../../chat/panelTabs';
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

function Panel({ ask, chat }: { ask: AgentAsk | null; chat: string }) {
  ui = usePanelTabs(true, ['terminal', 'files'], 'terminal', () => {}, null, undefined, chat, ask);
  return null;
}

const agent = { chat: 'p1|main', id: 'toolu_1', title: 'Run the tests' };

describe('an agent tab the panel opens with', () => {
  it('is kept, and the panel opens on it again', () => {
    act(() => root.render(<Panel ask={{ agent, n: 1 }} chat="p1|main" />));
    expect(ui!.active).toMatchObject({ kind: 'agent', agent });
    const kept = parsePanelTabs(localStorage.getItem(PANEL_TABS_KEY));
    expect(kept).toEqual([expect.objectContaining({ kind: 'agent', agent })]);
    expect(localStorage.getItem(PANEL_AGENT_TAB_KEY)).toBe(ui!.active.id);
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
});
