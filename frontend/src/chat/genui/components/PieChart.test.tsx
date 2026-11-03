// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: PieChart } = await import('./PieChart');
const { formatShare, formatValue } = await import('./piecharts/PieChartView');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const pie = (props: object) => JSON.stringify({ root: 'p', elements: { p: { type: 'PieChart', props, children: [] } } });
async function draw(props: object) {
  const block = { type: 'code' as const, lang: 'spec', text: pie(props), open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={null} fallback={null} />));
  // The drawing is a lazy chunk.
  await act(async () => { await import('./piecharts/PieChartView'); });
}

describe('PieChart', () => {
  it('takes 1 to 8 slices of 0 or more', () => {
    const slice = (value: number) => ({ label: 'a', value });
    expect(PieChart.props.safeParse({ label: 'Spend', slices: [slice(3), slice(0)], unit: '$', totalLabel: 'total' }).success).toBe(true);
    expect(PieChart.props.safeParse({ label: 'Spend', slices: [] }).success).toBe(false);
    expect(PieChart.props.safeParse({ label: 'Spend', slices: [slice(-1)] }).success).toBe(false);
    expect(PieChart.props.safeParse({ label: 'Spend', slices: Array.from({ length: 9 }, () => slice(1)) }).success).toBe(false);
    expect(PieChart.props.safeParse({ label: 'Spend', slices: [{ label: 'x'.repeat(61), value: 1 }] }).success).toBe(false);
  });

  it('draws a figure named by its label, with each share in the legend and the numbers as a table', async () => {
    await draw({ label: 'Sessions by agent', totalLabel: 'sessions', slices: [{ label: 'Claude', value: 300 }, { label: 'Codex', value: 100 }, { label: 'Grok', value: 0 }] });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(host.querySelector('figure.genui-piechart')?.getAttribute('aria-label')).toBe('Sessions by agent');
    expect([...host.querySelectorAll('.usage-legend > span')].map(s => s.textContent)).toEqual(['Claude 75%', 'Codex 25%', 'Grok 0%']);
    expect(host.querySelector('.genui-piechart-center')?.textContent).toBe(`${(400).toLocaleString()}sessions`);
    const rows = [...host.querySelectorAll('table.genui-sr tbody tr')].map(r => r.textContent);
    expect(rows).toEqual(['Claude30075%', 'Codex10025%', 'Grok00%']);
    expect(host.querySelector('table.genui-sr tfoot tr')?.textContent).toBe('Total400100%');
    // The empty slice draws no sector; the other two do, in the palette's first two colours.
    expect([...host.querySelectorAll('.recharts-pie-sector path')].map(p => p.getAttribute('fill'))).toEqual(['#3987e5', '#d95926']);
  });

  it('names a lone slice in the legend too', async () => {
    await draw({ label: 'Sessions by agent', slices: [{ label: 'Claude', value: 12 }] });
    expect([...host.querySelectorAll('.usage-legend > span')].map(s => s.textContent)).toEqual(['Claude 100%']);
  });

  it('has an empty middle without totalLabel, and draws a whole of nothing', async () => {
    await draw({ label: 'Nothing yet', slices: [{ label: 'A', value: 0 }, { label: 'B', value: 0 }] });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(host.querySelector('.genui-piechart-center')).toBeNull();
    expect([...host.querySelectorAll('table.genui-sr tbody td')].map(c => c.textContent)).toEqual(['0', '–', '0', '–']);
  });

  it('draws a note, not a donut, when a value is negative', async () => {
    await draw({ label: 'Bad', slices: [{ label: 'A', value: -2 }] });
    expect(host.querySelector('.genui-bad')?.textContent).toMatch(/^PieChart could not be drawn/);
  });

  it('rounds a share by its size', () => {
    expect(formatShare(1, 3)).toBe('33%');
    expect(formatShare(1, 40)).toBe('2.5%');
    expect(formatShare(1, 50)).toBe('2%');
    expect(formatShare(1, 10_000)).toBe('<0.1%');
    expect(formatShare(0, 5)).toBe('0%');
    expect(formatShare(0, 0)).toBe('–');
  });

  it('puts a unit after its value, and shortens a big total', () => {
    expect(formatValue(1234.5, 'ms')).toBe(`${(1234.5).toLocaleString()} ms`);
    expect(formatValue(12, '%')).toBe('12%');
    expect(formatValue(42.1, '$')).toBe(`$${(42.1).toLocaleString()}`);
    expect(formatValue(1234, '$', true)).toBe(`$${(1234).toLocaleString()}`);
    expect(formatValue(12_900, '$', true)).toBe(`$${Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(12_900)}`);
  });
});
