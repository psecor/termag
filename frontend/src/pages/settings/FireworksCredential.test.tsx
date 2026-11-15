// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveFireworksKey: vi.fn(), removeFireworksKey: vi.fn() }));
vi.mock('../../services/api', () => ({ credentialsApi: api }));
vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => {} }));

import { FireworksCredential, fireworksOwnerLine } from './FireworksCredential';
import type { FireworksKeyStatus } from '../../services/api';

const KEY: FireworksKeyStatus = {
  label: 'alice@example.com', hint: 'fw_3Zt…', owner: 'alice@example.com', account: 'Acme',
  expireTime: '2027-05-01T00:00:00Z', expiresSoon: false, invalid: null, updatedAt: '2026-11-09T00:00:00Z',
};
const status = (over: object = {}) => ({ available: true, required: false, key: null, unreadable: false, ...over });

let root: Root;
let el: HTMLDivElement;
let changed: ReturnType<typeof vi.fn<() => Promise<void>>>;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  api.saveFireworksKey.mockReset();
  api.removeFireworksKey.mockReset();
  changed = vi.fn<() => Promise<void>>(async () => {});
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

function render(s: ReturnType<typeof status>) {
  act(() => root.render(<FireworksCredential status={s} onChanged={changed} />));
}
const text = () => el.textContent ?? '';
const input = () => el.querySelector('input[name="fireworksKey"]') as HTMLInputElement | null;
const button = (name: string) => [...el.querySelectorAll('button')].find(b => b.textContent === name) as HTMLButtonElement | undefined;

async function type(value: string) {
  const i = input()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(i, value);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); });
  await flush();
}

describe('Settings → Fireworks API key', () => {
  it('empty: the label, a password field and Save, and no explanation under them', () => {
    render(status());
    expect(input()?.type).toBe('password');
    expect(text()).toContain('Fireworks API key');
    expect(button('Save')?.disabled).toBe(true);
    expect(el.querySelector('.credentials-hint, [slot="description"]')).toBeNull();
    expect(text()).not.toMatch(/shared Fireworks key|termag's copy only|checks it with Fireworks/);
  });

  it('shows no explanation when a key is required either', () => {
    render(status({ required: true }));
    expect(el.querySelector('.credentials-hint, [slot="description"]')).toBeNull();
  });

  it('saves a pasted key and reloads; shows the check’s refusal in the field', async () => {
    render(status());
    api.saveFireworksKey.mockResolvedValueOnce({ owner: 'alice@example.com', account: 'Acme', expireTime: null });
    await type('  fw_newkey0123456789abcdef  ');
    await submit();
    expect(api.saveFireworksKey).toHaveBeenCalledWith('fw_newkey0123456789abcdef');
    expect(changed).toHaveBeenCalled();

    api.saveFireworksKey.mockRejectedValueOnce({ response: { data: { error: 'Fireworks rejected that key (HTTP 401).' } } });
    await type('fw_badkey0123456789abcdef');
    await submit();
    expect(text()).toContain('Fireworks rejected that key (HTTP 401).');
  });

  it('valid: the key’s hint, owner and expiry, Replace and Remove; no field', () => {
    render(status({ key: KEY }));
    expect(text()).toContain('fw_3Zt…');
    expect(text()).toContain('in use for your Fireworks calls');
    expect(text()).toContain('Belongs to alice@example.com, in the Fireworks account Acme.');
    expect(text()).toMatch(/Expires on/);
    expect(input()).toBeNull();
    expect(button('Replace')).toBeDefined();
    expect(button('Remove from termag')).toBeDefined();
  });

  it('Replace opens the field; Remove deletes termag’s copy and reloads', async () => {
    render(status({ key: KEY }));
    await act(async () => { button('Replace')!.click(); });
    expect(input()).not.toBeNull();
    expect(text()).toContain('New Fireworks API key');
    api.removeFireworksKey.mockResolvedValueOnce(undefined);
    await act(async () => { button('Remove from termag')!.click(); });
    await flush();
    expect(api.removeFireworksKey).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
  });

  it('warns before the key expires', () => {
    render(status({ key: { ...KEY, expiresSoon: true } }));
    expect(el.querySelector('[role="alert"], .fw-key-alert')).not.toBeNull();
    expect(text()).toMatch(/expires on .*Create a new one in Fireworks/);
  });

  it('invalid: says Fireworks rejected it, that calls are refused, and asks for a new key', () => {
    render(status({ key: { ...KEY, invalid: { reason: 'rejected', at: '2026-11-09T00:00:00Z' } } }));
    expect(text()).toContain('Fireworks rejected your key (fw_3Zt…).');
    expect(text()).toContain('refused until you paste a new one');
    expect(text()).toContain('(not in use)');
    expect(input()).not.toBeNull();
    expect(button('Replace')).toBeUndefined();
  });

  it('expired: names the date', () => {
    render(status({ key: { ...KEY, invalid: { reason: 'expired', at: '2026-11-01T00:00:00Z' } } }));
    expect(text()).toMatch(/expired on .*2026/);
  });

  it('names the owner only as far as Fireworks said', () => {
    expect(fireworksOwnerLine({ ...KEY, owner: null })).toBe('In the Fireworks account Acme.');
    expect(fireworksOwnerLine({ ...KEY, owner: null, account: null })).toBe('Accepted by Fireworks.');
    expect(fireworksOwnerLine({ ...KEY, account: null })).toBe('Belongs to alice@example.com.');
  });
});
