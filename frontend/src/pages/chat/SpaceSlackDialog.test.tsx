// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackPickerChannel, SpaceSlackStatus } from '../../services/api';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), channels: vi.fn(), preview: vi.fn(), link: vi.fn(), unlinkPreview: vi.fn(), unlink: vi.fn(), pause: vi.fn(), resume: vi.fn(),
}));
vi.mock('../../services/api', () => ({ spaceSlackApi: mocks }));
vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => BOXES },
}));
const BOXES = [
  { id: 'b1', name: 'olive', status: 'ready' }, { id: 'b2', name: 'gone', status: 'terminated' },
  { id: 'b3', name: 'broken', status: 'failed' }, { id: 'b4', name: 'held', status: 'quarantined' },
];

// React Aria's Modal reads a CSP nonce through CSS.escape, which jsdom lacks (as in BoxResizeLaunchPad.test.tsx).
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SpaceSlackDialog } = await import('./SpaceSlackDialog');

const GENERAL = {
  channelId: 'C0FAKEGEN1', name: 'general', private: false, createdByTermag: false, linkedBy: { userId: 'u1', email: 'ana@example.com' },
  linkedVia: 'web', linkedAt: '2026-11-04T10:00:00.000Z', paused: false,
};
const status = (over: Partial<SpaceSlackStatus> = {}): SpaceSlackStatus => ({
  space: 'payments', enabled: true, status: 'active', runner: { userId: 'u1', email: 'ana@example.com' }, box: { kind: 'new', size: 'small' },
  pendingRunner: null, caps: { channelsPerSpace: 5, allowPrivate: true }, channels: [GENERAL], you: { owner: true, runner: true }, slack: 'fake', ...over,
});
const PICKER: SlackPickerChannel[] = [
  { id: 'C0FAKETEAM', name: 'team-payments', private: false, termagIn: true, members: 4 },
  { id: 'G0FAKELEAD', name: 'leads', private: true, termagIn: true, members: 2 },
  { id: 'C0FAKEGEN1', name: 'general', private: false, termagIn: true, members: 14, disabled: 'channel_linked', linkedTo: 'payments' },
];

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 300)); });
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
const text = () => document.body.textContent ?? '';
const combobox = () => document.querySelector('input[role="combobox"]') as HTMLInputElement;
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}
async function open() {
  await act(async () => root.render(<SpaceSlackDialog space="payments" onClose={() => {}} />));
  await flush();
}
const press = (b: HTMLElement | undefined) => act(async () => { b!.click(); });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.status.mockResolvedValue(status());
  mocks.channels.mockResolvedValue({ channels: PICKER, nextCursor: null });
  mocks.preview.mockResolvedValue({ bystanders: 3, needsInvite: false, firstLink: false, channelName: 'team-payments', isPrivate: false });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('the Slack channels dialog', () => {
  it('lists the linked channels with who linked them, the runner, and Unlink', async () => {
    await open();
    expect(document.querySelector('.space-slack-dialog h2')?.textContent).toBe('Slack channels for payments');
    expect(document.querySelector('[role="grid"]')).not.toBe(null);
    expect(text()).toContain('Linked channels · 1 of 5');
    expect(text()).toContain('Linked by ana@example.com via termag');
    expect(text()).toContain('Runner: ana@example.com (you), on a new small box');
    expect(text()).toContain('fake Slack workspace');
    expect(button('Unlink general')).toBeDefined();
  });

  it('confirms an unlink, offering to archive only a channel termag created, then reloads', async () => {
    mocks.unlinkPreview.mockResolvedValue({ channel: GENERAL, threads: 2, canArchive: false });
    mocks.unlink.mockResolvedValue({ unlinked: 'C0FAKEGEN1', name: 'general', archived: false });
    await open();
    await press(button('Unlink general'));
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).not.toBe(null);
    expect(text()).toContain('2 threads there stop answering');
    expect(text()).not.toContain('Also archive');
    mocks.status.mockResolvedValue(status({ channels: [] }));
    await press([...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Unlink') as HTMLElement);
    await flush();
    expect(mocks.unlink).toHaveBeenCalledWith('payments', 'C0FAKEGEN1', false);
    expect(text()).toContain('Unlinked #general.');
    expect(text()).toContain('No channels linked yet.');
  });

  it('searches channels on the server, shows why one can\'t be picked, previews the bystanders and links', async () => {
    mocks.link.mockResolvedValue({ channel: { ...GENERAL, channelId: 'C0FAKETEAM', name: 'team-payments' }, already: false, failedInvites: [] });
    await open();
    expect(button('Link channel')!.disabled || button('Link channel')!.getAttribute('aria-disabled') === 'true').toBe(true);
    await typeInto(combobox(), 'team');
    expect(mocks.channels).toHaveBeenLastCalledWith('team', undefined);
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map(o => o.textContent)).toEqual([
      expect.stringContaining('team-payments'), expect.stringContaining('leads'), expect.stringContaining('Already linked to payments'),
    ]);
    expect(options[2].getAttribute('aria-disabled')).toBe('true');
    await press(options[0] as HTMLElement);
    await flush();
    expect(mocks.preview).toHaveBeenCalledWith('payments', { channelId: 'C0FAKETEAM' });
    expect(text()).toContain('3 people in this channel aren\'t members of payments');
    await press(button('Link channel'));
    await flush();
    // Not a first link: no runner box is sent.
    expect(mocks.link).toHaveBeenCalledWith('payments', { channelId: 'C0FAKETEAM' }, undefined);
    expect(text()).toContain('Linked #team-payments to payments.');
  });

  it('stops at needs-invite with what to do in Slack', async () => {
    mocks.preview.mockResolvedValue({ bystanders: null, needsInvite: true, firstLink: false, channelName: null, isPrivate: true });
    await open();
    await typeInto(combobox(), 'lea');
    await press(document.querySelectorAll('[role="option"]')[1] as HTMLElement);
    await flush();
    expect(text()).toContain('/invite @termag');
    expect(button('Link channel')!.disabled || button('Link channel')!.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('validates a new channel\'s name before asking the server', async () => {
    await open();
    await press([...document.querySelectorAll('label')].find(l => l.textContent === 'A new channel') as HTMLElement);
    const name = [...document.querySelectorAll('input')].find(i => i.value === 'space-payments') as HTMLInputElement;
    expect(name).toBeDefined();
    await flush();
    expect(mocks.preview).toHaveBeenLastCalledWith('payments', { create: { name: 'space-payments', private: false, inviteMembers: false } });
    mocks.preview.mockClear();
    await typeInto(name, 'proj-x');
    expect(text()).toContain('proj-… names are for workstream channels');
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(button('Create and link')!.disabled || button('Create and link')!.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('asks for the runner\'s box on a first link only, a new small box by default, live boxes only', async () => {
    mocks.status.mockResolvedValue(status({ enabled: false, status: null, runner: null, box: null, channels: [], you: { owner: true, runner: false } }));
    mocks.preview.mockResolvedValue({ bystanders: 0, needsInvite: false, firstLink: true, channelName: 'team-payments', isPrivate: false });
    mocks.link.mockResolvedValue({ channel: { ...GENERAL, channelId: 'C0FAKETEAM', name: 'team-payments' }, already: false, failedInvites: [] });
    await open();
    expect(text()).toContain('Slack isn\'t on for payments yet');
    expect(text()).toContain('Runner\'s box');
    expect(text()).toContain('A new small box');
    await typeInto(combobox(), '');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    expect(text()).toContain('first channel');
    await press(button('Link channel'));
    await flush();
    expect(mocks.link).toHaveBeenCalledWith('payments', { channelId: 'C0FAKETEAM' }, { new: { size: 'small' } });
  });

  it('offers only boxes a runner can use: not terminated, failed or quarantined ones', async () => {
    mocks.status.mockResolvedValue(status({ enabled: false, status: null, runner: null, box: null, channels: [], you: { owner: true, runner: false } }));
    await open();
    await press(document.querySelector('.space-slack-select-button') as HTMLElement);
    await flush();
    const options = [...document.querySelectorAll('[role="option"]')].map(o => o.textContent);
    expect(options).toEqual(['A new small box', 'olive']);
  });

  it('follows the picker\'s cursor, adding the later pages', async () => {
    mocks.channels.mockImplementation(async (_q: string, cursor?: string) => cursor === 'c2'
      ? { channels: [{ id: 'C0FAKELATE', name: 'project-archive', private: false, termagIn: true, members: 2 }], nextCursor: null }
      : { channels: PICKER.slice(0, 1), nextCursor: 'c2' });
    await open();
    await typeInto(combobox(), 'p');
    expect(mocks.channels).toHaveBeenCalledWith('p', 'c2');
    expect([...document.querySelectorAll('[role="option"]')].map(o => o.textContent)).toEqual([
      expect.stringContaining('team-payments'), expect.stringContaining('project-archive'),
    ]);
  });

  it('disables private channels where the space may not link them, saying why', async () => {
    mocks.status.mockResolvedValue(status({ caps: { channelsPerSpace: 5, allowPrivate: false } }));
    await open();
    await typeInto(combobox(), 'lea');
    const leads = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.includes('leads'))!;
    expect(leads.getAttribute('aria-disabled')).toBe('true');
    expect(leads.textContent).toContain('Private channels can\'t be linked to spaces here');
  });

  it('empties the create form after a create, so a second press can\'t send it again', async () => {
    mocks.preview.mockResolvedValue({ bystanders: 0, needsInvite: false, firstLink: false, channelName: 'space-payments', isPrivate: false });
    mocks.link.mockResolvedValue({ channel: { ...GENERAL, channelId: 'C0NEW', name: 'space-payments', createdByTermag: true }, already: false, failedInvites: [] });
    await open();
    await press([...document.querySelectorAll('label')].find(l => l.textContent === 'A new channel') as HTMLElement);
    await flush();
    await press(button('Create and link'));
    await flush();
    expect(mocks.link).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Linked #space-payments to payments.');
    expect(button('Create and link')).toBeUndefined();
    expect(combobox()).not.toBe(null);
  });

  it('drops a preview that lands after its target was cleared', async () => {
    let resolve!: (p: unknown) => void;
    mocks.preview.mockImplementation(() => new Promise(r => { resolve = r; }));
    await open();
    await press([...document.querySelectorAll('label')].find(l => l.textContent === 'A new channel') as HTMLElement);
    await flush();
    const name = [...document.querySelectorAll('input')].find(i => i.value === 'space-payments') as HTMLInputElement;
    await typeInto(name, 'proj-x');
    await act(async () => { resolve({ bystanders: 7, needsInvite: false, firstLink: true, channelName: 'space-payments', isPrivate: false }); });
    await flush();
    expect(text()).not.toContain('7 people');
    expect(text()).not.toContain('first channel');
  });

  it('still unlinks when the unlink preview fails, without the archive offer', async () => {
    mocks.unlinkPreview.mockRejectedValue({ response: { data: { error: 'Slack refused (ratelimited); try again.' } } });
    mocks.unlink.mockResolvedValue({ unlinked: 'C0FAKEGEN1', name: 'general', archived: false });
    await open();
    await press(button('Unlink general'));
    await flush();
    expect(text()).toContain('You can still unlink it.');
    const go = [...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Unlink') as HTMLButtonElement;
    expect(go.disabled || go.getAttribute('aria-disabled') === 'true').toBe(false);
    await press(go);
    await flush();
    expect(mocks.unlink).toHaveBeenCalledWith('payments', 'C0FAKEGEN1', false);
  });

  it('says when the list could not be refreshed after a change, and offers to try again', async () => {
    mocks.unlinkPreview.mockResolvedValue({ channel: GENERAL, threads: 0, canArchive: false });
    mocks.unlink.mockResolvedValue({ unlinked: 'C0FAKEGEN1', name: 'general', archived: false });
    await open();
    mocks.status.mockRejectedValueOnce({ response: { data: { error: 'Bad gateway' } } });
    await press(button('Unlink general'));
    await flush();
    await press([...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Unlink') as HTMLElement);
    await flush();
    expect(text()).toContain('Couldn\'t refresh the list (Bad gateway); it may be out of date.');
    mocks.status.mockResolvedValue(status({ channels: [] }));
    await press(button('Try again'));
    await flush();
    expect(text()).not.toContain('Couldn\'t refresh the list');
    expect(text()).toContain('No channels linked yet.');
  });

  it('clears a link refusal when the target changes', async () => {
    mocks.link.mockRejectedValue({ response: { data: { error: 'This channel is already linked to another space; unlink it there first.' } } });
    await open();
    await typeInto(combobox(), 'team');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    await press(button('Link channel'));
    await flush();
    expect(text()).toContain('already linked to another space');
    await press([...document.querySelectorAll('label')].find(l => l.textContent === 'A new channel') as HTMLElement);
    await flush();
    expect(text()).not.toContain('already linked to another space');
  });

  it('drops the last search\'s channels and error as soon as the query changes', async () => {
    await open();
    await typeInto(combobox(), 'team');
    expect(document.querySelectorAll('[role="option"]').length).toBe(3);
    let resolve!: (v: unknown) => void;
    mocks.channels.mockImplementation(() => new Promise(r => { resolve = r; }));
    await typeInto(combobox(), 'zzz');
    // The new search hasn't answered: nothing from the old one is offered.
    expect([...document.querySelectorAll('[role="option"]')].map(o => o.textContent).join(' ')).not.toContain('team-payments');
    await act(async () => { resolve({ channels: [], nextCursor: null }); });
    mocks.channels.mockRejectedValueOnce({ response: { data: { error: 'Slack refused (ratelimited); try again.' } } });
    await typeInto(combobox(), 'err');
    expect(text()).toContain('ratelimited');
    mocks.channels.mockImplementation(() => new Promise(() => {}));
    await typeInto(combobox(), 'next');
    expect(text()).not.toContain('ratelimited');
  });

  it('searches again after a link, so the picker shows the new channel as linked', async () => {
    mocks.link.mockResolvedValue({ channel: { ...GENERAL, channelId: 'C0FAKETEAM', name: 'team-payments' }, already: false, failedInvites: [] });
    await open();
    await typeInto(combobox(), 'team');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    const before = mocks.channels.mock.calls.length;
    mocks.status.mockResolvedValue(status({ channels: [GENERAL, { ...GENERAL, channelId: 'C0FAKETEAM', name: 'team-payments' }] }));
    await press(button('Link channel'));
    await flush();
    expect(mocks.channels.mock.calls.length).toBeGreaterThan(before);
  });

  it('keeps the newest status when two loads overlap', async () => {
    mocks.link.mockResolvedValue({ channel: { ...GENERAL, channelId: 'C0FAKETEAM', name: 'team-payments' }, already: false, failedInvites: [] });
    mocks.unlinkPreview.mockResolvedValue({ channel: GENERAL, threads: 0, canArchive: false });
    mocks.unlink.mockResolvedValue({ unlinked: 'C0FAKEGEN1', name: 'general', archived: false });
    await open();
    // The link's reload answers late, with a list that still has #general.
    let late!: (v: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise(r => { late = r; }));
    await typeInto(combobox(), 'team');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    await press(button('Link channel'));
    await flush();
    // The unlink's reload, started after it, answers first: #general is gone.
    mocks.status.mockResolvedValueOnce(status({ channels: [{ ...GENERAL, channelId: 'C0FAKETEAM', name: 'team-payments' }] }));
    await press(button('Unlink general'));
    await flush();
    await press([...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Unlink') as HTMLElement);
    await flush();
    expect(button('Unlink general')).toBeUndefined();
    await act(async () => { late(status()); });
    await flush();
    // The older answer is dropped.
    expect(button('Unlink general')).toBeUndefined();
    expect(button('Unlink team-payments')).toBeDefined();
  });

  it('never lets a pause answer overwrite a newer list', async () => {
    mocks.unlinkPreview.mockResolvedValue({ channel: GENERAL, threads: 0, canArchive: false });
    mocks.unlink.mockResolvedValue({ unlinked: 'C0FAKEGEN1', name: 'general', archived: false });
    await open();
    // The pause answers late, with the list as it was (still #general).
    let late!: (v: unknown) => void;
    mocks.pause.mockImplementation(() => new Promise(r => { late = r; }));
    await press(button('Pause'));
    mocks.status.mockResolvedValue(status({ channels: [] }));
    await press(button('Unlink general'));
    await flush();
    await press([...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Unlink') as HTMLElement);
    await flush();
    expect(text()).toContain('No channels linked yet.');
    await act(async () => { late(status({ status: 'paused' })); });
    await flush();
    expect(text()).toContain('No channels linked yet.');
    expect(button('Unlink general')).toBeUndefined();
  });

  it('drops a pause error once a newer status has landed', async () => {
    mocks.unlinkPreview.mockResolvedValue({ channel: GENERAL, threads: 0, canArchive: false });
    mocks.unlink.mockResolvedValue({ unlinked: 'C0FAKEGEN1', name: 'general', archived: false });
    await open();
    let fail!: (e: unknown) => void;
    mocks.pause.mockImplementation(() => new Promise((_r, rej) => { fail = rej; }));
    await press(button('Pause'));
    mocks.status.mockResolvedValue(status({ channels: [] }));
    await press(button('Unlink general'));
    await flush();
    await press([...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Unlink') as HTMLElement);
    await flush();
    await act(async () => { fail({ response: { data: { error: 'Slack refused' } } }); });
    await flush();
    expect(text()).not.toContain('Slack refused');
  });

  it('locks the form while a link is in flight', async () => {
    let done!: (v: unknown) => void;
    mocks.link.mockImplementation(() => new Promise(r => { done = r; }));
    await open();
    await typeInto(combobox(), 'team');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    await press(button('Link channel'));
    expect(combobox().disabled).toBe(true);
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.length).toBe(2);
    expect(radios.every(r => r.disabled)).toBe(true);
    await act(async () => { done({ channel: { ...GENERAL, channelId: 'C0FAKETEAM', name: 'team-payments' }, already: false, failedInvites: [] }); });
    await flush();
    expect(combobox().disabled).toBe(false);
  });

  it('drops the pick when the text no longer names it', async () => {
    await open();
    await typeInto(combobox(), 'team');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    expect(mocks.preview).toHaveBeenLastCalledWith('payments', { channelId: 'C0FAKETEAM' });
    await typeInto(combobox(), 'tea');
    expect(button('Link channel')!.disabled || button('Link channel')!.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(text()).not.toContain('3 people in this channel');
  });

  it('keeps a new pick when picking another channel', async () => {
    await open();
    await typeInto(combobox(), '');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    expect(mocks.preview).toHaveBeenLastCalledWith('payments', { channelId: 'C0FAKETEAM' });
    // Open the list again without typing and pick another: the field's text becomes the new name in the same turn.
    await press(button('Show channels'));
    await flush();
    await press([...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.includes('leads')) as HTMLElement);
    await flush();
    expect(mocks.preview).toHaveBeenLastCalledWith('payments', { channelId: 'G0FAKELEAD' });
    expect(combobox().value).toBe('leads');
    expect(button('Link channel')!.disabled || button('Link channel')!.getAttribute('aria-disabled') === 'true').toBe(false);
  });

  it('checks a needs-invite channel again on Check again, without picking another', async () => {
    mocks.preview.mockResolvedValueOnce({ bystanders: null, needsInvite: true, firstLink: false, channelName: null, isPrivate: true });
    await open();
    await typeInto(combobox(), 'lea');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    expect(text()).toContain('/invite @termag');
    mocks.preview.mockResolvedValueOnce({ bystanders: 1, needsInvite: false, firstLink: false, channelName: 'leads', isPrivate: true });
    await press(button('Check again'));
    await flush();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain('/invite @termag');
    expect(button('Link channel')!.disabled || button('Link channel')!.getAttribute('aria-disabled') === 'true').toBe(false);
  });

  it('clears a failed pause\'s error once a later change reloads the list', async () => {
    mocks.pause.mockRejectedValue({ response: { data: { error: 'Slack refused (ratelimited); try again.' } } });
    mocks.unlinkPreview.mockResolvedValue({ channel: GENERAL, threads: 0, canArchive: false });
    mocks.unlink.mockResolvedValue({ unlinked: 'C0FAKEGEN1', name: 'general', archived: false });
    await open();
    await press(button('Pause'));
    await flush();
    expect(text()).toContain('ratelimited');
    mocks.status.mockResolvedValue(status({ channels: [] }));
    await press(button('Unlink general'));
    await flush();
    await press([...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Unlink') as HTMLElement);
    await flush();
    expect(text()).toContain('Unlinked #general.');
    expect(text()).not.toContain('ratelimited');
  });

  it('greys out a public channel you are not in, with the reason', async () => {
    mocks.channels.mockResolvedValue({ channels: [...PICKER, { id: 'C0FAKEOUT1', name: 'outsiders', private: false, termagIn: false, members: 5, disabled: 'not_in_channel' }], nextCursor: null });
    await open();
    await typeInto(combobox(), 'out');
    const outsiders = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.includes('outsiders'))!;
    expect(outsiders.getAttribute('aria-disabled')).toBe('true');
    expect(outsiders.textContent).toContain('You aren\'t in this channel');
  });

  it('runs no channel search while the space is full and the picker hidden', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...GENERAL, channelId: `C0FULL${i}000`, name: `c${i}` }));
    mocks.status.mockResolvedValue(status({ channels: five }));
    await open();
    await flush();
    expect(text()).toContain('the most it can have');
    expect(mocks.channels).not.toHaveBeenCalled();
  });

  it('says a channel is already linked at the preview, and offers nothing to link', async () => {
    mocks.preview.mockResolvedValue({ bystanders: null, needsInvite: false, firstLink: false, channelName: 'team-payments', isPrivate: false, alreadyLinked: true });
    await open();
    await typeInto(combobox(), 'team');
    await press(document.querySelectorAll('[role="option"]')[0] as HTMLElement);
    await flush();
    expect(text()).toContain('#team-payments is already linked to payments.');
    expect(text()).not.toContain('can\'t see who is in this channel');
    expect(button('Link channel')!.disabled || button('Link channel')!.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('shows a member the channels, without Unlink or the link form', async () => {
    mocks.status.mockResolvedValue(status({ you: { owner: false, runner: false } }));
    await open();
    expect(text()).toContain('general');
    expect(button('Unlink general')).toBeUndefined();
    expect(combobox()).toBe(null);
    expect(text()).toContain('Only payments\'s owners link and unlink its channels.');
  });

  it('says the server\'s refusal when the status can\'t be read', async () => {
    mocks.status.mockRejectedValue({ response: { data: { error: 'Space channels are not turned on for you', code: 'space_channels_off' } } });
    await open();
    expect(text()).toContain('Space channels are not turned on for you');
  });
});
