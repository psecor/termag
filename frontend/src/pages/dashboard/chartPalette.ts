// Chart colours that are App.css tokens (a dark and a light value each), kept
// in a plain module so pure helpers (usageProjects.ts) can use them;
// chartTheme.tsx re-exports them. theme/chartPalette.test.ts pins their
// contrast on the chart surfaces in both palettes.

/** The band under the hovered bar: `<Tooltip cursor={CURSOR} />`. */
export const CURSOR = { fill: 'var(--chart-cursor)' } as const;

/**
 * Named series hues for charts whose series are not providers or projects.
 * Each is an App.css token with a dark and a light value, so a chart follows
 * a palette toggle with no re-render. Provider colours come from the registry
 * (`providerColor` in providers/registry.ts), user-picked project colours as
 * they are.
 */
export const HUE = {
  blue: 'var(--series-blue)',
  green: 'var(--series-green)',
  amber: 'var(--series-amber)',
  purple: 'var(--series-purple)',
  red: 'var(--series-red)',
  teal: 'var(--series-teal)',
  gray: 'var(--series-gray)',
  orange: 'var(--series-orange)',
  pink: 'var(--series-pink)',
  other: 'var(--series-other)',
  unattributed: 'var(--series-unattributed)',
} as const;

/** The categorical order, for series with no colour of their own. */
export const HUE_ORDER = [HUE.blue, HUE.green, HUE.amber, HUE.purple, HUE.red, HUE.teal, HUE.gray, HUE.orange] as const;
