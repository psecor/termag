// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../types';
import type { BoxResizeInfo, DiskView, GrowView, ResizeView } from '../utils/boxResize';

const mocks = vi.hoisted(() => ({ resizeInfo: vi.fn(), resize: vi.fn(), growDisk: vi.fn() }));
vi.mock('../services/api', () => ({ instancesApi: { resizeInfo: mocks.resizeInfo, resize: mocks.resize, growDisk: mocks.growDisk } }));

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
  mocks.growDisk.mockReset();
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

describe('the full UI dialog\'s disk', () => {
  const disk = (over: Partial<DiskView> = {}): DiskView => ({ sizeGb: 120, maxGb: 300, refusal: null, grow: null, retry: null, ...over });
  const growing = (over: Partial<GrowView> = {}): GrowView => ({
    fromGb: 120, toGb: 200, state: 'modifying', running: true, detail: null, startedAt: '2026-11-03T12:00:00Z', finishedAt: null, ...over,
  });
  const diskInput = () => document.querySelector('#box-resize-disk') as HTMLInputElement;

  it('a grow whose file system step failed: offers finishing it at the same size, inside the six hours too (Devin on #1214)', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ disk: disk({
      sizeGb: 200, refusal: 'EBS allows one change to a disk every six hours. This one was last changed at 2026-11-03 11:30 UTC, so it can grow again after 2026-11-03 17:30 UTC.',
      grow: growing({ state: 'failed', running: false, detail: 'the agent went away' }), retry: { sizeGb: 200, error: 'the agent went away' },
    }) }));
    mocks.growDisk.mockResolvedValue({ grow: growing({ fromGb: 200, toGb: 200, state: 'filesystem' }) });
    await open();
    expect(document.body.textContent).toContain('The disk is 200 GB, but its file system was not grown into it: the agent went away');
    await act(async () => { button('Finish growing the disk')!.click(); });
    await flush();
    expect(mocks.growDisk).toHaveBeenCalledWith('b1', 200);
    expect(mocks.resize).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('.box-resize-steps li')].map(li => li.getAttribute('data-state'))).toEqual(['done', 'current']);
  });
  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(diskInput(), value);
      diskInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const warning = () => document.querySelector('.box-lifecycle-warning')?.textContent ?? '';

  it('a grow that fails while the dialog follows it offers finishing it there (Devin on #1214)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.resizeInfo.mockResolvedValueOnce(info({ disk: disk() }));
      mocks.growDisk.mockResolvedValue({ grow: growing() });
      await open();
      await type('200');
      mocks.resizeInfo.mockResolvedValue(info({ disk: disk({
        sizeGb: 200, grow: growing({ state: 'failed', running: false, detail: 'growpart: FAILED' }), retry: { sizeGb: 200, error: 'growpart: FAILED' },
      }) }));
      await act(async () => { button('Resize')!.click(); });
      await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await flush();
      expect(document.body.textContent).toContain('The disk grow failed: growpart: FAILED');
      mocks.growDisk.mockResolvedValue({ grow: growing({ fromGb: 200, toGb: 200, state: 'filesystem' }) });
      await act(async () => { button('Finish growing the disk')!.click(); });
      await flush();
      expect(mocks.growDisk).toHaveBeenLastCalledWith('b1', 200);
    } finally { vi.useRealTimers(); }
  });

  it('shows the disk beside the type, starts on no change, and grows only, up to the cap', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ disk: disk() }));
    await open();
    expect(document.body.textContent).toContain('Now: Small · 2 vCPU, 8 GB RAM · 120 GB disk');
    expect((document.querySelector('#box-resize-size') as HTMLSelectElement).value).toBe('small');
    expect(diskInput().value).toBe('120');
    expect(diskInput().min).toBe('120');
    expect(diskInput().max).toBe('300');
    expect(button('Resize')!.disabled).toBe(true);
  });

  it('a disk alone: no stop in the warning, grows it, and shows the grow\'s progress', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ disk: disk() }));
    mocks.growDisk.mockResolvedValue({ grow: growing() });
    await open();
    await type('200');
    expect(warning()).toBe("Growing the disk doesn't stop the box. A disk never shrinks, and EBS allows one change to it every six hours.");
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.growDisk).toHaveBeenCalledWith('b1', 200);
    expect(mocks.resize).not.toHaveBeenCalled();
    const steps = [...document.querySelectorAll('.box-resize-steps li')].map(li => `${li.getAttribute('data-state')}:${li.textContent}`);
    expect(steps).toEqual(['current:Growing the disk to 200 GB…', 'todo:Growing its file system']);
    expect(button('Close')).toBeDefined();
  });

  it('size and disk in one go: the disk first, then the resize, which waits for it', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ disk: disk() }));
    mocks.growDisk.mockResolvedValue({ grow: growing() });
    mocks.resize.mockResolvedValue({ resize: { ...running('disk'), fromStatus: 'ready' } });
    await open();
    await act(async () => {
      const select = document.querySelector('#box-resize-size') as HTMLSelectElement;
      select.value = 'large';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type('200');
    expect(warning()).toMatch(/two to three minutes.*The disk grows first, with the box up/);
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.growDisk.mock.invocationCallOrder[0]).toBeLessThan(mocks.resize.mock.invocationCallOrder[0]);
    expect(mocks.resize).toHaveBeenCalledWith('b1', 'large', true);
    expect([...document.querySelectorAll('.box-resize-steps li')].map(li => li.textContent)).toContain('Waiting for the disk to grow…');
  });

  it('says EBS\'s six-hour refusal plainly, and resizes nothing', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ disk: disk() }));
    mocks.growDisk.mockRejectedValue({ response: { status: 409, data: { code: 'disk_cooldown', error: 'EBS allows one change to a disk every six hours. This one was last changed at 2026-11-03 10:00 UTC, so it can grow again after 2026-11-03 16:00 UTC.' } } });
    await open();
    await act(async () => {
      const select = document.querySelector('#box-resize-size') as HTMLSelectElement;
      select.value = 'large';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type('200');
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(document.querySelector('.error-text')?.textContent).toMatch(/can grow again after 2026-11-03 16:00 UTC/);
    expect(mocks.resize).not.toHaveBeenCalled();
  });

  it('a disk that can\'t grow now: the field is disabled with why, and the size still changes', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ disk: disk({ refusal: 'the box is stopped; start it first (its agent grows the file system)' }) }, { status: 'stopped' }));
    await open();
    expect(diskInput().disabled).toBe(true);
    expect(document.body.textContent).toContain('the box is stopped; start it first');
    expect((document.querySelector('#box-resize-size') as HTMLSelectElement).disabled).toBe(false);
  });

  it('a value under the current disk is an error, and nothing is sent', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ disk: disk() }));
    await open();
    await type('100');
    expect(document.body.textContent).toContain('A whole number of GB from 120 to 300');
    expect(button('Resize')!.disabled).toBe(true);
  });
});
