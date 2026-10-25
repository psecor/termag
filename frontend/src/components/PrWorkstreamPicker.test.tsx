// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrCheckout, PrRow } from '../services/api';
import type { Project } from '../types';
import { PrWorkstreamPicker } from './PrWorkstreamPicker';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../services/api', () => ({
  prsApi: { link: vi.fn(), unlink: vi.fn(), newWorkstream: vi.fn() },
  projectsApi: { list: mocks.list },
}));
vi.mock('../contexts/ProjectContext', () => ({
  useProjects: () => ({ reloadProjects: vi.fn(), setActiveWorkstream: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: the picker keeps its highlighted row in view.
Element.prototype.scrollIntoView = () => {};

const project = (id: string, name: string) => ({
  id, name, archived: false, kind: 'normal', role: 'owner', lastActiveAt: '2026-10-24T00:00:00Z',
  workstreams: [{ name: 'main', archived: false, lastActiveAt: '2026-10-24T00:00:00Z' }],
}) as unknown as Project;

const row = {
  kind: 'pr', lane: 'team_review', repo: 'example-org/terraform', number: 28576, headRefName: 'termag-agent-tunnel-bypass',
  workstream: null, linkedBy: null,
} as unknown as PrRow;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  mocks.list.mockResolvedValue([project('p1', 'termag'), project('p2', 'terraform')]);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function openNewForm(checkouts: PrCheckout[]) {
  root = createRoot(host);
  await act(async () => {
    root!.render(<MemoryRouter><PrWorkstreamPicker row={row} checkouts={checkouts} onChanged={() => {}} onError={() => {}} /></MemoryRouter>);
  });
  await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-pick button')!.click(); });
  await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-new')!.click(); });
}

describe('New workstream for a PR', () => {
  it('warns when no project is known to be a checkout of the PR\'s repository', async () => {
    await openNewForm([{ projectId: 'p1', workstream: 'main', repo: 'example-org/termag' }]);
    expect(host.querySelector('[role="note"]')?.textContent)
      .toBe('No checkout of example-org/terraform known: pick a project on example-org/terraform, or make one (or un-archive it) first.');
  });
  it('offers only the checkout of the repository, without a warning, once one is known', async () => {
    await openNewForm([
      { projectId: 'p1', workstream: 'main', repo: 'example-org/termag' },
      { projectId: 'p2', workstream: 'main', repo: 'example-org/terraform' },
    ]);
    expect(host.querySelector('[role="note"]')).toBeNull();
    expect(host.querySelector('.prs-ws-scope')?.textContent).toBe('in terraform');
  });
});
