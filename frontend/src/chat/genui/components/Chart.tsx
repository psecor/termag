// A bar, line or area chart. LaunchPad has no chart; this is drawn with
// recharts, as termag's other charts are (pages/dashboard/chartTheme.tsx),
// loaded only when a spec draws one (charts/ChartView.tsx).
import React, { lazy, Suspense } from 'react';
import { z } from 'zod';
import { defineGenUiComponent } from './index';
import './Chart.css';

const ChartView = lazy(() => import('./charts/ChartView'));

export const CHART_HEIGHT = { small: 140, medium: 200, large: 280 } as const;

const props = z.object({
  label: z.string().min(1).max(200),
  kind: z.enum(['bar', 'line', 'area']).optional(),
  x: z.array(z.union([z.string().max(40), z.number()])).min(1).max(100),
  series: z.array(z.object({
    name: z.string().min(1).max(60),
    values: z.array(z.number().finite().nullable()).min(1).max(100),
  })).min(1).max(8),
  stacked: z.boolean().optional(),
  unit: z.string().max(12).optional(),
  height: z.enum(['small', 'medium', 'large']).optional(),
}).refine(p => p.series.every(s => s.values.length === p.x.length), { message: 'every series needs one value per x', path: ['series'] });

export type ChartProps = z.infer<typeof props>;

export default defineGenUiComponent({
  name: 'Chart',
  props,
  description: 'A chart of numbers the agent has: bar (default; compare amounts across categories), line (change over time) or area (a total over time, stacked: true to show its parts). x is the categories or times along the bottom, in order; each series is one named list of values, one per x (null for a gap), at most 8 series. unit goes with every value ("ms", "%", "$"). label says what it shows, for screen readers; put it in a Card whose title says the same. Use a Stat for one number, a Table when exact values matter more than the shape.',
  Component: ({ props: p }) => (
    <Suspense fallback={<div className="genui-chart-placeholder" style={{ height: CHART_HEIGHT[p.height ?? 'medium'] }} />}>
      <ChartView {...p} />
    </Suspense>
  ),
});
