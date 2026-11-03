// @vitest-environment jsdom
import React, { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow } from '../../mobile/inbox';
import type { OpenItemRef } from '../../chat/openItems';
import { agentForest, searchAgents } from '../../chat/explorerAgents';
import { resetUnfoldedRuns } from '../../chat/automationRunGroups';
import { sessionKey, useAgentTree } from './ExplorerTree';
import { AutomationsProvider } from '../../chat/useAutomations';
import { automation } from '../../chat/automationsView.fixtures';
import { searchAutomations } from '../../chat/automationPlaces';
import type { AutomationView } from '../../services/api';
import { setFlagValues } from '../../flags';

const mocks = vi.hoisted(() => ({
  links: [] as Array<{ projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }>,
  automations: null as unknown[] | null,
}));
vi.mock('./simpleData', () => ({
  useSimpleData: () => ({ live: new Map(), setupOf: new Map(), links: mocks.links }),
}));
vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  automationsApi: {
    list: async () => mocks.automations
      ?? [{ projectId: 'babysit', schedule: '0 9 * * 1-5', timezone: 'UTC', enabled: true, pausedReason: null, nextRunAt: null, lastRun: null }],
  },
}));

const row = (projectId: string): InboxRow => ({
  key: `${projectId}|main`, projectId, workstream: 'main', projectName: projectId, instanceId: `box-${projectId}`, band: 'idle',
} as unknown as InboxRow);
const ROWS = [row('boss'), row('kid'), row('grandkid'), row('solo')];

let root: Root;
let host: HTMLDivElement;
const show = vi.fn();
const shut = new Set<string>();

/** One explorer's tree, or its search hits, the way FileExplorer and AgentsExplorer render them. */
function Tree({ activeKey = null, query = '', space, rows = ROWS, placed }: {
  activeKey?: string | null; query?: string; space?: string; rows?: InboxRow[]; placed?: AutomationView[];
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const agents = agentForest(rows, mocks.links);
  const agentRef = (r: InboxRow): OpenItemRef => ({ kind: 'chat', projectId: r.projectId, workstream: r.workstream });
  const chatSpaceOf = space ? () => space : undefined;
  const { ctx, agentNodes, agentHit, automationHit } = useAgentTree({ shut, rerender, activeKey, show, agentRef, chatSpaceOf, agents, placed, openPage });
  return (
    <>
      <ul className="fx-tree">{query
        ? [...searchAutomations(placed ?? [], query).map(a => automationHit(a, query)), ...searchAgents(agents, query).map(r => agentHit(r, query))]
        : agentNodes(agents, true)}</ul>
      {ctx.menu}
    </>
  );
}
const openPage = vi.fn();

function render(props: React.ComponentProps<typeof Tree> = {}, path = '/chat') {
  act(() => root.render(<MemoryRouter initialEntries={[path]}><AutomationsProvider><Tree {...props} /></AutomationsProvider></MemoryRouter>));
}

const names = () => [...host.querySelectorAll('.fx-tree > li > a.fx-row .fx-name')].map(n => n.textContent);
const rowOf = (name: string) => [...host.querySelectorAll<HTMLAnchorElement>('a.fx-row')].find(a => a.querySelector('.fx-name')?.textContent === name)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.links = [
    { projectId: 'kid', workstream: 'main', parentProjectId: 'boss', parentWorkstream: 'main' },
    { projectId: 'grandkid', workstream: 'main', parentProjectId: 'kid', parentWorkstream: 'main' },
  ];
  shut.clear();
  resetUnfoldedRuns();
  show.mockClear();
  openPage.mockClear();
  mocks.automations = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('useAgentTree', () => {
  it('nests an agent under the one that started it, shown until its twisty folds it, in the explorer\'s own set', () => {
    render();
    expect(names()).toEqual(['boss', 'solo']);
    expect(rowOf('kid').closest('.fx-children')).not.toBeNull();
    const twisty = host.querySelector<HTMLButtonElement>('.fx-twisty')!;
    expect(twisty.getAttribute('aria-label')).toBe('Hide the agents boss started');
    expect(twisty.getAttribute('aria-expanded')).toBe('true');
    act(() => twisty.click());
    expect(rowOf('kid')).toBeUndefined();
    expect(shut.has(sessionKey({ projectId: 'boss', workstream: 'main' }))).toBe(true);
    // The set is the explorer's: a remount keeps what was folded.
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(rowOf('kid')).toBeUndefined();
  });

  it('reveals the agent shown, unfolding every agent that started it, and highlights it', () => {
    shut.add('boss|main');
    shut.add('kid|main');
    render({ activeKey: 'grandkid|main' });
    expect(rowOf('grandkid').classList.contains('active')).toBe(true);
    expect(rowOf('grandkid').getAttribute('aria-current')).toBe('page');
    expect(rowOf('boss').classList.contains('active')).toBe(false);
  });

  it('opens a row in its tab, and from its menu in a new tab, with the ref the explorer gives and the agent\'s own space', () => {
    render({ space: 'notes' });
    act(() => { rowOf('solo').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(show).toHaveBeenLastCalledWith({ kind: 'chat', projectId: 'solo', workstream: 'main' }, false, 'notes');
    act(() => { rowOf('solo').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
    const items = [...document.querySelectorAll<HTMLButtonElement>('.chat-ctx-menu [role=menuitem]')];
    expect(items.map(b => b.textContent)).toEqual(['Open', 'Open in new tab', 'Open in new browser tab']);
    act(() => items[1].click());
    expect(show).toHaveBeenLastCalledWith({ kind: 'chat', projectId: 'solo', workstream: 'main' }, true, 'notes');
    expect(host.querySelector('.fx-menu')!.getAttribute('aria-label')).toBe('Options for boss');
  });

  it('marks a search hit\'s match and says which agent it is under', () => {
    render({ query: 'kid' });
    const hits = [...host.querySelectorAll('.fx-hit')];
    expect(hits.map(h => h.querySelector('.fx-name')!.textContent)).toEqual(['kid', 'grandkid']);
    expect(hits.map(h => h.querySelector('.fx-where')?.textContent)).toEqual(['under boss', 'under kid']);
    expect(hits[0].querySelector('mark')!.textContent).toBe('kid');
  });
});

describe('an automation\'s runs', () => {
  // pr-babysitter's runs, one every half hour from 06:00: the newest (19:30) is working, the one before waits.
  const run = (i: number, status: string): InboxRow => {
    const t = 6 * 60 + 30 * i;
    const ws = `run-20261028-${String(Math.floor(t / 60)).padStart(2, '0')}${String(t % 60).padStart(2, '0')}`;
    return { key: `babysit|${ws}`, projectId: 'babysit', workstream: ws, projectName: 'pr-babysitter', kind: 'automation', instanceId: 'box-1', band: 'idle', status } as unknown as InboxRow;
  };
  const runs = (n: number, newest = 'not_running') => Array.from({ length: n }, (_, i) => run(i, i === n - 1 ? newest : 'idle'));
  const others = [row('main'), row('termag-5')];
  const head = () => host.querySelector<HTMLButtonElement>('.fx-runs-head')!;
  // A run is named by its weekday and time while it is within the week.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T20:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });
  const runNames = () => [...host.querySelectorAll('.fx-runs .fx-children a.fx-row .fx-name')].map(n => n.textContent);

  it('lists them as one row, folded, between the agents around it', async () => {
    render({ rows: [...others, ...runs(3)] });
    await act(async () => {});
    expect([...host.querySelectorAll('.fx-tree > li')].map(li => li.querySelector('.fx-name')!.textContent)).toEqual(['main', 'pr-babysitter', 'termag-5']);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(head().querySelector('.fx-runs-count')!.textContent).toBe('3');
    expect(head().querySelector('.fx-runs-count')!.getAttribute('aria-label')).toBe('3 runs');
    expect(head().querySelector('.fx-where')!.textContent).toBe('weekdays at 09:00 (UTC)');
    expect(runNames()).toEqual([]);
  });

  it('shows the latest run\'s status, and working while any run works', () => {
    render({ rows: runs(3, 'waiting') });
    expect(head().querySelector('.chat-agent-icon')!.getAttribute('data-status')).toBe('waiting');
    render({ rows: [run(0, 'working'), run(1, 'idle'), run(2, 'not_running')] });
    expect(head().querySelector('.chat-agent-icon')!.getAttribute('data-status')).toBe('working');
  });

  it('unfolds to the runs newest first, named by their time, and folds again', () => {
    render({ rows: runs(3) });
    act(() => head().click());
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(runNames()).toEqual(['Wed 07:00', 'Wed 06:30', 'Wed 06:00']);
    act(() => head().click());
    expect(runNames()).toEqual([]);
  });

  it('is unfolded when one of its runs is open', () => {
    render({ rows: runs(3), activeKey: 'babysit|run-20261028-0630' });
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(rowOf('Wed 06:30').classList.contains('active')).toBe(true);
  });

  it('lists the last ten, then Show all on the automation\'s page, and keeps an older open run', () => {
    render({ rows: runs(12) });
    act(() => head().click());
    expect(runNames()).toHaveLength(10);
    expect(runNames()[0]).toBe('Wed 11:30');
    const all = host.querySelector<HTMLAnchorElement>('.fx-runs-all a')!;
    expect(all.textContent).toBe('Show all 12 runs');
    expect(all.getAttribute('href')).toBe('/automations/babysit');
    resetUnfoldedRuns();
    render({ rows: runs(12), activeKey: 'babysit|run-20261028-0600' });
    expect(runNames()).toHaveLength(11);
    expect(runNames()[10]).toBe('Wed 06:00');
  });
});

describe('automations in an explorer, with their own pages (simple-ui-automations-enabled)', () => {
  const nightly = automation({ id: 'a1', projectId: 'babysit', projectName: 'pr-babysitter', schedule: '0 9 * * 1-5', timezone: 'UTC', spaceName: 'team' });
  const solo = automation({ id: 'a2', projectId: 'deps', projectName: 'deps-bump', schedule: '0 7 * * *', timezone: 'UTC' });
  const run = (ws: string): InboxRow => ({
    key: `babysit|${ws}`, projectId: 'babysit', workstream: ws, projectName: 'pr-babysitter', kind: 'automation', instanceId: 'box-1', band: 'idle', status: 'idle',
  } as unknown as InboxRow);
  const autoRow = (name: string) => [...host.querySelectorAll<HTMLAnchorElement>('a.fx-runs-head')].find(a => a.querySelector('.fx-name')?.textContent === name)!;
  beforeEach(() => {
    setFlagValues({ 'simple-ui-automations-enabled': true, 'automations-enabled': true });
    mocks.automations = [nightly, solo];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T20:00:00Z'));
  });
  afterEach(() => { setFlagValues(undefined); vi.useRealTimers(); });

  it('lists an automation placed here before its first run, by name among the agents, as a row to its page', async () => {
    render({ rows: [row('alpha'), row('solo')], placed: [solo] });
    await act(async () => {});
    expect([...host.querySelectorAll('.fx-tree > li')].map(li => li.querySelector('.fx-name')!.textContent)).toEqual(['alpha', 'deps-bump', 'solo']);
    const a = autoRow('deps-bump');
    expect(a.getAttribute('href')).toBe('/chat/automations/deps');
    expect(a.querySelector('.fx-runs-count')!.textContent).toBe('0');
    expect(a.querySelector('.fx-where')!.textContent).toBe('every day at 07:00 (UTC)');
    // No runs: no caret.
    expect(a.closest('li')!.querySelector('.fx-twisty')).toBeNull();
    act(() => a.click());
    expect(openPage).toHaveBeenCalledWith('/chat/automations/deps');
    expect(show).not.toHaveBeenCalled();
  });

  it('is one row with its runs: the row opens the page, the caret unfolds the runs', async () => {
    render({ rows: [run('run-20261028-0900'), run('run-20261027-0900')], placed: [nightly] });
    await act(async () => {});
    expect(host.querySelectorAll('.fx-tree > li')).toHaveLength(1);
    const a = autoRow('pr-babysitter');
    expect(a.getAttribute('href')).toBe('/chat/automations/babysit');
    expect(a.querySelector('.fx-runs-count')!.textContent).toBe('2');
    const caret = a.closest('li')!.querySelector<HTMLButtonElement>('.fx-twisty')!;
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    act(() => caret.click());
    expect([...host.querySelectorAll('.fx-runs .fx-children a.fx-row .fx-name')].map(n => n.textContent)).toEqual(['Wed 09:00', 'Tue 09:00']);
  });

  it('has Open and Open in new browser tab in its menu, and no tab of its own', async () => {
    render({ rows: [], placed: [solo] });
    await act(async () => {});
    act(() => { autoRow('deps-bump').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect([...document.querySelectorAll('[role="menuitem"]')].map(el => el.textContent)).toEqual(['Open', 'Open in new browser tab']);
  });

  it('is highlighted on its page', async () => {
    render({ rows: [], placed: [solo] }, '/chat/automations/a2');
    await act(async () => {});
    expect(autoRow('deps-bump').classList.contains('active')).toBe(true);
  });

  it('is a search hit by name', async () => {
    render({ rows: [row('solo')], placed: [solo], query: 'deps' });
    await act(async () => {});
    const hit = host.querySelector<HTMLAnchorElement>('a.fx-hit')!;
    expect(hit.getAttribute('href')).toBe('/chat/automations/deps');
    expect(hit.querySelector('mark')!.textContent).toBe('deps');
  });

  it('keeps the folding button and the full UI\'s page without the flag', async () => {
    setFlagValues({ 'automations-enabled': true });
    render({ rows: [run('run-20261028-0900')], placed: [solo] });
    await act(async () => {});
    expect(host.querySelector('button.fx-runs-head')).not.toBeNull();
    expect(host.querySelector('a.fx-runs-head')).toBeNull();
    expect([...host.querySelectorAll('.fx-tree > li')]).toHaveLength(1);
  });
});
