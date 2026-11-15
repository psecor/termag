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
  // Automation alerts ("Alerts and the outbound
  // webhook"): the keyword, target and health-alert fields in an
  // automation's Run settings. Defaults off; the backend refuses a keyword,
  // a non-DM target or a webhook on the same flag for the owner and box.
  automationAlerts: 'automation-alerts-enabled',
  // Automations: New automation (Shift on New project,
  // the split button, the ⌘K action), the /automations pages and the
  // automation rows' subtitles. Defaults off; the backend refuses create,
  // PATCH and Run now on the same flag for the owner and box.
  automations: 'automations-enabled',
  // Read here only by What's new, whose entry about the
  // shared Bazel cache on boxes shows while it is on;
  // delivering the cache block to a box is the server's.
  boxBazelCache: 'box-bazel-cache-enabled',
  // Runs on: Auto in New session: Auto as the default
  // box with its reason, Send on a parked box, and the Settings default.
  // Defaults off. The backend answers GET /api/boxes/placement with 404 and
  // refuses a parked box's create on the same flag.
  boxPlacement: 'box-placement-enabled',
  // New project shares: the Share item's invite form and accepting an invite.
  // Defaults off. The backend refuses invite and accept on the same flag
  // (services/boxSharingFlag.ts); existing shares, revoke, leave and decline
  // are never behind it.
  boxSharing: 'box-sharing-enabled',
  // Read here only by What's new, whose entry about Stop
  // asking again on a box running cloud sessions shows while it is on; the
  // refusal itself is the server's (routes/instances.ts powerBoxRow).
  boxStopCloudSessionGuard: 'box-stop-cloud-session-guard-enabled',
  // The lifetime the share dialog preselects.
  previewShareTtlHours: 'browser-pane-preview-share-ttl-hours',
  // Any other file attached to a chat message, kept on the chat's box and named
  // in the message (Other files). The server
  // decides (POST …/chat/files, GET …/chat fileInput); this only hides the upload.
  chatFileAttachments: 'chat-file-attachments-enabled',
  // Generative UI in the SDK chat: a
  // reply's ```spec fence, a json-render spec over a fixed LaunchPad catalog,
  // is drawn as UI. Defaults off; off, the fence is a code block. The server
  // reads it too, for the sender of a message: on, the turn gets the catalog's
  // system prompt (backend services/chatGenUi.ts).
  chatGenerativeUi: 'chat-generative-ui-enabled',
  // The agents an agent runs, nested under it:
  // a subagent's or an ask's own subagents and asks under its
  // row in a chat's drawer and context card, and an agent's Claude subagents
  // under it in Files, read when its row is expanded; and Archive in Files
  // ("Archived in Files"). Defaults off; off, both are flat and Files offers no
  // archive. The backend's only part is the archive route, which it doesn't gate.
  chatNestedAgents: 'chat-nested-agents-enabled',
  // A pane chat's subagents (a project made in Lab): its Claude's Agent-tool subagents in the drawer
  // on its composer, each opening its agent tab, read from beside the session by
  // its box. Defaults off; off, the pane chat is unchanged. The backend reads it
  // too, for GET …/chat/pane-subagents.
  chatPaneSubagents: 'chat-pane-subagents-enabled',
  // Phones open the chat:
  // a phone that loads the workspace URL, and the app installed on a touch
  // device, land in the chat rather than on /m, and a Lab link to a session in
  // its chat when it has one. Defaults off; off, phones land on /m as before.
  chatPhoneHome: 'chat-phone-home-enabled',
  // New session's worktree pill ("Worktree of termag-22" / "New checkout") and its
  // permission pill naming the setting and the checkout, not the box.
  // Defaults off; off, as before.
  chatSessionPermissions: 'chat-session-permissions-enabled',
  // A session dragged from the sidebar into a composer goes into the message as a
  // reference to it, with the `termag ask` that messages it.
  // Defaults off; off, a drag carries
  // no reference. No server side: an ask checks itself.
  chatSessionReferences: 'chat-session-references-enabled',
  chatSidebarRecentOrder: 'chat-sidebar-recent-order-enabled',
  // Subagents in the SDK chat: an Agent call is a
  // row that opens the subagent's transcript in the side panel's agent tab,
  // under the chrome refresh. Defaults off; off, the call is a tool card. The
  // backend reads it too, for GET …/chat/subagents/:agentId.
  chatSubagents: 'chat-subagents-enabled',
  // "Your turn" notifications in the simple UI:
  // the sidebar's Notify toggle and the open tab's notifications. Defaults
  // off; the backend sends no push while the same flag is off for a person.
  chatTurnNotifications: 'chat-turn-notifications-enabled',
  // Lab's nudge toward termag's chat (chatNudge/):
  // a toast for people who open in Lab, a spotlight
  // on the switch when they dismiss it, and only a switch (not a visit)
  // changing where termag opens. Defaults off; the backend leaves
  // chatNudgeDismissed out of /auth/me while the same flag is off.
  chatUiNudge: 'chat-ui-nudge-enabled',
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
  // Theme of the day: the option in Settings →
  // Appearance, and whether today's dated reskin loads for a person who turned
  // it on (theme/daily/DailyThemeLayer.tsx). Defaults off; a saved choice is kept.
  dailyTheme: 'daily-theme-enabled',
  // Kill switch for environment selection in the UI:
  // the Environment pickers in New project and New session, the Environments
  // links and menu item, and the Environments pages (hooks/useEnvironments.ts
  // useEnvironmentSelection). Defaults on, so the UI is unchanged when the flag
  // (or a flag source itself) is absent. Browser only: the API keeps taking
  // `environment`, and the CLI's --environment is not behind it.
  environmentSelection: 'environment-selection-enabled',
  // Kill-switch for the animated Hyperspace background. Defaults on, so the app
  // is unchanged when the flag is not configured. ANDed with
  // the user's theme in App.tsx: the flag can only turn the starfield off.
  hyperspaceBackground: 'hyperspace-background-enabled',
  // Light mode: the Dark / Light picker in Settings → Appearance. Defaults off
  // until the light colour values land; a palette already saved still applies.
  lightMode: 'light-mode-enabled',
  // Multi-repo projects: Add another repository
  // in the New project dialog, and a multi-select in the simplified UI's repository
  // picker. Defaults off; the backend refuses `repos` on a create while the
  // same flag is off for the user.
  multiRepo: 'multi-repo-projects-enabled',
  // The notice banner: its content, a JSON
  // value, parsed by notice/notice.ts; {} or null is no banner. Browser only.
  noticeBanner: 'notice-banner',
  // The MCP servers step in both first-run wizards ("The
  // MCP servers step" and "The refresh"), shown only while the catalog offers a
  // server too. Defaults off.
  onboardingMcpStep: 'onboarding-mcp-step-enabled',
  // The redrawn first run. Defaults off.
  // The sign-in page has no user to evaluate it for, so it follows what this
  // browser last saw (onboarding/refreshHint.ts).
  onboardingRefresh: 'onboarding-refresh-enabled',
  // Several review panes per workstream: the Review
  // dialog's add / restart wording and the PR overlay's. Defaults off; the
  // backend reads the same flag to pick a pane, off replacing the first.
  parallelReviews: 'parallel-reviews-enabled',
  // Preview links: the publish dialog and the
  // links list. Defaults off; every publish route answers 404 while the same
  // flag is off for the project's owner and box.
  previewLinks: 'preview-links-enabled',
  // Preview links' `people` and `link` audiences in the publish dialog.
  // Defaults off; the backend refuses them with 403 audience_disabled.
  previewLinksLinkAudience: 'preview-links-link-audience-enabled',
  // Project files and My files (part B): the side panel's
  // Files as Project files | My files with Move between them and Other spaces, Settings → My files, the
  // project menu's Use an existing space for files… and Slack channels…, and no space pill on New session.
  // Needs user-projects-enabled too. Defaults off; the server's routes answer project_files_disabled while it's off.
  projectFiles: 'project-files-enabled',
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
  // In-flight changes on the context card:
  // the files the session's agent has changed and not pushed or committed yet,
  // read from its box. Defaults off; the backend refuses the read (404) while
  // the same flag is off for the user.
  inflightChanges: 'simple-ui-inflight-changes-enabled',
  // Review with Claude opens a chat: a review
  // session as claude-chat, opened at once on the review-start page, instead
  // of the lab's review pane. Defaults off: Claude reviews in a pane.
  reviewChat: 'simple-ui-review-chat-enabled',
  // Review on a PR whose repository none of your projects has
  // (chat/reviewClone.ts): it clones the repository
  // into a new project on one of your boxes, then starts the review there.
  // Defaults off: the button is disabled and says why. Browser only.
  reviewClone: 'simple-ui-review-clone-enabled',
  // PR reviews in the simple UI: the sidebar's
  // Reviews section, /chat/reviews, a PR's page, agent reviews and review
  // sessions, the review card, posting and the follow-up round. Defaults off.
  simpleUiReviews: 'simple-ui-reviews-enabled',
  // Share to Slack: the project and workstream
  // menus' "Share to Slack…" item. Defaults off; the backend's /api/collab
  // routes refuse while the same flag is off for the user.
  slackCollab: 'slack-collab-enabled',
  // Space channels: linking Slack channels to a
  // space from termag (the space dialog, M6). Defaults off; the backend's
  // /spaces/:space/slack routes answer 404 space_channels_off while the same
  // flag is off for the caller. Off, the space menu has no Slack channels item
  // (pages/chat/SpaceSlackDialog.tsx).
  spaceChannels: 'space-channels-enabled',
  // Terminal tabs: the + / ✕ tab list beside the ctrl
  // pane's tab in the workspace. Defaults off; the backend refuses the add on
  // the same flag (routes/terminalSlots.ts), and the tab list is hidden.
  terminalTabs: 'terminal-tabs-enabled',
  // Thanksgiving: the "Thanksgiving turkeys" option in Settings → Appearance,
  // and whether the starfield honours it. Defaults off; a saved choice is kept.
  thanksgivingTurkeys: 'thanksgiving-turkeys-enabled',
  // The project record: New session
  // starts from a project, not a repository,
  // and the chat sidebar groups by project and opens on Projects, with no Group
  // by Space. Defaults off; off,
  // New session is the repository picker and the sidebar is milestone 3's. The
  // backend answers /api/user-projects with 404 user_projects_disabled on the same flag.
  userProjects: 'user-projects-enabled',
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
