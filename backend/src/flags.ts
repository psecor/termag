// Every feature flag termag reads, in one place.
//
// The server's variation helpers (services/featureFlags.ts) only accept a
// listed key of the matching kind (BoolFlagKey / StringFlagKey / JsonFlagKey), so a server
// read of an unlisted flag, or of a string flag as a boolean, does not compile. The browser's
// keys live in frontend/src/flags.ts, which cannot import this file; flags.test.ts
// holds the two together: each browser key must be listed here with `client`,
// read with the fallback given here, and each entry must still be read somewhere.
//
// Who maintains a flag is the flag source's business, not this file's.

export interface FlagSpec {
  kind: 'boolean' | 'string' | 'json';
  // What every read falls back to when TERMAG_FLAGS does not set the key.
  // A json flag falls back to null: its reader's code defaults, key by key.
  fallback: boolean | string | null;
  // The contexts the server evaluates it for (services/ldContext.ts):
  // `user`, `user+box` (multi: the owner and the box), or `pool` (the warm
  // pool's fixed box context). Empty when only the browser reads it.
  server: ReadonlyArray<'user' | 'user+box' | 'pool'>;
  // Read by the browser too, through the bootstrap: the flag must be marked
  // available to the browser (GET /api/flags).
  client: boolean;
  // `release`: gates something new; remove the flag (and its off path) once
  // it has been on for everyone for a while. `kill-switch`: kept on purpose
  // so something can be turned off without a deploy. `config`: carries a
  // value rather than an on/off decision.
  lifecycle: 'release' | 'kill-switch' | 'config';
  // The PR that added it.
  addedIn: string;
  // Where its behaviour is described.
  docs?: string;
  purpose: string;
}

export const FLAG_REGISTRY = {
  'hyperspace-background-enabled': {
    kind: 'boolean', fallback: true, server: [], client: true, lifecycle: 'kill-switch', addedIn: '#23',
    docs: 'AGENTS.md',
    purpose: 'The animated background; ANDed with the user\'s theme, so it can only turn the starfield off.',
  },
  'warm-pool-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#106',
    purpose: 'Claim a warm box from Add box, and the pool-depth line.',
  },
  'repo-first-gate-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#226',
    purpose: 'Adding a managed box requires a stored GitHub token.',
  },
  'repo-first-picker-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#312',
    purpose: 'Pick a repository in the New project form.',
  },
  'mobile-redirect-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#212',
    purpose: 'Send phone-sized viewports to the mobile client at /m.',
  },
  'claude-cloud-sessions-ui': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#244',
    purpose: 'Claude Code cloud sessions in the sidebar and the mobile inbox.',
  },
  'box-auto-lifecycle-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#301',
    purpose: 'A box hibernates, and later terminates, on its own after its idle window.',
  },
  'box-auto-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#270',
    docs: 'AGENTS.md',
    purpose: 'The orchestrator asks a box behind the current image to pull and restart its agent; off is the fleet-wide stop.',
  },
  'box-hibernation-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'pool'], client: false, lifecycle: 'release', addedIn: '#379',
    docs: 'docs/box-hibernation.md',
    purpose: 'New boxes, and the warm pool, launch hibernation-capable.',
  },
  'box-image': {
    kind: 'string', fallback: '', server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#331',
    docs: 'docs/box-hibernation.md',
    purpose: 'The AMI a user\'s boxes launch from: a pinned ami-… or a channel; empty is the published image.',
  },
  'box-sharing-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#397',
    docs: 'AGENTS.md',
    purpose: 'Sending and accepting new project shares; existing shares are never behind it.',
  },
  'spaces-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#385',
    purpose: 'Spaces, shared file stores across boxes; off, every /api/spaces route answers 404.',
  },
  'spaces-sharing-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#385',
    purpose: 'Adding people to a space.',
  },
  'simple-ui-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#399',
    purpose: 'The chat-first client at /chat and its sidebar entry.',
  },
  'agent-spawn-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#396',
    purpose: 'An agent can start another agent on a brief (POST /api/spawns), read for the box the child runs on.',
  },
  'agent-spawn-limits': {
    kind: 'json', fallback: null, server: ['user+box', 'user'], client: false, lifecycle: 'config', addedIn: '#428',
    purpose: 'Spawn limits and hot-box thresholds as tuning parameters; malformed keys fall back one by one to DEFAULT_SPAWN_LIMITS.',
  },
  'slack-collab-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#427',
    purpose: 'Slack collaboration cards to colleagues, with replies back to the session.',
  },
  'agent-handoff-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#433',
    purpose: 'Hand an agent pane off: it writes a handoff, the pane is cleared, compacted or restarted, and the next agent starts on it.',
  },
} as const satisfies Record<string, FlagSpec>;

export type FlagKey = keyof typeof FLAG_REGISTRY;
type Registry = typeof FLAG_REGISTRY;
export type BoolFlagKey = { [K in FlagKey]: Registry[K]['kind'] extends 'boolean' ? K : never }[FlagKey];
export type StringFlagKey = { [K in FlagKey]: Registry[K]['kind'] extends 'string' ? K : never }[FlagKey];
export type JsonFlagKey = { [K in FlagKey]: Registry[K]['kind'] extends 'json' ? K : never }[FlagKey];

export function isFlagKey(key: string): key is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAG_REGISTRY, key);
}
