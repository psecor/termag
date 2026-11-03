// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../types';
import type { BoxResizeInfo, ResizeView } from '../utils/boxResize';

const mocks = vi.hoisted(() => ({ resizeInfo: vi.fn(), resize: vi.fn() }));
vi.mock('../services/api', () => ({ instancesApi: { resizeInfo: mocks.resizeInfo, resize: mocks.resize } }));

const { BoxResizeDialog } = await import('./BoxResizeDialog');

const SIZES = [
  { size: 'small' as const, vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
  { size: 'medium' as const, vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
  { size: 'large' as const, vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
];
const info = (over: Partial<BoxResizeInfo> = {}, box: Partial<BoxResizeInfo['box']> = {}): BoxResizeInfo => ({
  box: { id: 'b1', name: 'olive', status: 'ready', size: 'small', instanceType: 'm8g.large', hibernationConfigured: false, ...box },
  sizes: SIZES, resize: null, refusal: null, blockers: [], ...over,
});
const running = (phase: ResizeView['phase']): ResizeView => ({
  to: 'medium', from: 'small', phase, running: true, startedAt: '2026-10-28T12:00:00Z', finishedAt: null, error: null, byAdmin: false, reason: null,
});

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;
const box = { id: 'b1', name: 'olive', kind: 'ec2', status: 'ready' } as unknown as Instance;
async function open() {
  await act(async () => root.render(<BoxResizeDialog box={box} onClose={() => {}} onChanged={() => {}} />));
  await flush();
}

beforeEach(() => {
  mocks.resizeInfo.mockReset();
  mocks.resize.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('the full UI Size… dialog', () => {
  it('lists the sizes in the standard select, the current one marked, with the downtime warning', async () => {
    mocks.resizeInfo.mockResolvedValue(info());
    await open();
    const options = [...document.querySelectorAll('#box-resize-size option')].map(o => o.textContent);
    expect(options).toEqual(['Small · 2 vCPU, 8 GB RAM (current)', 'Medium · 4 vCPU, 16 GB RAM', 'Large · 8 vCPU, 32 GB RAM']);
    expect((document.querySelector('#box-resize-size') as HTMLSelectElement).value).toBe('medium');
    expect(document.body.textContent).toContain('Now: Small · 2 vCPU, 8 GB RAM');
    expect(document.querySelector('.dialog-title')?.textContent).toBe('Resize “olive”');
    expect(document.body.textContent).toMatch(/two to three minutes/);
  });

  it('sends the pick and shows the progress', async () => {
    mocks.resizeInfo.mockResolvedValue(info());
    mocks.resize.mockResolvedValue({ resize: running('stopping') });
    await open();
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.resize).toHaveBeenCalledWith('b1', 'medium', true);
    const steps = [...document.querySelectorAll('.box-resize-steps li')].map(li => `${li.getAttribute('data-state')}:${li.textContent}`);
    expect(steps).toEqual(['current:Stopping…', 'todo:Changing its instance type', 'todo:Starting, waiting for its agent', 'todo:Running at the new size']);
    expect(document.body.textContent).toContain('the resize carries on');
  });

  it('a busy box: one warning, and Resize goes ahead, confirmed, with no second notice', async () => {
    const blockers = [{ check: 'ssh', reason: 'an SSH or SSM session is open to it', forceable: true }];
    mocks.resizeInfo.mockResolvedValue(info({ blockers }));
    mocks.resize.mockResolvedValueOnce({ resize: running('stopping') });
    await open();
    expect(document.querySelectorAll('.box-lifecycle-warning')).toHaveLength(1);
    expect(document.querySelector('.box-lifecycle-warning')!.textContent)
      .toBe("The box stops for two to three minutes while it's resized. Anything running on it stops too: agent turns, terminals, dev servers.");
    expect(document.body.textContent).not.toMatch(/SSH|Right now|Confirm \(force\)/);
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.resize).toHaveBeenCalledTimes(1);
    expect(mocks.resize).toHaveBeenCalledWith('b1', 'medium', true);
    expect(button('Resize anyway')).toBeUndefined();
    expect(document.querySelector('.box-resize-steps')).not.toBe(null);
  });

  it('a claim in flight still refuses: its reason shows as the error', async () => {
    mocks.resizeInfo.mockResolvedValue(info());
    mocks.resize.mockRejectedValue({ response: { status: 409, data: {
      code: 'box_busy', forceable: false, error: "Can't resize this box right now: it is still being set up.", blockers: [],
    } } });
    await open();
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(document.querySelector('.error-text')?.textContent).toContain("Can't resize this box right now");
    expect(button('Resize anyway')).toBeUndefined();
  });

  it('a larger size that costs hibernation says so in the same one warning', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { hibernationConfigured: true }));
    await open();
    expect(document.querySelectorAll('.box-lifecycle-warning')).toHaveLength(1);
    expect(document.querySelector('.box-lifecycle-warning')!.textContent).toMatch(/while it's resized.*can no longer hibernate/);
  });

  it('opens on the progress of a resize already running, and shows the outcome once it is done', async () => {
    mocks.resizeInfo.mockResolvedValueOnce(info({ resize: running('starting') }));
    await open();
    expect([...document.querySelectorAll('.box-resize-steps li')].map(li => li.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'todo']);
    expect(button('Close')).toBeDefined();
  });

  it('reopened mid-resize, follows the steps for the status the resize started from, not the live row', async () => {
    const steps = () => [...document.querySelectorAll('.box-resize-steps li')].map(li => `${li.getAttribute('data-state')}:${li.textContent}`);
    // A running box, stopped for its retype: the live row says stopped, but it comes back up.
    mocks.resizeInfo.mockResolvedValueOnce(info({ resize: { ...running('resizing'), fromStatus: 'ready' } }, { status: 'stopped' }));
    await open();
    expect(steps()).toEqual(['done:Stopping', 'current:Changing its instance type…', 'todo:Starting, waiting for its agent', 'todo:Running at the new size']);
    act(() => root.unmount());
    root = createRoot(el);
    // A hibernated box, past its resume: the live row says stopping.
    mocks.resizeInfo.mockResolvedValueOnce(info({ resize: { ...running('stopping'), fromStatus: 'hibernated' } }, { status: 'stopping' }));
    await open();
    expect(steps()).toEqual(['done:Resuming it from hibernation', 'current:Stopping…', 'todo:Changing its instance type', 'todo:Resized, and left stopped']);
  });

  it("after Resize, follows the server's fromStatus, not the status the dialog loaded", async () => {
    // Loaded running; hibernated (by hand, elsewhere) before Resize was pressed.
    mocks.resizeInfo.mockResolvedValue(info());
    mocks.resize.mockResolvedValueOnce({ resize: { ...running('resuming'), fromStatus: 'hibernated' } });
    await open();
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect([...document.querySelectorAll('.box-resize-steps li')].map(li => li.textContent))
      .toEqual(['Resuming it from hibernation…', 'Stopping', 'Changing its instance type', 'Resized, and left stopped']);
  });

  it('a refusal disables Resize and says why', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ refusal: { status: 409, code: 'box_changing', error: 'This box is starting; resize it once it is running, stopped or hibernated' } }));
    await open();
    expect(document.body.textContent).toContain('This box is starting');
    expect(button('Resize')!.disabled).toBe(true);
  });

  it('a stopped box: the warning says it stays stopped', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { status: 'stopped' }));
    await open();
    expect(document.body.textContent).toContain('stays stopped');
  });
});
