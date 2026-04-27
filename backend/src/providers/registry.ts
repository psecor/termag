/**
 * Provider Registry — single source of truth for all agent provider metadata.
 *
 * Adding a new provider means adding one entry here (plus a Prisma-free DB row
 * since we use String columns, not enums). Everything else — launch commands,
 * badges, colors, process detection, status sources — is derived from this file.
 */

export interface PollerPattern {
  /** Regex matching the idle/input prompt (e.g. → for cursor) */
  idlePattern: RegExp;
  /** Activity indicator keywords on short lines while working */
  activityPatterns: RegExp[];
  /** Patterns indicating the agent is waiting for user input (e.g. permission prompts) */
  waitingPatterns?: RegExp[];
  /** Animated spinner characters (e.g. Braille block chars) */
  spinnerPattern?: RegExp;
  /** Parse the status bar at the bottom of the pane. Return arbitrary metadata. */
  statusBarParser?: (lines: string[]) => Record<string, any>;
}

export interface ProviderConfig {
  id: string;
  displayName: string;
  badge: string;
  color: { base: string; bright: string };

  /** Shell command to launch the agent in a tmux pane */
  launchCommand: string;
  /** Process names for isAgentRunning() detection (matched case-insensitive) */
  processNames: string[];
  /** Status source values that map back to this provider */
  statusSources: string[];

  /** Codex-style: needs a bridge subprocess for status */
  needsBridge?: boolean;
  /** Cursor/augment-style: no hooks, needs tmux pane polling */
  needsPoller?: boolean;
  /** Poller pattern config (required when needsPoller is true) */
  pollerConfig?: PollerPattern;

  /** How token usage is measured */
  usageMethod: 'jsonl-scan' | 'server-side-estimate' | 'none';
  /** Whether the usage numbers are exact or estimated */
  usagePrecision: 'exact' | 'estimated';
}

// ── Status bar parsers ──────────────────────────────────────

const CURSOR_STATUS_BAR = /^\s*(.+?)\s*·\s*([\d.]+)%\s*·\s*(\d+)\s*files?\s*edited/;

function parseCursorStatusBar(lines: string[]): Record<string, any> {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = CURSOR_STATUS_BAR.exec(lines[i]);
    if (m) {
      return {
        cursorModel: m[1].trim(),
        cursorContextPct: parseFloat(m[2]),
        cursorFilesEdited: parseInt(m[3], 10),
      };
    }
  }
  return {};
}

const VIBE_STATUS_BAR = /(\d+)%\s*of\s*(\d+)k\s*tokens/;

function parseVibeStatusBar(lines: string[]): Record<string, any> {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = VIBE_STATUS_BAR.exec(lines[i]);
    if (m) {
      return {
        vibeTokenPct: parseInt(m[1], 10),
        vibeTokenBudgetK: parseInt(m[2], 10),
      };
    }
  }
  return {};
}

// ── Provider definitions ────────────────────────────────────

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    badge: 'CL',
    color: { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' },
    launchCommand: 'claude',
    processNames: ['claude'],
    statusSources: ['claude-hooks'],
    usageMethod: 'jsonl-scan',
    usagePrecision: 'exact',
  },

  codex: {
    id: 'codex',
    displayName: 'Codex',
    badge: 'CX',
    color: { base: 'rgba(35, 170, 100, 0.6)', bright: 'rgba(72, 220, 140, 0.9)' },
    launchCommand: 'codex --no-alt-screen -a on-request',
    processNames: ['codex'],
    statusSources: ['codex-app-server', 'codex-jsonl'],
    needsBridge: true,
    usageMethod: 'jsonl-scan',
    usagePrecision: 'exact',
  },

  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    badge: 'CR',
    color: { base: 'rgba(160, 80, 220, 0.6)', bright: 'rgba(200, 140, 255, 0.9)' },
    launchCommand: 'agent',
    processNames: ['agent'],
    statusSources: ['tmux-poller'],
    needsPoller: true,
    pollerConfig: {
      idlePattern: /^\s*→\s/m,
      activityPatterns: [
        /^\s*(Thinking|Composing|Reading|Globbing|Writing|Editing|Searching|Running|Executing|Applying|Planning|Grepping|Using tool|Running command)\b/i,
      ],
      spinnerPattern: /[\u2800-\u28FF]/,
      statusBarParser: parseCursorStatusBar,
    },
    usageMethod: 'server-side-estimate',
    usagePrecision: 'estimated',
  },

  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    badge: 'GE',
    color: { base: 'rgba(66, 133, 244, 0.6)', bright: 'rgba(120, 170, 255, 0.9)' },
    launchCommand: 'gemini',
    processNames: ['gemini'],
    statusSources: ['tmux-poller'],
    needsPoller: true,
    pollerConfig: {
      idlePattern: /^\s*>\s/m,
      activityPatterns: [
        /^\s*(Thinking|Reading|Writing|Editing|Searching|Running|Executing)\b/i,
      ],
    },
    usageMethod: 'none',
    usagePrecision: 'estimated',
  },

  augment: {
    id: 'augment',
    displayName: 'Augment',
    badge: 'AG',
    color: { base: 'rgba(255, 152, 0, 0.6)', bright: 'rgba(255, 183, 77, 0.9)' },
    launchCommand: 'auggie',
    processNames: ['auggie'],
    statusSources: ['tmux-poller'],
    needsPoller: true,
    pollerConfig: {
      idlePattern: /^\s*>\s/m,
      activityPatterns: [
        /^\s*(Thinking|Reading|Writing|Editing|Searching|Running|Executing)\b/i,
      ],
    },
    usageMethod: 'none',
    usagePrecision: 'estimated',
  },

  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    badge: 'DS',
    color: { base: 'rgba(0, 150, 136, 0.6)', bright: 'rgba(77, 208, 195, 0.9)' },
    launchCommand: 'deepseek',
    processNames: ['deepseek'],
    statusSources: ['tmux-poller'],
    needsPoller: true,
    pollerConfig: {
      idlePattern: /^\s*>\s/m,
      activityPatterns: [
        /^\s*(Thinking|Reading|Writing|Editing|Searching|Running|Executing)\b/i,
      ],
    },
    usageMethod: 'none',
    usagePrecision: 'estimated',
  },

  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    badge: 'MI',
    color: { base: 'rgba(230, 80, 50, 0.6)', bright: 'rgba(255, 130, 90, 0.9)' },
    launchCommand: 'vibe',
    processNames: ['vibe'],
    statusSources: ['tmux-poller'],
    needsPoller: true,
    pollerConfig: {
      idlePattern: /│\s*>\s/m,
      activityPatterns: [
        /Running command/,
        /Reading file/,
        /Writing file/,
        /^\s*■\s/,
      ],
      waitingPatterns: [
        /↑↓ navigate\s+Enter select/,
        /› \d+\.\s*(Yes|No)/,
      ],
      spinnerPattern: /[\u2800-\u28FF]/,
      statusBarParser: parseVibeStatusBar,
    },
    usageMethod: 'none',
    usagePrecision: 'estimated',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export type AgentProvider = string;

/** All process names across all providers, for isAgentRunning() */
export const ALL_PROCESS_NAMES = Object.values(PROVIDERS).flatMap(p => p.processNames);

/** All known status source values, for reverse-mapping source → provider */
export function providerForSource(source: string): string | undefined {
  for (const config of Object.values(PROVIDERS)) {
    if (config.statusSources.includes(source)) return config.id;
  }
  return undefined;
}

/** Providers that need tmux pane polling */
export function pollerProviderIds(): string[] {
  return Object.values(PROVIDERS).filter(p => p.needsPoller).map(p => p.id);
}

/** Providers with server-side usage estimation */
export function serverSideUsageProviderIds(): string[] {
  return Object.values(PROVIDERS).filter(p => p.usageMethod === 'server-side-estimate').map(p => p.id);
}
