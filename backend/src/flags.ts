// Every feature flag termag reads, in one place.
//
// The server's variation helpers (services/featureFlags.ts) only accept a
// listed key of the matching kind (BoolFlagKey / StringFlagKey / NumberFlagKey / JsonFlagKey), so a server
// read of an unlisted flag, or of a string flag as a boolean, does not compile. The browser's
// keys live in frontend/src/flags.ts, which cannot import this file; flags.test.ts
// holds the two together: each browser key must be listed here with `client`,
// read with the fallback given here, and each entry must still be read somewhere.
//
// Who maintains a flag is the flag source's business, not this file's.

export interface FlagSpec {
  kind: 'boolean' | 'string' | 'number' | 'json';
  // What every read falls back to when TERMAG_FLAGS does not set the key.
  // A json flag falls back to null: its reader's code defaults, key by key.
  fallback: boolean | string | number | null;
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
  'claude-runner-auto-box-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#191',
    purpose: 'A Claude Code cloud session whose owner has no usable box gets one: a stopped box started, a warm box claimed, else a cold box.',
  },
  'claude-runner-anthropic-git-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#287',
    purpose: 'A Claude Code cloud session fetches and pushes through Anthropic-managed git with the owner\'s claude.ai GitHub token; the termag GitHub credential becomes advisory for it.',
  },
  'claude-runner-auto-user-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#288',
    purpose: 'The spawn route creates the termag user for a first-time Claude Code cloud session owner the allowlist admits; read on the claude:<account id> placeholder key, and only where claude-runner-auto-box-enabled is on for it.',
  },
  'claude-runner-slack-notices-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#289',
    purpose: 'A Slack DM to a Claude Code cloud session\'s owner about what termag did or needs for it: one per owner, session and refusal, and a weekly GitHub reminder.',
  },
  'box-auto-lifecycle-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#301',
    purpose: 'A box hibernates, and later terminates, on its own after its idle window.',
  },
  'box-idle-stop-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#670',
    purpose: 'A box with no auto-park setting is parked after a 2 h default idle window: hibernated when it can be, plainly stopped when it cannot.',
  },
  'box-auto-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#270',
    purpose: 'The orchestrator asks a box behind the current image to pull and restart its agent; off is the fleet-wide stop.',
  },
  'box-hibernation-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'pool'], client: false, lifecycle: 'release', addedIn: '#379',
    docs: 'docs/box-hibernation.md',
    purpose: 'New boxes, and the warm pool, launch hibernation-capable.',
  },
  'box-warm-pool-size': {
    kind: 'number', fallback: 5, server: ['pool'], client: false, lifecycle: 'config', addedIn: '#482',
    purpose: 'How many claimable warm boxes the pool holds, clamped to 0..20; 0 drains it. Read for the fixed pool context.',
  },
  'box-image': {
    kind: 'string', fallback: '', server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#331',
    docs: 'docs/box-hibernation.md',
    purpose: 'The AMI a user\'s boxes launch from: a pinned ami-… or a channel; empty is the published image.',
  },
  'box-sharing-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#397',
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
  'spaces-html-links-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#596',
    purpose: 'A space file link renders an HTML file as a sandboxed page instead of downloading it.',
  },
  'simple-ui-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#399',
    purpose: 'The chat-first client at /chat and its sidebar entry.',
  },
  'chat-live-input-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#507',
    purpose: 'A chat message sent while a turn runs goes into that turn (agent chat-live-v1), so a turn waiting on a background task still answers; off, it queues behind the turn.',
  },
  'chat-image-input-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#544',
    purpose: 'Images in simple-UI chat messages (drag, paste or pick; agent chat-images-v1), delivered to Claude as image blocks; off, the composer offers none and a send with images answers 403. The composer learns it from GET …/chat, not the bootstrap.',
  },
  'agent-spawn-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#396',
    purpose: 'An agent can start another agent on a brief (POST /api/spawns), read for the box the child runs on.',
  },
  'agent-spawn-limits': {
    kind: 'json', fallback: null, server: ['user+box', 'user'], client: false, lifecycle: 'config', addedIn: '#428',
    purpose: 'Spawn limits and hot-box thresholds as tuning parameters; malformed keys fall back one by one to DEFAULT_SPAWN_LIMITS.',
  },
  'automations-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#483',
    purpose: 'Automations: a project whose prompt a fresh agent runs on a cron schedule, read for the owner and the box its runs land on; off, create and Run now answer 403 and the scheduler skips every occurrence.',
  },
  'automation-limits': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#483',
    purpose: 'Automation limits (minimum interval, enabled per user, run minutes, daily budget, runs per box) as tuning parameters; malformed keys fall back one by one to DEFAULT_AUTOMATION_LIMITS.',
  },
  'spawn-lifecycle-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#445',
    purpose: 'The spawn sweep parks finished delegates (stops their CLI) and retires parked ones whose work landed (removes the workstream), read for the child\'s box.',
  },
  'slack-collab-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#427',
    purpose: 'Slack collaboration cards to colleagues, with replies back to the session.',
  },
  'agent-handoff-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#433',
    purpose: 'Hand an agent pane off: it writes a handoff, the pane is cleared, compacted or restarted, and the next agent starts on it.',
  },
  'browser-pane-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#463',
    purpose: 'The browser pane under the ctrl terminal: a headless Chromium on the box, screencast into the workspace; read for the viewer and the project\'s box.',
  },
  'browser-pane-preview-share-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#520',
    purpose: 'Preview shares: an owner shares one workstream\'s browser pane with a named termag user, whose own sandboxed browser reaches only the shared app; read for the project\'s owner and box.',
  },
  'browser-pane-guest-kill-switch': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#520',
    purpose: 'On: no guest browser panes at all. Checked at every guest attach and every 30 s on each live guest socket, which it closes; read for the project\'s owner and box.',
  },
  'browser-pane-preview-share-ttl-hours': {
    kind: 'number', fallback: 24, server: ['user+box'], client: true, lifecycle: 'config', addedIn: '#520',
    purpose: 'A preview share\'s default lifetime in hours; clamped to 1..168 (services/previewShareRules.ts ttlHours); read for the owner and box.',
  },
  'browser-pane-guest-max-concurrent': {
    kind: 'number', fallback: 5, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#520',
    purpose: 'Guest browsers per box, live plus parked; clamped to 0..10 here and in the agent (one signed-in webapp tab is about 1.3 GB); read for the owner and box.',
  },
  'browser-pane-pr-link-shares-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#580',
    purpose: 'PR link shares (phase 2): an owner shares a pull request\'s preview by a link, posted on the PR, that any signed-in termag user can open, ended by the PR\'s merge or close; read for the project\'s owner and box, beside browser-pane-preview-share-enabled.',
  },
  'browser-pane-guest-wake-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#581',
    purpose: 'A PR link share\'s reviewer may wake the owner\'s box when the idle sweep hibernated it (never one the owner stopped), within a budget of one per 30 minutes and six a day per owner; read for the owner and box, so it can be switched off alone.',
  },
  'browser-pane-persistent-profiles-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#519',
    purpose: 'Browser panes keep their Chromium profile past the 60 s park, so a sign-in survives (owners keep loopback cookies only); read for the project\'s owner and box.',
  },
  'mobile-installed-app-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#401',
    purpose: 'An app installed on a touch device always opens the phone client at /m, and its Full UI lasts one window; off, it follows mobile-redirect-enabled like a tab.',
  },
  'mobile-web-push-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#403',
    purpose: 'Web push to the owner\'s phone when a session starts waiting; off, push reads as not available, nothing is sent and chat posts are never muted for it.',
  },
  'fireworks-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'user+box'], client: false, lifecycle: 'release', addedIn: '#585',
    purpose: 'Fireworks models through the termag gateway: the Fireworks backend in the pickers (GET /api/providers/models, user), the gateway\'s ext_authz and delivery to boxes (user+box).',
  },
  'fireworks-models': {
    kind: 'json', fallback: null, server: ['user', 'user+box'], client: false, lifecycle: 'config', addedIn: '#585',
    purpose: 'The Fireworks models a person may pick and call through the termag gateway: { default, fast, models: [{ id, label?, context? }] }; the gateway refuses any other. Off or malformed = none.',
  },
  'mcp-broker-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'user+box'], client: true, lifecycle: 'release', addedIn: '#525',
    purpose: 'MCP connectors through the termag MCP broker: the Settings section and API (user), the broker\'s ext_authz and delivery to boxes (user+box).',
  },
  'box-rename-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#552',
    purpose: 'Renaming a box: the box menu\'s Rename item and `termag box rename`; off, both rename routes answer 403 rename_disabled.',
  },
  'chat-turn-notifications-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#546',
    purpose: 'Simple UI: notify a person who opted in when a chat they can see finishes its turn (web push, else the open tab); off, nothing is sent and the Settings switch is hidden.',
  },
  'simple-ui-side-panel-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#598',
    purpose: 'Simple UI: a collapsible side panel beside a conversation with its ctrl terminal and (with browser-pane-enabled) its browser pane; where the user has spaces, also the sidebar of open tabs grouped by space (agents, space files and new tabs in the person\'s order: new on top, drag or Alt+Up/Down to move within a space, ⋮ or a right click to duplicate or close) under New session with each space\'s + menu, and a Files tab with the space\'s explorer of agents, subagents and files, shown beside a space file and on a new tab too, with the file viewer, rounded tooltips, and space file links opening in the simple UI; the terminal and browser sockets keep their own access checks.',
  },
  'simple-ui-session-titles-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#658',
    purpose: 'Simple UI: each sidebar row leads with Claude\'s own title for its session (a /rename, else the one Claude generated), with the project and workstream under it. Read for the sender of a chat message, which asks the box to report the title at turn end; off, nothing is reported and the sidebar names the project as before.',
  },
  'chat-voice-input-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#599',
    purpose: 'Simple UI: a mic button in the composers that dictates into the prompt box with the browser\'s Web Speech API, or with Whisper running in the browser where that fails or is missing (Arc, Brave, Firefox; model served from /termag/speech/); no termag server side. Off, or off a secure context, there is no button.',
  },
  'slack-bot-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'kill-switch', addedIn: '#573',
    docs: 'deploy/setup.md',
    purpose: 'Who may use /t from Slack on the projects they own or were shared, read for the termag user the Slack account\'s email matches; off or unmatched, the bot ignores them. DMs and @mentions run claude as the backend\'s own user, so they stay with the Slack ids in ALLOWED_SLACK_USERS, who also reach any project.',
  },
  'desktop-app-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#645',
    purpose: 'The termag desktop app (a T3 Code fork): the CLI routes only it calls (workstream create and remove, clone retry, box hibernate); off, each answers 404 not_found.',
  },
  'pr-review-groups-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#667',
    purpose: 'Review groups in the PR overlay and the phone: named, ordered lists of PRs reviewed together, as a card at the top of Needs you and Needs my review, Add to group on a PR, and suggested groups. Read for the user on GET /api/prs: on, the descriptions of reviews asked of them are read to suggest groups. Off, there is no card, no Add to group and no suggestion (nor its GitHub read); stored groups are left alone and still served.',
  },
} as const satisfies Record<string, FlagSpec>;

export type FlagKey = keyof typeof FLAG_REGISTRY;
type Registry = typeof FLAG_REGISTRY;
export type BoolFlagKey = { [K in FlagKey]: Registry[K]['kind'] extends 'boolean' ? K : never }[FlagKey];
export type StringFlagKey = { [K in FlagKey]: Registry[K]['kind'] extends 'string' ? K : never }[FlagKey];
export type NumberFlagKey = { [K in FlagKey]: Registry[K]['kind'] extends 'number' ? K : never }[FlagKey];
export type JsonFlagKey = { [K in FlagKey]: Registry[K]['kind'] extends 'json' ? K : never }[FlagKey];

export function isFlagKey(key: string): key is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAG_REGISTRY, key);
}
