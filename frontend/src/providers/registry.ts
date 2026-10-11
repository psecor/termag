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
  /** Offered in the create-project / default-agent pickers. false = kept only so
   *  existing projects and historical usage still render (hide, never delete). */
  selectable: boolean;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    selectable: true,
    badge: 'CL',
    color: { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['claude-hooks'],
  },

  codex: {
    id: 'codex',
    displayName: 'Codex',
    selectable: false,
    badge: 'CX',
    color: { base: 'rgba(35, 170, 100, 0.6)', bright: 'rgba(72, 220, 140, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['codex-app-server', 'codex-jsonl'],
  },

  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    selectable: true,
    badge: 'CR',
    color: { base: 'rgba(160, 80, 220, 0.6)', bright: 'rgba(200, 140, 255, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller', 'tmux-poller:cursor'],
  },

  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    selectable: false,
    badge: 'GE',
    color: { base: 'rgba(66, 133, 244, 0.6)', bright: 'rgba(120, 170, 255, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:gemini'],
  },

  augment: {
    id: 'augment',
    displayName: 'Augment',
    selectable: false,
    badge: 'AG',
    color: { base: 'rgba(255, 152, 0, 0.6)', bright: 'rgba(255, 183, 77, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:augment'],
  },

  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    selectable: false,
    badge: 'DS',
    color: { base: 'rgba(0, 150, 136, 0.6)', bright: 'rgba(77, 208, 195, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:deepseek'],
  },

  devin: {
    id: 'devin',
    displayName: 'Devin',
    selectable: true,
    badge: 'DV',
    color: { base: 'rgba(236, 72, 153, 0.6)', bright: 'rgba(244, 114, 182, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:devin'],
  },

  pi: {
    id: 'pi',
    displayName: 'pi',
    selectable: true,
    badge: 'PI',
    color: { base: 'rgba(217, 119, 6, 0.6)', bright: 'rgba(251, 191, 36, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['pi-ext:pi'],
  },

  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    selectable: false,
    badge: 'MI',
    color: { base: 'rgba(230, 80, 50, 0.6)', bright: 'rgba(255, 130, 90, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['tmux-poller:mistral'],
  },

  human: {
    id: 'human',
    displayName: 'You',
    selectable: false,
    badge: 'ME',
    color: { base: 'rgba(255, 255, 255, 0.4)', bright: 'rgba(255, 255, 255, 0.85)' },
    usagePrecision: 'estimated',
    statusSources: [],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
/** Providers a user may pick for a NEW project or as their default. Existing
 *  projects may carry any PROVIDER_IDS entry. */
export const SELECTABLE_PROVIDER_IDS = Object.values(PROVIDERS).filter(p => p.selectable).map(p => p.id);
export function isSelectableProvider(id: string | null | undefined): boolean {
  return !!id && SELECTABLE_PROVIDER_IDS.includes(id);
}
export type AgentProvider = string;

/** Reverse-map a status source to a provider ID */
export function providerForSource(source: string): string | undefined {
  for (const config of Object.values(PROVIDERS)) {
    if (config.statusSources.includes(source)) return config.id;
  }
  return undefined;
}

/**
 * The provider a live status source proves is running, for display and for
 * picking a transcript grammar. The bare `tmux-poller` source predates the
 * per-provider poller sources and only says "some poller provider" (it is
 * listed under Cursor for history), so it proves nothing: undefined, and the
 * caller falls back to the configured provider.
 */
export function runningProviderForSource(source: string | null | undefined): string | undefined {
  if (!source || source === 'tmux-poller') return undefined;
  return providerForSource(source);
}
