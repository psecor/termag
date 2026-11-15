// @vitest-environment jsdom
// lab.opened {from: phone} from /m's ways into Lab (chat/labOpened.ts).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow } from '../../mobile/inbox';

const recorded = vi.hoisted(() => [] as Array<{ name: string; attributes: unknown }>);
vi.mock('../../observability', async importOriginal => ({
  ...(await importOriginal<typeof import('../../observability')>()),
  recordProductEvent: (name: string, attributes: unknown) => { recorded.push({ name, attributes }); },
}));
vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  pushApi: { config: () => Promise.resolve({ enabled: false }) },
}));
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ reloadProjects: vi.fn() }),
}));

import { AppMenu } from './AppMenu';
import { useRowActions } from './SessionRow';

let root: Root;
let host: HTMLDivElement;
let where = '';

function Where() {
  const { pathname, search } = useLocation();
  where = `${pathname}${search}`;
  return null;
}

const row = { projectId: 'p1', projectName: 'web', workstream: 'feat', pinned: false, shared: false, kind: 'project' } as unknown as InboxRow;

function RowMenu() {
  const actions = useRowActions();
  return <><button className="open-row-menu" onClick={() => actions.open(row)}>⋯</button>{actions.sheets}</>;
}

async function show(node: React.ReactNode) {
  await act(async () => root.render(<MemoryRouter initialEntries={['/m']}>{node}<Where /></MemoryRouter>));
}
const press = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
const action = (label: string) => [...document.querySelectorAll('.m-sheet-action')].find(b => b.textContent === label);
const labOpened = () => recorded.filter(r => r.name === 'lab.opened').map(r => r.attributes);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  recorded.length = 0;
  where = '';
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('lab.opened from /m', () => {
  it('is phone from the app menu\'s Lab', async () => {
    await show(<AppMenu />);
    await press(host.querySelector('.m-more'));
    await press(action('Lab'));
    expect(where).toBe('/');
    expect(labOpened()).toEqual([{ 'termag.from': 'phone' }]);
  });

  it('is phone from a session row\'s Open in Lab', async () => {
    await show(<RowMenu />);
    await press(host.querySelector('.open-row-menu'));
    await press(action('Open in Lab'));
    expect(where).toBe('/?project=p1&ws=feat&lab=1');
    expect(labOpened()).toEqual([{ 'termag.from': 'phone' }]);
  });
});
