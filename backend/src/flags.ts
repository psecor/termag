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
  // serviceLdContext), or `orchestrator` (the orchestrator host's fixed box
  // context, services/toolUpdate/orchestrator.ts). Empty when only the
  // browser reads it.
  server: ReadonlyArray<'user' | 'user+box' | 'user+box+repo' | 'pool' | 'service' | 'orchestrator'>;
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
  'agent-spawn-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#396',
    purpose: 'An agent can start another agent on a brief (POST /api/spawns), read for the box the child runs on.',
  },
  'agent-spawn-limits': {
    kind: 'json', fallback: null, server: ['user+box', 'user'], client: false, lifecycle: 'config', addedIn: '#428',
    purpose: 'Spawn limits and hot-box thresholds as tuning parameters; malformed keys fall back one by one to DEFAULT_SPAWN_LIMITS.',
  },
  'ask-completion-notify-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#0',
    purpose: "When an ask finishes, termag tells the session that sent it (a turn of its chat, or a line typed into its idle agent pane), metadata only, read for the asker when the notice is due; off, the finish is only in `termag ask --inbox`.",
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
  'aws-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1110',
    purpose: 'Updating the AWS CLI v2 on a box from the admin Software tab, a root recipe: the update routes under /api/admin/software with component aws (off, 404 claude_update_off; the browser hides aws\'s actions on that answer) and a box\'s policy fetch for a requested aws run (off, restart none). Read for the box\'s owner and the box.',
  },
  'aws-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1110',
    purpose: 'AWS CLI v2 update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z; the box installs only AWS\'s zip for that version, its signature verified with AWS\'s key), restart (the AWS CLI has no sessions, so none of them restarts anything), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_AWS_UPDATE_POLICY (services/awsUpdatePolicy.ts: floor 2.35.3 from the advisories, restart none).',
  },
  'box-auto-lifecycle-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#301',
    purpose: 'A box hibernates, and later terminates, on its own after its idle window.',
  },
  'box-auto-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#270',
    purpose: 'The orchestrator asks a box behind the current image to pull and restart its agent; off is the fleet-wide stop.',
  },
  'box-default-size': {
    kind: 'string', fallback: '', server: ['user', 'pool'], client: false, lifecycle: 'config', addedIn: '#0',
    docs: 'docs/box-provisioning.md',
    purpose: 'The size new boxes launch at (small, medium, large), and the one the warm pool holds; any value also lets a person pick a size. Empty is BOX_INSTANCE_TYPE, as before sizes.',
  },
  'box-hibernation-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'pool'], client: false, lifecycle: 'release', addedIn: '#379',
    docs: 'docs/box-hibernation.md',
    purpose: 'New boxes, and the warm pool, launch hibernation-capable.',
  },
  'box-idle-park-hours': {
    kind: 'number', fallback: 2, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#620',
    purpose: "box-idle-stop-enabled's window in hours; anything but a whole number from 1 to 720 is the 2 h default (boxLifecyclePolicy.ts idleStopHours). Read for the owner and box, only while box-idle-stop-enabled is on.",
  },
  'box-idle-park-warn-minutes': {
    kind: 'number', fallback: 120, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#620',
    purpose: "How long before box-idle-stop-enabled's stop the owner is warned, in minutes (0 to a week), never more than half the window (boxLifecyclePolicy.ts warnLeadMs). Read for the owner and box, only while box-idle-stop-enabled is on.",
  },
  'box-idle-stop-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#670',
    purpose: 'A box with no idle hours is stopped after 2 h idle (box-idle-park-hours), even if it can hibernate, its owner warned first (box-idle-park-warn-minutes). A box with idle hours still hibernates on that setting.',
  },
  'box-image': {
    kind: 'string', fallback: '', server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#331',
    docs: 'docs/box-hibernation.md',
    purpose: 'The AMI a user\'s boxes launch from: a pinned ami-… or a channel; empty is the published image.',
  },
  'box-open-start-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#676',
    purpose: 'Opening a project or workstream whose box is stopped or hibernated starts the box, through the owner-only start route, in the workspace, the simple UI and the phone client. In the simple UI, an SDK chat whose transcript is stored (chat-transcripts-enabled) opens on that copy instead and leaves the box parked: sending a message starts it.',
  },
  'box-port-forward-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#724',
    purpose: 'The native port forward (termag forward): GET /api/cli/v1/boxes/:id/forward (the probe) and the forward socket at /api/cli/v1/boxes/:id/forward/:port, relayed to the box\'s loopback port over an agent tunnel. Owner and device sign-in only; off, both answer 404 not_found. The browser reads it only for What\'s new.',
  },
  'box-rename-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#552',
    docs: 'docs/agents/integration-surfaces.md',
    purpose: 'Renaming a box: the box menu\'s Rename item and `termag box rename`; off, both rename routes answer 403 rename_disabled.',
  },
  'box-sharing-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#397',
    purpose: 'Sending and accepting new project shares; existing shares are never behind it.',
  },
  'box-start-type-fallback-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box', 'pool'], client: false, lifecycle: 'release', addedIn: '#1011',
    docs: 'docs/box-provisioning.md',
    purpose: 'Starting a stopped box that EC2 has no capacity for retypes it to another type of the same vCPU and memory (boxStartFallback.ts) and starts it again, back on its old type when none starts. Read for the owner and box, or the pool context for a pool box, only on a capacity refusal.',
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
  'browser-pane-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#463',
    purpose: 'The browser pane under the ctrl terminal: a headless Chromium on the box, screencast into the workspace; read for the viewer and the project\'s box.',
  },
  'browser-pane-guest-kill-switch': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'kill-switch', addedIn: '#520',
    purpose: 'On: no guest browser panes at all. Checked at every guest attach and every 30 s on each live guest socket, which it closes; read for the project\'s owner and box.',
  },
  'browser-pane-guest-max-concurrent': {
    kind: 'number', fallback: 5, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#520',
    purpose: 'Guest browsers per box, live plus parked; clamped to 0..10 here and in the agent (one signed-in webapp tab is about 1.3 GB); read for the owner and box.',
  },
  'browser-pane-guest-wake-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#581',
    purpose: 'A PR link share\'s reviewer may wake the owner\'s box when the idle sweep hibernated it (never one the owner stopped), within a budget of one per 30 minutes and six a day per owner; read for the owner and box, so it can be switched off alone.',
  },
  'browser-pane-open-link-shares-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#787',
    purpose: 'Open links: the share dialog with nobody named makes a link to the workstream\'s preview that any signed-in termag user can open, for the dialog\'s lifetime; read for the project\'s owner and box, beside browser-pane-preview-share-enabled.',
  },
  'browser-pane-persistent-profiles-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#519',
    purpose: 'Browser panes keep their Chromium profile past the 60 s park, so a sign-in survives (owners keep loopback cookies only); read for the project\'s owner and box.',
  },
  'browser-pane-pr-auto-share-default': {
    kind: 'boolean', fallback: false, server: ['user+box+repo'], client: false, lifecycle: 'config', addedIn: '#681',
    purpose: 'Whether a project shares the PRs its owner opens automatically (4c) until its owner saves the PR previews settings; saving keeps what the dialog showed. Read for the owner, the box and the project\'s repository, so a repository can default on.',
  },
  'browser-pane-pr-checkout-shares-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#703',
    purpose: 'A PR link share is bound to the PR\'s own checkout on the box (4d): the checkout whose origin and branch are the PR\'s, among the workstream\'s, the project\'s others, ~/src/<repo> and their worktrees; and the repository flags read the PR\'s repository. Read for the owner and box. Off stops new checkout shares; live ones keep their checkout until they end.',
  },
  'browser-pane-pr-draft-shares-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box+repo'], client: false, lifecycle: 'release', addedIn: '#681',
    purpose: 'A draft pull request may have a link share: shared automatically when it is opened, and from the Share preview button. Read for the owner, the box and the project\'s repository.',
  },
  'browser-pane-pr-link-shares-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#580',
    purpose: 'PR link shares (phase 2): an owner shares a pull request\'s preview by a link, posted on the PR, that any signed-in termag user can open, ended by the PR\'s merge or close; read for the project\'s owner and box, beside browser-pane-preview-share-enabled.',
  },
  'browser-pane-preview-share-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: true, lifecycle: 'release', addedIn: '#520',
    purpose: 'Preview shares: an owner shares one workstream\'s browser pane with a named termag user, whose own sandboxed browser reaches only the shared app; read for the project\'s owner and box.',
  },
  'browser-pane-preview-share-ttl-hours': {
    kind: 'number', fallback: 24, server: ['user+box'], client: true, lifecycle: 'config', addedIn: '#520',
    purpose: 'A preview share\'s default lifetime in hours; clamped to 1..168 (services/previewShareRules.ts ttlHours); read for the owner and box.',
  },
  'chat-effort-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#693',
    purpose: 'Simple UI: an Effort slider in the composers\' model menu (LaunchPad\'s Slider), sent with each message as Claude Code\'s --effort (agent chat-effort-v1); off, the menu offers none and the server drops any effort a send carries.',
  },
  'chat-existing-box-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#698',
    purpose: 'Simple UI: New session\'s box dialog lists your boxes that are up, coming up or asleep beside New box, and the session starts on the one picked (an asleep one woken through the owner-only start route) instead of on a new box. Off, the dialog offers New box alone. No server side: a project on one of your boxes goes through the create route, which decides as it always has.',
  },
  'chat-generative-ui-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#793',
    purpose: 'Simple UI: generative UI in the SDK chat. A ```spec fence in a reply (a json-render spec over a fixed catalog of LaunchPad components, chat/genui/catalog.ts) is drawn as those components, and their buttons and forms answer the agent with an ordinary chat message (chat/genui/action.ts). Read for the sender of a chat message: on, the turn gets the catalog\'s system prompt (services/chatGenUi.ts, agent chat-genui-v1). Off, a spec fence is a plain code block and no prompt is sent.',
  },
  'chat-generative-ui-hint-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#898',
    purpose: 'Generative UI\'s prompt, split: read for the sender of a chat message that gets generative UI (chat-generative-ui-enabled). On, a box agent that files the prompt (chat-genui-v2) gets the hint too: its turn carries only the hint (a few hundred tokens: when UI helps, the components, read the reference first) and the whole prompt is a file the agent reads before its first UI. Off, or an older agent, every such turn carries the whole prompt (about 11k tokens), as before.',
  },
  'chat-image-input-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#544',
    purpose: 'Images in simple-UI chat messages (drag, paste or pick; agent chat-images-v1), delivered to Claude as image blocks; off, the composer offers none and a send with images answers 403. The composer learns it from GET …/chat, not the bootstrap.',
  },
  'chat-live-input-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#507',
    purpose: 'A chat message sent while a turn runs goes into that turn (agent chat-live-v1), so a turn waiting on a background task still answers; off, it queues behind the turn.',
  },
  'chat-plan-spend-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#705',
    purpose: 'Simple UI: the session composer\'s context ring shows the box owner\'s Claude Enterprise monthly spend. Read for the project\'s owner when they send a chat message, which asks the box to read the spend from Anthropic\'s undocumented usage endpoint with its claude.ai login after the answer, at most once a minute, and to send only the numbers to the owner\'s view; off, and for a collaborator\'s send, the box never calls the endpoint and the ring shows no spend.',
  },
  'chat-resume-new-box-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#796',
    purpose: 'Read for the project\'s owner: a simple-UI chat is told in its next message when its box restarted since its last turn (agent chat-box-notice-v1), each turn end records the checkout\'s git state, and a chat whose box was terminated offers "Continue on a new box": a fresh box, the repo cloned, the stored session restored (chat-restore-v1) and resumed, with a notice of what was lost. Needs chat-transcripts-enabled and the transcript store.',
  },
  'chat-session-references-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#947',
    purpose: 'Simple UI: drag a session from the sidebar (a row or a tab) into a composer, and the message gets a reference to it at the drop point: what the sidebar calls it and the `termag ask` (with --thread for an ask\'s chat) that messages it. A session that can\'t be asked (shared, a cloud session, not on a box of yours) says why instead. No server side: the drag is all browser, and an ask checks itself.',
  },
  'chat-subagents-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#932',
    purpose: 'Simple UI: subagents in the SDK chat. Under the chrome refresh an Agent call is a row that opens the subagent\'s whole transcript in the side panel\'s agent tab, read from its box by GET …/chat/subagents/:agentId (agent chat-subagents-v1). It also answers the asks a chat sent (`termag ask` from Bash; GET …/chat/asks, docs/simple-ui-subagents.md "Asks"). Off, the call is a tool card and both routes answer 404.',
  },
  'chat-transcripts-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#657',
    purpose: 'Read for the project\'s owner: the orchestrator stores each simple-UI chat\'s Claude Code transcript (encrypted, per turn, from the box at turn end and once on connect; agent chat-transcript-v1), and a chat whose box is down shows its stored history instead of "offline". Opening such a chat in the simple UI while its box is stopped, stopping or hibernated shows the stored copy and does not start the box (box-open-start-enabled starts it only when nothing is stored): the status line says "Box is stopped · sending a message starts it", and a send (the only way that view wakes it) starts the box and goes in once it is up. Needs CHAT_TRANSCRIPT_KMS_KEY_ID (or CHAT_TRANSCRIPT_ALLOW_PLAINTEXT=1 in dev/e2e).',
  },
  'chat-turn-notifications-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#546',
    purpose: 'Simple UI: notify a person who opted in when a chat they can see finishes its turn (web push, else the open tab); off, nothing is sent and the Settings switch is hidden.',
  },
  'chat-voice-input-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#599',
    purpose: 'Simple UI: a mic button in the composers that dictates into the prompt box with the browser\'s Web Speech API, or with Whisper running in the browser where that fails or is missing (Arc, Brave, Firefox; model served from /termag/speech/); no termag server side. Off, or off a secure context, there is no button.',
  },
  'chat-worktree-sessions-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#701',
    purpose: 'Simple UI: New session on one of your boxes (chat-existing-box-enabled) that already has the repository in one of your chat projects can start as a worktree of that project, from a freshly fetched origin/<default> or off its checkout, with its permissions; from a fetch it asks Full access or Read only as a fresh clone does (Full access only on a project with its trust tick). Read for the caller of POST /api/projects/:id/workstreams with a `fetch`: on, the fetch is honoured, and a box with worktree-fetch-attended-v1 leaves the tree unmarked (a person asked for it); off, the fetch is dropped and the add is a plain branch-off from the body\'s base, as before. Off, New session offers no worktree.',
  },
  'claude-cloud-sessions-ui': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#244',
    purpose: 'Claude Code cloud sessions in the sidebar and the mobile inbox.',
  },
  'claude-code-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#0',
    purpose: "Updating Claude Code on a box from the admin Software tab: the update routes under /api/admin/software (off, 404 claude_update_off; the browser hides its actions on that answer), a box's policy fetch for a requested run (off, restart none), and the runner backstop's claude-too-old refusal and floor run. Read for the box's owner and the box.",
  },
  'claude-code-update-policy': {
    kind: 'json', fallback: null, server: ['user+box', 'orchestrator'], client: false, lifecycle: 'config', addedIn: '#0',
    purpose: 'Claude Code update policy: floor, target (latest, stable or x.y.z), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_CLAUDE_UPDATE_POLICY (services/claudeUpdatePolicy.ts). The floor goes to a v3 runner wrapper as --claude-floor.',
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
  'codex-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1076',
    purpose: "Updating Codex on a box from the admin Software tab: the update routes under /api/admin/software with component codex (off, 404 claude_update_off; the browser hides Codex's actions on that answer) and a box's policy fetch for a requested Codex run (off, restart none). Read for the box's owner and the box.",
  },
  'codex-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1076',
    purpose: 'Codex update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z; Codex has no stable tag), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_CODEX_UPDATE_POLICY (services/codexUpdatePolicy.ts: floor 0.131.0 from the advisories, restart none).',
  },
  'cursor-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1080',
    purpose: "Updating the Cursor agent CLI on a box from the admin Software tab: the update routes under /api/admin/software with component cursor (off, 404 claude_update_off; the browser hides Cursor's actions on that answer) and a box's policy fetch for a requested Cursor run (off, restart none). Read for the box's owner and the box.",
  },
  'cursor-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1080',
    purpose: 'Cursor agent update policy, the shape of claude-code-update-policy: floor and target are Cursor builds (YYYY.MM.DD-<hex>), target also latest; restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_CURSOR_UPDATE_POLICY (services/cursorUpdatePolicy.ts: floor 2025.09.17-25b418f from the CLI advisories, restart none).',
  },
  'desktop-app-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'user+box'], client: false, lifecycle: 'release', addedIn: '#645',
    purpose: 'The termag desktop app (a T3 Code fork): its box bridge, /api/cli/v1/boxes/:id/t3/* (ensure, pair, revoke, projects, relay), and the CLI routes only it calls (workstream create and remove, clone retry, box hibernate; user+box), its PR page\'s writes (/api/cli/v1/prs/deferrals, /prs/groups*, /prs/bake and /prs/:owner/:repo/:number/workstream; user), and, per person, the briefing and working time; off, each answers 404 not_found.',
  },
  'devin-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1087',
    purpose: "Updating the Devin CLI on a box from the admin Software tab: the update routes under /api/admin/software with component devin (off, 404 claude_update_off; the browser hides Devin's actions on that answer) and a box's policy fetch for a requested Devin run (off, restart none). Read for the box's owner and the box.",
  },
  'devin-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1087',
    purpose: 'Devin CLI update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_DEVIN_UPDATE_POLICY (services/devinUpdatePolicy.ts: floor 3000.11.92, no advisory gives one; restart none).',
  },
  'fireworks-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'user+box'], client: true, lifecycle: 'release', addedIn: '#585',
    purpose: 'Fireworks models through the termag gateway: the Fireworks backend in the pickers (GET /api/providers/models, user), the gateway\'s ext_authz and delivery to boxes (user+box).',
  },
  'fireworks-models': {
    kind: 'json', fallback: null, server: ['user', 'user+box'], client: false, lifecycle: 'config', addedIn: '#585',
    purpose: 'The Fireworks models a person may pick and call through the termag gateway: { default, fast, models: [{ id, label?, context? }] }; the gateway refuses any other. Off or malformed = none.',
  },
  'gh-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1102',
    purpose: 'Updating the GitHub CLI (gh) on a box from the admin Software tab, a root recipe: the update routes under /api/admin/software with component gh (off, 404 claude_update_off; the browser hides gh\'s actions on that answer) and a box\'s policy fetch for a requested gh run (off, restart none). Read for the box\'s owner and the box.',
  },
  'gh-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1102',
    purpose: 'GitHub CLI update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z; the box installs only the version cli.github.com\'s apt repository lists), restart (gh has no sessions, so none of them restarts anything), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_GH_UPDATE_POLICY (services/ghUpdatePolicy.ts: floor 2.102.0 from the advisories, restart none).',
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
  'mcp-broker-enabled': {
    kind: 'boolean', fallback: false, server: ['user', 'user+box'], client: true, lifecycle: 'release', addedIn: '#525',
    purpose: 'MCP connectors through the termag MCP broker: the Settings section and API (user), the broker\'s ext_authz and delivery to boxes (user+box).',
  },
  'mcp-default-connectors': {
    kind: 'json', fallback: null, server: ['user'], client: false, lifecycle: 'config', addedIn: '#913',
    purpose: 'The catalog of OAuth MCP servers the orchestrator offers every user, and its on switch: a JSON array of {name, upstream} (services/mcpConnectors.ts defaultConnectors). Settings → MCP → Available to connect, and POST /api/mcp-connectors/catalog/:name/connect. null (off) or [] offers nothing and that route answers 404; connectors already made from it stay. Needs mcp-broker-enabled too.',
  },
  'mobile-installed-app-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#401',
    purpose: 'An app installed on a touch device always opens the phone client at /m, and its Full UI lasts one window; off, it follows mobile-redirect-enabled like a tab.',
  },
  'mobile-redirect-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#212',
    purpose: 'Send phone-sized viewports to the mobile client at /m.',
  },
  'mobile-web-push-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#403',
    purpose: 'Web push to the owner\'s phone when a session starts waiting; off, push reads as not available, nothing is sent and chat posts are never muted for it.',
  },
  'multi-repo-projects-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#729',
    purpose: 'Creating a project that holds several repositories (the New project dialog\'s Add another repository, and the simplified UI picker\'s multi-select); off, POST /api/projects refuses `repos`. Also `termag ask <box>/<project>:<repo>` into one of their repositories; off, every ask into a multi-repo project is refused 409 `multi_repo_disabled`. Existing multi-repo projects keep working either way.',
  },
  'node-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1113',
    purpose: 'Updating Node (nvm\'s default, within its major) on a box from the admin Software tab: the update routes under /api/admin/software with component node (off, 404 claude_update_off; the browser hides node\'s actions on that answer) and a box\'s policy fetch for a requested node run (off, restart none). A run reinstalls the npm globals under the new Node and restarts the agent on it. Read for the box\'s owner and the box.',
  },
  'node-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1113',
    purpose: 'Node update policy, the shape of claude-code-update-policy: floor, target (latest: the newest release of the box\'s major; or x.y.z in that major), restart (no session is restarted in this version, so none of them changes anything), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_NODE_UPDATE_POLICY (services/nodeUpdatePolicy.ts: floor 24.22.1 from the security releases, restart none).',
  },
  'onboarding-refresh-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#886',
    purpose: 'The redrawn first run: sign-in in LaunchPad, saying why a sign-in was refused; a three-step /welcome with a choice of termag or Lab, kept on the user (`users.uiMode`): off, /auth/me leaves it out and PUT /auth/me/preferences refuses it 403 `ui_mode_disabled`. The sign-in page has no user, so it follows what this browser last saw for a signed-in user.',
  },
  'orchestrator-claude-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box', 'orchestrator'], client: false, lifecycle: 'release', addedIn: '#1165',
    purpose: "Updating the orchestrator host's own Claude Code (/usr/bin/claude, which runs the runner orchestrator): the Software tab's orchestrator row (with claude-code-update-enabled, read for the admin and the orchestrator's fixed box context; off, its preview and update answer 404 claude_update_off), and the nightly run, read for the orchestrator's context alone. The boot floor run (claude-orchestrator-floor.service) is not gated.",
  },
  'orchestrator-claude-update-policy': {
    kind: 'json', fallback: null, server: ['orchestrator'], client: false, lifecycle: 'config', addedIn: '#1165',
    purpose: "The orchestrator host's own Claude Code target: {target: \"x.y.z\" | null}, read for the orchestrator's fixed box context. Only an exact version is a target (a tag or anything else is refused and logged); null, the default, is the floor only. A pin is run exactly, up or down to it, never below the floor (claude-code-update-policy's, raised to the image's floor file). Both the Software tab's orchestrator row and the nightly run use it.",
  },
  'parallel-reviews-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#786',
    purpose: 'Several review panes per workstream: Review on another PR adds a pane (up to 8) stacked under the running ones, and Review on a PR that already has one restarts only that pane. Read for the user on POST …/review; off, a review replaces the workstream\'s one pane as before. Panes already running stay listed either way.',
  },
  'pi-update-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#1088',
    purpose: "Updating pi (the pi provider's agent) on a box from the admin Software tab: the update routes under /api/admin/software with component pi (off, 404 claude_update_off; the browser hides pi's actions on that answer) and a box's policy fetch for a requested pi run (off, restart none). Read for the box's owner and the box.",
  },
  'pi-update-policy': {
    kind: 'json', fallback: null, server: ['user+box'], client: false, lifecycle: 'config', addedIn: '#1088',
    purpose: 'pi update policy, the shape of claude-code-update-policy: floor, target (latest or x.y.z), restart (none, idle, force), drainSec (0..3600), forceAfterHours (1..168); malformed keys fall back one by one to DEFAULT_PI_UPDATE_POLICY (services/piUpdatePolicy.ts: floor 0.79.0 from the advisories, restart none).',
  },
  'pr-live-updates-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#931',
    purpose: 'PR live updates (services/prLiveUpdates.ts): when one of the user\'s sessions opens a PR (a chat\'s gh pr create, the hook\'s pr_created milestone), their PR list is read from GitHub again until it has the PR, then their browsers are told (`{type: \'workspace\', what: \'prs\'}` on the status socket) and re-read the context card, the Pull request tab, the PR pills and the PRs tile at once; a chat\'s git push or gh pr merge/ready/close/reopen/edit/review tells them after 3 s. Read for the user when one is seen. Off, nothing is re-read or sent, and the browsers keep their one-minute poll.',
  },
  'pr-review-groups-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#667',
    purpose: 'Review groups in the PR overlay and the phone: named, ordered lists of PRs reviewed together, as a card at the top of Needs you and Needs my review, Add to group on a PR, and suggested groups. Read for the user on GET /api/prs: on, the descriptions of reviews asked of them are read to suggest groups. Off, there is no card, no Add to group and no suggestion (nor its GitHub read); stored groups are left alone and still served.',
  },
  'repo-first-gate-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#226',
    purpose: 'Adding a managed box requires a stored GitHub token.',
  },
  'repo-first-picker-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#312',
    purpose: 'Pick a repository in the New project form.',
  },
  'simple-ui-automations-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#852',
    purpose: 'Simple UI: an Automations button beside New session (with a count of live runs) opening /chat/automations, the list of the user\'s own and shared automations, and an automation\'s page with its run history, Run now, Pause/Enable, Resume and Archive. Shown only with automations-enabled too. Browser only: every write goes through /api/automations, which keeps gating on automations-enabled.',
  },
  'simple-ui-chrome-refresh-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#803',
    purpose: 'Simple UI: the chrome refresh, its sidebar, header and side panel redrawn with LaunchPad\'s components in termag\'s own colours and fonts (launchpad/theme.css), landing as a stack of PRs. Off, the simple UI is as it was. Browser only: it changes how the chrome looks, not what anyone may do.',
  },
  'simple-ui-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#399',
    purpose: 'The chat-first client at /chat and its sidebar entry. Read for the caller on the server only by a space folder\'s link (routes/spaceFiles.ts), which sends them to /chat/files/<space> only while it and simple-ui-side-panel-enabled are on, and is otherwise a 404.',
  },
  'simple-ui-inflight-changes-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#968',
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
  'simple-ui-session-titles-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#658',
    purpose: 'Simple UI: each sidebar row leads with Claude\'s own title for its session (a /rename, else the one Claude generated), with the project and workstream under it. Read for the sender of a chat message, which asks the box to report the title at turn end; off, nothing is reported and the sidebar names the project as before.',
  },
  'simple-ui-side-panel-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#598',
    docs: 'docs/agents/gotchas.md',
    purpose: 'Simple UI: a collapsible side panel beside a conversation with its ctrl terminal and (with browser-pane-enabled) its browser pane; also the sidebar of open tabs, grouped by space (for a user with no spaces or with spaces-enabled off, the same No space group, whose ⋮ New tab opens an explorer of their agents only; agents, space files and new tabs in the person\'s order: new on top, a file opened from the explorer, recents or a chat link or an agent sent a message back on top, drag or Alt+Up/Down to move within a space, ⋮ or a right click to duplicate or close) under New session with each space\'s + menu, and a Files tab with the space\'s explorer of agents, subagents and files, shown beside a space file and on a new tab too (beside an agent in no space, an Agents tab with the agents-only explorer), with the file viewer, rounded tooltips, and space file links opening in the simple UI; the terminal and browser sockets keep their own access checks. Read for the caller on the server only by a space folder\'s link (routes/spaceFiles.ts), which opens the folder in Files while it and simple-ui-enabled are on, and is otherwise a 404.',
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
  'space-memory-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#769',
    purpose: 'Agents load a space\'s .termag/ prompt and memories (never its skills) and write them with `termag space memory`; off, GET /spaces/:space/memory answers 404 space_memory_off and the box sync removes its local copy. The only kill switch.',
  },
  'spaces-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#385',
    purpose: 'Spaces, shared file stores across boxes; off, every /api/spaces route answers 404.',
  },
  'spaces-html-links-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#596',
    purpose: 'A space file link renders an HTML file as a sandboxed page instead of downloading it.',
  },
  'spaces-sharing-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: false, lifecycle: 'release', addedIn: '#385',
    purpose: 'Adding people to a space. The browser follows the server\'s answer (`sharing` on GET /api/spaces/:space/members), not its own read.',
  },
  'spawn-lifecycle-enabled': {
    kind: 'boolean', fallback: false, server: ['user+box'], client: false, lifecycle: 'release', addedIn: '#445',
    purpose: 'The spawn sweep parks finished delegates (stops their CLI) and retires parked ones whose work landed (removes the workstream), read for the child\'s box.',
  },
  'thanksgiving-turkeys-enabled': {
    kind: 'boolean', fallback: false, server: [], client: true, lifecycle: 'release', addedIn: '#1153',
    purpose: 'Thanksgiving: the "Thanksgiving turkeys" option in Settings → Appearance, which swaps the starfield\'s stars for little turkeys. Off, the option is hidden and the stars come back; a saved choice is kept. No server side: the theme validator accepts the key either way. Remove after the holiday.',
  },
  'warm-pool-enabled': {
    kind: 'boolean', fallback: false, server: ['user'], client: true, lifecycle: 'release', addedIn: '#106',
    purpose: 'Claim a warm box from Add box, and the pool-depth line.',
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
