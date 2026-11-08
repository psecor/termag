// @vitest-environment jsdom
// Images in a stored chat whose box is down (#971, the person's call: held on
// the server): the composer takes them (the + button, the picker, a drop), the
// send goes to the orchestrator, which holds it with its images and starts the
// box; every tab and every reload shows it waiting, and it goes in once the
// box is up. One the box refuses comes back to its sender's composer.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus, Project } from '../../types';
import { readQueued } from '../../chat/newChat';
import { readStoredOpen } from '../../chat/storedOpen';

const mocks = vi.hoisted(() => ({
  /** A text file's contents, as the mocked prepareTextFile reads them (no FileReader under fake timers). */
  texts: new WeakMap<File, string>(),
  flags: {} as Record<string, unknown>,
  putFile: vi.fn(),
  history: vi.fn(),
  take: vi.fn(),
  send: vi.fn(),
  start: vi.fn(),
  reload: vi.fn(async () => {}),
  boxes: [] as unknown[],
  listeners: new Set<() => void>(),
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: mocks.send, takeHeld: mocks.take, putFile: mocks.putFile, reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
  instancesApi: { start: mocks.start },
  activityApi: { heartbeat: () => Promise.resolve() },
  visitsApi: { record: () => Promise.resolve() },
}));
vi.mock('../../chat/chatTextFiles', async importOriginal => {
  const actual = await importOriginal<typeof import('../../chat/chatTextFiles')>();
  let n = 0;
  return {
    ...actual,
    // A file with no text given is not text, as a zip is.
    prepareTextFile: async (file: File) => {
      if (!mocks.texts.has(file)) throw new actual.TextFileRefusal(`${file.name} can't be attached: only text files, images and PDFs can`, 'not-text');
      if (mocks.texts.get(file)!.length > actual.MAX_TEXT_FILE_CHARS) throw new actual.TextFileRefusal(`${file.name} is too big: text files go in the message up to 90 KB`, 'too-large');
      return { id: `t${++n}`, name: file.name, text: mocks.texts.get(file)! };
    },
  };
});
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key in mocks.flags ? mocks.flags[key] as T : fallback) };
});
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ settleProjectClone: vi.fn(), reloadProjects: vi.fn(async () => {}) }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: {
    subscribe: (l: () => void) => { mocks.listeners.add(l); return () => { mocks.listeners.delete(l); }; },
    getSnapshot: () => mocks.boxes,
    hasLoaded: () => true,
    isGone: () => false,
    lookFor: () => {},
    reload: mocks.reload,
  },
}));
vi.mock('../../chat/chatEvents', () => ({
  chatEvents: { subscribe: () => () => {}, subscribeReconnect: () => () => {} },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));
// jsdom draws no images: a picked or dropped file comes back prepared as it would in a browser.
vi.mock('../../chat/chatImageData', async importOriginal => ({
  ...(await importOriginal<typeof import('../../chat/chatImageData')>()),
  prepareImage: async (f: File) => ({ id: `img-${f.name}`, mediaType: f.type, data: 'aGVsbG8=', src: 'data:image/png;base64,aGVsbG8=', name: f.name }),
  // The composer prepares attachments (images, and PDFs since #1110) through this one.
  prepareAttachment: async (f: File) => ({ id: `img-${f.name}`, mediaType: f.type, data: 'aGVsbG8=', src: 'data:image/png;base64,aGVsbG8=', name: f.name }),
}));

import { SdkChatView } from './SdkChatView';

const project = {
  id: 'p1', name: 'web', instanceId: 'b1', repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

const entries = [
  { type: 'user', message: { role: 'user', content: 'what is in the readme?' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It explains how to run the stack.' }] } },
];
// What routes/chat.ts storedHistoryFor answers when the box can't.
const storedHistory = {
  chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, liveInput: false, parked: false, turn: null,
  checkoutReady: true, sendsLive: false, imageInput: true, stopsTurn: false,
  entries, turns: [], model: 'sonnet', trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
  stored: true,
};
const liveHistory = { ...storedHistory, stored: undefined };

const box = (status: InstanceStatus) => ({ id: 'b1', name: 'cp-tools-10261', kind: 'ec2', ec2InstanceId: 'i-b1', status }) as Instance;
const setBox = (status: InstanceStatus) => act(() => { mocks.boxes = [box(status)]; mocks.listeners.forEach(l => l()); });

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

async function render(workstream = 'main', state?: unknown) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[{ pathname: '/', state }]}><SdkChatView project={project} workstream={workstream} /></MemoryRouter>);
  });
  await flush();
}

const statusLine = () => container.querySelector('.chat-status')?.textContent ?? '';
// Sending is the only way this view wakes the box (#900 review): there is no Start box.
const startButton = () => [...container.querySelectorAll('button')].find(b => /start box/i.test(b.textContent ?? '')) ?? null;
const transcript = () => container.textContent ?? '';

async function type(text: string) {
  const input = container.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector('form.chat-composer') as HTMLFormElement;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
}

async function send(text = 'and the tests?') {
  await type(text);
  await submit();
}

const png = () => new File(['x'], 'shot.png', { type: 'image/png' });
const textFile = (name: string, text: string) => { const f = new File([text], name, { type: 'text/csv' }); mocks.texts.set(f, text); return f; };
const composerChips = () => [...container.querySelectorAll('.chat-composer .chat-attachment[data-text-file] .chat-attachment-name')].map(n => n.textContent);
const attachButton = () => container.querySelector('button.chat-attach') as HTMLButtonElement | null;

async function pick(file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}

async function drop(file: File) {
  const target = container.querySelector('.chat-conv') as HTMLElement;
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [file], dropEffect: 'none' } });
  await act(async () => { target.dispatchEvent(ev); });
  await flush();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.send.mockReset().mockResolvedValue({ queued: false, turnId: 't1' });
  mocks.start.mockReset().mockResolvedValue({ ok: true, status: 'starting' });
  // The route marks the box starting before it answers 202, so the reload after it says so.
  mocks.reload.mockReset().mockImplementation(async () => { mocks.boxes = [box('starting')]; mocks.listeners.forEach(l => l()); });
  mocks.boxes = [box('stopped')];
});

afterEach(() => {
  if (container?.isConnected) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

// The orchestrator's side, as routes/chat.ts answers: a send while the box is down is held (images and
// all) and shows in the history's continuation; once the box is up the history is live and the message in it.
type Held = { id: string; text: string; error: string | null; mine: boolean; images?: Array<{ mediaType: string }> };
const server = { held: [] as Held[], up: false, sent: [] as Array<{ text: string; images: unknown[] }>, files: {} as { fileInput?: boolean; fileRefusal?: string } };
function serve() {
  mocks.history.mockImplementation(async (_p: string, ws: string) => (server.up
    ? { ...liveHistory, workstream: ws, entries: [...entries, ...server.sent.map(m => ({ type: 'user', message: { role: 'user', content: m.text } }))] }
    : { ...storedHistory, ...server.files, workstream: ws, continuation: { takesSends: true, ...(server.held.length ? { phase: 'starting', held: server.held } : {}) } }));
  mocks.send.mockImplementation(async (_p: string, _ws: string, text: string, images: Array<{ mediaType: string; data: string }>) => {
    if (server.up) { server.sent.push({ text, images }); return { queued: false, turnId: 't1' }; }
    server.held.push({ id: `m${server.held.length + 1}`, text, error: null, mine: true, ...(images.length ? { images: images.map(i => ({ mediaType: i.mediaType })) } : {}) });
    return { queued: true, held: true, position: server.held.length, phase: 'starting' };
  });
}

async function reload(workstream = 'main') {
  act(() => root.unmount());
  container.remove();
  await render(workstream);
}

async function boxComesUp() {
  // The orchestrator delivers the held message once the box is up (chatHeld.ts).
  for (const m of server.held.splice(0)) server.sent.push({ text: m.text, images: m.images ?? [] });
  server.up = true;
  setBox('ready');
  await act(async () => { vi.advanceTimersByTime(3500); });
  await flush();
}

const heldBubble = () => container.querySelector('[data-pending][data-held-id]');

describe('images in a stored chat whose box is down', () => {
  beforeEach(() => { server.held = []; server.up = false; server.sent = []; server.files = {}; mocks.flags = {}; serve(); mocks.take.mockReset(); mocks.putFile.mockReset(); });

  it('the + button takes an image; the send goes to the orchestrator with it, which holds it and starts the box', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render();
    expect(attachButton()?.disabled).toBe(false);
    await pick(png());
    expect(container.querySelector('.chat-composer img')).not.toBeNull();
    await send('what is in this screenshot?');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [pid, ws, text, images] = mocks.send.mock.calls[0];
    expect([pid, ws, text]).toEqual(['p1', 'main', 'what is in this screenshot?']);
    expect(images).toEqual([{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
    // The orchestrator starts the box (routes/chat.ts holdIfContinuing), not this tab.
    expect(mocks.start).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-composer img')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(3500); });
    await flush();
    expect(statusLine()).toBe('Starting the box…');
    expect(heldBubble()?.textContent).toContain('what is in this screenshot?');
    expect(heldBubble()?.querySelector('img')?.getAttribute('src')).toBe('/termag/api/projects/p1/chat/held/m1/images/0?workstream=main');
  });

  it('a reload (or another tab) shows the held message with its image, and it goes in once the box is up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render();
    await pick(png());
    await send('look');
    await reload();
    expect(heldBubble()?.textContent).toContain('look');
    expect(heldBubble()?.querySelector('img')).not.toBeNull();
    expect(transcript()).toContain('sent once the chat is back');
    await boxComesUp();
    expect(heldBubble()).toBeNull();
    expect(transcript()).toContain('look');
    expect(server.sent).toEqual([{ text: 'look', images: [{ mediaType: 'image/png' }] }]);
  });

  it('a dropped image is taken too', async () => {
    await render();
    await drop(png());
    expect(container.querySelector('.chat-composer img')).not.toBeNull();
  });

  it('text on any workstream (an ask thread\'s) is held the same way, not handed back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render('ask-t1');
    await send('and the tests?');
    expect(mocks.send.mock.calls[0].slice(0, 3)).toEqual(['p1', 'ask-t1', 'and the tests?']);
    expect(transcript()).not.toContain('Send this again');
    await reload('ask-t1');
    expect(heldBubble()?.textContent).toContain('and the tests?');
  });

  it('one the box refused comes back to its sender\'s composer, text and image, and says why', async () => {
    server.held = [{ id: 'm1', text: 'look', error: 'This box\'s chat runner cannot take images yet', mine: true, images: [{ mediaType: 'image/png' }] }];
    mocks.take.mockImplementation(async () => {
      server.held = [];
      return { text: 'look', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }], error: 'This box\'s chat runner cannot take images yet' };
    });
    await render();
    await flush();
    expect(mocks.take).toHaveBeenCalledWith('p1', 'main', 'm1');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('look');
    expect(container.querySelector('.chat-composer img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(transcript()).toContain('cannot take images yet');
    expect(heldBubble()).toBeNull();
  });

  // Bugbot on #971: a take-back whose request failed (not "another tab took it") was never tried again.
  it('a take-back that fails on the network is tried again, and then comes back to the composer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server.held = [{ id: 'm1', text: 'look', error: 'refused', mine: true }];
    mocks.take.mockRejectedValueOnce(new Error('Network Error'));
    mocks.take.mockImplementation(async () => { server.held = []; return { text: 'look', images: [], error: 'refused' }; });
    await render();
    expect(mocks.take).toHaveBeenCalledTimes(1);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    await act(async () => { vi.advanceTimersByTime(3500); });
    await flush();
    expect(mocks.take).toHaveBeenCalledTimes(2);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('look');
  });

  it('a take-back another tab won (404) is not tried again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server.held = [{ id: 'm1', text: 'look', error: 'refused', mine: true }];
    mocks.take.mockImplementation(async () => { server.held = []; throw { response: { status: 404, data: { code: 'not-held' } } }; });
    await render();
    await act(async () => { vi.advanceTimersByTime(7000); });
    await flush();
    expect(mocks.take).toHaveBeenCalledTimes(1);
  });

  // Bugbot on #996 (the same code is on main): a follow-up send once the box is starting, or one sent before
  // the list knew the box, went to an offline box. The orchestrator now takes every send of a stored chat whose
  // box is down or coming up (takesSends), so the composer posts it and the orchestrator holds it.
  it('a follow-up send while the box is starting goes to the orchestrator too, and is held behind the first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render();
    await send('first');
    setBox('starting');
    await flush();
    await send('second');
    expect(mocks.send.mock.calls.map(c => c[2])).toEqual(['first', 'second']);
    expect(server.held.map(m => m.text)).toEqual(['first', 'second']);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  // Bugbot on #971 ("Take-back drops refused messages"): several refused messages taken back at once, all kept.
  it('several refused messages taken back at once all come back to the composer, texts and images', async () => {
    server.held = [
      { id: 'm1', text: 'first', error: 'refused', mine: true, images: [{ mediaType: 'image/png' }] },
      { id: 'm2', text: 'second', error: 'refused', mine: true },
      { id: 'm3', text: 'third', error: 'refused', mine: true, images: [{ mediaType: 'image/png' }] },
    ];
    const back: Record<string, { text: string; images: Array<{ mediaType: string; data: string }>; error: string }> = {
      m1: { text: 'first', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }], error: 'refused' },
      m2: { text: 'second', images: [], error: 'refused' },
      m3: { text: 'third', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }], error: 'refused' },
    };
    // All three answer in the same tick, as parallel requests can.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mocks.take.mockImplementation(async (_p: string, _w: string, id: string) => { await gate; server.held = server.held.filter(m => m.id !== id); return back[id]; });
    await render();
    expect(mocks.take).toHaveBeenCalledTimes(3);
    await act(async () => { release(); });
    await flush();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('first\n\nsecond\n\nthird');
    expect(container.querySelectorAll('.chat-composer img')).toHaveLength(2);
  });

  it('refused messages whose images would overflow the composer wait, shown, until there is room', async () => {
    const two = [{ mediaType: 'image/png' }, { mediaType: 'image/png' }];
    server.held = ['m1', 'm2', 'm3'].map(id => ({ id, text: id, error: 'refused', mine: true, images: two }));
    mocks.take.mockImplementation(async (_p: string, _w: string, id: string) => {
      server.held = server.held.filter(m => m.id !== id);
      return { text: id, images: two.map(i => ({ ...i, data: 'aGVsbG8=' })), error: 'refused' };
    });
    await render();
    await flush();
    // Four images fit: m1 and m2 come back; m3 stays on the orchestrator, shown with why.
    expect(mocks.take.mock.calls.map(c => c[2])).toEqual(['m1', 'm2']);
    expect(container.querySelectorAll('.chat-composer img')).toHaveLength(4);
    expect(container.querySelector('[data-held-id="m3"]')?.textContent).toContain('not sent: refused');
    // Room again: m3 comes back too, nothing lost.
    for (const b of [...container.querySelectorAll<HTMLButtonElement>('.chat-attachment-remove')]) await act(async () => { b.click(); });
    await flush();
    expect(mocks.take.mock.calls.map(c => c[2])).toEqual(['m1', 'm2', 'm3']);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('m1\n\nm2\n\nm3');
    expect(container.querySelectorAll('.chat-composer img')).toHaveLength(2);
  });

  // Bugbot on #971 ("Take-backs overflow the image cap"): images attached while a take-back is on its way count
  // the room it reserved, so the composer never goes past MAX_CHAT_IMAGES and the next send is not refused.
  it('images attached while a take-back is on its way leave room for its images', async () => {
    server.held = [{ id: 'm1', text: 'look', error: 'refused', mine: true, images: [{ mediaType: 'image/png' }, { mediaType: 'image/png' }] }];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mocks.take.mockImplementation(async () => {
      await gate;
      server.held = [];
      return { text: 'look', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }, { mediaType: 'image/png', data: 'aGVsbG8=' }], error: 'refused' };
    });
    await render();
    expect(mocks.take).toHaveBeenCalledTimes(1);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = ['a', 'b', 'c'].map(n => new File(['x'], `${n}.png`, { type: 'image/png' }));
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    // Two of the three fit beside the two on their way back.
    expect(container.querySelectorAll('.chat-composer img')).toHaveLength(2);
    expect(transcript()).toContain('At most 4 images per message');
    await act(async () => { release(); });
    await flush();
    expect(container.querySelectorAll('.chat-composer img')).toHaveLength(4);
  });

  // Bugbot on #971 ("Take-back lost on chat switch"): a take-back that answers after the view left the chat (a
  // switch remounts it) still lands in that chat's composer when it is shown again.
  it('a take-back that answers after a chat switch lands in the composer when the chat is back', async () => {
    server.held = [{ id: 'm1', text: 'look', error: 'refused', mine: true, images: [{ mediaType: 'image/png' }] }];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let calls = 0;
    mocks.take.mockImplementation(async () => {
      calls += 1;
      if (calls > 1) throw { response: { status: 404, data: { code: 'not-held' } } };
      await gate;
      server.held = [];
      return { text: 'look', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }], error: 'refused' };
    });
    await render();
    expect(mocks.take).toHaveBeenCalledTimes(1);
    // Off to another chat, the take still out.
    act(() => root.unmount());
    container.remove();
    await act(async () => { release(); });
    await flush();
    // Back on this chat: what was taken back is in its composer, not lost.
    await render();
    await flush();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('look');
    expect(container.querySelectorAll('.chat-composer img')).toHaveLength(1);
    expect(transcript()).toContain('Not sent: refused');
  });

  // A text file goes in the message's own text (chat/chatTextFiles.ts), so it is held, sent and stored as text,
  // and every bubble reads it back as a chip.
  it('a text file goes in the message as text, and shows as a chip while held and from the history once it is in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render();
    await pick(textFile('data.csv', 'a,b\n1,2\n'));
    expect(composerChips()).toEqual(['data.csv']);
    await send('sum column b');
    const [, , text, images] = mocks.send.mock.calls[0];
    expect(text).toBe('sum column b\n\nAttached file: data.csv\n```csv\na,b\n1,2\n\n```');
    expect(images).toEqual([]);
    expect(composerChips()).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(3500); });
    await flush();
    expect(heldBubble()?.querySelector('.sdk-file[data-text-file] .sdk-file-name')?.textContent).toBe('data.csv');
    expect(heldBubble()?.querySelector('.sdk-user-bubble')?.textContent).toBe('sum column b');
    await boxComesUp();
    const mine = [...container.querySelectorAll('.sdk-user')].at(-1)!;
    expect(mine.querySelector('.sdk-file[data-text-file] .sdk-file-kind')?.textContent).toBe('CSV');
    expect(mine.querySelector('.sdk-user-bubble')?.textContent).toBe('sum column b');
    expect(transcript()).not.toContain('Attached file:');
  });

  it('a held message refused with a text file comes back to the composer with the file as a file', async () => {
    const message = 'look\n\nAttached file: notes.md\n```md\n# Hi\n```';
    server.held = [{ id: 'm1', text: message, error: 'refused', mine: true }];
    mocks.take.mockImplementation(async () => { server.held = []; return { text: message, images: [], error: 'refused' }; });
    await render();
    await flush();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('look');
    expect(composerChips()).toEqual(['notes.md']);
  });

  // Devin on #1476: New session's first message, handed over as a draft when this browser would not queue it.
  it('a draft handed over with text files puts them back in the composer as files', async () => {
    await render('main', { draft: 'look\n\nAttached file: notes.md\n```md\n# Hi\n```' });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('look');
    expect(composerChips()).toEqual(['notes.md']);
  });

  // Bugbot on #1476: two attaches read at once could each fit beside what was held, and together go over.
  it('text files over the cap together are checked when they go in, not only when they are read', async () => {
    await render();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [textFile('a.txt', 'a'.repeat(60_000)), textFile('b.txt', 'b'.repeat(60_000))], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(composerChips()).toEqual(['a.txt']);
    expect(container.querySelector('.chat-composer-note[data-error]')?.textContent).toContain("b.txt doesn't fit");
  });

  // Any other file goes to the box as it is attached; one for a box that is down wakes it, its chip
  // saying so, and the message names where the box kept it.
  it('a zip for a chat whose box is down wakes the box, says so on its chip, and the message names its path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.flags = { 'chat-file-attachments-enabled': true };
    server.files = { fileInput: true };
    mocks.putFile
      .mockRejectedValueOnce({ response: { status: 503, data: { error: "The box's agent is offline", code: 'offline' } } })
      .mockResolvedValueOnce({ path: '.termag-attachments/0123456789abcdef/build.zip', name: 'build.zip', size: 6 });
    await render();
    await pick(new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])], 'build.zip'));
    const chip = () => container.querySelector('.chat-composer .chat-attachment[data-box-file]');
    expect(chip()?.getAttribute('data-box-file')).toBe('waking');
    expect(chip()?.textContent).toContain('waking the box…');
    // It asked for the box to start (the composer's own wake, as a send's).
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flush();
    expect(mocks.putFile).toHaveBeenCalledTimes(2);
    expect(chip()?.getAttribute('data-box-file')).toBe('kept');
    await send('unzip it');
    expect(mocks.send.mock.calls[0][2]).toBe('unzip it\n\nAttached file on the box: .termag-attachments/0123456789abcdef/build.zip (6 bytes)');
    await act(async () => { vi.advanceTimersByTime(3500); });
    await flush();
    expect(heldBubble()?.querySelector('.sdk-file[data-box-file] .sdk-file-name')?.textContent).toBe('build.zip');
    expect(heldBubble()?.querySelector('.sdk-user-bubble')?.textContent).toBe('unzip it');
  });

  it('a send waits for a file still on its way to the box', async () => {
    mocks.flags = { 'chat-file-attachments-enabled': true };
    server.files = { fileInput: true };
    mocks.putFile.mockImplementation(() => new Promise(() => {}));
    await render();
    await pick(new File([new Uint8Array([0, 1, 2])], 'blob.bin'));
    await send('look');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(transcript()).toContain('blob.bin is still on its way to the box');
  });

  it('says why a file can\'t go where the box\'s agent predates chat-files-v1, and sends nothing to it', async () => {
    mocks.flags = { 'chat-file-attachments-enabled': true };
    server.files = { fileInput: false, fileRefusal: "This box's agent can't take files yet; it needs an update and a restart" };
    await render();
    await pick(new File([new Uint8Array([0, 1, 2])], 'blob.bin'));
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-composer-note[data-error]')?.textContent).toBe("blob.bin can't be attached: This box's agent can't take files yet; it needs an update and a restart");
    // Bugbot on #1481: text over the inline cap says why the box can't keep it either.
    await pick(textFile('server.log', 'x'.repeat(100_000)));
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-composer-note[data-error]')?.textContent).toBe("server.log is too big: text files go in the message up to 90 KB; the box can't keep it instead: This box's agent can't take files yet; it needs an update and a restart");
  });

  it('with the flag off, any other file is refused as before', async () => {
    server.files = { fileInput: true };
    await render();
    await pick(new File([new Uint8Array([0, 1, 2])], 'blob.bin'));
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-composer-note[data-error]')?.textContent).toBe("blob.bin can't be attached: only text files, images and PDFs can");
  });

  it('someone else\'s refused message stays shown with why; only its sender takes it back', async () => {
    server.held = [{ id: 'm1', text: 'look', error: 'refused', mine: false }];
    await render();
    expect(mocks.take).not.toHaveBeenCalled();
    expect(transcript()).toContain('not sent: refused');
  });
});
