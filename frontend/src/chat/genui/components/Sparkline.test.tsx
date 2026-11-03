// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: Sparkline, sparkPoints } = await import('./Sparkline');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(props: object) {
  const text = JSON.stringify({ root: 's', elements: { s: { type: 'Sparkline', props, children: [] } } });
  act(() => root.render(<GenUiSurface block={{ type: 'code', lang: 'spec', text, open: false }} itemKey="r" streaming={false} chat={null} fallback={null} />));
}

describe('Sparkline', () => {
  it('takes 2 to 100 finite values', () => {
    expect(Sparkline.props.safeParse({ label: 'p95', values: [1, 2], tone: 'danger', unit: 'ms', showLast: true }).success).toBe(true);
    expect(Sparkline.props.safeParse({ label: 'p95', values: [1] }).success).toBe(false);
    expect(Sparkline.props.safeParse({ label: 'p95', values: Array.from({ length: 101 }, (_, i) => i) }).success).toBe(false);
    expect(Sparkline.props.safeParse({ label: 'p95', values: [1, Number.POSITIVE_INFINITY] }).success).toBe(false);
    expect(Sparkline.props.safeParse({ label: 'p95', values: [1, 2], tone: 'info' }).success).toBe(false);
  });

  it('draws one line through every value, high values near the top, with a summary for a screen reader', () => {
    draw({ label: 'p95 latency', values: [212, 198, 240, 182], unit: 'ms', tone: 'success', showLast: true });
    expect(host.querySelector('.genui-bad')).toBeNull();
    const spark = host.querySelector('.genui-sparkline')!;
    expect(spark.getAttribute('role')).toBe('img');
    expect(spark.getAttribute('data-tone')).toBe('success');
    expect(spark.getAttribute('aria-label')).toBe('p95 latency: 4 values, from 212 ms to 182 ms, low 182 ms, high 240 ms');
    expect(host.querySelector('.genui-sparkline-line')?.getAttribute('d')?.match(/[ML]/g)).toEqual(['M', 'L', 'L', 'L']);
    expect(host.querySelector('.genui-sparkline-last')?.textContent).toBe('182 ms');
    const ys = sparkPoints([212, 198, 240, 182]).map(([, y]) => y);
    expect(ys[2]).toBeLessThan(ys[0]);
    expect(ys[3]).toBeGreaterThan(ys[1]);
  });

  it('keeps a flat series in the middle, and prints nothing more unless showLast', () => {
    expect(new Set(sparkPoints([5, 5, 5]).map(([, y]) => y))).toEqual(new Set([16]));
    draw({ label: 'Replicas', values: [3, 3, 3] });
    expect(host.querySelector('.genui-sparkline')?.getAttribute('data-tone')).toBe('default');
    expect(host.querySelector('.genui-sparkline-last')).toBeNull();
  });

  it('shows the nearest value under the pointer', () => {
    draw({ label: 'Deploys', values: [10, 20, 30], unit: '%' });
    const svg = host.querySelector('.genui-sparkline svg')!;
    // jsdom lays nothing out: the box is 0 wide, so x is the drawing's own (120 px, the middle point at 60).
    act(() => { svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 58 })); });
    expect(host.querySelector('.genui-sparkline-tip')?.textContent).toBe('20%');
    act(() => { svg.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); });
    expect(host.querySelector('.genui-sparkline-tip')).toBeNull();
  });
});
