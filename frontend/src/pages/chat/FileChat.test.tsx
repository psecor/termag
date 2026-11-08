// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistory, SpaceViewUrl } from '../../services/api';
import { chatEvents } from '../../chat/chatEvents';
import { LAST_CHAT_KEY } from '../../chat/fileChat';
import { chatModelOptions } from '../../chat/composer';
import { requestComposeFill } from '../../chat/fileChat';
import { resetStripsForTests } from '../../chat/fileStrip';

const SPACE = 'improve-termag';
const project = (id: string, provider = 'claude-chat') => ({
  id, name: id, instanceId: 'box-1', workstreams: [{ id: `${id}-ws`, name: 'main' }], workflows: [{ id: `${id}-wf`, type: 'agent', workstreamId: `${id}-ws`, provider }],
});
const row = (id: string, updatedAt: string) => ({
  key: `${id}|main`, projectId: id, projectName: id, workstream: 'main', instanceId: 'box-1', updatedAt, status: 'idle', message: null, kind: 'normal',
});
const mocks = vi.hoisted(() => ({
  view: vi.fn(),
  history: vi.fn(),
  send: vi.fn(),
  noteSent: vi.fn(),
  tabs: [] as unknown[],
  rows: [] as unknown[],
  projects: [] as unknown[],
  spaces: [] as Array<{ name: string; role?: string }>,
  interrupt: vi.fn(async () => ({ interrupted: true })),
  context: vi.fn(async (_p: string, _w: string, action: string) => (action === 'clear' ? { reset: true, at: '2026-10-27T12:00:00Z' } : { compacting: true })),
  noBoxes: [] as unknown[],
  start: vi.fn(async () => ({ ok: true, status: 'starting' })),
  fileText: '# PR outbox\n\n- #755',
}));
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { pick: vi.fn(), noteSent: mocks.noteSent, state: { items: mocks.tabs } }, rows: mocks.rows, live: new Map(), setupOf: new Map(), links: [], activeTab: 'f1', itemsShown: true,
    spaces: { loaded: true, current: true, spaces: mocks.spaces, index: new Map([['box-1', [SPACE]]]) },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: mocks.projects, reloadProjects: async () => {} }) }));
vi.mock('../../chat/useChatModelOptions', () => ({ useChatModelOptions: () => chatModelOptions([]) }));
vi.mock('../../services/api', () => ({
  spacesApi: { view: mocks.view },
  chatApi: { history: mocks.history, send: mocks.send, interrupt: mocks.interrupt, reclaim: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn(), context: mocks.context },
  activityApi: { heartbeat: vi.fn(async () => ({})) },
  instancesApi: { start: mocks.start },
}));
// jsdom draws no images: a picked file comes back prepared as it would in a browser.
vi.mock('../../chat/chatImageData', async importOriginal => ({
  ...(await importOriginal<typeof import('../../chat/chatImageData')>()),
  prepareImage: async (f: File) => ({ id: `img-${f.name}`, mediaType: f.type, data: 'aGVsbG8=', src: 'data:image/png;base64,aGVsbG8=', name: f.name }),
  // The composer prepares attachments (images, and PDFs since #1110) through this one.
  prepareAttachment: async (f: File) => ({ id: `img-${f.name}`, mediaType: f.type, data: 'aGVsbG8=', src: 'data:image/png;base64,aGVsbG8=', name: f.name }),
}));
// The conversation's composer, as SdkChatView's tests mount it: no box feed, no sign-in card.
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => mocks.noBoxes, hasLoaded: () => true, isGone: () => false, lookFor: () => {}, reload: () => Promise.resolve() },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));
vi.mock('../../services/spaceTransfer', () => ({ downloadFile: vi.fn(), errorMessage: (_e: unknown, f: string) => f }));

import { SpaceFileView } from './SpaceFileView';

const history = (over: Partial<ChatHistory> = {}): ChatHistory => ({
  chatKey: 'k', workstream: 'main', sessionId: 's', running: false, queued: 0, checkoutReady: true, entries: [], model: 'opus', ...over,
});

let root: Root;
let host: HTMLDivElement;
let location = '';
function Probe() {
  const l = useLocation();
  location = l.pathname + l.search;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // React Aria (LaunchPad's menu and popovers) escapes ids with CSS.escape, which jsdom lacks.
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  sessionStorage.clear();
  mocks.spaces = [{ name: SPACE, role: 'owner' }, { name: 'other', role: 'editor' }];
  resetStripsForTests();
  localStorage.clear();
  mocks.projects = [project('docs'), project('termag-5'), project('pane', 'claude')];
  mocks.rows = [row('docs', '2026-10-27T10:00:00Z'), row('termag-5', '2026-10-27T09:00:00Z'), row('pane', '2026-10-27T11:00:00Z')];
  mocks.tabs = [
    { kind: 'file', space: SPACE, path: 'pr-outbox.md', id: 'f1', openedAt: 1 },
    { kind: 'chat', projectId: 'termag-5', workstream: 'main', id: 't5', openedAt: 1 },
    { kind: 'chat', projectId: 'docs', workstream: 'main', id: 'd1', openedAt: 1 },
    { kind: 'chat', projectId: 'pane', workstream: 'main', id: 'p1', openedAt: 1 },
  ];
  mocks.view.mockResolvedValue({ url: 'https://bucket.s3.test/x', expiresAt: '', size: 20, contentType: null, view: { contentType: 'text/markdown', render: 'markdown' } } as SpaceViewUrl);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(mocks.fileText)));
  mocks.history.mockResolvedValue(history());
  mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mocks.fileText = '# PR outbox\n\n- #755';
  vi.unstubAllGlobals();
  mocks.view.mockReset(); mocks.history.mockReset(); mocks.send.mockReset(); mocks.noteSent.mockReset(); mocks.interrupt.mockClear();
});

async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function open(path = 'pr-outbox.md') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/chat/f/${SPACE}/${path}`]}>
        <Routes><Route path="/chat/f/:space/*" element={<SpaceFileView />} /><Route path="*" element={null} /></Routes>
        <Probe />
      </MemoryRouter>,
    );
  });
  await settle();
}

const input = () => host.querySelector<HTMLTextAreaElement>('.fv-chat textarea')!;
const toChip = () => host.querySelector<HTMLButtonElement>('.fv-chat-agent');
// The one line above the box, and what it says.
const line = () => host.querySelector<HTMLElement>('.fv-chat-line')!;
const lineText = () => host.querySelector('.fv-chat-line-text')?.textContent;
async function type(text: string) {
  const el = input();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enter() {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await settle();
}
function frame(projectId: string, event: unknown) {
  act(() => chatEvents.publish({ type: 'chat', projectId, workstream: 'main', turnId: null, event }));
}

describe('FileChat under a space file', () => {
  it('goes to the conversation the tab came from when it is in the space, and says so', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    await open();
    expect(host.querySelector('.fv-md')?.textContent).toContain('PR outbox');
    expect(toChip()?.getAttribute('aria-label')).toBe('To: termag-5');
    expect(input().placeholder).toBe('Message an agent about this file…');
    expect(mocks.history).toHaveBeenCalledWith('termag-5', 'main');
  });

  it('else goes to the space\'s most recently active chat session; a pane session is never a target', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'elsewhere', workstream: 'main' }));
    await open();
    // pane is newer but runs in a terminal pane; docs is the newest chat-runner session.
    expect(toChip()?.getAttribute('aria-label')).toBe('To: docs');
  });

  it('names the target as the sidebar does: Claude\'s title, then the project', async () => {
    mocks.rows = mocks.rows.map(r => ((r as { projectId: string }).projectId === 'termag-5' ? { ...(r as object), sessionTitle: 'Track the PR outbox' } : r));
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    await open();
    expect(toChip()?.getAttribute('aria-label')).toBe('To: Track the PR outbox · termag-5');
    expect(input().placeholder).toBe('Message an agent about this file…');
  });

  it('picks another session of the space from the To chip, and remembers it', async () => {
    await open();
    await act(async () => { toChip()!.click(); });
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    // The space's chat sessions in tab order, the current one ticked; not the pane session, not another space's.
    expect(items.map(i => i.textContent?.split(' · ')[0])).toEqual(['termag-5', '✓ docs']);
    await act(async () => { items.find(i => i.textContent?.includes('termag-5'))!.click(); });
    await settle();
    expect(toChip()?.getAttribute('aria-label')).toBe('To: termag-5');
    expect(JSON.parse(sessionStorage.getItem(LAST_CHAT_KEY)!)).toEqual({ projectId: 'termag-5', workstream: 'main' });
  });

  it('sends with Enter through the conversation\'s send route, with the file as context, and shows the reply without leaving the file', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    await open();
    await type('mark 755 ready');
    await enter();
    const message = 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)';
    expect(mocks.send).toHaveBeenCalledWith('termag-5', 'main', message, [], null);
    expect(mocks.noteSent).toHaveBeenCalledWith({ projectId: 'termag-5', workstream: 'main' });
    expect(input().value).toBe('');
    const status = () => lineText();
    // Sent; the box hasn't started it yet.
    expect(status()).toBe('termag-5 · Queued · sent after the current turn');

    frame('termag-5', { type: 'turn-start', text: message });
    expect(status()).toBe('termag-5 · working…');
    expect(host.querySelector('.fv-chat-line .sdk-spinner')).not.toBeNull();
    frame('termag-5', { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Marked **#755** ready for review.' }] } });
    frame('termag-5', { type: 'turn-end' });
    // One line: the reply's first line, as plain text; the reply itself is in the conversation (Open).
    expect(status()).toBe('termag-5 replied: Marked #755 ready for review.');
    // Still on the file.
    expect(location).toBe(`/chat/f/${SPACE}/pr-outbox.md`);
    expect(host.querySelector('.fv-md')?.textContent).toContain('PR outbox');
    expect(host.querySelector('.fv-chat-open')?.textContent).toBe('Open');
    expect(host.querySelector('.fv-chat-open')?.getAttribute('href')).toBe('/chat/p/termag-5?tab=t5');
  });

  it('shows a session\'s last reply again when the target comes back to it, until dismissed', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    await open();
    await type('mark 755 ready');
    await enter();
    const message = 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)';
    frame('termag-5', { type: 'turn-start', text: message });
    frame('termag-5', { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Marked.' }] } });
    frame('termag-5', { type: 'turn-end' });
    const pickTarget = async (name: string) => {
      await act(async () => { toChip()!.click(); });
      await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(i => i.textContent?.includes(name))!.click(); });
      await settle();
    };
    await pickTarget('docs');
    expect(line().dataset.strip).toBe('hidden');
    // The history now has the message and its answer.
    mocks.history.mockResolvedValue(history({ entries: [
      { type: 'user', message: { role: 'user', content: message } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Marked.' }] } },
    ] }));
    await pickTarget('termag-5');
    expect(lineText()).toBe('termag-5 replied: Marked.');
    await act(async () => { host.querySelector<HTMLButtonElement>('.fv-chat-line-dismiss')!.click(); });
    expect(line().dataset.strip).toBe('hidden');
    await pickTarget('docs');
    await pickTarget('termag-5');
    expect(line().dataset.strip).toBe('hidden');
  });

  it('follows a message sent again, not the answer the same words got before', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    const message = 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)';
    mocks.history.mockResolvedValue(history({ entries: [
      { type: 'user', message: { role: 'user', content: message } },
      { type: 'assistant', message: { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'Marked earlier.' }] } },
    ] }));
    await open();
    await type('mark 755 ready');
    await enter();
    const status = () => lineText();
    expect(status()).toBe('termag-5 · Queued · sent after the current turn');
    expect(host.querySelector('.fv-chat-reply-body')).toBeNull();
    frame('termag-5', { type: 'turn-start', text: message });
    frame('termag-5', { type: 'assistant', message: { id: 'new', content: [{ type: 'text', text: 'Already ready.' }] } });
    frame('termag-5', { type: 'turn-end' });
    expect(status()).toBe('termag-5 replied: Already ready.');
  });

  it('before the history answers, holds a message as the conversation does, then follows the new bubble, not an old one with the same words', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    const message = 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)';
    let answer: (h: ChatHistory) => void = () => {};
    mocks.history.mockReturnValue(new Promise<ChatHistory>(r => { answer = r; }));
    await open();
    await type('mark 755 ready');
    await enter();
    // The pre-ready queue holds it, in the conversation's words; nothing has gone yet.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(lineText()).toBe('termag-5 · sent as soon as Claude is ready');
    await act(async () => { answer(history({ entries: [
      { type: 'user', message: { role: 'user', content: message } },
      { type: 'assistant', message: { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'Marked earlier.' }] } },
    ] })); });
    await settle();
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0].slice(0, 3)).toEqual(['termag-5', 'main', message]);
    expect(host.querySelector('.fv-chat-reply-body')).toBeNull();
    frame('termag-5', { type: 'turn-start', text: message });
    frame('termag-5', { type: 'assistant', message: { id: 'new', content: [{ type: 'text', text: 'Already ready.' }] } });
    frame('termag-5', { type: 'turn-end' });
    expect(lineText()).toBe('termag-5 replied: Already ready.');
  });

  it('queues behind a running turn as the chat would, and keeps the message on a failed send', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    mocks.history.mockResolvedValue(history({ running: true }));
    await open();
    expect(input().placeholder).toBe('Message an agent about this file… (sent after this turn)');
    mocks.send.mockRejectedValueOnce({ response: { data: { error: 'The box is offline' } } });
    await type('merge it');
    await enter();
    expect(input().value).toBe('merge it');
    expect(host.querySelector('.chat-composer-note[data-error]')?.textContent).toBe('The box is offline');
    expect(line().dataset.strip).toBe('hidden');
  });

  it('has no target, and sends nothing, when the space has no chat session', async () => {
    mocks.tabs = [{ kind: 'file', space: SPACE, path: 'pr-outbox.md', id: 'f1', openedAt: 1 }];
    await open();
    expect(toChip()).toBeNull();
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe(`No agent session in ${SPACE} to message`);
    expect(mocks.history).not.toHaveBeenCalled();
  });
});

describe('the conversation\'s composer under the file', () => {
  beforeEach(() => { sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' })); });

  it('is the conversation\'s: model chip, context ring, and images where the chat takes them', async () => {
    mocks.history.mockResolvedValue(history({ imageInput: true }));
    await open();
    const bar = host.querySelector('.fv-chat .chat-composer-bar')!;
    // The agent picker leads the bar, a small button, no chip or row of its own.
    expect(bar.firstElementChild?.classList.contains('fv-chat-agent')).toBe(true);
    expect(host.querySelector('.fv-chat-to')).toBeNull();
    expect(bar.querySelector('.chat-compose-model-btn')).not.toBeNull();
    expect(bar.querySelector('.chat-ring, .chat-ring-btn, [class*="chat-ring"]')).not.toBeNull();
    const attach = bar.querySelector<HTMLButtonElement>('.chat-attach');
    expect(attach?.disabled).toBe(false);
  });

  it('takes an image while the target\'s box is stopped, and sends it with the text to the orchestrator, which holds both (#971)', async () => {
    mocks.noBoxes = [{ id: 'box-1', name: 'box-1', kind: 'ec2', ec2InstanceId: 'i-1', status: 'stopped' }];
    // A stored chat whose send the orchestrator holds while its box is down (routes/chat.ts holdIfContinuing).
    mocks.history.mockResolvedValue(history({ imageInput: true, stored: true, continuation: { takesSends: true }, entries: [{ type: 'user', message: { role: 'user', content: 'earlier' } }] }));
    mocks.send.mockResolvedValue({ queued: true, held: true, position: 1, phase: 'starting' });
    try {
      await open();
      const picker = host.querySelector<HTMLInputElement>('.fv-chat input[type="file"]')!;
      Object.defineProperty(picker, 'files', { value: [new File(['x'], 'shot.png', { type: 'image/png' })], configurable: true });
      await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
      await settle();
      expect(host.querySelector('.fv-chat .chat-composer img')).not.toBeNull();
      await type('what changed here?');
      await enter();
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.send.mock.calls[0][3]).toEqual([{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
      expect(String(mocks.send.mock.calls[0][2])).toContain('what changed here?');
      // The orchestrator starts the box for a send it holds; this tab doesn't.
      expect(mocks.start).not.toHaveBeenCalled();
      expect(host.querySelector('.fv-chat .chat-composer img')).toBeNull();
    } finally {
      mocks.noBoxes = [];
      mocks.start.mockClear();
    }
  });

  it('sends at the effort chosen for the session, as the conversation does', async () => {
    mocks.history.mockResolvedValue(history({ effortInput: true }));
    localStorage.setItem('termag.chatEffort.termag-5|main', 'high');
    await open();
    await type('merge #748');
    await enter();
    expect(mocks.send).toHaveBeenCalledWith('termag-5', 'main', 'merge #748\n\n(viewing improve-termag:pr-outbox.md)', [], null, 'high');
  });

  it('does not take the cursor when the file opens, and Escape stops a turn only from the composer', async () => {
    mocks.history.mockResolvedValue(history({ running: true }));
    await open();
    expect(document.activeElement).not.toBe(input());
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(mocks.interrupt).not.toHaveBeenCalled();
    act(() => input().focus());
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(mocks.interrupt).toHaveBeenCalledWith('termag-5', 'main', 'all');
    // And the Stop button is there, as in the conversation.
    expect(host.querySelector('.fv-chat .chat-stop-btn')).not.toBeNull();
  });
});

describe('the target, as Bugbot found it', () => {
  const pick = async (name: string) => {
    await act(async () => { toChip()!.click(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(i => i.textContent?.includes(name))!.click(); });
    await settle();
  };

  it('is chosen once when the file opens: newer activity elsewhere does not move it', async () => {
    await open();
    expect(toChip()?.getAttribute('aria-label')).toBe('To: docs');
    await type('mark 755 ready');
    // termag-5 becomes the most recently active session while the person types.
    mocks.rows = mocks.rows.map(r => ((r as { projectId: string }).projectId === 'termag-5' ? { ...(r as object), updatedAt: '2026-10-27T12:00:00Z' } : r));
    await open();
    expect(toChip()?.getAttribute('aria-label')).toBe('To: docs');
    expect(input().value).toBe('mark 755 ready');
  });

  it('keeps a newly picked target and its draft when an earlier send finishes', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    let finish: (v: { queued: boolean }) => void = () => {};
    mocks.send.mockReturnValueOnce(new Promise(r => { finish = r; }));
    await open();
    await type('mark 755 ready');
    await enter();
    expect(mocks.send).toHaveBeenCalledWith('termag-5', 'main', 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)', [], null);
    await pick('docs');
    await type('a draft for docs');
    await act(async () => { finish({ queued: false }); });
    await settle();
    expect(toChip()?.getAttribute('aria-label')).toBe('To: docs');
    expect(input().value).toBe('a draft for docs');
    expect(line().dataset.strip).toBe('hidden');
    // The reply belongs to termag-5, and shows there.
    await pick('termag-5');
    expect(lineText()).toMatch(/^termag-5 · /);
  });
});

describe('compose links in the file', () => {
  const OUTBOX = '| PR | Do it |\n|----|----|\n| #761 | [mark ready](termag-compose:mark%20%23761%20ready) |\n| #748 | [merge](termag-compose:merge%20%23748) |';
  const links = () => [...host.querySelectorAll<HTMLButtonElement>('.fv-md button.md-compose')];
  const click = async (label: string) => {
    await act(async () => { links().find(b => b.textContent === label)!.click(); });
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
  };

  it('fill the composer, focused, with the target unchanged, and never send', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    mocks.fileText = OUTBOX;
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    await open();
    await click('mark ready');
    expect(input().value).toBe('mark #761 ready');
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe('mark #761 ready'.length);
    expect(scrolled).toHaveBeenCalled();
    expect(toChip()?.getAttribute('aria-label')).toBe('To: termag-5');
    expect(mocks.send).not.toHaveBeenCalled();
    // Another link replaces what a link put there; Enter sends it as typed.
    await click('merge');
    expect(input().value).toBe('merge #748');
    await enter();
    expect(mocks.send).toHaveBeenCalledWith('termag-5', 'main', 'merge #748\n\n(viewing improve-termag:pr-outbox.md)', [], null);
  });

  it('keep what the person typed, adding the text on a new line', async () => {
    mocks.fileText = OUTBOX;
    await open();
    await type('after the demo');
    await click('mark ready');
    expect(input().value).toBe('after the demo\nmark #761 ready');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('Bugbot, sweep 11', () => {
  it('shows a queued message that failed, with Retry, as the conversation does', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    let answer: (h: ChatHistory) => void = () => {};
    mocks.history.mockReturnValue(new Promise<ChatHistory>(r => { answer = r; }));
    mocks.send.mockRejectedValueOnce({ response: { data: { error: 'The box is offline' } } });
    await open();
    await type('mark 755 ready');
    await enter();
    await act(async () => { answer(history()); });
    await settle(); await settle();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const strip = () => host.querySelector('.fv-chat-line')!;
    expect(strip().textContent).toContain('not sent: The box is offline');
    const retry = strip().querySelector<HTMLButtonElement>('.chat-queued-retry')!;
    expect(retry.textContent).toBe('Retry');
    await act(async () => { retry.click(); });
    await settle(); await settle();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(strip().textContent).not.toContain('not sent');
  });

  it('draws Do it links as plain text while no composer listens (no session in the space)', async () => {
    mocks.tabs = [{ kind: 'file', space: SPACE, path: 'pr-outbox.md', id: 'f1', openedAt: 1 }];
    mocks.fileText = '| PR | Do it |\n|----|----|\n| #761 | [mark ready](termag-compose:mark%20%23761%20ready) |';
    await open();
    expect(host.querySelector('.fv-md button.md-compose')).toBeNull();
    expect(host.querySelector('.fv-md tr td:last-child')?.textContent).toBe('mark ready');
  });
});

describe('who gets the composer: members who may send, not someone viewing a shared file', () => {
  const DO_IT = '| PR | Do it |\n|----|----|\n| #761 | [mark ready](termag-compose:mark%20%23761%20ready) |';
  const links = () => host.querySelectorAll('.fv-md button.md-compose');

  it('gives someone who is not a member of the space (a file shared with termag, #718) no composer, and Do it links as plain text', async () => {
    // Their spaces don't include this one; the shared file still opens in the file view.
    mocks.spaces = [{ name: 'other', role: 'owner' }];
    mocks.fileText = DO_IT;
    await open();
    expect(host.querySelector('.fv-md')?.textContent).toContain('mark ready');
    expect(host.querySelector('.fv-chat, .fv-chat-host')).toBeNull();
    expect(links()).toHaveLength(0);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('gives a viewer of the space no composer either: viewers read, they don\'t act', async () => {
    mocks.spaces = [{ name: SPACE, role: 'viewer' }];
    mocks.fileText = DO_IT;
    await open();
    expect(host.querySelector('.fv-chat, .fv-chat-host')).toBeNull();
    expect(links()).toHaveLength(0);
  });

  it('gives an editor the composer and live Do it links, as an owner has', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    mocks.spaces = [{ name: SPACE, role: 'editor' }];
    mocks.fileText = DO_IT;
    await open();
    expect(host.querySelector('.fv-chat textarea')).not.toBeNull();
    expect(links()).toHaveLength(1);
  });

  it('keeps a link in one space\'s file from filling another space\'s composer', async () => {
    // A composer listens for improve-termag; a fill for another space reaches nothing.
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    await open();
    act(() => requestComposeFill('other', 'merge #1'));
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(input().value).toBe('');
    act(() => requestComposeFill(SPACE, 'merge #748'));
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(input().value).toBe('merge #748');
  });
});

describe('Bugbot, sweep 15: the strip follows the latest message', () => {
  const failQueued = async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    let answer: (h: ChatHistory) => void = () => {};
    mocks.history.mockReturnValue(new Promise<ChatHistory>(r => { answer = r; }));
    mocks.send.mockRejectedValueOnce({ response: { data: { error: 'The box is offline' } } });
    await open();
    await type('mark 755 ready');
    await enter();
    await act(async () => { answer(history()); });
    await settle(); await settle();
    expect(lineText()).toContain('not sent: The box is offline');
  };
  const A = 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)';
  const B = 'merge #748\n\n(viewing improve-termag:pr-outbox.md)';

  it('clears the failure once a later message is sent, and shows that one', async () => {
    await failQueued();
    mocks.send.mockResolvedValue({ queued: false });
    await type('merge #748');
    await enter();
    const strip = () => host.querySelector('.fv-chat-line')!;
    expect(mocks.send.mock.calls.map(c => c[2])).toEqual([A, B]);
    expect(strip().textContent).not.toContain('not sent');
    expect(strip().querySelector('.chat-queued-retry')).toBeNull();
    frame('termag-5', { type: 'turn-start', text: B });
    frame('termag-5', { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Merged.' }] } });
    frame('termag-5', { type: 'turn-end' });
    expect(lineText()).toBe('termag-5 replied: Merged.');
    // The failed one was not sent again behind the person's back.
    expect(mocks.send.mock.calls.map(c => c[2])).toEqual([A, B]);
  });

  it('Retry re-sends only the message that failed, once, however often it is pressed', async () => {
    await failQueued();
    mocks.send.mockResolvedValue({ queued: false });
    const retry = host.querySelector<HTMLButtonElement>('.chat-queued-retry')!;
    await act(async () => { retry.click(); retry.click(); });
    await settle(); await settle();
    await act(async () => { host.querySelector<HTMLButtonElement>('.chat-queued-retry')?.click(); });
    await settle();
    expect(mocks.send.mock.calls.map(c => c[2])).toEqual([A, A]);
    expect(lineText()).not.toContain('not sent');
  });
});

describe('Bugbot, sweep 17', () => {
  const pending = () => {
    let answer: (h: ChatHistory) => void = () => {};
    mocks.history.mockReturnValue(new Promise<ChatHistory>(r => { answer = r; }));
    return (h: ChatHistory) => answer(h);
  };
  beforeEach(() => { sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' })); });

  it('Dismiss after a later send took over the strip does not bring back the older failed queued message', async () => {
    const answer = pending();
    mocks.send.mockRejectedValueOnce({ response: { data: { error: 'The box is offline' } } });
    await open();
    await type('mark 755 ready');
    await enter();
    await act(async () => { answer(history()); });
    await settle(); await settle();
    expect(lineText()).toContain('not sent');
    mocks.send.mockResolvedValue({ queued: false });
    await type('merge #748');
    await enter();
    expect(lineText()).not.toContain('not sent');
    await act(async () => { host.querySelector<HTMLButtonElement>('.fv-chat-line-dismiss')!.click(); });
    expect(line().dataset.strip).toBe('hidden');
  });

  it('a second send while Claude is not ready keeps the queued wording, with both counted, and Retry if the queue fails', async () => {
    const answer = pending();
    await open();
    await type('mark 755 ready');
    await enter();
    await type('merge #748');
    await enter();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(lineText()).toBe('termag-5 · 2 messages · sent as soon as Claude is ready');
    mocks.send.mockRejectedValueOnce({ response: { data: { error: 'The box is offline' } } });
    await act(async () => { answer(history()); });
    await settle(); await settle();
    expect(lineText()).toBe('termag-5 · 2 messages · not sent: The box is offline');
    expect(host.querySelector('.fv-chat-line .chat-queued-retry')).not.toBeNull();
  });
});

describe('Bugbot: a direct send that fails after the target changed', () => {
  const pick = async (name: string) => {
    await act(async () => { toChip()!.click(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(i => i.textContent?.includes(name))!.click(); });
    await settle();
  };
  const sendThenFailAway = async (beforeFail?: () => Promise<void>) => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    let fail: (e: unknown) => void = () => {};
    mocks.send.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    await open();
    await type('mark 755 ready');
    await enter();
    expect(input().value).toBe('');
    await pick('docs');
    await type('a draft for docs');
    if (beforeFail) await beforeFail();
    await act(async () => { fail({ response: { data: { error: 'The box is offline' } } }); });
    await settle();
  };

  it('tells the person where they are now, and keeps their new draft', async () => {
    await sendThenFailAway();
    expect(input().value).toBe('a draft for docs');
    // On the one line: short, with the error and the way back in its label.
    const away = host.querySelector('.fv-chat-line .fv-chat-away');
    expect(away?.textContent).toBe('Not sent · Go');
    expect(away?.getAttribute('aria-label')).toContain('Not sent to termag-5: The box is offline');
    expect(away?.getAttribute('aria-label')).toContain('back in its box');
  });

  it('brings the text back into the failed session\'s box, with the error on its strip and no Retry', async () => {
    await sendThenFailAway();
    await act(async () => { host.querySelector<HTMLButtonElement>('.fv-chat-line .fv-chat-away')!.click(); });
    await settle();
    expect(toChip()?.getAttribute('aria-label')).toBe('To: termag-5');
    expect(input().value).toBe('mark 755 ready');
    expect(lineText()).toBe('termag-5 · not sent: The box is offline · back in the box');
    expect(host.querySelector('.fv-chat-line .chat-queued-retry')).toBeNull();
    expect(host.querySelector('.fv-chat-away')).toBeNull();
  });

  it('reaches the failed session\'s box even when the person went back to it before the failure came', async () => {
    await sendThenFailAway(async () => { await pick('termag-5'); });
    expect(toChip()?.getAttribute('aria-label')).toBe('To: termag-5');
    expect(input().value).toBe('mark 755 ready');
    expect(lineText()).toBe('termag-5 · not sent: The box is offline · back in the box');
  });
});

describe('#738\'s context popover in the file view', () => {
  it('offers Clear and Compact as the conversation does, acting on the target session', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    mocks.history.mockResolvedValue(history({ contextActions: 'ready' } as Partial<ChatHistory>));
    await open();
    await act(async () => { host.querySelector<HTMLButtonElement>('.fv-chat .chat-ring-btn')!.click(); });
    const clear = document.querySelector<HTMLButtonElement>('.chat-ring-clear');
    const compact = document.querySelector<HTMLButtonElement>('.chat-ring-compact');
    expect(clear).not.toBeNull();
    expect(compact).not.toBeNull();
    await act(async () => { clear!.click(); });
    await settle();
    expect(mocks.context).toHaveBeenCalledWith('termag-5', 'main', 'clear');
    // A clear is not a message from here: the strip stays as it was (hidden).
    expect(line().dataset.strip).toBe('hidden');
  });
});

describe('Bugbot: two sends to one target that fail while its composer is gone', () => {
  const pick = async (name: string) => {
    await act(async () => { toChip()!.click(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(i => i.textContent?.includes(name))!.click(); });
    await settle();
  };

  it('bring each text back once, in the order sent, and keep a draft typed there meanwhile', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    const fails: Array<(e: unknown) => void> = [];
    mocks.send.mockImplementation(() => new Promise((_, reject) => { fails.push(reject); }));
    await open();
    await type('mark 755 ready');
    await enter();
    await pick('docs');
    await pick('termag-5');
    await type('merge #748');
    await enter();
    await pick('docs');
    expect(fails).toHaveLength(2);
    await act(async () => { for (const f of fails) f({ response: { data: { error: 'The box is offline' } } }); });
    await settle();
    await pick('termag-5');
    expect(input().value).toBe('mark 755 ready\nmerge #748');
    expect(lineText()).toBe('termag-5 · not sent: The box is offline · back in the box');
  });

  it('adds to a draft the person typed in that session after the sends went', async () => {
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    let fail: (e: unknown) => void = () => {};
    mocks.send.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    await open();
    await type('mark 755 ready');
    await enter();
    await pick('docs');
    await pick('termag-5');
    await type('a new thought');
    await pick('docs');
    await act(async () => { fail({ response: { data: { error: 'The box is offline' } } }); });
    await settle();
    await pick('termag-5');
    expect(input().value).toBe('a new thought\nmark 755 ready');
  });
});

describe('above the box: one line, never more', () => {
  beforeEach(() => { sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' })); });
  // What sits between the top of the composer's area and its box.
  const aboveBox = () => {
    const bottom = host.querySelector('.fv-chat')!;
    const kids = [...bottom.children];
    return kids.slice(0, kids.findIndex(k => k.matches('form.chat-composer')));
  };

  it('stays one row while a long reply streams in, quoting only its first line', async () => {
    await open();
    expect(aboveBox().map(k => k.className)).toEqual(['fv-chat-line']);
    expect(lineText()).toBe('termag-5 · Say what you want to do');
    await type('mark 755 ready');
    await enter();
    const message = 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)';
    frame('termag-5', { type: 'turn-start', text: message });
    for (let i = 0; i < 6; i++) {
      frame('termag-5', { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: `## Step ${i}\n\n${'A long paragraph of the reply. '.repeat(20)}\n\n- one\n- two` }] } });
      expect(aboveBox().map(k => k.className)).toEqual(['fv-chat-line']);
      expect(lineText()).toBe('termag-5 · working…');
    }
    frame('termag-5', { type: 'turn-end' });
    expect(aboveBox().map(k => k.className)).toEqual(['fv-chat-line']);
    expect(lineText()).toBe('termag-5 replied: Step 5');
    // No reply body or Markdown above the box.
    expect(host.querySelector('.fv-chat .sdk-text, .fv-chat .md-block')).toBeNull();
  });

  it('collapses messages Stop took back to "N not sent · Show", which opens them in a popover', async () => {
    mocks.history.mockResolvedValue(history({ running: true }));
    mocks.interrupt.mockResolvedValueOnce({ interrupted: true, dropped: ['first queued', 'second queued'] } as never);
    await open();
    act(() => input().focus());
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await settle();
    expect(aboveBox().map(k => k.className)).toEqual(['fv-chat-line']);
    const show = host.querySelector<HTMLButtonElement>('.fv-chat-line .fv-chat-unsent')!;
    expect(show.textContent).toBe('2 not sent · Show');
    expect(document.querySelector('.sdk-unsent')).toBeNull();
    await act(async () => { show.click(); });
    const pop = document.querySelector('.fv-chat-unsent-pop');
    expect(pop?.textContent).toContain('first queued');
    expect(pop?.textContent).toContain('second queued');
  });

  it('never prints the agent\'s name in the composer: a generic placeholder, the name only in the button\'s label and tooltip', async () => {
    const long = 'A very long haiku agent name that would never fit in a composer';
    mocks.rows = mocks.rows.map(r => ((r as { projectId: string }).projectId === 'termag-5' ? { ...(r as object), sessionTitle: long } : r));
    sessionStorage.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: 'termag-5', workstream: 'main' }));
    await open();
    expect(input().placeholder).toBe('Message an agent about this file…');
    const form = host.querySelector('.fv-chat form.chat-composer')!;
    expect(form.textContent).not.toContain(long);
    expect([...form.querySelectorAll('[placeholder]')].map(e => e.getAttribute('placeholder')).join(' ')).not.toContain(long);
    expect(toChip()?.getAttribute('aria-label')).toBe(`To: ${long} · termag-5`);
    expect(toChip()?.textContent).toBe('');
    // The one line names it, cut first by CSS (fileChatCss.test), with the full name on hover; its status is its own span.
    const name = host.querySelector<HTMLElement>('.fv-chat-line-name')!;
    expect(name.textContent).toBe(long);
    expect(name.title).toBe(`${long} · termag-5`);
    expect(host.querySelector('.fv-chat-line-status')?.textContent).toBe(' · Say what you want to do');
    expect(host.querySelector('.fv-chat-open')?.textContent).toBe('Open');
  });
});

