// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tabs' own pages fetch; only the route table is under test here.
const { tab } = vi.hoisted(() => ({ tab: (name: string) => () => <div data-testid="tab">{name}</div> }));
vi.mock('./admin/AdminOverview', () => ({ AdminOverview: tab('overview') }));
vi.mock('./admin/AdminFleet', () => ({ AdminFleet: tab('fleet') }));
vi.mock('./admin/AdminSegments', () => ({ AdminSegments: tab('segments') }));
vi.mock('./admin/AdminUsers', () => ({ AdminUsers: tab('users') }));
vi.mock('./admin/AdminProjects', () => ({ AdminProjects: tab('projects') }));
vi.mock('./admin/AdminUsage', () => ({ AdminUsage: tab('usage') }));
vi.mock('./admin/AdminSystem', () => ({ AdminSystem: tab('system') }));
vi.mock('./admin/AdminCloud', () => ({ AdminCloud: tab('cloud') }));
vi.mock('./admin/AdminSettings', () => ({ AdminSettings: tab('settings') }));
vi.mock('./admin/AdminSoftware', () => ({ AdminSoftware: tab('software') }));
vi.mock('./admin/AdminPrs', () => ({ AdminPrs: tab('prs') }));
vi.mock('./admin/AdminSpend', () => ({ AdminSpend: tab('spend') }));
vi.mock('./dashboard/RangePicker', () => ({ RangePicker: () => null }));
const auth = vi.hoisted(() => ({ user: { role: 'admin' } as { role: string } | null }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

import Admin from './Admin';

let root: Root;
let el: HTMLDivElement;

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}

// App.tsx mounts Admin the same way: a splat route, its own <Routes> inside.
function mount(path: string) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<Admin />} />
        <Route path="/dashboard" element={<div data-testid="tab">dashboard</div>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  ));
}

const where = () => el.querySelector('[data-testid="where"]')?.textContent;
const shown = () => el.querySelector('[data-testid="tab"]')?.textContent;
const click = (label: string) => {
  const link = [...el.querySelectorAll('a')].find(a => a.textContent === label);
  if (!link) throw new Error(`no link ${label}`);
  act(() => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
};

beforeEach(() => { auth.user = { role: 'admin' }; localStorage.clear(); });
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Admin routes (v7 path resolution)', () => {
  it('sends an unknown tab back to the overview', () => {
    mount('/admin/no-such-tab');
    expect(where()).toBe('/admin');
    expect(shown()).toBe('overview');
  });

  it('also catches a deeper unknown path', () => {
    mount('/admin/fleet/extra/segments');
    expect(where()).toBe('/admin');
    expect(shown()).toBe('overview');
  });

  it('opens a tab from its URL', () => {
    mount('/admin/fleet?box=i-1');
    expect(where()).toBe('/admin/fleet?box=i-1');
    expect(shown()).toBe('fleet');
  });

  it('moves between tabs with the nav links, back to the overview too', () => {
    mount('/admin/users');
    expect(shown()).toBe('users');
    click('Cloud sessions');
    expect(where()).toBe('/admin/cloud');
    expect(shown()).toBe('cloud');
    click('Overview');
    expect(where()).toBe('/admin');
    expect(shown()).toBe('overview');
  });

  it('marks only the current tab active, Overview included', () => {
    mount('/admin/spend');
    const active = [...el.querySelectorAll('nav a.active')].map(a => a.textContent);
    expect(active).toEqual(['Spend']);
    click('Overview');
    expect([...el.querySelectorAll('nav a.active')].map(a => a.textContent)).toEqual(['Overview']);
  });

  it('sends a non-admin to the dashboard', () => {
    auth.user = { role: 'member' };
    mount('/admin/fleet');
    expect(where()).toBe('/dashboard');
    expect(shown()).toBe('dashboard');
  });
});
