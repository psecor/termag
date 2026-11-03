// Feature flags, configured by the deployment.
//
// The backend serves the values set in TERMAG_FLAGS (backend/src/services/
// featureFlags.ts) at GET /api/flags, and FeatureFlagsProvider loads them
// before rendering anything that reads a flag. Every read names a fallback, so
// with nothing configured the app runs on the fallbacks below. Each key must
// also be listed, with the same fallback, in backend/src/flags.ts
// (backend/src/flags.test.ts checks it).
// Entries are in alphabetical order by flag key (the value, so the order is the
// backend's): insert a new flag where it sorts, not at the end.
export const FLAGS = {
  // Agent handoff: "Hand off…" in the project and
  // workstream menus and on the context card. Defaults off; the backend
  // refuses a handoff while the same flag is off for the owner and box.
  agentHandoff: 'agent-handoff-enabled',
  // Automations: New automation (Shift on New project,
  // the split button, the ⌘K action), the /automations pages and the
  // automation rows' subtitles. Defaults off; the backend refuses create,
  // PATCH and Run now on the same flag for the owner and box.
  automations: 'automations-enabled',
  // Automatic box lifecycle: the box menu's Auto-hibernate item.
  // Defaults off; the backend's sweep reads the
  // same flag, so notes about what already happened show regardless.
  autoLifecycle: 'box-auto-lifecycle-enabled',
  // Read here only by What's new, whose entry about the idle
  // stop shows while it is on; the stop itself is the server's.
  boxIdleStop: 'box-idle-stop-enabled',
  // Opening a project or workstream whose box is stopped or hibernated starts
  // it (hooks/useStartParkedBoxOnOpen.ts), in the workspace, the simple UI and
  // the phone client. Defaults off. Browser only: it calls the box menu's
  // owner-only start route, which decides as it always has. A simple-UI chat
  // whose transcript is stored (chat-transcripts-enabled, server side) opens on
  // that copy and leaves the box parked (chat/storedOpen.ts).
  boxOpenStart: 'box-open-start-enabled',
  // Read here only by What's new, whose entries about the
  // port forward show while it is on; the forward itself is the server's.
  boxPortForward: 'box-port-forward-enabled',
  // Renaming a box: the box menu's Rename item. Defaults off; the backend's
  // rename routes answer 403 rename_disabled while the same flag is off.
  boxRename: 'box-rename-enabled',
  // New project shares: the Share item's invite form and accepting an invite.
  // Defaults off. The backend refuses invite and accept on the same flag
  // (services/boxSharingFlag.ts); existing shares, revoke, leave and decline
  // are never behind it.
  boxSharing: 'box-sharing-enabled',
  // Browser pane: the Browser bar under the ctrl
  // terminal, a headless Chromium on the box screencast into the workspace.
  // Defaults off; the backend closes the pane socket 4403 while the same flag
  // is off for the viewer and box.
  browserPane: 'browser-pane-enabled',
  // Open links: the share dialog with nobody named shares by a link anyone signed in can open.
  openLinkShares: 'browser-pane-open-link-shares-enabled',
  // Kept browser profiles: the pane's "Reset browser".
  persistentProfiles: 'browser-pane-persistent-profiles-enabled',
  // PR link shares (phase 2): the PR overlay's "Share preview", beside previewShare.
  prLinkShares: 'browser-pane-pr-link-shares-enabled',
  // Preview shares: the dock's "Share…" for an owner,
  // and the lifetime its dialog preselects.
  previewShare: 'browser-pane-preview-share-enabled',
  previewShareTtlHours: 'browser-pane-preview-share-ttl-hours',
  // Effort beside the model in the simple UI's composers:
  // New session reads it here; an open session learns it from its history's
  // effortInput, which also needs the box's chat-effort-v1.
  chatEffort: 'chat-effort-enabled',
  // New session on one of your boxes (pages/chat/LaunchDrawer.tsx): the box
  // dialog lists the boxes that are up, coming up or asleep (woken when
  // picked) beside New box. Defaults off, and off the dialog offers New box
  // alone, as New session always has. Client only: a project on one of your
  // boxes is the create route's, which decides as it always has.
  chatExistingBox: 'chat-existing-box-enabled',
  // Generative UI in the SDK chat: a
  // reply's ```spec fence, a json-render spec over a fixed LaunchPad catalog,
  // is drawn as UI. Defaults off; off, the fence is a code block. The server
  // reads it too, for the sender of a message: on, the turn gets the catalog's
  // system prompt (backend services/chatGenUi.ts).
  chatGenerativeUi: 'chat-generative-ui-enabled',
  // Read here only by What's new, like boxIdleStop; the composer learns these
  // from the server.
  chatImageInput: 'chat-image-input-enabled',
  chatLiveInput: 'chat-live-input-enabled',
  // A session dragged from the sidebar into a composer goes into the message as a
  // reference to it, with the `termag ask` that messages it.
  // Defaults off; off, a drag carries
  // no reference. No server side: an ask checks itself.
  chatSessionReferences: 'chat-session-references-enabled',
  // Subagents in the SDK chat: an Agent call is a
  // row that opens the subagent's transcript in the side panel's agent tab,
  // under the chrome refresh. Defaults off; off, the call is a tool card. The
  // backend reads it too, for GET …/chat/subagents/:agentId.
  chatSubagents: 'chat-subagents-enabled',
  // "Your turn" notifications in the simple UI:
  // the sidebar's Notify toggle and the open tab's notifications. Defaults
  // off; the backend sends no push while the same flag is off for a person.
  chatTurnNotifications: 'chat-turn-notifications-enabled',
  // Voice dictation in the simple UI's composers: the
  // mic button, on the browser's own speech recognition, or on Whisper in
  // the browser where that fails (Arc, Brave) or is missing (Firefox).
  // Defaults off; there is no server side: the audio goes to the browser's
  // vendor's speech service or stays on the device, never through termag.
  chatVoiceInput: 'chat-voice-input-enabled',
  // New session as a worktree of a project already on the chosen box
  // (pages/chat/CheckoutPicker.tsx): the drawer's checkout choice. Defaults
  // off, and off there is no such choice; the backend drops a create body's
  // `fetch` while the same flag is off for the caller.
  chatWorktreeSessions: 'chat-worktree-sessions-enabled',
  // Claude Code cloud sessions in the sidebar and the mobile inbox.
  // Defaults off. The dashboard section is not
  // behind it: that route sits outside the flags provider, so it shows
  // whenever the owner has a session in the window.
  cloudSessions: 'claude-cloud-sessions-ui',
  // Read here only by What's new, like boxIdleStop; the pickers get Fireworks
  // models from the server.
  fireworks: 'fireworks-enabled',
  // Kill-switch for the animated Hyperspace background. Defaults on, so the app
  // is unchanged when the flag is not configured. ANDed with
  // the user's theme in App.tsx: the flag can only turn the starfield off.
  hyperspaceBackground: 'hyperspace-background-enabled',
  // Light mode: the Dark / Light picker in Settings → Appearance. Defaults off
  // until the light colour values land; a palette already saved still applies.
  lightMode: 'light-mode-enabled',
  // MCP connectors through the termag MCP broker: the
  // Settings page's MCP section. Defaults off; the backend's
  // /api/mcp-connectors routes answer 404 while the same flag is off.
  mcpBroker: 'mcp-broker-enabled',
  // The installed-app rules: an app on a phone's home
  // screen always opens /m and its "Full UI" lasts one window. Defaults off, so
  // an installed app follows mobile-redirect-enabled like a browser tab.
  mobileInstalledApp: 'mobile-installed-app-enabled',
  // Send phone-sized viewports to the mobile client at /m.
  // Defaults off so the route can be exercised on a real phone before anyone
  // is redirected; "Full UI" on the phone opts a browser out regardless.
  mobileRedirect: 'mobile-redirect-enabled',
  // Multi-repo projects: Add another repository
  // in the New project dialog, and a multi-select in the simplified UI's repository
  // picker. Defaults off; the backend refuses `repos` on a create while the
  // same flag is off for the user.
  multiRepo: 'multi-repo-projects-enabled',
  // The redrawn first run. Defaults off.
  // The sign-in page has no user to evaluate it for, so it follows what this
  // browser last saw (onboarding/refreshHint.ts).
  onboardingRefresh: 'onboarding-refresh-enabled',
  // Several review panes per workstream: the Review
  // dialog's add / restart wording and the PR overlay's. Defaults off; the
  // backend reads the same flag to pick a pane, off replacing the first.
  parallelReviews: 'parallel-reviews-enabled',
  // Review groups in the PR overlay: the
  // card at the top of Needs you and Needs my review, and Add to group on a PR.
  // Defaults off; GET /api/prs serves stored groups regardless.
  prReviewGroups: 'pr-review-groups-enabled',
  repoFirstPicker: 'repo-first-picker-enabled',
  // Automations in the simple UI (pages/chat/automations/):
  // an Automations button beside New session, the list at /chat/automations
  // and an automation's page with its run history, Run now, Pause/Enable,
  // Resume and Archive. Shown only with automations-enabled too. Defaults off.
  // Client only: the API keeps gating on automations-enabled.
  simpleUiAutomations: 'simple-ui-automations-enabled',
  // The simple UI's chrome refresh: its
  // sidebar, header and side panel on LaunchPad's components, in termag's
  // colours. Read once, in ChatApp, which scopes it to .chat-root and hands it
  // down as useChatChrome().refresh. Defaults off, and off the simple UI is
  // unchanged. Client only: it is how the chrome looks, not what anyone may do.
  chatChromeRefresh: 'simple-ui-chrome-refresh-enabled',
  // The simple UI: a chat-first client at /chat over the same sessions, and
  // its entry in the sidebar header. Defaults off; off, /chat sends you to the
  // workspace.
  simpleUi: 'simple-ui-enabled',
  // In-flight changes on the context card:
  // the files the session's agent has changed and not pushed or committed yet,
  // read from its box. Defaults off; the backend refuses the read (404) while
  // the same flag is off for the user.
  inflightChanges: 'simple-ui-inflight-changes-enabled',
  // Review on a PR whose repository none of your projects has
  // (chat/reviewClone.ts): it clones the repository
  // into a new project on one of your boxes, then starts the review there.
  // Defaults off: the button is disabled and says why. Browser only.
  reviewClone: 'simple-ui-review-clone-enabled',
  // PR reviews in the simple UI: the sidebar's
  // Reviews section, /chat/reviews, a PR's page, agent reviews and review
  // sessions, the review card, posting and the follow-up round. Defaults off.
  simpleUiReviews: 'simple-ui-reviews-enabled',
  // Session titles in the simple UI's sidebar:
  // each row leads with Claude's own title for its session, the project and
  // workstream under it. Defaults off; the backend asks boxes for the title
  // only while the same flag is on for the sender, so off there is none to show.
  sessionTitles: 'simple-ui-session-titles-enabled',
  // The simple UI's side panel (chat/sidePanel.ts): the Tools button and
  // Ctrl+Alt+B, a column beside a conversation with its ctrl terminal and,
  // where browser-pane-enabled is on, its browser. Where the user has spaces
  // the sidebar is open tabs grouped by space (agents, space files and new
  // tabs in the person's order, each space's + menu, the tab context menu),
  // the panel has Files, the space's explorer of agents, subagents and files,
  // and shows beside a space file and on a new tab, with the file viewer;
  // space links open in place and tooltips are the rounded layer. Defaults
  // off. Client only: the terminal and browser sockets keep their own access
  // checks.
  chatSidePanel: 'simple-ui-side-panel-enabled',
  // Share to Slack: the project and workstream
  // menus' "Share to Slack…" item. Defaults off; the backend's /api/collab
  // routes refuse while the same flag is off for the user.
  slackCollab: 'slack-collab-enabled',
  // Spaces, shared file stores across boxes: the sidebar
  // section and the box menu's Spaces… item. Defaults off; the backend's
  // /api/spaces routes answer 404 while the same flag is off for the user.
  spaces: 'spaces-enabled',
  // Thanksgiving: the "Thanksgiving turkeys" option in Settings → Appearance,
  // and whether the starfield honours it. Defaults off; a saved choice is kept.
  thanksgivingTurkeys: 'thanksgiving-turkeys-enabled',
  // Claim a warm box from Add box, plus the pool-depth line. Defaults off, so
  // the cold path is unchanged when the flag is not configured.
  warmPool: 'warm-pool-enabled',
  // What's new: the button in termag's sidebar foot and
  // lab's sidebar head, and the dialog it opens. Defaults off. Client only:
  // the entries are bundled with the frontend, and nothing on the server reads it.
  whatsNew: 'whats-new-enabled',
} as const;
let flagValues: Record<string, unknown> = {};

export function setFlagValues(values: Record<string, unknown> | undefined): void {
  flagValues = values ?? {};
}

// Read a flag with a typed fallback. Values are loaded once, before the app
// renders, so this needs no subscription; it keeps the hook name so call sites
// read like any other hook. `key` is a FLAGS value, so an unlisted key does not
// compile.
export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export function useFlag<T>(key: FlagKey, fallback: T): T {
  const value = flagValues[key];
  return (value === undefined ? fallback : value) as T;
}

/**
 * Which of `keys` are on, for a list only known at run time: the flags What's
 * new entries name (whatsNew/). Each is an on/off flag that falls back off,
 * so a missing one is off, as useFlag(key, false) would read it.
 */
export function useOnFlags(keys: readonly FlagKey[]): ReadonlySet<FlagKey> {
  return new Set(keys.filter(key => flagValues[key] === true));
}
