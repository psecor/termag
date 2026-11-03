// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxResizeInfo, ResizeView } from '../../utils/boxResize';

const mocks = vi.hoisted(() => ({ boxResizeInfo: vi.fn(), resizeBox: vi.fn() }));
vi.mock('../../services/adminApi', () => ({ adminApi: { boxResizeInfo: mocks.boxResizeInfo, resizeBox: mocks.resizeBox } }));
vi.mock('../../services/api', () => ({ instancesApi: {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AdminBoxResize } = await import('./AdminBoxResize');
const { RESIZE_POLL_MS } = await import('../../hooks/useBoxResize');

const SIZES = [
  { size: 'small' as const, vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
  { size: 'medium' as const, vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
  { size: 'large' as const, vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
];
const info = (box: Partial<BoxResizeInfo['box']> = {}, resize: ResizeView | null = null): BoxResizeInfo => ({
  box: { id: 'b1', name: 'olive', status: 'ready', size: 'small', instanceType: 'm8g.large', hibernationConfigured: false, ...box },
  sizes: SIZES, resize, refusal: null, blockers: [],
});
const view = (over: Partial<ResizeView> = {}): ResizeView => ({
  to: 'medium', from: 'small', fromStatus: 'ready', phase: 'stopping', running: true, startedAt: '2026-10-28T12:00:00Z',
  finishedAt: null, error: null, byAdmin: true, reason: 'cost', ...over,
});

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const select = () => el.querySelector('select[aria-label="new size"]');
const button = (label: string) => [...el.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.boxResizeInfo.mockReset();
  mocks.resizeBox.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function resizeAndFinish(finished: ResizeView, onChanged: () => void) {
  mocks.boxResizeInfo.mockResolvedValueOnce(info());
  mocks.resizeBox.mockResolvedValueOnce({ resize: view() });
  await act(async () => root.render(<AdminBoxResize boxId="b1" onChanged={onChanged} />));
  await flush();
  act(() => {
    const input = el.querySelector('input[aria-label="reason"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'cost');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); });
  await flush();
  expect(el.querySelector('.box-resize-steps')).not.toBe(null);
  expect(select()).toBe(null);
  // The next read finds it finished.
  mocks.boxResizeInfo.mockResolvedValue(info({ size: finished.phase === 'ready' ? 'medium' : 'small' }, finished));
  await act(async () => { await vi.advanceTimersByTimeAsync(RESIZE_POLL_MS + 10); });
  await flush();
}

describe("the Fleet card's resize, once the resize ends", () => {
  it('a finished resize says how it ended and gives the form back, and the card refreshes', async () => {
    const onChanged = vi.fn();
    await resizeAndFinish(view({ phase: 'ready', running: false, finishedAt: '2026-10-28T12:03:00Z' }), onChanged);
    expect(el.textContent).toContain('Now Medium · 4 vCPU, 16 GB RAM, and running.');
    expect(select()).not.toBe(null);
    expect(button('Resize')).toBeDefined();
    // Once when it started, once when it ended: the card's size line and operations follow.
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('a failed resize gives the form back with the error, for a retry', async () => {
    const onChanged = vi.fn();
    await resizeAndFinish(view({ phase: 'failed', running: false, error: 'no capacity', finishedAt: '2026-10-28T12:03:00Z' }), onChanged);
    expect(el.textContent).toContain('no capacity');
    expect(select()).not.toBe(null);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
