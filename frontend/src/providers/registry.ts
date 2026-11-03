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
  /** The dark palette's colours: `base` is the series fill, `bright` the
   *  emphasis (a badge's border, the human series). */
  color: { base: string; bright: string };
  /** The same pair for the light palette (html[data-palette="light"]): at
   *  least 3:1 (`base`) and 4.5:1 (`bright`) on the light surfaces, so
   *  `bright` is the darker one. Both registries carry it; registry.test.ts
   *  keeps them equal. */
  lightColor: { base: string; bright: string };
  /** Whether token usage numbers are exact or estimated */
  usagePrecision: 'exact' | 'estimated';
  /** Status source values that map back to this provider */
  statusSources: string[];
  /** Offered in the create-project / default-agent pickers. false = kept only so
   *  existing projects and historical usage still render (hide, never delete). */
  selectable: boolean;
  /** How a handoff can reset this agent: 'clear' and
   *  'compact' in place, 'restart' by a prompted relaunch. Absent = it cannot
   *  be handed off FROM (it has no way to write its handoff). Derived on the
   *  backend from handoffWriter, clearCommand, compactCommand and promptLaunch;
   *  backend/src/providers/registry.test.ts keeps them equal. */
  handoffModes?: ('clear' | 'compact' | 'restart')[];
  /** A handoff restart may start this agent (the backend's canRestartInto). */
  handoffTarget?: boolean;
  /** The owner's MCP connectors reach this agent on their boxes:
   * the backend's mcpConfig is set. Claude Code's
   *  through mcp-broker-v1, the others through mcp-broker-v2.
   *  backend/src/providers/registry.test.ts keeps them equal. */
  mcpConnectors?: boolean;
  /** The agent-orchestrator skill is installed for it (backend orchestratorSkill),
   *  so New session can offer "Act as an orchestrator". */
  orchestratorSkill?: boolean;
  /** Model backends this harness can also run on (the backend registry's
   *  `backends`). Absent = its default only. */
  backends?: string[];
  /** Runs in the simple UI's chat runner, not the agent pane (backend chatRunner). */
  chatRunner?: boolean;
  /** The headless agent the chat runner drives for it (backend chatEngine). */
  chatEngine?: 'claude' | 'pi';
  /** The chatRunner provider its automations run as (backend automationChatProvider). */
  automationChatProvider?: string;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    selectable: true,
    handoffModes: ['clear', 'compact', 'restart'],
    handoffTarget: true,
    orchestratorSkill: true,
    badge: 'CL',
    color: { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' },
    lightColor: { base: 'rgba(9, 105, 218, 0.6)', bright: 'rgba(5, 80, 174, 0.9)' },
    automationChatProvider: 'claude-chat',
    usagePrecision: 'exact',
    // t3:claude: the desktop app's threads on a box.
    statusSources: ['claude-hooks', 't3:claude'],
    backends: ['fireworks'],
    mcpConnectors: true,
  },

  // Claude driven headless by the simple UI's chat runner (backend registry).
  'claude-chat': {
    id: 'claude-chat',
    displayName: 'Claude (chat)',
    selectable: false,
    chatRunner: true,
    chatEngine: 'claude',
    orchestratorSkill: true,
    backends: ['fireworks'],
    badge: 'CC',
    color: { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' },
    lightColor: { base: 'rgba(9, 105, 218, 0.6)', bright: 'rgba(5, 80, 174, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['chat-runner'],
    mcpConnectors: true,
  },

  codex: {
    id: 'codex',
    displayName: 'Codex',
    selectable: false,
    badge: 'CX',
    color: { base: 'rgba(35, 170, 100, 0.6)', bright: 'rgba(72, 220, 140, 0.9)' },
    lightColor: { base: 'rgba(26, 127, 55, 0.6)', bright: 'rgba(17, 99, 41, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['codex-app-server', 'codex-jsonl'],
    mcpConnectors: true,
  },

  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    selectable: true,
    handoffTarget: true,
    badge: 'CR',
    color: { base: 'rgba(160, 80, 220, 0.6)', bright: 'rgba(200, 140, 255, 0.9)' },
    lightColor: { base: 'rgba(130, 80, 223, 0.6)', bright: 'rgba(102, 57, 186, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller', 'tmux-poller:cursor'],
    mcpConnectors: true,
  },

  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    selectable: false,
    badge: 'GE',
    color: { base: 'rgba(66, 133, 244, 0.6)', bright: 'rgba(120, 170, 255, 0.9)' },
    lightColor: { base: 'rgba(26, 115, 232, 0.6)', bright: 'rgba(21, 88, 176, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:gemini'],
    mcpConnectors: true,
  },

  augment: {
    id: 'augment',
    displayName: 'Augment',
    selectable: false,
    badge: 'AG',
    color: { base: 'rgba(255, 152, 0, 0.6)', bright: 'rgba(255, 183, 77, 0.9)' },
    lightColor: { base: 'rgba(179, 89, 0, 0.6)', bright: 'rgba(138, 70, 0, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:augment'],
    mcpConnectors: true,
  },

  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    selectable: false,
    badge: 'DS',
    color: { base: 'rgba(0, 150, 136, 0.6)', bright: 'rgba(77, 208, 195, 0.9)' },
    lightColor: { base: 'rgba(0, 121, 107, 0.6)', bright: 'rgba(0, 92, 82, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['tmux-poller:deepseek'],
  },

  devin: {
    id: 'devin',
    displayName: 'Devin',
    selectable: true,
    handoffTarget: true,
    badge: 'DV',
    color: { base: 'rgba(236, 72, 153, 0.6)', bright: 'rgba(244, 114, 182, 0.9)' },
    lightColor: { base: 'rgba(191, 57, 137, 0.6)', bright: 'rgba(153, 40, 110, 0.9)' },
    usagePrecision: 'estimated',
    statusSources: ['devin-hooks', 'tmux-poller:devin'],
    mcpConnectors: true,
  },

  pi: {
    id: 'pi',
    displayName: 'pi',
    selectable: true,
    handoffModes: ['clear', 'compact', 'restart'],
    handoffTarget: true,
    badge: 'PI',
    color: { base: 'rgba(217, 119, 6, 0.6)', bright: 'rgba(251, 191, 36, 0.9)' },
    lightColor: { base: 'rgba(154, 103, 0, 0.6)', bright: 'rgba(125, 78, 0, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['pi-ext:pi'],
    mcpConnectors: true,
    backends: ['fireworks'],
  },

  // pi driven headless by the chat runner (backend registry).
  'pi-chat': {
    id: 'pi-chat',
    displayName: 'pi (chat)',
    selectable: false,
    chatRunner: true,
    chatEngine: 'pi',
    badge: 'PI',
    color: { base: 'rgba(217, 119, 6, 0.6)', bright: 'rgba(251, 191, 36, 0.9)' },
    lightColor: { base: 'rgba(154, 103, 0, 0.6)', bright: 'rgba(125, 78, 0, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['chat-runner'],
    mcpConnectors: true,
  },

  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    selectable: false,
    badge: 'MI',
    color: { base: 'rgba(230, 80, 50, 0.6)', bright: 'rgba(255, 130, 90, 0.9)' },
    lightColor: { base: 'rgba(201, 60, 55, 0.6)', bright: 'rgba(160, 37, 31, 0.9)' },
    usagePrecision: 'exact',
    statusSources: ['tmux-poller:mistral'],
    mcpConnectors: true,
  },

  human: {
    id: 'human',
    displayName: 'You',
    selectable: false,
    badge: 'ME',
    color: { base: 'rgba(255, 255, 255, 0.4)', bright: 'rgba(255, 255, 255, 0.85)' },
    lightColor: { base: 'rgba(110, 119, 129, 0.6)', bright: 'rgba(36, 41, 47, 0.85)' },
    usagePrecision: 'estimated',
    statusSources: [],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** A provider's colour pair for a palette (theme/usePalette.ts reads the live one). */
export function providerColor(p: ProviderConfig, palette: 'dark' | 'light'): { base: string; bright: string } {
  return palette === 'light' ? p.lightColor : p.color;
}

/** A provider badge's border and tint, from its colour pair. */
export function providerBadgeStyle(p: ProviderConfig, palette: 'dark' | 'light'): { borderColor: string; background: string } {
  const c = providerColor(p, palette);
  return { borderColor: c.bright.replace(/[\d.]+\)$/, '0.45)'), background: c.base.replace(/[\d.]+\)$/, '0.16)') };
}
/** Providers a user may pick for a NEW project or as their default. Existing
 *  projects may carry any PROVIDER_IDS entry. */
export const SELECTABLE_PROVIDER_IDS = Object.values(PROVIDERS).filter(p => p.selectable).map(p => p.id);
export function isSelectableProvider(id: string | null | undefined): boolean {
  return !!id && SELECTABLE_PROVIDER_IDS.includes(id);
}
export type AgentProvider = string;

/** Model backends a workstream's agent can run on besides its harness's own
 *  default (backend MODEL_BACKENDS). */
export const MODEL_BACKENDS: Record<string, { displayName: string; badge: string }> = {
  fireworks: { displayName: 'Fireworks', badge: 'FW' },
};

/** The simple UI's chat provider (backend CHAT_PROVIDER_ID). */
export const CHAT_PROVIDER_ID = 'claude-chat';
/** Whether a provider runs in the chat runner (the SDK chat), whatever its engine. */
export function isChatRunnerProvider(id: string | null | undefined): boolean {
  return !!id && PROVIDERS[id]?.chatRunner === true;
}

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
 * caller falls back to the configured provider. Nor does a desktop thread's
 * (`t3:*`): it runs beside the pane, not in it.
 */
export function runningProviderForSource(source: string | null | undefined): string | undefined {
  if (!source || source === 'tmux-poller' || source.startsWith('t3:')) return undefined;
  return providerForSource(source);
}
