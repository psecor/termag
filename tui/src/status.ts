import type { AgentStatusValue } from './types.js';

export const STATUS_PRIORITY: Record<AgentStatusValue, number> = {
  not_running: 0,
  idle: 1,
  waiting: 2,
  working: 3,
};

// Plain glyphs: emoji widths are unreliable across terminals and fonts.
export const STATUS_GLYPH: Record<AgentStatusValue, string> = {
  working: '●',
  waiting: '◐',
  idle: '○',
  not_running: '·',
};

export const STATUS_COLOR: Record<AgentStatusValue, string> = {
  working: 'green',
  waiting: 'yellow',
  idle: 'red',
  not_running: 'gray',
};

export const NO_AGENT_GLYPH = '—';

// Same thresholds as frontend/src/utils/thresholds.ts.
export const CONTEXT_WARN_TOKENS = 500_000;
export const CONTEXT_DANGER_TOKENS = 1_000_000;
export type ContextLevel = 'ok' | 'warn' | 'danger';
export function contextLevel(tokens: number | null | undefined): ContextLevel {
  if (tokens == null) return 'ok';
  if (tokens >= CONTEXT_DANGER_TOKENS) return 'danger';
  if (tokens >= CONTEXT_WARN_TOKENS) return 'warn';
  return 'ok';
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

// Badge letters from frontend/src/providers/registry.ts, colors mapped to the
// nearest terminal color.
export const PROVIDER_BADGE: Record<string, { badge: string; color: string }> = {
  claude: { badge: 'CL', color: 'blue' },
  codex: { badge: 'CX', color: 'green' },
  cursor: { badge: 'CR', color: 'magenta' },
  gemini: { badge: 'GE', color: 'blueBright' },
  augment: { badge: 'AG', color: 'yellow' },
  deepseek: { badge: 'DS', color: 'cyan' },
  devin: { badge: 'DV', color: 'magentaBright' },
  mistral: { badge: 'MI', color: 'redBright' },
  human: { badge: 'ME', color: 'white' },
};

export function providerBadge(provider: string | null | undefined): { badge: string; color: string } | null {
  if (!provider) return null;
  return PROVIDER_BADGE[provider] ?? { badge: provider.slice(0, 2).toUpperCase(), color: 'white' };
}
