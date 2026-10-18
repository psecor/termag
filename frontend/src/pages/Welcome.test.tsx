// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Welcome from './Welcome';
import { SshKeysSection, SshKeysSectionHandle } from './settings/SshKeysSection';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), add: vi.fn(), remove: vi.fn(), credentials: vi.fn(),
  navigate: vi.fn(), setOnboarded: vi.fn(),
  user: { email: 'owner@example.com' },
}));
vi.mock('../services/api', () => ({
  sshKeysApi: { list: mocks.list, add: mocks.add, remove: mocks.remove },
  credentialsApi: { get: mocks.credentials },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, setOnboarded: mocks.setOnboarded }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../services/boxFeed', () => ({ boxFeed: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('./settings/GithubCredential', () => ({ GithubCredential: () => <div>GitHub settings</div> }));
vi.mock('./settings/DotfilesSection', () => ({ DotfilesSection: () => <div>Dotfiles settings</div> }));
vi.mock('../components/NewProjectForm', () => ({ NewProjectForm: () => <div>New project</div> }));

// These tests render the real Welcome and SshKeysSection together. Only
// external APIs, routing, and the unrelated later steps are stand-ins.
const draft = 'ssh-ed25519 fixture-key owner@example.com';
const savedKey = {
  id: 'key-1', comment: 'owner@example.com', type: 'ssh-ed25519', bits: 256,
  fingerprint: 'SHA256:fixture', createdAt: '2026-10-14T00:00:00Z',
  boxes: { updated: [], pending: [] },
};
let root: Root;
let container: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function input(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('input[aria-label="SSH public key"]');
  if (!found) throw new Error('SSH key step is not mounted');
  return found;
}
const stepTitle = () => document.querySelector('#wiz-h')?.textContent;
const dialog = () => document.querySelector('[role="dialog"]');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function typeKey(value = draft) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.list.mockResolvedValue([]);
  mocks.add.mockResolvedValue(savedKey);
  mocks.credentials.mockResolvedValue({ github: { boxGate: 'clear' } });
  mocks.setOnboarded.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<Welcome />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('wizard SSH key navigation', () => {
  it('keeps a pasted key on Next until the user chooses what to do', async () => {
    await typeKey();
    await click(button('Next'));
    expect(stepTitle()).toContain('Your laptop SSH key');
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Add key and continue');
    expect(mocks.add).not.toHaveBeenCalled();
    await click(button('Keep editing'));
    expect(dialog()).toBeNull();
    expect(input().value).toBe(draft);
    expect(stepTitle()).toContain('Your laptop SSH key');
  });

  it('waits for the save and blocks navigation and editing while boxes update', async () => {
    let resolve!: (value: typeof savedKey) => void;
    mocks.add.mockReturnValue(new Promise<typeof savedKey>(r => { resolve = r; }));
    await typeKey();
    await click(button('Next'));
    await click(button('Add key and continue'));
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(draft);
    expect(stepTitle()).toContain('Your laptop SSH key');
    expect(button('Next').disabled).toBe(true);
    expect(button('Skip setup').disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLButtonElement>('.wiz-steps button')].every(b => b.disabled)).toBe(true);
    expect(input().readOnly).toBe(true);
    expect(input().disabled).toBe(false);
    await act(async () => { resolve(savedKey); });
    expect(stepTitle()).toContain('GitHub');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('retains the draft and error on failure so saving can be retried', async () => {
    mocks.add.mockRejectedValueOnce({ response: { data: { error: 'Invalid public key' } } });
    await typeKey();
    await click(button('Next'));
    await click(button('Add key and continue'));
    expect(stepTitle()).toContain('Your laptop SSH key');
    expect(input().value).toBe(draft);
    expect(document.querySelector('.error-banner')?.textContent).toContain('Invalid public key');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invalid public key');
    expect(document.activeElement).toBe(input());
    expect(button('Next').disabled).toBe(false);
    await click(button('Next'));
    await click(button('Add key and continue'));
    expect(stepTitle()).toContain('GitHub');
    expect(mocks.add).toHaveBeenCalledTimes(2);
  });

  it('advances without saving only after an explicit discard', async () => {
    await typeKey();
    await click(button('Next'));
    await click(button('Continue without adding'));
    expect(stepTitle()).toContain('GitHub');
    expect(mocks.add).not.toHaveBeenCalled();
    await click(button('← Back'));
    expect(input().value).toBe('');
  });

  it.each(['', '   '])('does not prompt for an empty draft (%j)', async value => {
    await typeKey(value);
    await click(button('Next'));
    expect(stepTitle()).toContain('GitHub');
    expect(dialog()).toBeNull();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('does not prompt or add again after the form already saved the key', async () => {
    await typeKey();
    await click(button('Add key'));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Key added');
    await click(button('Next'));
    expect(stepTitle()).toContain('GitHub');
    expect(dialog()).toBeNull();
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(draft);
  });

  it('also protects step-tab navigation', async () => {
    await typeKey();
    const dotfiles = document.querySelectorAll<HTMLButtonElement>('.wiz-steps button')[2];
    await click(dotfiles);
    expect(dialog()).not.toBeNull();
    await click(button('Add key and continue'));
    expect(stepTitle()).toContain('Dotfiles');
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(draft);
  });

  it('also protects Skip setup and only exits after a deliberate choice', async () => {
    await typeKey();
    await click(button('Skip setup'));
    expect(dialog()).not.toBeNull();
    expect(mocks.setOnboarded).not.toHaveBeenCalled();
    await click(button('Keep editing'));
    expect(input().value).toBe(draft);
    await click(button('Skip setup'));
    await click(button('Continue without adding'));
    expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('recovers from an already-registered key only after refreshing its saved entry', async () => {
    mocks.add.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Key SHA256:fixture is already registered' } } });
    mocks.list.mockResolvedValueOnce([savedKey]);
    await typeKey();
    await click(button('Next'));
    await click(button('Add key and continue'));
    expect(stepTitle()).toContain('GitHub');
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('keeps the draft if the duplicate response cannot be confirmed in the saved list', async () => {
    mocks.add.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Key SHA256:fixture is already registered' } } });
    mocks.list.mockResolvedValueOnce([]);
    await typeKey();
    await click(button('Next'));
    await click(button('Add key and continue'));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(stepTitle()).toContain('Your laptop SSH key');
    expect(input().value).toBe(draft);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('does not mark setup done or navigate when the wizard unmounts during save', async () => {
    const save = deferred<typeof savedKey>();
    mocks.add.mockReturnValue(save.promise);
    await typeKey();
    await click(button('Skip setup'));
    await click(button('Add key and continue'));
    await act(async () => { root.render(<div>Another route</div>); });
    await act(async () => { save.resolve(savedKey); });
    expect(mocks.setOnboarded).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Another route');
  });

  it('preserves the original destination if another navigation fires while the prompt is open', async () => {
    await typeKey();
    await click(button('Next'));
    await click(button('Skip setup'));
    await click(button('Add key and continue'));
    expect(stepTitle()).toContain('GitHub');
    expect(mocks.setOnboarded).not.toHaveBeenCalled();
  });

  it('blocks same-frame navigation before the save busy state renders', async () => {
    const save = deferred<typeof savedKey>();
    mocks.add.mockReturnValue(save.promise);
    await typeKey();
    await act(async () => {
      input().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      button('Next').click();
    });
    expect(dialog()).toBeNull();
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(draft);
    await act(async () => { save.resolve(savedKey); });
    expect(stepTitle()).toContain('Your laptop SSH key');
  });

  it('supports Escape after focusing the dialog itself and returns focus to the draft', async () => {
    await typeKey();
    await click(button('Next'));
    const modal = dialog() as HTMLDivElement;
    modal.focus();
    expect(document.activeElement).toBe(modal);
    await act(async () => { modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dialog()).toBeNull();
    expect(input().value).toBe(draft);
    expect(document.activeElement).toBe(input());
    expect(mocks.add).not.toHaveBeenCalled();
  });
});

describe('shared SSH key form', () => {
  it('keeps the Settings input focused and read-only during an Add key request', async () => {
    const save = deferred<typeof savedKey>();
    mocks.add.mockReturnValue(save.promise);
    await act(async () => { root.render(<SshKeysSection />); });
    await typeKey();
    input().focus();
    await act(async () => { input().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(input().disabled).toBe(false);
    expect(input().readOnly).toBe(true);
    expect(document.activeElement).toBe(input());
    await act(async () => { save.resolve(savedKey); });
    expect(input().readOnly).toBe(false);
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
  });

  it('coalesces rapid calls to the exposed add operation into one request', async () => {
    const ref = createRef<SshKeysSectionHandle>();
    const save = deferred<typeof savedKey>();
    mocks.add.mockReturnValue(save.promise);
    await act(async () => { root.render(<SshKeysSection ref={ref} />); });
    await typeKey();
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => { first = ref.current!.addDraft(); second = ref.current!.addDraft(); });
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(draft);
    await expect(second).resolves.toBe(false);
    await act(async () => { save.resolve(savedKey); await first; });
  });

  it('clears the parent busy state when unmounted during a pending save', async () => {
    const busy = vi.fn();
    const save = deferred<typeof savedKey>();
    mocks.add.mockReturnValue(save.promise);
    await act(async () => { root.render(<SshKeysSection onBusyChange={busy} />); });
    await typeKey();
    await click(button('Add key'));
    expect(busy).toHaveBeenLastCalledWith(true);
    await act(async () => { root.render(<div>Other step</div>); });
    expect(busy).toHaveBeenLastCalledWith(false);
    const calls = busy.mock.calls.length;
    await act(async () => { save.resolve(savedKey); });
    expect(busy).toHaveBeenCalledTimes(calls);
  });

  it('accepts a public key whose comment contains a private-key header', async () => {
    await act(async () => { root.render(<SshKeysSection />); });
    // Valid public-key fixture from the backend parser tests, with a legal comment.
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBAbYOa2X2cb3APrq0kCH4nqKhJ7K02+SmcLB3Y5DcE2 -----BEGIN RSA PRIVATE KEY-----';
    await typeKey(publicKey);
    expect(input().value).toBe(publicKey);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await click(button('Add key'));
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(publicKey);
  });

  it.each(['OPENSSH', 'RSA', 'ENCRYPTED', ''])('rejects repeated %s private-key pastes without retaining or uploading them', async kind => {
    await act(async () => { root.render(<SshKeysSection />); });
    const header = ['-----BEGIN', kind, 'PRIVATE KEY-----'].filter(Boolean).join(' ');
    for (let attempt = 0; attempt < 3; attempt++) {
      await typeKey(`  ${header}\nnot-a-real-key\n-----END ${kind} PRIVATE KEY-----`);
      expect(input().value).toBe('');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('private key');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('.pub');
      await act(async () => { input().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      expect(mocks.add).not.toHaveBeenCalled();
    }
  });
});
