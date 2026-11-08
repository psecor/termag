// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceView } from '../../services/api';

type Role = 'owner' | 'editor' | 'viewer';
const mocks = vi.hoisted(() => ({
  members: vi.fn(),
  boxes: vi.fn(),
  addMember: vi.fn(),
  setRole: vi.fn(),
  removeMember: vi.fn(),
  removeInvite: vi.fn(),
  addBox: vi.fn(),
  removeBox: vi.fn(),
  myBoxes: [] as Array<{ id: string; name: string; status: string }>,
}));
vi.mock('../../services/api', () => ({
  spacesApi: {
    members: mocks.members, boxes: mocks.boxes, addMember: mocks.addMember, setRole: mocks.setRole,
    removeMember: mocks.removeMember, removeInvite: mocks.removeInvite, addBox: mocks.addBox, removeBox: mocks.removeBox,
  },
  usersApi: { search: async () => [] },
}));
vi.mock('../../services/boxFeed', () => ({ boxFeed: { subscribe: () => () => {}, getSnapshot: () => mocks.myBoxes } }));
vi.mock('../../chat/useChatSpaces', async () => {
  const { spaceColor } = await import('../../chat/spaceColors');
  return { useSharedChatSpaces: () => ({ colorOf: spaceColor }) };
});

import { SpaceShareDialog } from './SpaceShareDialog';

const person = (userId: string, role: Role, displayName = userId) => ({ userId, email: `${userId}@example.com`, displayName, role, addedAt: '' });
const view = (role: Role, readOnly = false): SpaceView => ({ id: 's1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role, readOnly });

let root: Root;
let host: HTMLDivElement;
let onChanged: ReturnType<typeof vi.fn<() => void>>;
let onLeft: ReturnType<typeof vi.fn<() => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });
const dialog = () => document.querySelector<HTMLElement>('.chat-share-dialog')!;
const names = () => [...dialog().querySelectorAll('.chat-share-name')].map(n => n.textContent);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)!;
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => act(() => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

async function open(role: Role, opts: { readOnly?: boolean; userId?: string } = {}) {
  await act(async () => root.render(
    <SpaceShareDialog space={view(role, opts.readOnly)} userId={opts.userId ?? 'ada'} onClose={onClose} onChanged={onChanged} onLeft={onLeft} />,
  ));
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mocks.members.mockResolvedValue({
    members: [person('ada', 'owner', 'Ada Lovelace'), person('bo', 'editor', 'Bo Ito')],
    invites: [{ id: 'inv1', email: 'cy@example.com', role: 'editor', addedAt: '' }],
  });
  mocks.boxes.mockResolvedValue({ boxes: [{ id: 'b1', name: 'box-1', kind: 'ec2', status: 'ready', ownerEmail: 'ada@example.com', mine: true, children: [{ id: 'b3', name: 'box-3', via: 'b1' }] }] });
  for (const f of [mocks.addMember, mocks.setRole, mocks.removeMember, mocks.removeInvite, mocks.addBox, mocks.removeBox]) f.mockResolvedValue({ ok: true });
  mocks.myBoxes = [{ id: 'b1', name: 'box-1', status: 'ready' }, { id: 'b2', name: 'box-2', status: 'ready' }];
  onChanged = vi.fn<() => void>();
  onLeft = vi.fn<() => void>();
  onClose = vi.fn<() => void>();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the Share dialog, as an owner', () => {
  it('lists people and invites, and adds someone as Can edit by default', async () => {
    await open('owner');
    expect(dialog().querySelector('.chat-share-title')!.textContent).toBe('Share notes');
    expect(names()).toEqual(['Ada Lovelace (you)', 'Bo Ito', 'cy@example.com']);
    expect(dialog().querySelector('.chat-menu-heading')!.textContent).toBe('People · 3');
    const role = dialog().querySelector<HTMLSelectElement>('select[aria-label="Role"]')!;
    expect(role.value).toBe('editor');
    expect([...role.options].map(o => o.textContent)).toEqual(['Can edit', 'Can view', 'Owner']);
    mocks.addMember.mockResolvedValue({ member: { ...person('di', 'editor', 'Di Ng') } });
    setValue(dialog().querySelector<HTMLInputElement>('input[aria-label="Email"]')!, 'di@example.com');
    await act(async () => { dialog().querySelector<HTMLFormElement>('form.chat-share-add')!.requestSubmit(); });
    await settle();
    expect(mocks.addMember).toHaveBeenCalledWith('notes', 'di@example.com', 'editor');
    expect(dialog().querySelector('.chat-share-note')!.textContent).toBe('Di Ng can now edit notes.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Email"]')!.value).toBe('');
  });

  it('says when someone becomes a member only on first sign-in', async () => {
    await open('owner');
    mocks.addMember.mockResolvedValue({ invite: { id: 'inv2', email: 'ed@example.com', role: 'viewer' } });
    setValue(dialog().querySelector<HTMLInputElement>('input[aria-label="Email"]')!, 'ed@example.com');
    setValue(dialog().querySelector<HTMLSelectElement>('select[aria-label="Role"]')!, 'viewer');
    await act(async () => { dialog().querySelector<HTMLFormElement>('form.chat-share-add')!.requestSubmit(); });
    await settle();
    expect(mocks.addMember).toHaveBeenCalledWith('notes', 'ed@example.com', 'viewer');
    expect(dialog().querySelector('.chat-share-note')!.textContent).toBe('ed@example.com gets access when they first sign in to termag.');
  });

  it('shows the server\'s refusal and keeps what was typed', async () => {
    await open('owner');
    mocks.addMember.mockRejectedValue({ response: { data: { error: 'An email address is required', code: 'invalid_email' } } });
    setValue(dialog().querySelector<HTMLInputElement>('input[aria-label="Email"]')!, 'nope@x');
    await act(async () => { dialog().querySelector<HTMLFormElement>('form.chat-share-add')!.requestSubmit(); });
    await settle();
    expect(dialog().querySelector('[role=alert]')!.textContent).toContain('An email address is required');
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Email"]')!.value).toBe('nope@x');
    act(() => button('Dismiss').click());
    expect(dialog().querySelector('[role=alert]')).toBeNull();
  });

  it('changes a role, removes someone after asking, and cancels an invite', async () => {
    await open('owner');
    // No role picker or Remove on yourself.
    expect(dialog().querySelector('select[aria-label="Role of ada@example.com"]')).toBeNull();
    setValue(dialog().querySelector<HTMLSelectElement>('select[aria-label="Role of bo@example.com"]')!, 'viewer');
    await settle();
    expect(mocks.setRole).toHaveBeenCalledWith('notes', 'bo', 'viewer');
    act(() => button('Remove bo@example.com').click());
    expect(mocks.removeMember).not.toHaveBeenCalled();
    expect(document.querySelector('.confirm-message')!.textContent).toBe('Remove bo@example.com from notes? The boxes they added lose access too.');
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.confirm-btn')].find(b => b.textContent === 'Remove')!.click(); });
    await settle();
    expect(mocks.removeMember).toHaveBeenCalledWith('notes', 'bo');
    expect(onChanged).toHaveBeenCalled();
    await act(async () => { button('Cancel the invite to cy@example.com').click(); });
    expect(mocks.removeInvite).toHaveBeenCalledWith('notes', 'inv1');
  });

  it('won\'t let the last owner leave', async () => {
    await open('owner');
    const leave = button('Leave');
    expect(leave.disabled).toBe(true);
    expect(leave.title).toBe('Make someone else an owner first');
  });

  it('shows the boxes, with those started from them, and adds one of the user\'s own', async () => {
    await open('owner');
    expect(dialog().querySelector('.chat-share-box-dot')).toBeNull();
    act(() => dialog().querySelector<HTMLButtonElement>('.chat-share-disclose')!.click());
    expect(names()).toEqual(['Ada Lovelace (you)', 'Bo Ito', 'cy@example.com', 'box-1', '↳ box-3']);
    const pick = dialog().querySelector<HTMLSelectElement>('select[aria-label="Box to add"]')!;
    expect([...pick.options].map(o => o.textContent)).toEqual(['Add one of your boxes…', 'box-2']);
    setValue(pick, 'b2');
    await act(async () => { pick.form!.requestSubmit(); });
    await settle();
    expect(mocks.addBox).toHaveBeenCalledWith('notes', 'b2');
    await act(async () => { button('Remove box box-1').click(); });
    expect(mocks.removeBox).toHaveBeenCalledWith('notes', 'b1');
  });

  it('copies the space\'s link', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await open('owner');
    await act(async () => { button('Copy link').click(); });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/chat/files/notes`);
    expect(dialog().querySelector('.chat-share-copy')!.textContent).toBe('Link copied');
  });
});

describe('the Share dialog, as someone else', () => {
  it('is a read-only list for a viewer, who may leave', async () => {
    mocks.members.mockResolvedValue({ members: [person('ada', 'owner', 'Ada Lovelace'), person('vi', 'viewer')], invites: [] });
    await open('viewer', { userId: 'vi' });
    expect(dialog().querySelector('.chat-share-title')!.textContent).toBe('Share notes');
    expect(dialog().querySelector('.chat-share-gate')!.textContent).toBe('You can view this space. Only its owners add people: ask Ada Lovelace.');
    expect(dialog().querySelector('form')).toBeNull();
    expect(dialog().querySelectorAll('.chat-share-row select')).toHaveLength(0);
    expect([...dialog().querySelectorAll('.chat-share-role')].map(r => r.textContent)).toEqual(['Owner', 'Can view']);
    act(() => dialog().querySelector<HTMLButtonElement>('.chat-share-disclose')!.click());
    expect(dialog().querySelector('select[aria-label="Box to add"]')).toBeNull();
    act(() => button('Leave').click());
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.confirm-btn')].find(b => b.textContent === 'Leave')!.click(); });
    await settle();
    expect(mocks.removeMember).toHaveBeenCalledWith('notes', 'vi');
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it('lets an editor add their own boxes', async () => {
    await open('editor', { userId: 'bo' });
    expect(dialog().querySelector('.chat-share-gate')!.textContent).toContain('You can edit this space.');
    act(() => dialog().querySelector<HTMLButtonElement>('.chat-share-disclose')!.click());
    expect(dialog().querySelector('select[aria-label="Box to add"]')).not.toBeNull();
  });

  it('says a space with no owner is read-only, and offers nothing to change', async () => {
    await open('owner', { readOnly: true });
    expect(dialog().textContent).toContain('This space has no owner, so it is read-only.');
    expect(dialog().querySelector('form')).toBeNull();
    expect(dialog().querySelectorAll('.chat-share-row select')).toHaveLength(0);
  });
});
