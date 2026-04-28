/**
 * Provider Registry (frontend) — display metadata for agent providers.
 *
 * This mirrors the backend registry's identity/UI fields. Adding a new provider
 * means adding one entry here and one in backend/src/providers/registry.ts.
 */

export interface ProviderConfig {
  id: string;
  displayName: string;
  badge: string;
  color: { base: string; bright: string };
  /** Whether token usage numbers are exact or estimated */
  usagePrecision: 'exact' | 'estimated';
  /** Status source values that map back to this provider */
  statusSources: string[];
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    badge: 'CL',
    color: { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['claude-hooks'],
  },

  codex: {
    id: 'codex',
    displayName: 'Codex',
    badge: 'CX',
    color: { base: 'rgba(35, 170, 100, 0.6)', bright: 'rgba(72, 220, 140, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['codex-app-server', 'codex-jsonl'],
  },

  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    badge: 'CR',
    color: { base: 'rgba(160, 80, 220, 0.6)', bright: 'rgba(200, 140, 255, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller', 'tmux-poller:cursor'],
  },

  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    badge: 'GE',
    color: { base: 'rgba(66, 133, 244, 0.6)', bright: 'rgba(120, 170, 255, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:gemini'],
  },

  augment: {
    id: 'augment',
    displayName: 'Augment',
    badge: 'AG',
    color: { base: 'rgba(255, 152, 0, 0.6)', bright: 'rgba(255, 183, 77, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:augment'],
  },

  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    badge: 'DS',
    color: { base: 'rgba(0, 150, 136, 0.6)', bright: 'rgba(77, 208, 195, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:deepseek'],
  },

  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    badge: 'MI',
    color: { base: 'rgba(230, 80, 50, 0.6)', bright: 'rgba(255, 130, 90, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:mistral'],
  },

  human: {
    id: 'human',
    displayName: 'You',
    badge: 'ME',
    color: { base: 'rgba(255, 255, 255, 0.4)', bright: 'rgba(255, 255, 255, 0.85)' },
    usagePrecision: 'estimated',
    statusSources: [],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export type AgentProvider = string;

/** Reverse-map a status source to a provider ID */
export function providerForSource(source: string): string | undefined {
  for (const config of Object.values(PROVIDERS)) {
    if (config.statusSources.includes(source)) return config.id;
  }
  return undefined;
}
