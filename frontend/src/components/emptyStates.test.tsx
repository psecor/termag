// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentRow } from '../services/api';
import { RecentsDropdown } from './RecentsDropdown';
import { SshKeysSection } from '../pages/settings/SshKeysSection';
import { CliDevicesSection } from '../pages/settings/CliDevicesSection';

const mocks = vi.hoisted(() => ({
  sshList: vi.fn(), cliList: vi.fn(), recents: { rows: [] as RecentRow[] | null },
}));
vi.mock('../services/api', () => ({
  sshKeysApi: { list: mocks.sshList, add: vi.fn(), remove: vi.fn() },
  cliDevicesApi: { list: mocks.cliList, revoke: vi.fn() },
}));
vi.mock('../hooks/useRecents', () => ({
  useRecents: () => ({ rows: mocks.recents.rows, refresh: vi.fn() }),
}));
vi.mock('../contexts/ProjectContext', () => ({
  useProjects: () => ({
    projects: [], activeProjectId: null,
    setActiveProject: vi.fn(), setActiveWorkstream: vi.fn(), getActiveWorkstream: () => 'main',
  }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const text = () => document.body.textContent ?? '';
const row = (i: number): RecentRow => ({
  projectId: `p${i}`, projectName: `project-${i}`, workstream: 'main', owner: 'ada', access: 'owner',
  instanceId: null, archived: false, lastVisitedAt: '2026-10-14T00:00:00Z', status: 'idle',
  statusUpdatedAt: null, lastActiveAt: '2026-10-14T00:00:00Z', provider: null,
});

describe('settings empty states', () => {
  it('points to the add form when there are no SSH keys', async () => {
    mocks.sshList.mockResolvedValue([]);
    await act(async () => { root.render(<SshKeysSection />); });
    expect(text()).toContain('No SSH keys yet. Add a public key below');
  });

  it('does not suggest adding a key when the key list failed to load', async () => {
    mocks.sshList.mockRejectedValue(new Error('boom'));
    await act(async () => { root.render(<SshKeysSection />); });
    expect(text()).toContain('Failed to load SSH keys');
    expect(text()).not.toContain('No SSH keys yet');
  });

  it('keeps the SSH key hint hidden after a failed load error is dismissed', async () => {
    mocks.sshList.mockRejectedValue(new Error('boom'));
    await act(async () => { root.render(<SshKeysSection />); });
    await act(async () => { document.querySelector<HTMLButtonElement>('.error-banner button')!.click(); });
    expect(text()).not.toContain('Failed to load SSH keys');
    expect(text()).not.toContain('No SSH keys yet');
  });

  it('keeps the SSH key hint when an unrelated paste error shows on an empty list', async () => {
    mocks.sshList.mockResolvedValue([]);
    await act(async () => { root.render(<SshKeysSection />); });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="SSH public key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '-----BEGIN OPENSSH PRIVATE KEY-----');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(text()).toContain('That looks like a private key');
    expect(text()).toContain('No SSH keys yet. Add a public key below');
  });

  it('keeps the CLI device hint hidden after a failed load error is dismissed', async () => {
    mocks.cliList.mockRejectedValue(new Error('boom'));
    await act(async () => { root.render(<CliDevicesSection />); });
    await act(async () => { document.querySelector<HTMLButtonElement>('.error-banner button')!.click(); });
    expect(text()).not.toContain('Failed to load CLI sign-ins');
    expect(text()).not.toContain('No devices signed in');
  });

  it('points to termag login when no CLI device is signed in', async () => {
    mocks.cliList.mockResolvedValue([]);
    await act(async () => { root.render(<CliDevicesSection />); });
    expect(text()).toContain('No devices signed in. To add one, run termag login on a laptop.');
  });

  it('does not suggest signing in when the device list failed to load', async () => {
    mocks.cliList.mockRejectedValue(new Error('boom'));
    await act(async () => { root.render(<CliDevicesSection />); });
    expect(text()).toContain('Failed to load CLI sign-ins');
    expect(text()).not.toContain('No devices signed in');
  });
});

describe('Recents dropdown empty states', () => {
  async function openDropdown() {
    await act(async () => { root.render(<RecentsDropdown />); });
    const trigger = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Recents'))!;
    await act(async () => { trigger.click(); });
  }
  async function filter(value: string) {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Filter recent sessions"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('says nothing matches when a filter hides every session', async () => {
    mocks.recents.rows = Array.from({ length: 11 }, (_, i) => row(i));
    await openDropdown();
    const all = [...document.querySelectorAll('button')].find(b => b.textContent === 'all')!;
    await act(async () => { all.click(); });
    await filter('  nope  ');
    expect(text()).toContain('No recent sessions match “nope”.');
    expect(text()).not.toContain('No sessions visited yet');
  });

  it('suggests selecting a project when there is no history', async () => {
    mocks.recents.rows = [];
    await openDropdown();
    expect(text()).toContain('No sessions visited yet. Select a project and it shows up here.');
  });
});
