// Every feature flag termag reads, in one place.
//
// The server's variation helpers (services/featureFlags.ts) only accept a
// listed key of the matching kind (BoolFlagKey / StringFlagKey / NumberFlagKey / JsonFlagKey), so a server
// read of an unlisted flag, or of a string flag as a boolean, does not compile. The browser's
// keys live in frontend/src/flags.ts, which cannot import this file; flags.test.ts
// holds the two together: each browser key must be listed here with `client`,
// read with the fallback given here, and each entry must still be read somewhere.
//
// Entries are in alphabetical order by key, and flags.test.ts fails otherwise:
// insert a new flag where it sorts, not at the end, so two PRs that each add one
// do not conflict. `node scripts/sort-flags.mjs` sorts both files.
//
// Who maintains a flag is the flag source's business, not this file's.

export interface FlagSpec {
  kind: 'boolean' | 'string' | 'number' | 'json';
  // What every read falls back to when TERMAG_FLAGS does not set the key.
  // A json flag falls back to null: its reader's code defaults, key by key.
  fallback: boolean | string | number | null;
  // The contexts the server evaluates it for (services/ldContext.ts):
  // `user`, `user+box` (multi: the owner and the box), `user+box+repo` (the
  // same plus a `repo` context keyed `owner/name`), `pool` (the warm
  // pool's fixed box context), `service` (the orchestrator process,
  // serviceLdContext), `service+slack` (the same plus the Slack workspace,
  // `slack-workspace` keyed T…, and its Enterprise Grid org, `slack-org`
  // keyed E…, serviceSlackFlagContext), or `orchestrator` (the orchestrator host's fixed box
  // context, services/toolUpdate/orchestrator.ts). Empty when only the
  // browser reads it.
  server: ReadonlyArray<'user' | 'user+box' | 'user+box+repo' | 'pool' | 'service' | 'service+slack' | 'orchestrator'>;
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
  'agent-handoff-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#433',
    purpose: 'Hand an agent pane off: it writes a handoff, the pane is cleared, compacted or restarted, and the next agent starts on it.',
  },
  'agent-spawn-limits': {
    kind: 'json', fallback: null, server: ['user+box', 'user'], client: false, lifecycle: 'config', addedIn: '#428',
    purpose: 'Spawn limits and hot-box thresholds as tuning parameters; malformed keys fall back one by one to DEFAULT_SPAWN_LIMITS.',
  },
  'api-broker-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'user+box'], client: false, lifecycle: 'release', addedIn: '#1311',
    purpose: 'The API broker in the MCP broker: a box calls a provider\'s REST API as <broker>/c/<provider>@<host>/<path> and the check adds the owner\'s OAuth token from their MCP connectors (services/apiBroker.ts), user+box; and the Google connector under Settings → MCP servers → Available to connect, user. Off, both are refused or hidden; connectors already made stay. Read in services/mcpConnectorStore.ts apiBrokerEnabledForUser/ForBox.',
  },
  'ask-completion-notify-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#0',
    purpose: "When an ask finishes, termag tells the session that sent it (a turn of its chat, or a line typed into its idle agent pane), metadata only, read for the asker when the notice is due; off, the finish is only in `termag ask --inbox`.",
  },
  'ask-model-choice-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1322',
    purpose: "`termag ask --model` and `project create --model` (services/askModelFlag.ts), read for the asker and the target box: the turn launches on the tier, which the thread's chat keeps. Off, a requested model is ignored as an older box agent's is (the box's default, modelIgnored says why), and an ask thread's stored tier is not applied.",
  },
  'automation-limits': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#483',
    purpose: 'Automation limits (minimum interval, enabled per user, run minutes, daily budget, runs per box) as tuning parameters; malformed keys fall back one by one to DEFAULT_AUTOMATION_LIMITS.',
  },
  'automation-space-folder-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#0',
    purpose: "An automation in a space lives in a folder of it (state, run logs, README, the space section of the brief), read for the owner; off, only the notes file is mirrored, as before.",
  },
  'automations-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#483',
    purpose: 'Automations: a project whose prompt a fresh agent runs on a cron schedule, read for the owner and the box its runs land on; off, create and Run now answer 403 and the scheduler skips every occurrence.',
  },
  'aws-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1110',
    purpose: 'AWS CLI v2 update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z; the box installs only AWS\'s zip for that version, its signature verified with AWS\'s key), restart (the AWS CLI has no sessions, so none of them restarts anything), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_AWS_UPDATE_POLICY (services/awsUpdatePolicy.ts: floor 2.35.3 from the advisories, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'box-auto-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#270',
    purpose: 'The orchestrator asks a box behind the current image to pull and restart its agent; off is the fleet-wide stop.',
  },
  'box-bazel-cache-config': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1201',
    purpose: 'The shared Bazel cache block\'s settings over code defaults, each clamped (services/bazelCache.ts parseBazelCacheConfig): remoteTimeoutSeconds, remoteRetries, jobs, downloadOutputs, flushGeneration, goHostModcache. Never the URL or bucket: unknown keys are ignored.',
  },
  'box-bazel-cache-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'kill-switch', addedIn: '#1201',
    purpose: 'Delivers the shared Bazel cache block (/etc/bazel.bazelrc) to the owner\'s box; off removes it within about a minute. Kept as the cache\'s kill switch, not removed after rollout. The browser reads it only for What\'s new\'s entry about the cache.',
  },
  'box-default-size': {
    kind: 'string', fallback: '', server: ['user', 'pool'], client: false, lifecycle: 'config', addedIn: '#0',
    docs: 'docs/box-provisioning.md',
    purpose: 'The size new boxes launch at (small, medium, large), and the one the warm pool holds; any value also lets a person pick a size. Empty is BOX_INSTANCE_TYPE, as before sizes.',
  },
  'box-idle-park-hours': {
    kind: 'number', fallback: 2, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#620',
    purpose: "The default idle window in hours; anything but a whole number from 1 to 720 is the 2 h default (boxLifecyclePolicy.ts idleStopHours). Read for the owner and box.",
  },
  'box-idle-park-warn-minutes': {
    kind: 'number', fallback: 120, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#620',
    purpose: "How long before the default idle window's stop the owner is warned, in minutes (0 to a week), never more than half the window (boxLifecyclePolicy.ts warnLeadMs). Read for the owner and box.",
  },
  'box-image': {
    kind: 'string', fallback: '', server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#331',
    docs: 'docs/box-hibernation.md',
    purpose: 'The AMI a user\'s boxes launch from: a pinned ami-… or a channel; empty is the published image.',
  },
  'box-port-forward-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#724',
    purpose: 'The native port forward (termag forward): GET /api/cli/v1/boxes/:id/forward (the probe) and the forward socket at /api/cli/v1/boxes/:id/forward/:port, relayed to the box\'s loopback port over an agent tunnel. Owner and device sign-in only; off, both answer 404 not_found. The browser reads it only for What\'s new.',
  },
  'box-root-volume-performance': {
    kind: 'json', fallback: null, server: ['pool'], client: false, lifecycle: 'config', addedIn: '#1216',
    docs: 'docs/box-provisioning.md',
    purpose: 'Throughput (MiB/s) and IOPS a new box\'s root gp3 volume gets above the free 125 MiB/s and 3,000 IOPS: { "throughput": n, "iops": n } (boxVolumePerformance.ts). Not an object, or neither field above the baseline, is off; each field is clamped to 125..1000 and 3,000..16,000, and per launch to 500 IOPS per GiB and 0.25 MiB/s per IOPS (throughput lowered to fit). A refusal relaunches at the baseline. Billed per volume-month while the volume exists, stopped boxes too. Read for the fixed pool context on every launch, pool or not; not in the pool spec hash, so changing it does not roll the pool, and existing boxes keep what they launched with.',
  },
  'box-sharing-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#397',
    purpose: 'Sending and accepting new project shares; existing shares are never behind it.',
  },
  'box-volume-initialization-rate': {
    kind: 'number', fallback: 0, server: ['pool'], client: false, lifecycle: 'config', addedIn: '#1210',
    docs: 'docs/box-provisioning.md',
    purpose: 'MiB/s at which EBS initializes a new box\'s root volume from the image snapshot (RunInstances VolumeInitializationRate), so first reads are not lazy S3 fetches; 0 or less is off, anything else is clamped to 100..300 (boxVolumeInitRate.ts). Billed per GiB of snapshot data per launch, and used in place of fast snapshot restore where both apply. Read for the fixed pool context on every launch, pool or not; not in the pool spec hash, so changing it does not roll the pool.',
  },
  'box-wake-on-action-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#1470',
    purpose: 'An action on a project whose box is parked wakes the box instead of refusing with "This box is stopped…". First user: POST /projects/:id/review (routes/review.ts), from the web and the phone: on a parked box of the caller\'s own, it starts the box through the owner-only path POST /instances/:id/start takes and holds the review start in memory (services/reviewHeld.ts), answering 202. The start runs once the box is ready, and GET …/review/held says how it is going. Someone else\'s box answers a 409 that says who can wake it. Off, the 409 is as before.',
  },
  'box-warm-pool-size': {
    kind: 'number', fallback: 5, server: ['pool'], client: false, lifecycle: 'config', addedIn: '#482',
    purpose: 'How many claimable warm boxes the single-size pool holds, clamped to 0..20; 0 drains it. Only applies to that pool: sizes off for the pool, or box-warm-pool-sizes unset or malformed. When box-warm-pool-sizes serves an object, this flag is not read. Read for the fixed pool context.',
  },
  'box-warm-pool-sizes': {
    kind: 'json', fallback: null, server: ['pool'], client: false, lifecycle: 'config', addedIn: '#0',
    docs: 'docs/box-provisioning.md',
    purpose: 'How many warm boxes the pool holds of each size, e.g. {"small":4,"medium":2,"large":2}; read for the fixed pool context while box-default-size is on for it. A served object\'s counts are the pool: their sum is the total and box-warm-pool-size is ignored. A size left out takes DEFAULT_WARM_POOL_SIZES (4/2/2). The total is clamped in code to 20, filled smallest size first (15/15/15 is 15/5/0), with a warning; no size has a limit of its own. Unset or malformed (not an object, or a count that is not a whole number of 0 or more) is the single-size pool of box-warm-pool-size.',
  },
  'browser-pane-guest-kill-switch': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#520',
    purpose: 'On: no guest browser panes at all. Checked at every guest attach and every 30 s on each live guest socket, which it closes; read for the project\'s owner and box.',
  },
  'browser-pane-guest-max-concurrent': {
    kind: 'number', fallback: 5, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#520',
    purpose: 'Guest browsers per box, live plus parked; clamped to 0..10 here and in the agent (one signed-in webapp tab is about 1.3 GB); read for the owner and box.',
  },
  'browser-pane-pr-auto-share-default': {
    kind: 'boolean', fallback: false, server: ['user+box+repo'], client: false, lifecycle: 'config', addedIn: '#681',
    purpose: 'Whether a project shares the PRs its owner opens automatically (4c) until its owner saves the PR previews settings; saving keeps what the dialog showed. Read for the owner, the box and the project\'s repository, so a repository can default on.',
  },
  'browser-pane-pr-draft-shares-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box+repo'], client: false, lifecycle: 'release', addedIn: '#681',
    purpose: 'A draft pull request may have a link share: shared automatically when it is opened, and from the Share preview button. Read for the owner, the box and the project\'s repository.',
  },
  'browser-pane-preview-share-ttl-hours': {
    kind: 'number', fallback: 24, server: ['user+box'], client: true, lifecycle: 'config', addedIn: '#520',
    purpose: 'A preview share\'s default lifetime in hours; clamped to 1..168 (services/previewShareRules.ts ttlHours); read for the owner and box.',
  },
  'chat-confined-mcp-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1431',
    purpose: 'Simple UI chat: a confined turn (dontAsk, auto) of the box\'s owner gets their MCP broker connectors, rebuilt by the box from its record, with a reviewed allowlist of read tools (services/chatConfinedMcp.ts CATALOG_READ_TOOLS; dontAsk refuses every other MCP call, auto hands it to its classifier), and anyone else\'s turn on that box (a sharee\'s) gets none, a bypassPermissions one included. An automation\'s turns get them only when all the run produces stays with the owner: a private space of theirs or none, no Slack report or channel, the project shared with nobody (services/chatConfinedMcp.ts automationStaysWithOwner). Read for the owner and the box on each send and Open in full UI, and on an automation run\'s brief; needs agent chat-confined-mcp-v1. Off, or on an older agent, confined turns load no MCP server and bypass turns load the box\'s own.',
  },
  'chat-file-attachments-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#1478',
    purpose: 'Simple UI: any file attached to a chat message that does not go in its text (a zip, a spreadsheet, a binary, text over the inline cap) is uploaded through POST …/chat/files and kept in the chat\'s checkout on its box (agent chat-files-v1, chat-file-put), and the message names its path. Read for the person attaching: GET …/chat says fileInput, and the upload route answers 404 when off; the browser reads it too, to hide the upload and for its What\'s new entry. Off, the composer takes images, PDFs and text files only, as before.',
  },
  'chat-generative-ui-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'kill-switch', addedIn: '#793',
    purpose: 'Simple UI: generative UI in the SDK chat. A ```spec fence in a reply (a json-render spec over a fixed catalog of LaunchPad components, chat/genui/catalog.ts) is drawn as those components, and their buttons and forms answer the agent with an ordinary chat message (chat/genui/action.ts). Read for the sender of a chat message: on, the turn gets the catalog\'s system prompt (services/chatGenUi.ts, agent chat-genui-v1). Off, a spec fence is a plain code block and no prompt is sent.',
  },
  'chat-generative-ui-hint-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#898',
    purpose: 'Generative UI\'s prompt, split: read for the sender of a chat message that gets generative UI (chat-generative-ui-enabled). On, a box agent that files the prompt (chat-genui-v2) gets the hint too: its turn carries only the hint (a few hundred tokens: when UI helps, the components, read the reference first) and the whole prompt is a file the agent reads before its first UI. Off, or an older agent, every such turn carries the whole prompt (about 11k tokens), as before.',
  },
  'chat-nested-agents-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#1536',
    purpose: 'Simple UI: the agents an agent runs, nested under it, and Archive in Files. In a chat\'s drawer and context card, a subagent\'s own subagents and an ask\'s own subagents and asks sit under its row; in a space\'s Files, an agent\'s Claude subagents sit under it, read when its row is expanded, and a session\'s ⋮ has Archive, which moves it and the agents under it to an Archived fold (Workstream.explorerArchivedAt, POST …/workstreams/:id/explorer-archive, owner only; the session and its box are untouched) with Unarchive. Off, both lists are flat as before and Files offers no archive.',
  },
  'chat-pane-subagents-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#1418',
    purpose: 'Simple UI: the Agent-tool subagents of a pane Claude (a project made in Lab) in the pane chat, read from beside its session by its box (agent pane-subagents-v1) through GET …/chat/pane-subagents and GET …/chat/pane-subagents/:agentId. Off, both routes answer 404 and the pane chat is unchanged.',
  },
  'chat-plan-spend-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#705',
    purpose: 'Simple UI: the session composer\'s context ring shows the box owner\'s Claude Enterprise monthly spend. Read for the project\'s owner when they send a chat message, which asks the box to read the spend from Anthropic\'s undocumented usage endpoint with its claude.ai login after the answer, at most once a minute, and to send only the numbers to the owner\'s view; off, and for a collaborator\'s send, the box never calls the endpoint and the ring shows no spend.',
  },
  'chat-session-references-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#947',
    purpose: 'Simple UI: drag a session from the sidebar (a row or a tab) into a composer, and the message gets a reference to it at the drop point: what the sidebar calls it and the `termag ask` (with --thread for an ask\'s chat) that messages it. A session that can\'t be asked (shared, a cloud session, not on a box of yours) says why instead. No server side: the drag is all browser, and an ask checks itself.',
  },
  'chat-subagents-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#932',
    purpose: 'Simple UI: subagents in the SDK chat. Under the chrome refresh an Agent call is a row that opens the subagent\'s whole transcript in the side panel\'s agent tab, read from its box by GET …/chat/subagents/:agentId (agent chat-subagents-v1). It also answers the asks a chat sent (`termag ask` from Bash; GET …/chat/asks). Off, the call is a tool card and both routes answer 404.',
  },
  'chat-turn-notifications-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#546',
    purpose: 'Simple UI: notify a person who opted in when a chat they can see finishes its turn (web push, else the open tab); off, nothing is sent and the Settings switch is hidden.',
  },
  'chat-worktree-sessions-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#701',
    purpose: 'Simple UI: New session on one of your boxes that already has the repository in one of your chat projects can start as a worktree of that project, from a freshly fetched origin/<default> or off its checkout, with its permissions; from a fetch it asks Full access or Read only as a fresh clone does (Full access only on a project with its trust tick). Read for the caller of POST /api/projects/:id/workstreams with a `fetch`: on, the fetch is honoured, and a box with worktree-fetch-attended-v1 leaves the tree unmarked (a person asked for it); off, the fetch is dropped and the add is a plain branch-off from the body\'s base, as before. Off, New session offers no worktree.',
  },
  'claude-cloud-sessions-ui': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#244',
    purpose: 'Claude Code cloud sessions in the sidebar and the mobile inbox.',
  },
  'claude-code-update-policy': {
    kind: 'json', fallback: null, server: ['user+box', 'orchestrator'], client: false, lifecycle: 'config', addedIn: '#0',
    purpose: 'Claude Code update policy: floor, target (latest, stable or x.y.z), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_CLAUDE_UPDATE_POLICY (services/claudeUpdatePolicy.ts). The floor goes to a v3 runner wrapper as --claude-floor. mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none, and a v3 runner wrapper still enforces the floor; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'claude-runner-anthropic-git-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#287',
    purpose: 'A Claude Code cloud session fetches and pushes through Anthropic-managed git with the owner\'s claude.ai GitHub token; the termag GitHub credential becomes advisory for it.',
  },
  'claude-runner-auto-box-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#191',
    purpose: 'A Claude Code cloud session whose owner has no usable box gets one: a stopped box started, a warm box claimed, else a cold box.',
  },
  'claude-runner-auto-user-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#288',
    purpose: 'The spawn route creates the termag user for a first-time Claude Code cloud session owner the allowlist admits; read on the claude:<account id> placeholder key, and only where claude-runner-auto-box-enabled is on for it.',
  },
  'claude-runner-slack-notices-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#289',
    purpose: 'A Slack DM to a Claude Code cloud session\'s owner about what termag did or needs for it: one per owner, session and refusal, and a weekly GitHub reminder.',
  },
  'codex-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1076',
    purpose: 'Codex update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z; Codex has no stable tag), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_CODEX_UPDATE_POLICY (services/codexUpdatePolicy.ts: floor 0.131.0 from the advisories, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'cursor-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1080',
    purpose: 'Cursor agent update policy, the shape of claude-code-update-policy: floor and target are Cursor builds (YYYY.MM.DD-<hex>), target also latest; restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_CURSOR_UPDATE_POLICY (services/cursorUpdatePolicy.ts: floor 2025.09.17-25b418f from the CLI advisories, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },

  'daily-theme-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'kill-switch', addedIn: '#1338',
    purpose: 'Theme of the day: the "Theme of the day" option in Settings → Appearance, and whether today\'s dated reskin (frontend/src/theme/daily/<Pacific date>/) loads for a person who turned it on. Off, nothing of a day\'s theme is fetched or applied, ?dailyTheme= previews included (nor is an override remembered), and the option is hidden; a saved choice is kept. Kept as the kill switch for a bad day\'s theme, since every day is agent-written CSS and sprite code: not removed after rollout. No server side: the theme validator accepts the key either way.',
  },
  'desktop-live-chat-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'kill-switch', addedIn: '#1230',
    purpose: 'The termag desktop\'s live chat: POST /api/cli/v1/projects/:id/chat/messages and /chat/interrupt, the owner\'s turns on a chat\'s runner as web sends and stops them (routes/cliChats.ts), and whoami features.liveChat; off, both answer 404 not_found and the desktop keeps handing the session over.',
  },
  'devin-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1087',
    purpose: 'Devin CLI update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_DEVIN_UPDATE_POLICY (services/devinUpdatePolicy.ts: floor 3000.11.92, no advisory gives one; restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'docker-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1305',
    purpose: "Docker update policy, the shape of claude-code-update-policy: floor and target (latest or x.y.z, Docker Engine's version; the box installs only what download.docker.com lists, and moves containerd.io and the plugins to that repository's newest), restart (ignored: a run only ever happens at the box's start, before any container runs), drainSec, forceAfterHours; malformed keys fall back one by one to DEFAULT_DOCKER_UPDATE_POLICY (services/dockerUpdatePolicy.ts: floor 29.9.3, the newest Docker Engine advisory's fix, target latest, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab's actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box's policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).",
  },
  'empty-box-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#659',
    purpose: 'Lets a new box have termag setup off (the CLI\'s --no-setup, the API\'s setupEnabled: false, a repository\'s .termag/environment.json "setupEnabled": false, which the CLI states): termag manages the box but delivers no skills, agent config or credentials and takes no warm-pool box. The key keeps the feature\'s first name, "empty box". Only gates turning setup off; a box launched with it off keeps it off with the flag off.',
  },
  'environment-pool-enabled': {
    kind: 'boolean', fallback: false, server: ['pool'], client: false, lifecycle: 'kill-switch', addedIn: '#1453',
    purpose: 'Environment pools: stopped boxes per shared environment with its repositories cloned and its setup run (services/envPool.ts). Off, nothing is prepared or claimed from them, and the boxes already prepared stay stopped. Read for the fixed pool context.',
  },
  'environment-pool-sizes': {
    kind: 'json', fallback: null, server: ['pool'], client: false, lifecycle: 'config', addedIn: '#1453',
    purpose: 'How many env-stopped boxes each shared environment keeps, {"<environment name>": <count>}; an environment not listed has no pool. The total is clamped in code to 20, in name order. Read for the fixed pool context while environment-pool-enabled is on.',
  },
  'environment-selection-enabled': {
    kind: 'boolean', fallback: true, server: ['user'], client: true, lifecycle: 'kill-switch', addedIn: '#1284',
    purpose: 'Environments in the web app and their automatic steps. In the browser: the Environment pickers in New project and New session (and New session\'s ?environment=), the Environments links in both sidebars and the simple UI\'s account menu, the /environments and /chat/environments pages (which redirect home while it is off), and Share\'s "This environment\'s app". On the server, for the project\'s owner: whether a box made for a project sends environment-up after its clone (services/projectEnvironment.ts startEnvironmentAfterClone), so off, no environment\'s steps start on their own. On by default (the fallback), so a flag-source outage keeps both. termag-env on the box, the API, the CLI\'s --environment and the stored environments are not gated.',
  },
  'fireworks-models': {
    kind: 'json', fallback: null, server: ['user', 'user+box'], client: false, lifecycle: 'config', addedIn: '#585',
    purpose: 'The Fireworks models termag offers a person: the pickers, a launch\'s default and fast model, windows and Claude Code\'s /model menu: { default, fast, models: [{ id, label?, context? }] }. Not an allowlist: the gateway\'s check does not read it, and Fireworks\' account governance decides which models run. Off or malformed = none offered.',
  },
  'gh-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1102',
    purpose: 'GitHub CLI update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z; the box installs only the version cli.github.com\'s apt repository lists), restart (gh has no sessions, so none of them restarts anything), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_GH_UPDATE_POLICY (services/ghUpdatePolicy.ts: floor 2.102.0 from the advisories, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'hyperspace-background-enabled': {
    kind: 'boolean', fallback: true, server: [], client: true, lifecycle: 'kill-switch', addedIn: '#23',
    docs: 'docs/agents/configuration.md',
    purpose: 'The animated background; ANDed with the user\'s theme, so it can only turn the starfield off.',
  },
  'light-mode-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#819',
    purpose: 'Light mode: the Dark / Light palette picker in Settings → Appearance. Off, the picker is hidden; a palette already saved still applies. No server side: the theme validator accepts the palette key either way. Remove once the light colour values have landed everywhere.',
  },

  'mcp-default-connectors': {
    kind: 'json', fallback: null, server: ['user'], client: false, lifecycle: 'config', addedIn: '#913',
    purpose: 'The catalog of OAuth MCP servers the orchestrator offers every user, and its on switch: a JSON array of {name, upstream} (services/mcpConnectors.ts defaultConnectors). Settings → MCP → Available to connect, and POST /api/mcp-connectors/catalog/:name/connect. null (off) or [] offers nothing and that route answers 404; connectors already made from it stay.',
  },
  'mcp-oauth-loopback-servers': {
    kind: 'json', fallback: null, server: ['user'], client: false, lifecycle: 'config', addedIn: '#1288',
    purpose: 'The OAuth MCP servers this user links by pasting the redirect: a JSON array of server URLs as pasted into Settings (matched on scheme, host and path, trailing slash ignored; services/mcpOAuthLoopback.ts). For a listed server termag registers and signs in with http://localhost:53682/callback, and Settings → MCP shows a box for the address the browser lands on (POST /api/mcp-connectors/:id/oauth/paste, which refuses servers off the list). For providers that accept only loopback redirects for unlisted clients (New Relic); a URL comes off once the provider supports termag\'s own callback. null (off) or [] lists nothing.',
  },
  'mcp-oauth-scope-labels': {
    kind: 'json', fallback: null, server: ['user'], client: false, lifecycle: 'config', addedIn: '#1286',
    purpose: 'Labels for the OAuth scopes in Settings → MCP servers\' scope checklist, per authorization server: a JSON object keyed by issuer ("https://mcp.slack.com"), each a list of {scope, label} (services/mcpOAuthScopes.ts parseScopeLabels). A value that is not an object (null, the fallback) uses the built-in Slack table; malformed issuers and entries are skipped with a warning. Unlisted scopes show their raw name.',
  },

  'multi-repo-projects-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#729',
    purpose: 'Creating a project that holds several repositories (the New project dialog\'s Add another repository, and the simplified UI picker\'s multi-select); off, POST /api/projects refuses `repos`. Also `termag ask <box>/<project>:<repo>` into one of their repositories; off, every ask into a multi-repo project is refused 409 `multi_repo_disabled`. Existing multi-repo projects keep working either way.',
  },
  'node-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1113',
    purpose: 'Node update policy, the shape of claude-code-update-policy: floor, target (latest: the newest release of the box\'s major; or x.y.z in that major), restart (no session is restarted in this version, so none of them changes anything), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_NODE_UPDATE_POLICY (services/nodeUpdatePolicy.ts: floor 24.22.1 from the security releases, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'onboarding-mcp-step-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#1369',
    purpose: 'The first-run wizard\'s optional MCP servers step, read by the browser for the signed-in user: on, the step shows when the mcp-default-connectors catalog offers a server; off, the wizard has no MCP step. Settings → MCP and the returnTo: "welcome" sign-in return are not gated.',
  },
  'onboarding-refresh-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#886',
    purpose: 'The redrawn first run: sign-in in LaunchPad, saying why a sign-in was refused; a three-step /welcome with a choice of termag or Lab, kept on the user (`users.uiMode`): off, /auth/me leaves it out and PUT /auth/me/preferences refuses it 403 `ui_mode_disabled`. The sign-in page has no user, so it follows what this browser last saw for a signed-in user.',
  },
  'orchestrator-claude-update-policy': {
    kind: 'json', fallback: null, server: ['orchestrator'], client: false, lifecycle: 'config', addedIn: '#1165',
    purpose: "The orchestrator host's own Claude Code target: {target: \"x.y.z\" | null}, read for the orchestrator's fixed box context. Only an exact version is a target (a tag or anything else is refused and logged); null, the default, is the floor only. A pin is run exactly, up or down to it, never below the floor (claude-code-update-policy's, raised to the image's floor file). Both the Software tab's orchestrator row and the nightly run use it. mode (off, manual or auto), read for the same context: off turns off the orchestrator row's update (404 claude_update_off) and the nightly run, and keeps the floor (the boot floor run is not gated); manual, the row is on and there is no nightly run; auto, both. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).",
  },
  'parallel-reviews-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#786',
    purpose: 'Several review panes per workstream: Review on another PR adds a pane (up to 8) stacked under the running ones, and Review on a PR that already has one restarts only that pane. Read for the user on POST …/review; off, a review replaces the workstream\'s one pane as before. Panes already running stay listed either way.',
  },
  'pi-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1088',
    purpose: 'pi update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_PI_UPDATE_POLICY (services/piUpdatePolicy.ts: floor 0.79.0 from the advisories, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'pr-live-updates-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'kill-switch', addedIn: '#931',
    purpose: 'PR live updates (services/prLiveUpdates.ts): when one of the user\'s sessions opens a PR (a chat\'s gh pr create, the hook\'s pr_created milestone), their PR list is read from GitHub again until it has the PR, then their browsers are told (`{type: \'workspace\', what: \'prs\'}` on the status socket) and re-read the context card, the Pull request tab, the PR pills and the PRs tile at once; a chat\'s git push or gh pr merge/ready/close/reopen/edit/review tells them after 3 s. Read for the user when one is seen. Off, nothing is re-read or sent, and the browsers keep their one-minute poll.',
  },
  'preview-links-agent-requests-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1107',
    purpose: 'Preview links phase 3: `termag preview request <port>` on a box files a PreviewLinkRequest for the owner to publish or decline; read for the owner and the box. Off, the request route answers 404.',
  },
  'preview-links-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#1107',
    purpose: 'Preview links: publish a box port at <name>.<preview domain> (routes/previewLinks.ts, routes/cliPreviewLinks.ts), the landing page and the preview host; read for the project\'s owner and box. Off, every publish route answers 404 and live links refuse.',
  },
  'preview-links-kill-switch': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#1107',
    purpose: 'On: no preview host serves anything, and every preview WebSocket closes at its next recheck, without ending any link, so turning it off restores them; read for the link\'s owner and box on every session check.',
  },
  'preview-links-link-audience-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#1107',
    purpose: 'Preview links phase 2: the `people` and `link` audiences (named termag users, or anyone signed in to termag with the link\'s token); read for the project\'s owner and box. Off, publishing one answers 403 `audience_disabled`.',
  },
  'preview-links-ttl-hours': {
    kind: 'number', fallback: 24, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1107',
    purpose: 'A preview link\'s default lifetime in hours, when a publish names none; clamped to 1..168 (services/previewLinkRules.ts); read for the project\'s owner and box.',
  },
  'preview-links-wake-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1107',
    purpose: 'The preview\'s asleep page offers Wake for a box the idle sweep stopped, within the owner\'s guest wake budget; read for the link\'s owner and box.',
  },
  'python-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1219',
    purpose: 'Python update policy, the shape of claude-code-update-policy: floor, target (latest: the newest CPython of the box\'s minor that its uv lists; or x.y.z in that minor), restart (Python has no sessions, so none of them restarts anything), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_PYTHON_UPDATE_POLICY (services/pythonUpdatePolicy.ts: floor 3.13.18, the newest 3.13 security release, restart none). mode (off, manual or auto; services/toolUpdate/gate.ts): off turns off the Software tab\'s actions (404 claude_update_off), the sweep and session restarts, and keeps the floor, and nothing else: a box\'s policy is floor only, restart none; manual, the routes are on and the sweep does nothing; auto, the sweep runs it too. A missing or malformed mode is off, and so is a value the flag source cannot serve (each logged once).',
  },
  'simple-ui-automations-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#852',
    purpose: 'Simple UI: an Automations button beside New session (with a count of live runs) opening /chat/automations, the list of the user\'s own and shared automations, and an automation\'s page with its run history, Run now, Pause/Enable, Resume and Archive. Shown only with automations-enabled too. Browser only: every write goes through /api/automations, which keeps gating on automations-enabled.',
  },
  'simple-ui-chrome-refresh-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#803',
    purpose: 'Simple UI: the chrome refresh, its sidebar, header and side panel redrawn with LaunchPad\'s components in termag\'s own colours and fonts (launchpad/theme.css), landing as a stack of PRs. Off, the simple UI is as it was. Browser only: it changes how the chrome looks, not what anyone may do.',
  },
  'simple-ui-inflight-changes-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'kill-switch', addedIn: '#968',
    purpose: 'In-flight changes on the simple UI\'s context card: GET /api/projects/:id/workstreams/:ws/changes asks the box (agent git-changes-v1) for the files its checkout, or the worktree on the session\'s PR branch, has changed and not pushed or not committed, and the card lists them above the PR\'s, re-read as the session\'s tools finish. Read for the caller; off, the route answers 404 and the card shows the PR\'s files alone.',
  },
  'simple-ui-review-clone-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#1188',
    purpose: 'Simple UI: Review on a PR whose repository none of your projects has clones it first, into a new chat project on one of your boxes (the box of your most recently active project when it is up, else another that is up, else the most recent asleep one, woken through the owner-only start route), waits for the clone, then starts the agent review or review session there (frontend chat/reviewClone.ts). Off, that Review button is disabled and says why under it. No server side: the project goes through the create route, which decides as it always has.',
  },
  'simple-ui-reviews-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#1015',
    purpose: 'Simple UI: PR reviews. The sidebar\'s Reviews section, /chat/reviews and a PR\'s page, starting the lab\'s agent review (Devin, Claude or Cursor) or a review session on a checkout of the PR, the review card and its posting, and the follow-up round. Off, the simple UI has none of it and the lab is unchanged. Read for the caller on the server too: off, GET /api/prs/:owner/:repo/:n/files and /threads answer 404, and POST …/review refuses inline comments or a pinned head (403); the lab\'s summary-only review is unchanged. GET /api/prs reads the user\'s review rounds (pr_review_rounds) only while it is on.',
  },
  'slack-agent-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#555',
    docs: 'deploy/setup.md',
    purpose: 'Slack DMs and @mentions run as Slack agent sessions (streamed, Stop button, choices, attachments) when the app is also declared an agent; off, they answer as before. Only for people DMs and @mentions answer at all (ALLOWED_SLACK_USERS).',
  },
  'slack-bot-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'kill-switch', addedIn: '#573',
    docs: 'deploy/setup.md',
    purpose: 'Who may use /t from Slack on the projects they own or were shared, read for the termag user the Slack account\'s email matches; off or unmatched, the bot ignores them. DMs and @mentions run claude as the backend\'s own user, so they stay with the Slack ids in ALLOWED_SLACK_USERS, who also reach any project.',
  },
  'slack-collab-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#427',
    purpose: 'Slack collaboration cards to colleagues, with replies back to the session.',
  },
  'slack-interactions-enabled': {
    kind: 'boolean', fallback: true, server: ['service+slack'], client: false, lifecycle: 'kill-switch', addedIn: '#1514',
    docs: 'deploy/setup.md',
    purpose: "The Slack app's off switch, read on every Slack event and every Web API call (services/slackInteractionsFlag.ts) for the orchestrator's service context plus the Slack workspace (slack-workspace, key T…, with name and enterpriseId) and its Enterprise Grid org (slack-org, key E…): the event's own for an event, the bot's (auth.test, once per process) for the app's client, so it can be off in one workspace or org and on in another. Off, termag does nothing in Slack: events, slash commands (an ephemeral \"not available yet\"), buttons, shortcuts and views are acked and dropped, and the app's client refuses every call but auth.test, so DMs, notices, collab cards, briefings, reports and space channels stop. The Slack MCP connector keeps working: its sign-in uses the termag Slack app as OAuth client and auth.test to pin the workspace, and its calls carry each person's own token. Falls back on without a flag source; with one configured but not yet answering, Slack stays off.",
  },
  'slack-router-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#1346',
    purpose: 'Slack DMs and @mentions outside space channels go through the router (the requester\'s own spaces only): routed to a space orchestrator, a question, or a cross-space answer. Read for the person writing. Off: today\'s behaviour. Registered ahead of the router (M11); nothing routes yet.',
  },
  'slack-router-overview-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#1346',
    purpose: 'The router answers read-only cross-space status itself (the person\'s metaterm view and their spaces\' status.md heads). Off: a cross-space question gets buttons for the spaces, including a read-only fan-out to each space orchestrator. Read for the person asking, and only where slack-router-enabled is on for them (services/spaceSlack/flags.ts); decided during the alpha.',
  },
  'space-channels-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#1346',
    purpose: 'Space channels: linking Slack channels to a space (from Slack and termag), the space orchestrator, and space files from Slack. Read for the space\'s runner and for the person acting. Off: the /spaces/:space/slack routes answer 404 space_channels_off, /termag answers "not available", and linked channels stop answering.',
  },
  'space-slack-limits': {
    kind: 'json', fallback: null, server: ['user'], client: false, lifecycle: 'config', addedIn: '#1346',
    purpose: 'Caps for space channels and the router (channelsPerSpace, concurrentTurnsPerSpace, concurrentTurnsAll, routerTurnsPerDay, turnsPerRequesterPerDay, fanOut, asksPerSpace, asksPerRequesterPerDay, cardTtlHours, newBoxesPerDay, runMinutesPerDay, streamStartsPerMinute, allowPrivate); malformed keys fall back one by one to the code defaults (services/spaceSlack/limits.ts DEFAULT_SPACE_SLACK_LIMITS).',
  },
  'spawn-lifecycle-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#445',
    purpose: 'The spawn sweep parks finished delegates (stops their CLI) and retires parked ones whose work landed (removes the workstream), read for the child\'s box.',
  },
  'terminal-tabs-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#832',
    purpose: "Terminal tabs: the workspace's ctrl pane gains a tab list, + adds another shell pane in the workstream (up to 8 slots, routes/terminalSlots.ts) and ✕ closes it. Read for the user on POST …/terminals; the tab list itself is what tmux says, so already-open tabs show either way.",
  },
  'thanksgiving-turkeys-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#1153',
    purpose: 'Thanksgiving: the "Thanksgiving turkeys" option in Settings → Appearance, which swaps the starfield\'s stars for little turkeys. Off, the option is hidden and the stars come back; a saved choice is kept. No server side: the theme validator accepts the key either way. Remove after the holiday.',
  },
  'tool-auto-update-schedule': {
    kind: 'json', fallback: null, server: ['user'], client: false, lifecycle: 'config', addedIn: '#1300',
    purpose: "The automatic tool sweep's nightly schedule, for testing nightly runs in the daytime (services/toolUpdate/auto.ts parseNightlySchedule), read once per pass for the box's owner: { \"nightFromHour\": 0..23, \"nightToHour\": 0..23 (the night window in the owner's User.timeZone, end exclusive; it may wrap past midnight, e.g. 22 to 4; start equal to end keeps 0 to 6), \"everyHours\": 1..168 (between nightly runs, 24), \"quietMinutes\": 10..1440 (activity clock age for quiet, 60) }. A missing or invalid field keeps today's value; off, unset or unreadable is today's schedule. Moves only the nightly decision (session tools and sessionless ones, and the never-quiet fallback's window), never floor or resume runs, the force clock, the backoffs or the pacer. A moved value shows in the run's reason and the [TOOL-AUTO] log.",
  },
  'whats-new-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#928',
    purpose: 'What\'s new: the button in termag\'s sidebar foot and lab\'s sidebar head, and the dialog of entries it opens (frontend/src/whatsNew/). Browser only: the entries are bundled with the frontend, and nothing on the server reads it.',
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
