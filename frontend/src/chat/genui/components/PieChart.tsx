// A donut of the parts of one whole. LaunchPad has no chart; this is drawn
// with recharts, as termag's other charts are (pages/dashboard/chartTheme.tsx),
// loaded only when a spec draws one (piecharts/PieChartView.tsx).
import React, { lazy, Suspense } from 'react';
import { z } from 'zod';
import { defineGenUiComponent } from './index';
import './PieChart.css';

const PieChartView = lazy(() => import('./piecharts/PieChartView'));

/** The donut's width and height, px. */
export const PIE_SIZE = 160;

const props = z.object({
  label: z.string().min(1).max(200),
  slices: z.array(z.object({
    label: z.string().min(1).max(60),
    value: z.number().finite().min(0),
  })).min(1).max(8),
  unit: z.string().max(12).optional(),
  totalLabel: z.string().min(1).max(30).optional(),
});

export type PieChartProps = z.infer<typeof props>;

export default defineGenUiComponent({
  name: 'PieChart',
  props,
  description: 'A donut chart of the parts of one whole (sessions by agent, spend by service): each slice is a label and a value of 0 or more, in the order given, at most 8 (6 or fewer reads best; fold the rest into "Other"); the legend shows each slice\'s share. unit goes with every value ("$", "ms"); totalLabel puts the total in the middle with that word under it ("sessions"). label says what it shows, for screen readers; put it in a Card whose title says the same. Use a Chart (stacked bars) to compare parts across several wholes, a Meter for one amount against a limit, a Table when exact values matter more than the shape.',
  Component: ({ props: p }) => (
    <Suspense fallback={<div className="genui-piechart-placeholder" style={{ width: PIE_SIZE, height: PIE_SIZE }} />}>
      <PieChartView {...p} />
    </Suspense>
  ),
});
