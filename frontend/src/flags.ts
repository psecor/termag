// Feature flags, configured by the deployment.
//
// The backend serves the values set in TERMAG_FLAGS (backend/src/services/
// featureFlags.ts) at GET /api/flags, and FeatureFlagsProvider loads them
// before rendering anything that reads a flag. Every read names a fallback, so
// with nothing configured the app runs on the fallbacks below. Each key must
// also be listed, with the same fallback, in backend/src/flags.ts
// (backend/src/flags.test.ts checks it).
export const FLAGS = {
  // Kill-switch for the animated Hyperspace background. Defaults on. ANDed with
  // the user's theme in App.tsx: the flag can only turn the starfield off.
  hyperspaceBackground: 'hyperspace-background-enabled',
  // Claim a warm box from Add box, plus the pool-depth line. Defaults off, so
  // the cold path is unchanged unless the deployment opts in.
  warmPool: 'warm-pool-enabled',
  repoFirstPicker: 'repo-first-picker-enabled',
  // Send phone-sized viewports to the mobile client at /m. Defaults off;
  // "Full UI" on the phone opts a browser out regardless.
  mobileRedirect: 'mobile-redirect-enabled',
  // The installed-app rules: an app on a phone's home
  // screen always opens /m and its "Full UI" lasts one window. Defaults off, so
  // an installed app follows mobile-redirect-enabled like a browser tab.
  mobileInstalledApp: 'mobile-installed-app-enabled',
  // Claude Code cloud sessions in the sidebar and the mobile inbox.
  // Defaults off. The dashboard section is not
  // behind it: that route sits outside the flags provider, so it shows
  // whenever the owner has a session in the window.
  cloudSessions: 'claude-cloud-sessions-ui',
  // Automatic box lifecycle: the box menu's Auto-hibernate item. Defaults
  // off; the backend's sweep reads the same flag, so notes about what already
  // happened show regardless.
  autoLifecycle: 'box-auto-lifecycle-enabled',
  // Spaces, shared file stores across boxes: the sidebar
  // section and the box menu's Spaces… item. Defaults off; the backend's
  // /api/spaces routes answer 404 while the same flag is off for the user.
  spaces: 'spaces-enabled',
  // Adding people to a space: the Members & boxes tab's add
  // form. Defaults off; the backend refuses adding members and invites while
  // the same flag is off for the owner, so a space has only its owner.
  spacesSharing: 'spaces-sharing-enabled',
  // New project shares: the Share item's invite form and accepting an invite.
  // Defaults off. The backend refuses invite and accept on the same flag
  // (services/boxSharingFlag.ts); existing shares, revoke, leave and decline
  // are never behind it.
  boxSharing: 'box-sharing-enabled',
  // The simple UI: a chat-first client at /chat over the same sessions, and
  // its entry in the sidebar header. Defaults off; off, /chat sends you to the
  // workspace.
  simpleUi: 'simple-ui-enabled',
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
  // Share to Slack: the project and workstream
  // menus' "Share to Slack…" item. Defaults off; the backend's /api/collab
  // routes refuse while the same flag is off for the user.
  slackCollab: 'slack-collab-enabled',
  // Agent handoff: "Hand off…" in the project and
  // workstream menus and on the context card. Defaults off; the backend
  // refuses a handoff while the same flag is off for the owner and box.
  agentHandoff: 'agent-handoff-enabled',
  // MCP connectors through the termag MCP broker: the
  // Settings page's MCP section. Defaults off; the backend's
  // /api/mcp-connectors routes answer 404 while the same flag is off.
  mcpBroker: 'mcp-broker-enabled',
  // Automations: New automation (Shift on New project,
  // the split button, the ⌘K action), the /automations pages and the
  // automation rows' subtitles. Defaults off; the backend refuses create,
  // PATCH and Run now on the same flag for the owner and box.
  automations: 'automations-enabled',
  // Browser pane: the Browser bar under the ctrl
  // terminal, a headless Chromium on the box screencast into the workspace.
  // Defaults off; the backend closes the pane socket 4403 while the same flag
  // is off for the viewer and box.
  browserPane: 'browser-pane-enabled',
  // Renaming a box: the box menu's Rename item. Defaults off; the backend's
  // rename routes answer 403 rename_disabled while the same flag is off.
  boxRename: 'box-rename-enabled',
  // Preview shares: the dock's "Share…" for an owner,
  // and the lifetime its dialog preselects.
  previewShare: 'browser-pane-preview-share-enabled',
  previewShareTtlHours: 'browser-pane-preview-share-ttl-hours',
  // PR link shares (phase 2): the PR overlay's "Share preview", beside previewShare.
  prLinkShares: 'browser-pane-pr-link-shares-enabled',
  // Kept browser profiles: the pane's "Reset browser".
  persistentProfiles: 'browser-pane-persistent-profiles-enabled',
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
  // Session titles in the simple UI's sidebar:
  // each row leads with Claude's own title for its session, the project and
  // workstream under it. Defaults off; the backend asks boxes for the title
  // only while the same flag is on for the sender, so off there is none to show.
  sessionTitles: 'simple-ui-session-titles-enabled',
  // Review groups in the PR overlay: the
  // card at the top of Needs you and Needs my review, and Add to group on a PR.
  // Defaults off; GET /api/prs serves stored groups regardless.
  prReviewGroups: 'pr-review-groups-enabled',
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
