// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: Chart } = await import('./Chart');
const { formatValue } = await import('./charts/ChartView');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const chart = (props: object) => JSON.stringify({ root: 'c', elements: { c: { type: 'Chart', props, children: [] } } });
async function draw(props: object) {
  const block = { type: 'code' as const, lang: 'spec', text: chart(props), open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={null} fallback={null} />));
  // The drawing is a lazy chunk.
  await act(async () => { await import('./charts/ChartView'); });
}

describe('Chart', () => {
  it('needs one value per x in every series', () => {
    const base = { label: 'Latency', x: ['a', 'b'] };
    expect(Chart.props.safeParse({ ...base, series: [{ name: 'p95', values: [1, null] }] }).success).toBe(true);
    expect(Chart.props.safeParse({ ...base, series: [{ name: 'p95', values: [1] }] }).success).toBe(false);
    expect(Chart.props.safeParse({ ...base, series: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, values: [1, 2] })) }).success).toBe(false);
  });

  it('draws a figure named by its label, with the numbers as a table for a screen reader', async () => {
    await draw({ label: 'API latency by day', kind: 'line', unit: 'ms', x: ['Mon', 'Tue'], series: [{ name: 'p95', values: [212, null] }, { name: 'p50', values: [84, 80] }] });
    expect(host.querySelector('figure.genui-chart')?.getAttribute('aria-label')).toBe('API latency by day');
    const rows = [...host.querySelectorAll('table.genui-sr tbody tr')].map(r => r.textContent);
    expect(rows).toEqual(['Mon212 ms84 ms', 'Tue–80 ms']);
    expect(host.querySelector('.genui-bad')).toBeNull();
  });

  it('draws a note, not a chart, when a series is short', async () => {
    await draw({ label: 'Deploys', x: ['a', 'b', 'c'], series: [{ name: 'Auto', values: [1, 2] }] });
    expect(host.querySelector('.genui-bad')?.textContent).toMatch(/^Chart could not be drawn/);
  });

  it('puts a unit after its value', () => {
    expect(formatValue(1234.5, 'ms')).toBe(`${(1234.5).toLocaleString()} ms`);
    expect(formatValue(12, '%')).toBe('12%');
    expect(formatValue(3)).toBe('3');
    expect(formatValue(42.1, '$')).toBe(`$${(42.1).toLocaleString()}`);
    expect(formatValue(-5, '$')).toBe('−$5');
  });
});
