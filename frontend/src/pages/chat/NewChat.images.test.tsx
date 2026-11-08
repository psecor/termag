// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewChat } from './NewChat';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

const boxes: Array<Record<string, unknown>> = [];
// The box feed's snapshot: `boxes` unless a test swaps in a new list, as a reload does.
const feed: { list: Array<Record<string, unknown>> } = { list: boxes };
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  credentials: vi.fn(),
  list: vi.fn(),
  createBox: vi.fn(),
  startBox: vi.fn(async () => ({ ok: true, status: 'starting' })),
  sizes: vi.fn(async (): Promise<unknown> => ({ enabled: false, default: null, sizes: [] })),
  createProject: vi.fn(),
  createAutomation: vi.fn(),
  previewSchedule: vi.fn(),
  flags: {} as Record<string, unknown>,
  search: '',
  reloadProjects: vi.fn(async () => {}),
  upsert: vi.fn(),
  reloadBoxes: vi.fn(async () => {}),
  listSpaces: vi.fn(async () => ({ spaces: [] as Array<{ id: string; name: string; description: null; createdAt: string; usedBytes: number; quotaBytes: number; role: 'owner'; readOnly: boolean }> })),
  addSpaceBox: vi.fn(async () => ({})),
  openTab: vi.fn(),
  projects: [] as Array<Record<string, unknown>>,
  createWorkstream: vi.fn(),
  warmPool: vi.fn(async () => ({ warm: 0, warming: 0, target: 0 })),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams(mocks.search)],
  useLocation: () => ({ pathname: '/chat/new', search: '', hash: '', state: null, key: 'visit' }),
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key in mocks.flags ? mocks.flags[key] as T : fallback) };
});
vi.mock('../../contexts/ProjectContext', () => ({
  useProjects: () => ({ projects: mocks.projects, reloadProjects: mocks.reloadProjects }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: {
    subscribe: () => () => {},
    getSnapshot: () => feed.list,
    upsert: mocks.upsert,
    reload: mocks.reloadBoxes,
  },
}));
vi.mock('../../services/api', () => ({
  credentialsApi: { get: mocks.credentials },
  githubReposApi: { list: mocks.list },
  instancesApi: { create: mocks.createBox, start: mocks.startBox, sizes: mocks.sizes },
  projectsApi: { create: mocks.createProject },
  workstreamsApi: { create: mocks.createWorkstream },
  automationsApi: { create: mocks.createAutomation, preview: mocks.previewSchedule },
  spacesApi: { list: mocks.listSpaces, create: vi.fn(), addBox: mocks.addSpaceBox },
  warmPoolApi: { get: mocks.warmPool },
  environmentsApi: { list: async () => [], resolved: async () => ({ repos: [], size: null, warnings: [] }) },
}));
// jsdom decodes no images: an image's preparation is the composer's own but for the decode (chat/chatImageData.ts).
const prep = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('../../chat/chatImageData', async () => {
  const actual = await vi.importActual<typeof import('../../chat/chatImageData')>('../../chat/chatImageData');
  let n = 0;
  return {
    ...actual,
    prepareAttachment: async (file: File) => {
      if (prep.gate) await prep.gate;
      if (actual.isPdfFile(file)) return actual.prepareAttachment(file);
      if (!actual.isChatImageType(file.type)) throw new Error('not an image');
      if (file.size > actual.MAX_CHAT_IMAGE_BYTES) throw new Error(`${file.name} is too large to send, even made smaller`);
      return { id: `img${++n}`, mediaType: file.type, data: btoa(file.name), src: `data:${file.type};base64,${btoa(file.name)}`, name: file.name };
    },
  };
});
vi.mock('../../observability', () => ({ replaySessionId: async () => null }));
vi.mock('./simpleData', () => ({ useSimpleDataIfAny: () => ({ items: { open: mocks.openTab } }) }));
vi.mock('../../services/claimTiming', () => ({
  noteAddBoxClick: () => {},
  noteBoxClaimed: () => {},
  noteProjectCreated: () => {},
}));

import { admitImages, MAX_CHAT_IMAGES } from '../../chat/chatImageData';
import { ATTACHMENTS_ONLY, firstImages } from '../../chat/firstImages';
import { readQueued } from '../../chat/newChat';
import { splitTextFiles } from '../../chat/chatTextFiles';
import { MAX_KEYS } from '../../chat/compose';

const catalog = {
  status: 'ok',
  groups: [{ owner: 'acme', kind: 'user', status: 'ok', repos: [{ fullName: 'acme/web', defaultBranch: 'main' }] }],
};

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found as HTMLButtonElement;
}

const png = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' });
const attachButton = () => document.querySelector<HTMLButtonElement>('button.chat-compose-attach');
const tiles = () => [...document.querySelectorAll('.chat-attachment img')].map(i => i.getAttribute('alt'));
const textChips = () => [...document.querySelectorAll('.chat-attachment[data-text-file] .chat-attachment-name')].map(n => n.textContent);
const note = () => document.querySelector('.chat-compose-error[role="status"]')?.textContent ?? null;

/** Picks files through the + button's file input (LaunchPad's FileTrigger). */
async function pick(...files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  // The picker offers any file, as an open chat's does: a text file of any name goes too.
  expect(input.accept).toBe('');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}

/** Waits, a macrotask at a time, for what a FileReader brings. */
async function until(done: () => boolean) {
  for (let i = 0; i < 50 && !done(); i++) await act(async () => { await new Promise(r => setTimeout(r, 10)); });
}

async function type(text: string) {
  const input = document.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseRepo() {
  await act(async () => { buttonByText('Choose a repository').click(); });
  await flush();
  await act(async () => { buttonByText('acme/web').click(); });
  await flush();
}

async function send() {
  const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  await act(async () => { button.click(); });
  await flush();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  for (const key of Object.keys(mocks.flags)) delete mocks.flags[key];
  boxes.length = 0;
  feed.list = boxes;
  mocks.projects.length = 0;
  mocks.navigate.mockReset();
  mocks.createBox.mockReset();
  mocks.createProject.mockReset();
  mocks.createWorkstream.mockReset();
  mocks.credentials.mockResolvedValue({ github: { boxGate: 'clear' } });
  mocks.list.mockResolvedValue(catalog);
  mocks.listSpaces.mockResolvedValue({ spaces: [] });
  mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
  mocks.createProject.mockResolvedValue({ id: 'proj-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

async function render() {
  await act(async () => { root.render(<NewChat />); });
  await flush();
}

describe('NewChat images for the first message', () => {
  it('holds picked images through a new box and the session, for the first send', async () => {
    await render();
    await pick(png('shot.png'));
    expect(tiles()).toEqual(['shot.png']);
    await type('what is in this screenshot?');
    await chooseRepo();
    await send();
    expect(mocks.createBox).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-1' }));
    expect(readQueued(localStorage, 'proj-1')).toBe('what is in this screenshot?');
    const held = firstImages(localStorage, 'proj-1');
    expect(held.lost).toBe(0);
    expect(held.images.map(i => [i.name, i.mediaType])).toEqual([['shot.png', 'image/png']]);
  });

  it('starts a session whose first message is images alone, queued as attachments only', async () => {
    await render();
    await chooseRepo();
    expect(document.querySelector('button[type="submit"]')).toBeNull();
    await pick(png('shot.png'));
    await send();
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(readQueued(localStorage, 'proj-1')).toBe(ATTACHMENTS_ONLY);
    expect(firstImages(localStorage, 'proj-1').images.map(i => i.name)).toEqual(['shot.png']);
  });

  it('holds them for a session on one of your boxes too', async () => {
    mocks.flags['chat-existing-box-enabled'] = true;
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '' });
    mocks.createProject.mockResolvedValue({ id: 'proj-2' });
    await render();
    await chooseRepo();
    const trigger = document.querySelector('.chat-launch-trigger') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    const dev = [...document.querySelectorAll('.chat-launch-box')].find(b => b.textContent?.startsWith('dev')) as HTMLButtonElement;
    await act(async () => { dev.click(); });
    await act(async () => { (document.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    await pick(png('a.png'), png('b.png'));
    await type('compare these');
    await send();
    expect(mocks.createBox).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'b1' }));
    expect(firstImages(localStorage, 'proj-2').images.map(i => i.name)).toEqual(['a.png', 'b.png']);
  });

  it('takes a PDF on Claude\'s models, as an open chat\'s composer does, and holds it with its name', async () => {
    await render();
    expect(attachButton()?.getAttribute('aria-label')).toBe('Attach files');
    await pick(new File(['%PDF-1.7 spec'], 'spec.pdf', { type: 'application/pdf' }));
    expect(document.querySelector('.chat-attachment[data-file]')?.textContent).toContain('spec.pdf');
    await type('summarise the spec');
    await chooseRepo();
    await send();
    expect(firstImages(localStorage, 'proj-1').images.map(i => [i.name, i.mediaType])).toEqual([['spec.pdf', 'application/pdf']]);
  });

  it('holds Send while an attachment is still being prepared, so the session never leaves it behind', async () => {
    await render();
    await type('what is this?');
    await chooseRepo();
    let finish!: () => void;
    prep.gate = new Promise<void>(r => { finish = r; });
    await pick(png('slow.png'));
    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.body.textContent).toContain('Getting the attachments ready to send');
    prep.gate = null;
    await act(async () => { finish(); });
    await flush();
    expect(tiles()).toEqual(['slow.png']);
    expect(button.disabled).toBe(false);
  });

  it('takes an image pasted into the message', async () => {
    await render();
    const input = document.querySelector('textarea')!;
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [png('pasted.png')], getData: () => '' };
    await act(async () => { input.dispatchEvent(paste); });
    await flush();
    expect(tiles()).toEqual(['pasted.png']);
    expect(paste.defaultPrevented).toBe(true);
  });

  it('holds a long pasted transcript as a text file, so none of it is cut at the box\'s limit', async () => {
    await render();
    const input = document.querySelector('textarea')!;
    const transcript = Array.from({ length: 40 }, (_, i) => `${i}:00 ${'Uhm, so this radio button component here is like the toggle group. '.repeat(2)}`).join('\n');
    expect(transcript.length).toBeGreaterThan(MAX_KEYS);
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [], getData: (type: string) => (type === 'text/plain' ? transcript : '') };
    await act(async () => { input.dispatchEvent(paste); });
    await flush();
    expect(paste.defaultPrevented).toBe(true);
    expect(textChips()).toEqual(['Pasted text #1 +39 lines']);
    expect(input.value).toBe('');
    await type('Summarize this Loom transcript');
    await chooseRepo();
    await send();
    expect(splitTextFiles(readQueued(localStorage, 'proj-1')!)).toEqual({
      text: 'Summarize this Loom transcript',
      files: [{ name: 'Pasted text #1 +39 lines', text: transcript }],
    });
  });

  it('replaces the selected draft with a long paste, as a paste into the box would', async () => {
    await render();
    const input = document.querySelector('textarea')!;
    await type('Explain the old log');
    input.setSelectionRange(0, input.value.length);
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [], getData: () => 'new log line\n'.repeat(40) };
    await act(async () => { input.dispatchEvent(paste); });
    await flush();
    expect(textChips()).toEqual(['Pasted text #1 +40 lines']);
    expect(input.value).toBe('');
  });

  it('leaves a short paste to the message box', async () => {
    await render();
    const input = document.querySelector('textarea')!;
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [], getData: () => 'a short line' };
    await act(async () => { input.dispatchEvent(paste); });
    await flush();
    expect(paste.defaultPrevented).toBe(false);
    expect(textChips()).toEqual([]);
  });

  it('takes a dropped image, with the drop overlay while it is dragged', async () => {
    await render();
    const form = document.querySelector('form.chat-new-card')!;
    const drag = (type: string, files: File[] = []) => {
      const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      e.dataTransfer = { types: ['Files'], files, dropEffect: 'none' };
      return e;
    };
    await act(async () => { form.dispatchEvent(drag('dragenter')); });
    expect(document.querySelector('.chat-drop-overlay')).not.toBeNull();
    await act(async () => { form.dispatchEvent(drag('drop', [png('dropped.png')])); });
    await flush();
    expect(document.querySelector('.chat-drop-overlay')).toBeNull();
    expect(tiles()).toEqual(['dropped.png']);
  });

  it('keeps the composer\'s limits, types and notes', async () => {
    await render();
    const files = [png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png'), new File(['x'], 'notes.txt', { type: 'text/plain' })];
    await pick(...files);
    expect(tiles()).toEqual(['1.png', '2.png', '3.png', '4.png']);
    expect(tiles()).toHaveLength(MAX_CHAT_IMAGES);
    // A text file goes in the message's text, beside the four (chat/chatTextFiles.ts); it is read off the page's turn.
    await until(() => textChips().length > 0);
    expect(textChips()).toEqual(['notes.txt']);
    // The same note an open chat's composer gives for the same images (chat/chatImageData.ts admitImages).
    expect(note()).toBe(admitImages(0, files.slice(0, 5), true).note);
    expect(note()).toBe('At most 4 images and PDFs per message');
    // Full: one more is left out with the same words.
    await pick(png('6.png'));
    expect(tiles()).toHaveLength(MAX_CHAT_IMAGES);
    expect(note()).toBe('At most 4 images and PDFs per message');
    // A file that is not text is not attached, and says so.
    await pick(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], 'build.zip'));
    await until(() => note()?.startsWith('build.zip') ?? false);
    expect(note()).toBe("build.zip can't be attached: only text files, images and PDFs can");
    expect(textChips()).toEqual(['notes.txt']);
    // A removed one makes room again.
    await act(async () => { (document.querySelector('button[aria-label="Remove 1.png"]') as HTMLButtonElement).click(); });
    await pick(png('6.png'));
    expect(tiles()).toEqual(['2.png', '3.png', '4.png', '6.png']);
  });

  it('says why an image is too large, through the same preparation the composer uses', async () => {
    await render();
    await pick(new File([new Uint8Array(1)], 'huge.png', { type: 'image/png' }));
    expect(tiles()).toEqual(['huge.png']);
    const big = png('big.png', 4_000_000);
    await pick(big);
    expect(note()).toBe('big.png is too large to send, even made smaller');
    expect(tiles()).toEqual(['huge.png']);
  });

  it('offers no images for a scheduled run, whose prompt takes none', async () => {
    mocks.flags['automations-enabled'] = true;
    mocks.search = 'schedule=1';
    await render();
    expect(attachButton()).toBeNull();
    mocks.search = '';
  });
});
