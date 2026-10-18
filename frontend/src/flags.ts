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
  // Claude Code cloud sessions in the sidebar and the mobile inbox. Defaults
  // off. The dashboard section is not behind it.
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
  // Share to Slack: the project and workstream
  // menus' "Share to Slack…" item. Defaults off; the backend's /api/collab
  // routes refuse while the same flag is off for the user.
  slackCollab: 'slack-collab-enabled',
  // Agent handoff: "Hand off…" in the project and
  // workstream menus and on the context card. Defaults off; the backend
  // refuses a handoff while the same flag is off for the owner and box.
  agentHandoff: 'agent-handoff-enabled',
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
