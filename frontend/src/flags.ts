// Feature flags, configured by the deployment.
//
// The backend serves the values set in TERMAG_FLAGS (backend/src/services/
// featureFlags.ts) at GET /api/flags, and FeatureFlagsProvider loads them
// before rendering anything that reads a flag. Every read names a fallback, so
// with nothing configured the app runs on the fallbacks below.
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
} as const;

let flagValues: Record<string, unknown> = {};

export function setFlagValues(values: Record<string, unknown> | undefined): void {
  flagValues = values ?? {};
}

// Read a flag with a typed fallback. Values are loaded once, before the app
// renders, so this needs no subscription; it keeps the hook name so call sites
// read like any other hook.
export function useFlag<T>(key: string, fallback: T): T {
  const value = flagValues[key];
  return (value === undefined ? fallback : value) as T;
}
