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
  mcpList: vi.fn(), connectCatalog: vi.fn(), startOAuth: vi.fn(),
  search: '',
  // onboarding-mcp-step-enabled.
  mcpStep: false,
}));
vi.mock('../flags', async importOriginal => ({
  ...(await importOriginal<typeof import('../flags')>()),
  useFlag: (key: string, fallback: unknown) => (key === 'onboarding-mcp-step-enabled' ? mocks.mcpStep : fallback),
}));
vi.mock('../services/api', () => ({
  sshKeysApi: { list: mocks.list, add: mocks.add, remove: mocks.remove },
  credentialsApi: { get: mocks.credentials },
  mcpConnectorsApi: { list: mocks.mcpList, connectCatalog: mocks.connectCatalog, startOAuth: mocks.startOAuth },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, setOnboarded: mocks.setOnboarded }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate, useLocation: () => ({ search: mocks.search }) }));
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
const ACME = { name: 'acme', upstream: 'https://mcp.acme.example/mcp' };
const mcpPage = (over: object) => ({ available: true, storeAvailable: true, connectors: [], catalog: [], ...over });
const acmeConnector = {
  id: 'c1', name: 'acme', upstream: ACME.upstream, authType: 'oauth', headers: {}, secretNames: [], missingSecrets: [],
  brokerUrl: null, updatedAt: '2026-11-04T00:00:00Z', linkStatus: 'linked', linkError: null, oauth: null,
};

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
  mocks.mcpList.mockResolvedValue(mcpPage({}));
  mocks.search = '';
  mocks.mcpStep = false;
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
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBAbYOa2X2cb3APrq0kCH4nqKhJ7K02+SmcLB3Y5DcE2 -----BEGIN RSA PRIVATE KEY-----'; // gitleaks:allow (a public key with a header in its comment)
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

describe('wizard MCP servers step', () => {
  // Renders the wizard again with the MCP list, the URL's query and the flag set first.
  async function rerender(list: object, search = '', flag = true) {
    await act(async () => { root.unmount(); });
    mocks.mcpList.mockResolvedValue(list);
    mocks.search = search;
    mocks.mcpStep = flag;
    root = createRoot(container);
    await act(async () => { root.render(<Welcome />); });
  }
  const stepTitles = () => [...document.querySelectorAll('.wiz-step-t')].map(e => e.textContent);
  const available = () => document.querySelector('[aria-label="Available to connect"]');

  it('has no MCP step with onboarding-mcp-step-enabled off, even when the catalog offers a server', async () => {
    await rerender(mcpPage({ catalog: [ACME] }), '', false);
    expect(stepTitles()).toEqual(['Your laptop SSH key', 'GitHub', 'Dotfiles', 'Your first box and project']);
    expect(mocks.mcpList).not.toHaveBeenCalled();
    // A sign-in's return to ?step=mcp opens on the first step, as without the step.
    await rerender(mcpPage({ catalog: [ACME] }), '?step=mcp&server=c1&linked=1', false);
    expect(stepTitles()).not.toContain('MCP servers');
    expect(stepTitle()).toContain('Your laptop SSH key');
  });

  it('has no MCP step when the catalog is empty (mcp-default-connectors off or [])', async () => {
    await rerender(mcpPage({}));
    expect(stepTitles()).toEqual(['Your laptop SSH key', 'GitHub', 'Dotfiles', 'Your first box and project']);
    await rerender(mcpPage({ catalog: undefined }));
    expect(stepTitles()).not.toContain('MCP servers');
  });

  it('has no MCP step when the catalog offers only API providers, which are not MCP servers', async () => {
    await rerender(mcpPage({ catalog: [{ name: 'google', upstream: 'https://www.googleapis.com', kind: 'api' }] }));
    expect(stepTitles()).not.toContain('MCP servers');
  });

  it('does not mark the MCP step done when it arrives after the person has moved past it', async () => {
    await act(async () => { root.unmount(); });
    const list = deferred<object>();
    mocks.mcpList.mockReturnValue(list.promise);
    mocks.mcpStep = true;
    root = createRoot(container);
    await act(async () => { root.render(<Welcome />); });
    // The Project tab, before GET /api/mcp-connectors answers.
    await click([...document.querySelectorAll<HTMLButtonElement>('.wiz-steps button')][3]);
    expect(stepTitle()).toContain('Your first box and project');
    await act(async () => { list.resolve(mcpPage({ catalog: [ACME] })); });
    const mcpTab = [...document.querySelectorAll('.wiz-step')].find(li => li.textContent?.includes('MCP servers'))!;
    expect(mcpTab.classList.contains('is-done')).toBe(false);
    expect(mcpTab.querySelector('.wiz-step-n')?.textContent).toBe('4');
    expect(stepTitle()).toBe('Step 5 of 5: Your first box and project');
  });

  it('says so with a Retry when the list fails on the return from a sign-in, rather than loading forever', async () => {
    await act(async () => { root.unmount(); });
    mocks.mcpList.mockRejectedValueOnce({ response: { data: { error: 'network down' } } });
    mocks.mcpList.mockResolvedValue(mcpPage({ connectors: [acmeConnector] }));
    mocks.search = '?step=mcp&server=c1&linked=1';
    mocks.mcpStep = true;
    Element.prototype.scrollIntoView = vi.fn();
    root = createRoot(container);
    await act(async () => { root.render(<Welcome />); });
    expect(stepTitle()).toContain('MCP servers');
    expect(document.body.textContent).not.toContain('Loading…');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('network down');
    await click(button('Retry'));
    expect(mocks.mcpList).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-label="Your servers"]')?.textContent).toContain('acme');
  });

  it('warns that boxes don\'t get the servers when the orchestrator has no MCP broker, and doesn\'t promise agents can use one', async () => {
    await rerender(mcpPage({ available: false, connectors: [acmeConnector], catalog: [ACME] }), '?step=mcp&server=c1&linked=1');
    expect(document.body.textContent).toContain("No MCP broker is set up on this orchestrator yet, so boxes don't get these servers.");
    expect(document.body.textContent).not.toContain('Your agents can use it now');
  });

  it('has no MCP step when the list cannot be loaded', async () => {
    await act(async () => { root.unmount(); });
    mocks.mcpList.mockRejectedValue(new Error('down'));
    mocks.mcpStep = true;
    root = createRoot(container);
    await act(async () => { root.render(<Welcome />); });
    expect(stepTitles()).not.toContain('MCP servers');
    expect(stepTitle()).toContain('Your laptop SSH key');
  });

  it('shows the step between Dotfiles and Project with the flag on and a server in the catalog, with its Connect', async () => {
    await rerender(mcpPage({ catalog: [ACME] }));
    expect(stepTitles()).toEqual(['Your laptop SSH key', 'GitHub', 'Dotfiles', 'MCP servers', 'Your first box and project']);
    await click([...document.querySelectorAll<HTMLButtonElement>('.wiz-steps button')][3]);
    expect(stepTitle()).toBe('Step 4 of 5: MCP servers');
    expect(available()?.textContent).toContain('acme');
    expect(document.body.textContent).toContain('Optional. You can finish it later in Settings.');
    await click(button('Next'));
    expect(stepTitle()).toContain('Your first box and project');
  });

  it('starts the sign-in with returnTo welcome, so the callback comes back here', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      await rerender(mcpPage({ catalog: [ACME] }), '?step=mcp');
      mocks.connectCatalog.mockResolvedValue({ id: 'c1', authorizeUrl: 'https://auth.acme.example/authorize', connector: { ...acmeConnector, linkStatus: 'needs_link' } });
      await click([...available()!.querySelectorAll('button')].find(b => b.textContent === 'Connect')!);
      expect(mocks.connectCatalog).toHaveBeenCalledWith('acme', { chooseScopes: true, returnTo: 'welcome' });
      expect(assign).toHaveBeenCalledWith('https://auth.acme.example/authorize');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reopens on the MCP step after a sign-in, with that server connected, even once the catalog is empty', async () => {
    // The returned server's row scrolls into view; jsdom has no layout.
    Element.prototype.scrollIntoView = vi.fn();
    await rerender(mcpPage({ connectors: [acmeConnector] }), '?step=mcp&server=c1&linked=1');
    expect(stepTitle()).toBe('Step 4 of 5: MCP servers');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('acme is connected.');
    const yours = document.querySelector('[aria-label="Your servers"]');
    expect(yours?.textContent).toContain('acme');
    expect(yours?.textContent).toContain('Re-link');
    expect(available()).toBeNull();
  });

  it('shows a sign-in error on the step', async () => {
    await rerender(mcpPage({ catalog: [ACME] }), '?step=mcp&server=c1&error=The+server+did+not+grant+access');
    expect(stepTitle()).toContain('MCP servers');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The server did not grant access');
  });

  it('keeps Skip setup working from the MCP step', async () => {
    await rerender(mcpPage({ catalog: [ACME] }), '?step=mcp');
    await click(button('Skip setup'));
    expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
  });
});
