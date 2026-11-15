// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), add: vi.fn(), credentials: vi.fn(), connectGithub: vi.fn(),
  navigate: vi.fn(), setOnboarded: vi.fn(), updateDotfiles: vi.fn(), event: vi.fn(),
  mcpList: vi.fn(), connectCatalog: vi.fn(), startOAuth: vi.fn(), search: '',
  created: null as null | ((p: { id: string }) => Promise<void> | void),
  user: { email: 'owner@example.com', dotfilesRepoUrl: null as string | null },
}));
vi.mock('../../services/api', () => ({
  sshKeysApi: { list: mocks.list, add: mocks.add },
  credentialsApi: { get: mocks.credentials, connectGithub: mocks.connectGithub },
  mcpConnectorsApi: { list: mocks.mcpList, connectCatalog: mocks.connectCatalog, startOAuth: mocks.startOAuth },
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, setOnboarded: mocks.setOnboarded, updateDotfilesRepoUrl: mocks.updateDotfiles }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate, useLocation: () => ({ search: mocks.search }) }));
vi.mock('../../services/boxFeed', () => ({ boxFeed: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
vi.mock('../../observability', () => ({ recordProductEvent: mocks.event }));
vi.mock('../../components/NewProjectForm', () => ({
  NewProjectForm: (p: { onCreated: (project: { id: string }) => Promise<void> | void }) => {
    mocks.created = p.onCreated;
    return <div>New project form</div>;
  },
}));

import WelcomeRefresh from './WelcomeRefresh';
import { setFlagValues } from '../../flags';

// React Aria's Modal reads a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);

const draft = 'ssh-ed25519 fixture-key owner@example.com';
const savedKey = {
  id: 'key-1', comment: 'owner@example.com', type: 'ssh-ed25519', bits: 256,
  fingerprint: 'SHA256:fixture', createdAt: '2026-10-28T00:00:00Z',
  boxes: { updated: [], pending: [] },
};
const connected = { github: { available: true, connected: { label: '@octocat', orgs: { 'example-org': { status: 'ok' } } }, boxGate: 'clear' } };

let root: Root;
let container: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
const heading = () => document.querySelector('#wel-h')?.textContent;
const dialog = () => document.querySelector('[role="alertdialog"]');
function sshInput(): HTMLInputElement {
  const label = [...document.querySelectorAll('label')].find(l => l.textContent === 'SSH public key');
  const found = label ? document.getElementById(label.htmlFor) as HTMLInputElement | null : null;
  if (!found) throw new Error('SSH key field is not open');
  return found;
}
async function press(el: HTMLElement) { await act(async () => { el.click(); }); }
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openExtras() { await press(button('SSH key and dotfilesOptional')); }

async function remount() {
  await act(async () => { root.unmount(); });
  root = createRoot(container);
  await act(async () => { root.render(<WelcomeRefresh />); });
}

beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.list.mockResolvedValue([]);
  mocks.add.mockResolvedValue(savedKey);
  mocks.credentials.mockResolvedValue(connected);
  mocks.setOnboarded.mockResolvedValue(undefined);
  mocks.created = null;
  mocks.search = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<WelcomeRefresh />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  setFlagValues({});
});

describe('the redrawn first run', () => {
  it('goes GitHub, how you work, start, and ends termag users on New session', async () => {
    expect(heading()).toBe('Connect GitHub');
    expect(document.body.textContent).toContain('Connected as @octocat');
    await press(button('Continue'));
    expect(heading()).toBe('How do you want to work?');
    expect((document.querySelector('input[value="termag"]') as HTMLInputElement).checked).toBe(true);
    await press(button('Continue'));
    expect(heading()).toBe("You're ready");
    await press(button('Start a session'));
    expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    expect(localStorage.getItem('termag-ui-mode')).toBe('simple');
    expect(mocks.navigate).toHaveBeenCalledWith('/chat/new', { replace: true });
  });

  it('opens a Lab user\'s first project in Lab', async () => {
    await press(button('Continue'));
    await press(document.querySelector('input[value="lab"]') as HTMLInputElement);
    await press(button('Continue'));
    expect(heading()).toBe('Start your first project');
    expect(document.body.textContent).toContain('New project form');
    await act(async () => { await mocks.created!({ id: 'p1' }); });
    expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    expect(localStorage.getItem('termag-ui-mode')).toBe('full');
    expect(mocks.navigate).toHaveBeenCalledWith('/?project=p1', { replace: true });
  });

  it('opens each step at its top, not where the last one was scrolled to', async () => {
    const page = document.querySelector('.wel-root') as HTMLDivElement;
    page.scrollTop = 400;
    await press(button('Continue'));
    expect(heading()).toBe('How do you want to work?');
    expect(page.scrollTop).toBe(0);
    page.scrollTop = 300;
    await press(document.querySelector('input[value="lab"]') as HTMLInputElement);
    await press(button('Continue'));
    expect(heading()).toBe('Start your first project');
    expect(page.scrollTop).toBe(0);
  });

  it('starts a skipping user in termag', async () => {
    await press(button('Skip for now'));
    expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    expect(localStorage.getItem('termag-ui-mode')).toBe('simple');
    expect(mocks.navigate).toHaveBeenCalledWith('/chat', { replace: true });
  });

  it('holds the first step while adding a box needs a GitHub token', async () => {
    mocks.credentials.mockResolvedValue({ github: { available: true, boxGate: 'blocked' } });
    await remount();
    expect(button('Continue').disabled).toBe(true);
    expect(document.body.textContent).toContain('Connect GitHub to continue.');
  });

  it('waits for the GitHub check before Continue', async () => {
    let answer!: (v: unknown) => void;
    mocks.credentials.mockReturnValue(new Promise(r => { answer = r; }));
    await remount();
    expect(button('Continue').disabled).toBe(true);
    await act(async () => { answer(connected); });
    expect(button('Continue').disabled).toBe(false);
  });

  it('offers Retry, and keeps Continue off, when the GitHub check fails', async () => {
    mocks.credentials.mockRejectedValueOnce(new Error('network'));
    await remount();
    expect(button('Continue').disabled).toBe(true);
    expect(document.body.textContent).toContain("Couldn't check your GitHub connection.");
    mocks.credentials.mockResolvedValue(connected);
    await press(button('Retry'));
    expect(button('Continue').disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Couldn't check your GitHub connection.");
  });

  it('keeps the SSH key and dotfiles folded away until asked for', async () => {
    const trigger = button('SSH key and dotfilesOptional');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(sshInput().closest('[hidden]')).not.toBeNull();
    await openExtras();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(sshInput().closest('[hidden]')).toBeNull();
    expect(document.body.textContent).toContain('Dotfiles repository');
  });
});

describe('the setup funnel', () => {
  const events = () => mocks.event.mock.calls.map(([name, attrs]) => [name, attrs]);

  it('records each step, the mode chosen and how setup ended', async () => {
    await press(button('Continue'));
    await press(button('Continue'));
    await press(button('Start a session'));
    expect(events()).toEqual([
      ['welcome.viewed', { 'termag.refresh': true, 'termag.firstRun': false }],
      ['welcome.step', { 'termag.step': 'github' }],
      ['welcome.step', { 'termag.step': 'mode' }],
      ['welcome.mode.chosen', { 'termag.mode': 'termag' }],
      ['welcome.step', { 'termag.step': 'start' }],
      ['welcome.finished', { 'termag.mode': 'termag', 'termag.exit': 'session', 'termag.step': 'start' }],
    ]);
  });

  it('records a skip, and the step it came from', async () => {
    await press(button('Skip for now'));
    expect(events().at(-1)).toEqual(['welcome.finished', { 'termag.mode': 'termag', 'termag.exit': 'skip', 'termag.step': 'github' }]);
  });

  it('records a lab project as its own exit', async () => {
    await press(button('Continue'));
    await press(document.querySelector('input[value="lab"]') as HTMLInputElement);
    await press(button('Continue'));
    await act(async () => { await mocks.created!({ id: 'p1' }); });
    expect(events().at(-1)).toEqual(['welcome.finished', { 'termag.mode': 'lab', 'termag.exit': 'project', 'termag.step': 'start' }]);
  });
});

describe('leaving the first step with an SSH key typed', () => {
  beforeEach(async () => {
    await openExtras();
    await type(sshInput(), draft);
  });

  it('asks before Continue, and Keep editing keeps the draft', async () => {
    await press(button('Continue'));
    expect(heading()).toBe('Connect GitHub');
    expect(dialog()?.textContent).toContain('Add key and continue');
    expect(mocks.add).not.toHaveBeenCalled();
    await press(button('Keep editing'));
    expect(dialog()).toBeNull();
    expect(sshInput().value).toBe(draft);
  });

  it('adds the key, then continues', async () => {
    await press(button('Continue'));
    await press(button('Add key and continue'));
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(draft);
    expect(heading()).toBe('How do you want to work?');
  });

  it('stays, with the draft and the error, when the add fails', async () => {
    mocks.add.mockRejectedValueOnce({ response: { data: { error: 'Invalid public key' } } });
    await press(button('Continue'));
    await press(button('Add key and continue'));
    expect(heading()).toBe('Connect GitHub');
    expect(sshInput().value).toBe(draft);
    expect(document.body.textContent).toContain('Invalid public key');
  });

  it('continues without the key only when asked to', async () => {
    await press(button('Continue'));
    await press(button('Continue without it'));
    expect(mocks.add).not.toHaveBeenCalled();
    expect(heading()).toBe('How do you want to work?');
  });

  it('asks before Skip for now too', async () => {
    await press(button('Skip for now'));
    expect(dialog()).not.toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    await press(button('Continue without it'));
    expect(mocks.navigate).toHaveBeenCalledWith('/chat', { replace: true });
  });

  it('counts a key the server already has as added once the list confirms it', async () => {
    mocks.add.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Key SHA256:fixture is already registered' } } });
    mocks.list.mockResolvedValue([savedKey]);
    await press(button('Continue'));
    await press(button('Add key and continue'));
    expect(heading()).toBe('How do you want to work?');
  });

  it('keeps the draft when a duplicate cannot be confirmed in the list', async () => {
    mocks.add.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Key SHA256:fixture is already registered' } } });
    mocks.list.mockResolvedValue([]);
    await press(button('Continue'));
    await press(button('Add key and continue'));
    expect(heading()).toBe('Connect GitHub');
    expect(sshInput().value).toBe(draft);
  });
});

describe('the SSH key field', () => {
  it('clears a private key and never sends it', async () => {
    await openExtras();
    await type(sshInput(), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc');
    expect(sshInput().value).toBe('');
    expect(document.body.textContent).toContain('That looks like a private key.');
    await press(button('Continue'));
    expect(dialog()).toBeNull();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});

describe('the MCP servers step', () => {
  const LD = { name: 'acme-observability', upstream: 'https://mcp.obs.example/mcp' };
  const ACME = { name: 'acme', upstream: 'https://mcp.acme.example/mcp' };
  const ldConnector = {
    id: 'c1', name: 'acme-observability', displayName: 'acme-observability', upstream: LD.upstream, authType: 'oauth',
    headers: {}, secretNames: [], missingSecrets: [], brokerUrl: null, updatedAt: '2026-11-09T00:00:00Z', linkStatus: 'linked',
  };
  const page = (over: Record<string, unknown> = {}) => ({ available: true, storeAvailable: true, connectors: [], catalog: [], ...over });
  const progress = () => [...document.querySelectorAll('.wel-progress-label')].map(l => l.textContent);
  const rows = () => [...document.querySelectorAll('.wel-tool')].map(r => r.textContent);
  async function open(list: unknown, search = '', flag = true) {
    mocks.mcpList.mockResolvedValue(list);
    mocks.search = search;
    setFlagValues({ 'onboarding-mcp-step-enabled': flag });
    await remount();
  }
  async function toMcp() {
    await press(button('Continue'));
    await press(button('Continue'));
  }

  it('comes between how you work and start, in the catalog\'s order, and Skip goes on to start', async () => {
    await open(page({ catalog: [ACME, LD] }));
    expect(progress()).toEqual(['GitHub', 'How you work', 'Tools', 'Start']);
    await toMcp();
    expect(heading()).toBe('Connect your tools');
    expect(rows()[0]).toContain('mcp.acme.example');
    expect(rows()[1]).toContain('acme-observability');
    await press(button('Back'));
    expect(heading()).toBe('How do you want to work?');
    await press(button('Continue'));
    await press(button('Skip'));
    expect(heading()).toBe("You're ready");
    await press(button('Back'));
    expect(heading()).toBe('Connect your tools');
  });

  it('has three steps with the flag off, and does not load the list', async () => {
    await open(page({ catalog: [LD] }), '?step=mcp&server=c1&linked=1', false);
    expect(progress()).toEqual(['GitHub', 'How you work', 'Start']);
    expect(heading()).toBe('Connect GitHub');
    expect(mocks.mcpList).not.toHaveBeenCalled();
    await toMcp();
    expect(heading()).toBe("You're ready");
  });

  it('has three steps when the catalog offers nothing, or only an API provider', async () => {
    await open(page({ catalog: [{ name: 'google', upstream: 'https://api.example', kind: 'api' }] }));
    expect(progress()).toEqual(['GitHub', 'How you work', 'Start']);
  });

  it('has three steps when the list cannot be loaded', async () => {
    mocks.search = '';
    setFlagValues({ 'onboarding-mcp-step-enabled': true });
    mocks.mcpList.mockRejectedValue(new Error('down'));
    await remount();
    expect(progress()).toEqual(['GitHub', 'How you work', 'Start']);
  });

  it('connects a server with the sign-in returning to the wizard', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      await open(page({ catalog: [LD] }));
      await toMcp();
      mocks.connectCatalog.mockResolvedValue({ id: 'c1', authorizeUrl: 'https://auth.obs.example/authorize', connector: { ...ldConnector, linkStatus: 'needs_link' } });
      await press(button('Connect'));
      expect(mocks.connectCatalog).toHaveBeenCalledWith('acme-observability', { chooseScopes: true, returnTo: 'welcome' });
      expect(assign).toHaveBeenCalledWith('https://auth.obs.example/authorize');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reopens on the step after a sign-in with the server connected, and Continue goes to start', async () => {
    await open(page({ connectors: [ldConnector] }), '?step=mcp&server=c1&linked=1');
    expect(heading()).toBe('Connect your tools');
    expect(progress()).toEqual(['GitHub', 'How you work', 'Tools', 'Start']);
    expect(document.body.textContent).toContain('acme-observability is connected.');
    expect(rows()[0]).toContain('Connected');
    await press(button('Continue'));
    expect(heading()).toBe("You're ready");
    await press(button('Start a session'));
    expect(mocks.navigate).toHaveBeenCalledWith('/chat/new', { replace: true });
  });

  it('shows a failed sign-in with Retry, which signs in again', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      await open(page({ connectors: [{ ...ldConnector, linkStatus: 'needs_link' }] }), '?step=mcp&server=c1&error=The+server+did+not+grant+access');
      expect(heading()).toBe('Connect your tools');
      expect(document.body.textContent).toContain('The server did not grant access');
      mocks.startOAuth.mockResolvedValue('https://auth.obs.example/again');
      await press(button('Retry'));
      expect(mocks.startOAuth).toHaveBeenCalledWith('c1', undefined, 'welcome');
      expect(assign).toHaveBeenCalledWith('https://auth.obs.example/again');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers Skip, not Continue, when no connected server is a usable MCP server', async () => {
    const staticMissing = { ...ldConnector, id: 'c2', name: 'acme', authType: 'static', linkStatus: undefined, secretNames: ['token'], missingSecrets: ['token'] };
    const apiLinked = { ...ldConnector, id: 'c3', name: 'google', kind: 'api' };
    await open(page({ catalog: [LD], connectors: [staticMissing, apiLinked] }));
    await toMcp();
    expect(heading()).toBe('Connect your tools');
    expect(() => button('Continue')).toThrow();
    await press(button('Skip'));
    expect(heading()).toBe("You're ready");
  });

  it('shows a failed load with Retry on the return from a sign-in', async () => {
    mocks.search = '?step=mcp&server=c1&linked=1';
    setFlagValues({ 'onboarding-mcp-step-enabled': true });
    mocks.mcpList.mockRejectedValueOnce(new Error('down'));
    mocks.mcpList.mockResolvedValue(page({ connectors: [ldConnector] }));
    await remount();
    expect(heading()).toBe('Connect your tools');
    expect(document.body.textContent).toContain("Couldn't load MCP servers.");
    await press(button('Retry'));
    expect(rows()[0]).toContain('Connected');
  });
});
