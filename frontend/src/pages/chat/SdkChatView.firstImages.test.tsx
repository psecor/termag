// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  send: vi.fn(),
  interrupt: vi.fn(),
  noBoxes: [] as unknown[],
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: mocks.send, reclaim: vi.fn(), interrupt: mocks.interrupt, openInTerminal: vi.fn(), trust: vi.fn() },
  activityApi: { heartbeat: () => Promise.resolve() },
  visitsApi: { record: () => Promise.resolve() },
}));
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ settleProjectClone: vi.fn(), reloadProjects: vi.fn() }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: {
    subscribe: () => () => {},
    getSnapshot: () => mocks.noBoxes,
    hasLoaded: () => true,
    isGone: () => false,
    lookFor: () => {},
  },
}));
vi.mock('../../chat/chatEvents', () => ({
  chatEvents: { subscribe: () => () => {}, subscribeReconnect: () => () => {} },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));

// React Aria's popover reads a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);

import { SdkChatView } from './SdkChatView';
import { ChatChromeProvider } from './chatChrome';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

function historyOn(model: string) {
  return {
    chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, checkoutReady: true,
    entries: [], turns: [], model, trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
  };
}

import { ATTACHMENTS_ONLY, holdFirstImages, firstImages, queuedFirstText } from '../../chat/firstImages';
import { readQueued, writeQueued } from '../../chat/newChat';
import type { PreparedImage } from '../../chat/chatImageData';

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter><SdkChatView project={project} workstream="main" /></MemoryRouter>); });
  await flush();
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

const shot: PreparedImage = { id: 'img1', mediaType: 'image/png', data: 'iVBORw0K', src: 'data:image/png;base64,iVBORw0K', name: 'shot.png' };
const queuedNote = () => document.querySelector('.sdk-user[data-pending] .sdk-user-note')?.textContent ?? null;
const retry = () => document.querySelector<HTMLButtonElement>('.chat-queued-retry');

/** New session's first message, as NewChat leaves it: the text queued, the image held. */
function startedWithImage() {
  writeQueued(localStorage, 'p1', 'what is in this screenshot?');
  holdFirstImages(localStorage, 'p1', [shot]);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
});

afterEach(() => { if (container?.isConnected) unmount(); });

describe('SdkChatView: New session\'s first message with images', () => {
  it('sends the images New session held with the queued first message, once Claude is ready', async () => {
    startedWithImage();
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0].slice(0, 4)).toEqual(['p1', 'main', 'what is in this screenshot?', [{ mediaType: 'image/png', data: 'iVBORw0K' }]]);
    expect(readQueued(localStorage, 'p1')).toBeNull();
    expect(firstImages(localStorage, 'p1')).toEqual({ images: [], lost: 0 });
  });

  it('sends a first message of images alone with no text, and shows no stand-in text for it', async () => {
    holdFirstImages(localStorage, 'p1', [shot]);
    writeQueued(localStorage, 'p1', queuedFirstText(localStorage, 'p1', '', 1)!);
    mocks.history.mockReturnValueOnce(new Promise(() => {}));
    await render();
    expect(document.querySelector('.sdk-user[data-pending] img')).not.toBeNull();
    expect(document.querySelector('.sdk-user[data-pending] .sdk-user-bubble')).toBeNull();
    unmount();
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0].slice(0, 4)).toEqual(['p1', 'main', '', [{ mediaType: 'image/png', data: 'iVBORw0K' }]]);
    expect(readQueued(localStorage, 'p1')).toBeNull();
    expect(document.body.textContent).not.toContain(ATTACHMENTS_ONLY);
  });

  it('a first message of images alone whose images this page lost says so, and Retry drops it', async () => {
    writeQueued(localStorage, 'p1', queuedFirstText(localStorage, 'p1', '', 1)!);
    localStorage.setItem('termag-chat-queued-images:p1', '1');
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(queuedNote()).toContain('this page no longer has its attachment');
    expect(queuedNote()).toContain('the message has no text: Retry drops it');
    await act(async () => { retry()!.click(); });
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(readQueued(localStorage, 'p1')).toBeNull();
    // Dropped, not sent: no bubble stays for it, and the stand-in never shows.
    expect(document.querySelector('.sdk-user')).toBeNull();
    expect(document.body.textContent).not.toContain(ATTACHMENTS_ONLY);
  });

  it('sends a typed message that reads like the attachments-only stand-in as it was typed', async () => {
    writeQueued(localStorage, 'p1', ATTACHMENTS_ONLY);
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0].slice(0, 4)).toEqual(['p1', 'main', ATTACHMENTS_ONLY, []]);
  });

  it('keeps the newlines of a message queued behind a first message of images alone', async () => {
    holdFirstImages(localStorage, 'p1', [shot]);
    writeQueued(localStorage, 'p1', `${queuedFirstText(localStorage, 'p1', '', 1)} First line\nSecond line  indented`);
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send.mock.calls[0].slice(0, 4)).toEqual(['p1', 'main', 'First line\nSecond line  indented', [{ mediaType: 'image/png', data: 'iVBORw0K' }]]);
  });

  it('sends them on a Fireworks model too, as the composer does', async () => {
    startedWithImage();
    mocks.history.mockResolvedValue({ ...historyOn('accounts/fireworks/models/kimi-k3'), backend: 'fireworks', imageInput: true });
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][3]).toEqual([{ mediaType: 'image/png', data: 'iVBORw0K' }]);
  });

  it('shows the held image in the queued bubble while the box comes up', async () => {
    startedWithImage();
    mocks.history.mockReturnValue(new Promise(() => {}));
    await render();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(document.querySelector('.sdk-user[data-pending] img')?.getAttribute('src')).toBe(shot.src);
  });

  it('a box that takes no images says so, keeps the text queued, and Retry sends it without them', async () => {
    startedWithImage();
    mocks.send.mockRejectedValueOnce({ response: { status: 409, data: { code: 'images-unsupported', error: "This box's chat runner cannot take images yet; it needs an update and a restart" } } });
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: false });
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(queuedNote()).toBe("not sent: This box's chat runner cannot take images yet; it needs an update and a restart. Retry sends the text without its image.");
    expect(readQueued(localStorage, 'p1')).toBe('what is in this screenshot?');
    expect(document.body.textContent).toContain('what is in this screenshot?');
    await act(async () => { retry()!.click(); });
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1].slice(0, 4)).toEqual(['p1', 'main', 'what is in this screenshot?', []]);
  });

  it('sends a held PDF with its name, and a runner that takes none says so with the text kept', async () => {
    const pdf: PreparedImage = { id: 'pdf1', mediaType: 'application/pdf', data: 'JVBERi0=', src: 'data:application/pdf;base64,JVBERi0=', name: 'spec.pdf' };
    writeQueued(localStorage, 'p1', 'summarise the spec');
    holdFirstImages(localStorage, 'p1', [pdf]);
    mocks.send.mockRejectedValueOnce({ response: { status: 409, data: { code: 'pdfs-unsupported', error: "This box's chat runner cannot take PDFs yet; it needs an update and a restart" } } });
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send.mock.calls[0][3]).toEqual([{ mediaType: 'application/pdf', data: 'JVBERi0=', name: 'spec.pdf' }]);
    expect(queuedNote()).toBe("not sent: This box's chat runner cannot take PDFs yet; it needs an update and a restart. Retry sends the text without its PDF.");
    expect(readQueued(localStorage, 'p1')).toBe('summarise the spec');
  });

  it('a PDF the box cannot read (bad-image) is let go too, so Retry can send the text', async () => {
    const pdf: PreparedImage = { id: 'pdf2', mediaType: 'application/pdf', data: 'JVBERi0=', src: 'data:application/pdf;base64,JVBERi0=', name: 'locked.pdf' };
    writeQueued(localStorage, 'p1', 'summarise this');
    holdFirstImages(localStorage, 'p1', [pdf]);
    mocks.send.mockRejectedValueOnce({ response: { status: 400, data: { code: 'bad-image', error: 'locked.pdf is encrypted' } } });
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(queuedNote()).toBe('not sent: locked.pdf is encrypted. Retry sends the text without its PDF.');
    await act(async () => { retry()!.click(); });
    await flush();
    expect(mocks.send.mock.calls[1].slice(0, 4)).toEqual(['p1', 'main', 'summarise this', []]);
  });

  it('after a reload lost the images, says so before sending the text alone', async () => {
    writeQueued(localStorage, 'p1', 'compare these');
    // The count New session stored, with no images in this page's memory.
    localStorage.setItem('termag-chat-queued-images:p1', '2');
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(queuedNote()).toContain('this page no longer has its 2 attachments');
    await act(async () => { retry()!.click(); });
    await flush();
    expect(mocks.send.mock.calls[0].slice(0, 4)).toEqual(['p1', 'main', 'compare these', []]);
  });

  it('puts the images in the composer with the draft when the text could not be queued', async () => {
    holdFirstImages(localStorage, 'p1', [shot]);
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(mocks.send).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('form.chat-composer .chat-attachment img')].map(i => i.getAttribute('alt'))).toEqual(['shot.png']);
  });
});
