// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxLifecycle, Instance } from '../types';

const mocks = vi.hoisted(() => ({ setLifecycle: vi.fn() }));
vi.mock('../services/api', () => ({ instancesApi: { setLifecycle: mocks.setLifecycle } }));

import { BoxLifecycleDialog } from './BoxLifecycleDialog';

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const lc = (over: Partial<BoxLifecycle> = {}): BoxLifecycle => ({
  canAutoHibernate: true, idleHibernateHours: null, hibernatedTerminateDays: null, hibernateDueAt: null,
  terminateDueAt: null, parkedAt: null, unsavedWork: null, note: null, warning: null, ...over,
});
const boxWith = (lifecycle: BoxLifecycle) => ({ id: 'b1', name: 'olive', kind: 'ec2', status: 'ready', lifecycle }) as unknown as Instance;
const render = (lifecycle: BoxLifecycle) => act(() => root.render(<BoxLifecycleDialog box={boxWith(lifecycle)} onClose={() => {}} onSaved={() => {}} />));
function choose(id: string, value: string) {
  const select = el.querySelector(`#${id}`) as HTMLSelectElement;
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
const button = (label: string) => [...el.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement;

beforeEach(() => {
  mocks.setLifecycle.mockReset();
  mocks.setLifecycle.mockResolvedValue({});
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Auto-park dialog', () => {
  it('offers Stop when idle and Terminate once parked, with no hibernate wording, on a box that can hibernate', () => {
    render(lc({ idleHibernateHours: 1, hibernatedTerminateDays: 1 }));
    expect(el.textContent).toContain('Stop when idle');
    expect(el.textContent).toContain('Terminate once parked');
    expect(el.textContent).toContain('After 1 day parked');
    expect(el.textContent).not.toMatch(/hibernat|Include RAM/i);
  });

  it('saves the hours and days chosen on a box that cannot hibernate, with no cannot-hibernate warning', async () => {
    render(lc({ canAutoHibernate: false }));
    expect(el.textContent).not.toMatch(/can't hibernate/);
    choose('lc-stop', '4');
    choose('lc-terminate', '7');
    act(() => { button('Save').click(); });
    await flush();
    expect(mocks.setLifecycle).toHaveBeenCalledWith('b1', { idleHibernateHours: 4, hibernatedTerminateDays: 7 });
  });
});
