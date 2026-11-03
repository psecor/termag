// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolItem } from '../../chat/toolRuns';
import { askCallsOf, type AskView } from '../../chat/asks';
import { ToolCard, ToolRun } from './ToolCards';
import { AsksContext, type AsksUi } from './Asks';

const T1 = 'cmvtr5x6r0i0lafsfuclk9ed5';
const T2 = 'cmvtr5y1k0i0qbm2pz7xw3d8c';
const T3 = 'cmvtr5yd90i0v7hs1qe4nb6ka';

const fire = (id: string, thread: string, title: string, over: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', key: `tool:${id}`, id, name: 'Bash',
  input: { command: `termag ask --no-wait termag-4/termag-4 --title "${title}" - < /tmp/${id}.md 2>&1`, description: `Fire ask ${id}` },
  inputJson: '', result: `Asked termag-4/termag-4 (hop 1). Nothing keeps the reply: only a \`termag ask --reply m${id}000000000\` waiting when it finishes gets it.\nthread: ${thread}`,
  isError: false, done: true, ...over,
});
const write: ToolItem = { kind: 'tool', key: 'tool:w', id: 'w', name: 'Write', input: { file_path: '/tmp/a.md' }, inputJson: '', result: 'ok', isError: false, done: true };

const view = (thread: string, title: string, over: Partial<AskView> = {}): AskView => ({
  thread, title, target: 'termag-4/termag-4', chat: { projectId: 'p4', workstream: `ask-${thread}` }, state: 'working', turns: 1, error: null,
  startedAt: new Date(Date.now() - 64_000).toISOString(), completedAt: null, waiting: 'nobody', noWait: true, reply: 'pending', prs: [], known: true, ...over,
});

const calls = [fire('1', T1, 'Titanic wreck: discovery'), fire('2', T2, 'Titanic wreck: location'), fire('3', T3, 'Titanic wreck: expeditions')];
function ui(views: AskView[], open = vi.fn()): AsksUi {
  const c = askCallsOf(calls);
  return {
    calls: c,
    byCall: new Map(calls.map((t, i) => [t.id, [[T1, T2, T3][i]]])),
    views: new Map(views.map(v => [v.thread, v])),
    open, shownThread: null,
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

const line = () => host.querySelector('.ask-line');
const rows = () => [...host.querySelectorAll('.ask-call')];

describe('a run that sent asks, shut', () => {
  const working = [view(T1, 'Titanic wreck: discovery'), view(T2, 'Titanic wreck: location'), view(T3, 'Titanic wreck: expeditions', { state: 'done', completedAt: new Date().toISOString(), reply: 'dropped' })];

  it('folds them into one quiet line that says nobody is waiting for the replies', () => {
    act(() => root.render(<AsksContext.Provider value={ui(working)}><ToolRun runKey="run:w" tools={[write, ...calls]} /></AsksContext.Provider>));
    expect(line()?.textContent).toContain('Asked 3 agents');
    expect(line()?.textContent).toContain('on termag-4 · 2 working · 1 done');
    expect(line()?.querySelector('.ask-waiting')?.textContent).toBe('Claude isn’t waiting for replies');
    // Quiet: no rows until it is opened, and no Bash cards.
    expect(rows()).toEqual([]);
    expect(host.querySelector('.sdk-tool-detail')).toBeNull();
  });

  it('opens to a row per ask, each saying where it is and that Claude isn\'t waiting', () => {
    const open = vi.fn();
    act(() => root.render(<AsksContext.Provider value={ui(working, open)}><ToolRun runKey="run:w" tools={[write, ...calls]} /></AsksContext.Provider>));
    act(() => line()!.querySelector<HTMLButtonElement>('.ask-line-head')!.click());
    expect(rows().map(r => r.querySelector('.sdk-tool-intent')?.textContent)).toEqual(['Titanic wreck: discovery', 'Titanic wreck: location', 'Titanic wreck: expeditions']);
    expect(rows()[0].querySelector('.agent-call-line')?.textContent).toBe('working · 1m 4s');
    expect(rows()[0].querySelector('.ask-waiting')?.textContent).toBe('Claude isn’t waiting for a reply');
    expect(rows()[2].querySelector('.ask-waiting')?.textContent).toBe('Not sent back to Claude');
    act(() => rows()[1].querySelector<HTMLButtonElement>('button')!.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ thread: T2 }));
  });

  it('says they went to nobody once all are done', () => {
    const done = working.map(v => ({ ...v, state: 'done' as const, reply: 'dropped' as const, completedAt: new Date().toISOString() }));
    act(() => root.render(<AsksContext.Provider value={ui(done)}><ToolRun runKey="run:w" tools={[write, ...calls]} /></AsksContext.Provider>));
    expect(line()?.querySelector('.ask-waiting')?.textContent).toBe('Not sent back to Claude');
  });
});

describe('an ask call on its own', () => {
  it('is its ask\'s row, and a follow-up says so', () => {
    const follow = { ...fire('4', T1, 'x'), input: { command: `termag ask --no-wait termag-4/termag-4 --thread ${T1} - < f.md` } };
    const u = ui([view(T1, 'Titanic wreck: discovery', { turns: 2 })]);
    const withFollow: AsksUi = { ...u, calls: askCallsOf([...calls, follow]), byCall: new Map([...u.byCall, ['4', [T1]]]) };
    act(() => root.render(<AsksContext.Provider value={withFollow}><ToolCard item={follow} /></AsksContext.Provider>));
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector('.sdk-tool-title')?.textContent).toBe('Follow-up');
    expect(rows()[0].querySelector('.agent-type')?.textContent).toBe('termag-4');
  });

  it('opens its tab before the asks route has named its session', () => {
    const open = vi.fn();
    act(() => root.render(<AsksContext.Provider value={ui([view(T1, 'Titanic wreck: discovery', { known: false, chat: null, state: 'starting' })], open)}><ToolCard item={calls[0]} /></AsksContext.Provider>));
    act(() => rows()[0].querySelector<HTMLButtonElement>('button')!.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ thread: T1, known: false }));
  });

  it('says Claude is waiting while a call waits for it', () => {
    act(() => root.render(<AsksContext.Provider value={ui([view(T1, 'Titanic wreck: discovery', { waiting: 'claude', noWait: false })])}><ToolCard item={calls[0]} /></AsksContext.Provider>));
    expect(rows()[0].querySelector('.ask-waiting')?.textContent).toBe('Claude is waiting');
  });

  it('is a Bash card as before with asks off', () => {
    act(() => root.render(<ToolCard item={calls[0]} />));
    expect(rows()).toEqual([]);
    expect(host.querySelector('.sdk-tool-title')?.textContent).toBe('Bash');
  });
});

describe('asks kept in view', () => {
  const kept = [view(T1, 'Titanic wreck: discovery'), view(T2, 'Titanic wreck: location', { state: 'done', completedAt: new Date().toISOString(), reply: 'dropped' })];

  it('lead the context card\'s Asks, each saying whether Claude is waiting, and open the ask', async () => {
    const { AsksCardSection } = await import('./Asks');
    const open = vi.fn();
    act(() => root.render(<AsksCardSection list={kept} ui={ui(kept, open)} />));
    expect(host.querySelector('.ctx-heading')?.textContent).toBe('Asks1 working · 1 done');
    expect([...host.querySelectorAll('.agent-row-sub')].map(e => e.textContent)).toEqual(['Working · Claude isn’t waiting for a reply', 'Finished · not sent back to Claude']);
    act(() => host.querySelector<HTMLButtonElement>('.ask-row')!.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ thread: T1 }));
  });

  it('are one line in the drawer that says nobody is waiting, and open to their rows', async () => {
    const { AsksDrawer } = await import('./Asks');
    act(() => root.render(<AsksDrawer list={kept} ui={ui(kept)} />));
    expect(host.querySelector('.agent-drawer-lead')?.textContent).toBe('1 ask working');
    expect(host.querySelector('.agent-drawer-now')?.textContent).toBe('· 1 done · Claude isn’t waiting for replies');
    expect(host.querySelectorAll('.ask-row')).toHaveLength(0);
    act(() => host.querySelector<HTMLButtonElement>('.agent-drawer-head')!.click());
    expect(host.querySelectorAll('.ask-row')).toHaveLength(2);
  });

  it('never repeats the lead, and says Claude is waiting when it is', async () => {
    const { AsksDrawer } = await import('./Asks');
    const waited = [view(T1, 'One', { waiting: 'claude', noWait: false }), view(T2, 'Two', { state: 'starting', waiting: 'claude', noWait: false })];
    act(() => root.render(<AsksDrawer list={waited} ui={ui(waited)} />));
    expect(host.querySelector('.agent-drawer-lead')?.textContent).toBe('2 asks working');
    expect(host.querySelector('.agent-drawer-now')?.textContent).toBe('· Claude is waiting');
    const mixed = [view(T1, 'One', { waiting: 'claude', noWait: false }), view(T2, 'Two', { state: 'done', reply: 'delivered', waiting: 'nobody', noWait: false })];
    act(() => root.render(<AsksDrawer list={mixed} ui={ui(mixed)} />));
    expect(host.querySelector('.agent-drawer-now')?.textContent).toBe('· 1 done');
  });
});
