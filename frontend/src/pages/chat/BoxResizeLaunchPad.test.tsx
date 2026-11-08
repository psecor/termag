// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxResizeInfo, DiskView, GrowView, ResizeView } from '../../utils/boxResize';

const mocks = vi.hoisted(() => ({ resizeInfo: vi.fn(), resize: vi.fn(), growDisk: vi.fn() }));
vi.mock('../../services/api', () => ({ instancesApi: { resizeInfo: mocks.resizeInfo, resize: mocks.resize, growDisk: mocks.growDisk } }));
vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

// React Aria's Modal reads a CSP nonce through CSS.escape, which jsdom lacks (as in GenUiSurface.test.tsx).
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { BoxResizeLaunchPad } = await import('./BoxResizeLaunchPad');

const SIZES = [
  { size: 'small' as const, vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
  { size: 'medium' as const, vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
  { size: 'large' as const, vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
];
const info = (box: Partial<BoxResizeInfo['box']> = {}, over: Partial<BoxResizeInfo> = {}): BoxResizeInfo => ({
  box: { id: 'b1', name: 'olive', status: 'ready', size: 'medium', instanceType: 'm8g.xlarge', hibernationConfigured: false, ...box },
  sizes: SIZES, resize: null, refusal: null, blockers: [], ...over,
});
const view = (over: Partial<ResizeView> = {}): ResizeView => ({
  to: 'large', from: 'medium', phase: 'stopping', running: true, startedAt: '2026-10-28T12:00:00Z', finishedAt: null,
  error: null, byAdmin: false, reason: null, ...over,
});

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;
const text = () => document.body.textContent ?? '';
async function open() {
  await act(async () => root.render(<BoxResizeLaunchPad box={{ id: 'b1', name: 'olive' }} onClose={() => {}} />));
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

describe('the simple UI Box size… dialog', () => {
  it("is LaunchPad's Modal and Select, with the current size, the pick and the downtime warning", async () => {
    mocks.resizeInfo.mockResolvedValue(info());
    await open();
    expect(document.querySelector('[role="dialog"]')).not.toBe(null);
    expect(document.querySelector('.chat-resize-dialog h2')?.textContent).toBe('Resize olive');
    expect(text()).toContain('Now: Medium · 4 vCPU, 16 GB RAM');
    // The trigger shows the preselection, the next size up.
    expect(document.querySelector('.box-size-select-button')?.textContent).toContain('Large · 8 vCPU, 32 GB RAM');
    expect(text()).toMatch(/two to three minutes/);
  });

  it('resizes and shows the progress, one row per phase', async () => {
    mocks.resizeInfo.mockResolvedValue(info());
    mocks.resize.mockResolvedValue({ resize: view({ phase: 'resizing' }) });
    await open();
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.resize).toHaveBeenCalledWith('b1', 'large', true);
    const steps = [...document.querySelectorAll('.chat-resize-steps li')].map(li => `${li.getAttribute('data-state')}:${li.textContent}`);
    expect(steps).toEqual(['done:Stopping', 'current:Changing its instance type', 'todo:Starting, waiting for its agent', 'todo:Running at the new size']);
    expect(document.querySelector('.chat-resize-steps li[data-state="current"] [role="progressbar"]')).not.toBe(null);
    expect(button('Close')).toBeDefined();
  });

  it('a busy box: one warning, the downtime notice, and Resize goes ahead confirmed', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { blockers: [{ check: 'ssh', reason: 'an SSH or SSM session is open to it', forceable: true }] }));
    mocks.resize.mockResolvedValueOnce({ resize: view() });
    await open();
    const warnings = [...document.querySelectorAll('.chat-resize-warning')].map(w => w.textContent);
    expect(warnings).toEqual(["The box stops for two to three minutes while it's resized. Anything running on it stops too: agent turns, terminals, dev servers."]);
    expect(text()).not.toMatch(/SSH|Right now|Confirm \(force\)/);
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.resize).toHaveBeenCalledTimes(1);
    expect(mocks.resize).toHaveBeenCalledWith('b1', 'large', true);
    expect(button('Resize anyway')).toBeUndefined();
    expect(document.querySelector('.chat-resize-steps')).not.toBe(null);
  });

  it('the outcome once a resize this dialog follows is done', async () => {
    mocks.resizeInfo.mockResolvedValueOnce(info({}, { resize: view({ phase: 'starting' }) }));
    await open();
    expect(text()).toContain('Starting, waiting for its agent');
    expect(text()).toContain('the resize carries on');
  });

  it('a hibernated box: it is resumed first and stays stopped', async () => {
    mocks.resizeInfo.mockResolvedValue(info({ status: 'hibernated' }));
    await open();
    expect(text()).toMatch(/resumed first.*stays stopped/);
  });
});

describe('the simple UI dialog\'s disk', () => {
  const disk = (over: Partial<DiskView> = {}): DiskView => ({ sizeGb: 120, maxGb: 300, refusal: null, grow: null, retry: null, ...over });
  const growing = (over: Partial<GrowView> = {}): GrowView => ({
    fromGb: 120, toGb: 200, state: 'modifying', running: true, detail: null, startedAt: '2026-11-03T12:00:00Z', finishedAt: null, ...over,
  });
  const diskInput = () => document.querySelector('.chat-resize-disk input') as HTMLInputElement | null;
  async function typeDisk(value: string) {
    const el = diskInput()!;
    await act(async () => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // LaunchPad's NumberField commits on blur.
    await act(async () => { el.blur(); });
  }
  const warning = () => document.querySelector('.chat-resize-warning')?.textContent ?? '';

  it('sends a disk typed but not yet committed (no blur) with the resize (Cursor on #1214)', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { disk: disk() }));
    mocks.growDisk.mockResolvedValue({ grow: growing() });
    await open();
    const el = diskInput()!;
    await act(async () => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '200');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // No blur: LaunchPad's NumberField hasn't committed, but the dialog must still send what is typed.
    expect(button('Resize')!.disabled).toBe(false);
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.growDisk).toHaveBeenCalledWith('b1', 200);
  });

  it('a grow that fails while the dialog follows it offers finishing it there (Devin on #1214)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.resizeInfo.mockResolvedValueOnce(info({}, { disk: disk() }));
      mocks.growDisk.mockResolvedValue({ grow: growing() });
      await open();
      await typeDisk('200');
      mocks.resizeInfo.mockResolvedValue(info({}, { disk: disk({
        sizeGb: 200, grow: growing({ state: 'failed', running: false, detail: 'growpart: FAILED' }), retry: { sizeGb: 200, error: 'growpart: FAILED' },
      }) }));
      await act(async () => { button('Resize')!.click(); });
      await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await flush();
      expect(text()).toContain('The disk grow failed: growpart: FAILED');
      expect(button('Finish growing the disk')).toBeDefined();
    } finally { vi.useRealTimers(); }
  });

  it('shows the disk beside the type in LaunchPad\'s NumberField, and opens on no change', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { disk: disk() }));
    await open();
    expect(text()).toContain('Now: Medium · 4 vCPU, 16 GB RAM · 120 GB disk');
    expect(document.querySelector('.box-size-select-button')?.textContent).toContain('Medium · 4 vCPU, 16 GB RAM');
    expect(diskInput()?.value).toBe('120');
    expect(document.querySelector('.chat-resize-disk .box-disk-input-hint')?.textContent).toBe('GB, 120–300');
    expect(button('Resize')!.disabled).toBe(true);
    expect(document.querySelector('.chat-resize-warning')).toBeNull();
  });

  it('a disk alone: the warning has no stop, and the grow\'s progress follows', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { disk: disk() }));
    mocks.growDisk.mockResolvedValue({ grow: growing({ state: 'filesystem' }) });
    await open();
    await typeDisk('200');
    expect(warning()).toBe("Growing the disk doesn't stop the box. A disk never shrinks, and EBS allows one change to it every six hours.");
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(mocks.growDisk).toHaveBeenCalledWith('b1', 200);
    expect(mocks.resize).not.toHaveBeenCalled();
    const steps = [...document.querySelectorAll('.chat-resize-steps li')].map(li => `${li.getAttribute('data-state')}:${li.textContent}`);
    expect(steps).toEqual(['done:Growing the disk to 200 GB', 'current:Growing its file system']);
    expect(text()).toContain('the disk carries on growing');
  });

  it('offers finishing a grow whose file system step failed, with LaunchPad\'s Button (Devin on #1214)', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { disk: disk({ sizeGb: 200, retry: { sizeGb: 200, error: 'growpart: FAILED' } }) }));
    mocks.growDisk.mockResolvedValue({ grow: growing({ fromGb: 200, toGb: 200, state: 'filesystem' }) });
    await open();
    expect(text()).toContain('The disk is 200 GB, but its file system was not grown into it: growpart: FAILED');
    await act(async () => { button('Finish growing the disk')!.click(); });
    await flush();
    expect(mocks.growDisk).toHaveBeenCalledWith('b1', 200);
  });

  it('a disk refusal disables the field and says why, in the dialog\'s words', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { disk: disk({ refusal: 'EBS allows one change to a disk every six hours. This one was last changed at 2026-11-03 10:00 UTC, so it can grow again after 2026-11-03 16:00 UTC.' }) }));
    await open();
    expect(diskInput()?.disabled).toBe(true);
    expect(text()).toContain('can grow again after 2026-11-03 16:00 UTC');
  });

  it('EC2\'s refusal on the grow is the error, and no resize follows', async () => {
    mocks.resizeInfo.mockResolvedValue(info({}, { disk: disk() }));
    mocks.growDisk.mockRejectedValue({ response: { status: 409, data: { code: 'disk_cooldown', error: 'EBS allows one change to a disk every six hours, and this one was changed less than six hours ago. Try again later.' } } });
    await open();
    await typeDisk('200');
    await act(async () => { button('Resize')!.click(); });
    await flush();
    expect(document.querySelector('.chat-new-error')?.textContent).toMatch(/one change to a disk every six hours/);
    expect(mocks.resize).not.toHaveBeenCalled();
  });
});
