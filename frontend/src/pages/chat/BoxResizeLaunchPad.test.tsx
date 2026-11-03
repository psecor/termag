// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxResizeInfo, ResizeView } from '../../utils/boxResize';

const mocks = vi.hoisted(() => ({ resizeInfo: vi.fn(), resize: vi.fn() }));
vi.mock('../../services/api', () => ({ instancesApi: { resizeInfo: mocks.resizeInfo, resize: mocks.resize } }));
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
