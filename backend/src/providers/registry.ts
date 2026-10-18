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
  /** Command used instead of launchCommand when relaunching into a pane whose
   *  agent exited (reconnect reconstruction): resume the last session in that
   *  cwd. Absent = launchCommand. */
  resumeCommand?: string;
  /** The launch line that starts the agent on a prompt file, given the file as
   *  an already double-quoted shell word. The CLI reads the file or gets it as
   *  one argument (`"$(cat F)"`), so the text never goes through shell quoting.
   *  Spawns (services/agentSpawn.ts) and handoff restarts
   *  (services/agentHandoff.ts) use it. Absent = it cannot be started on one. */
  promptLaunch?: (file: string) => string;
  /** The agent can write its own handoff: termag-reconcile registers the
   *  metaterm MCP server (handoff_written) and installs the termag-handoff
   *  skill for it. Only such an agent can be handed off FROM; any agent with
   *  promptLaunch can be restarted INTO. */
  handoffWriter?: boolean;
  /** Typed into the running agent to drop its conversation in place (handoff
   *  `clear` mode). Absent = a handoff restarts it. */
  clearCommand?: string;
  /** Typed into the running agent to summarize its conversation in place,
   *  followed by focus instructions (handoff `compact` mode). Absent = a
   *  handoff restarts it. */
  compactCommand?: string;
  /** Process names for isAgentRunning() detection (matched case-insensitive) */
  processNames: string[];
  /** Status source values that map back to this provider */
  statusSources: string[];
  /** Offered in the create-project / default-agent pickers. false = kept only so
   *  existing projects and historical usage still render (hide, never delete). */
  selectable: boolean;

  /** Runs in the simple UI's chat runner on the box (agent/chat-runner.js),
   *  not in the agent pane: nothing is typed into the pane at launch or on
   *  reconnect, and the pane stays a shell. */
  chatRunner?: boolean;
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

// "SWE-1.6 Fast                Context: 66k / 200k tokens (33%)"
const DEVIN_STATUS_BAR = /^(.+?)\s{2,}Context:\s+(\d+)k\s*\/\s*(\d+)k\s+tokens\s*\((\d+)%\)/;

function parseDevinStatusBar(lines: string[]): Record<string, any> {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = DEVIN_STATUS_BAR.exec(lines[i]);
    if (m) {
      return {
        devinModel: m[1].trim(),
        devinTokensK: parseInt(m[2], 10),
        devinTokenBudgetK: parseInt(m[3], 10),
        devinContextPct: parseInt(m[4], 10),
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
    selectable: true,
    badge: 'CL',
    color: { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' },
    launchCommand: 'claude',
    resumeCommand: 'claude --continue',
    promptLaunch: f => `claude "$(cat ${f})"`,
    handoffWriter: true,
    clearCommand: '/clear',
    compactCommand: '/compact',
    processNames: ['claude'],
    statusSources: ['claude-hooks'],
    usageMethod: 'jsonl-scan',
    usagePrecision: 'exact',
  },

  // Claude driven headless by the simple UI's chat runner: one `claude -p`
  // stream-json turn per message, resumed by session id. Never offered in a
  // picker; the simple UI's New chat asks for it by id (CHAT_PROVIDER_ID).
  'claude-chat': {
    id: 'claude-chat',
    displayName: 'Claude (chat)',
    selectable: false,
    badge: 'CC',
    color: { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' },
    launchCommand: '',
    processNames: [],
    statusSources: ['chat-runner'],
    chatRunner: true,
    // The session transcripts are Claude Code's own; usage-scanner reads them.
    usageMethod: 'jsonl-scan',
    usagePrecision: 'exact',
  },

  codex: {
    id: 'codex',
    displayName: 'Codex',
    selectable: false,
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
    selectable: true,
    badge: 'CR',
    color: { base: 'rgba(160, 80, 220, 0.6)', bright: 'rgba(200, 140, 255, 0.9)' },
    launchCommand: 'cursor-agent',
    promptLaunch: f => `cursor-agent "$(cat ${f})"`,
    processNames: ['cursor-agent'],
    statusSources: ['tmux-poller', 'tmux-poller:cursor'],
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
    selectable: false,
    badge: 'GE',
    color: { base: 'rgba(66, 133, 244, 0.6)', bright: 'rgba(120, 170, 255, 0.9)' },
    launchCommand: 'gemini',
    processNames: ['gemini'],
    statusSources: ['tmux-poller:gemini'],
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
    selectable: false,
    badge: 'AG',
    color: { base: 'rgba(255, 152, 0, 0.6)', bright: 'rgba(255, 183, 77, 0.9)' },
    launchCommand: 'auggie',
    processNames: ['auggie'],
    statusSources: ['tmux-poller:augment'],
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
    selectable: false,
    badge: 'DS',
    color: { base: 'rgba(0, 150, 136, 0.6)', bright: 'rgba(77, 208, 195, 0.9)' },
    launchCommand: 'deepseek',
    processNames: ['deepseek'],
    statusSources: ['tmux-poller:deepseek'],
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

  devin: {
    id: 'devin',
    displayName: 'Devin',
    selectable: true,
    badge: 'DV',
    color: { base: 'rgba(236, 72, 153, 0.6)', bright: 'rgba(244, 114, 182, 0.9)' },
    launchCommand: 'devin',
    promptLaunch: f => `devin --prompt-file ${f}`,
    processNames: ['devin'],
    statusSources: ['tmux-poller:devin'],
    needsPoller: true,
    pollerConfig: {
      idlePattern: /^❭\s/m,
      activityPatterns: [
        /^⏺\s+(Read|Searched|Ran|Running|Invoked|Found|Writing|Editing|Reading|Globbing|Grepping|Bash)\b/,
        /^(I'll|Let me|I'm going to|Based on)\b/,
      ],
      waitingPatterns: [
        /↑↓\s+select\s*·\s*↵\s+confirm/,
      ],
      statusBarParser: parseDevinStatusBar,
    },
    usageMethod: 'none',
    usagePrecision: 'estimated',
  },

  // pi: the pi coding agent, on whatever model provider the box owner has
  // configured for it. The launch loads deploy/pi-ext/termag-status.ts and
  // termag-otel.ts (which termag-reconcile installs; the second exports only
  // when the box has a telemetry destination). The status extension posts with source
  // `pi-ext:pi` -- hooks-style like Claude, no poller (the tmux poller is
  // orchestrator-only and this runs on boxes). pi runs tools without approval
  // prompts.
  pi: {
    id: 'pi',
    displayName: 'pi',
    selectable: true,
    badge: 'PI',
    color: { base: 'rgba(217, 119, 6, 0.6)', bright: 'rgba(251, 191, 36, 0.9)' },
    launchCommand: 'pi -e ~/.local/share/termag/pi-ext/termag-status.ts -e ~/.local/share/termag/pi-ext/termag-otel.ts',
    resumeCommand: 'pi -e ~/.local/share/termag/pi-ext/termag-status.ts -e ~/.local/share/termag/pi-ext/termag-otel.ts --continue',
    promptLaunch: f => `pi -e ~/.local/share/termag/pi-ext/termag-status.ts -e ~/.local/share/termag/pi-ext/termag-otel.ts "$(cat ${f})"`,
    handoffWriter: true,
    // pi's own: /new starts a fresh session in the running process (the
    // metaterm server and skills stay loaded; the termag pi extension reports
    // it as idle, not not_running), /compact [instructions] summarizes.
    clearCommand: '/new',
    compactCommand: '/compact',
    processNames: ['pi'],
    statusSources: ['pi-ext:pi'],
    // usage-scanner reads ~/.pi/agent/sessions/**.jsonl (exact per-call usage)
    usageMethod: 'jsonl-scan',
    usagePrecision: 'exact',
  },

  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    selectable: false,
    badge: 'MI',
    color: { base: 'rgba(230, 80, 50, 0.6)', bright: 'rgba(255, 130, 90, 0.9)' },
    launchCommand: 'vibe',
    processNames: ['vibe'],
    statusSources: ['tmux-poller:mistral'],
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
      // Single Braille char with no Braille neighbors \u2014 avoids matching the
      // multi-glyph logo art at the top of the Mistral Vibe TUI.
      spinnerPattern: /(?<![\u2800-\u28FF])[\u2800-\u28FF](?![\u2800-\u28FF])/,
      statusBarParser: parseVibeStatusBar,
    },
    // usage-scanner reads ~/.vibe/logs/session/*/meta.json (the CLI's own
    // session totals); dates are local day at session start, not UTC.
    usageMethod: 'jsonl-scan',
    usagePrecision: 'exact',
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

/** The simple UI's chat provider: accepted on create although no picker offers it. */
export const CHAT_PROVIDER_ID = 'claude-chat';
export function isChatRunnerProvider(id: string | null | undefined): boolean {
  return !!id && PROVIDERS[id]?.chatRunner === true;
}

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
