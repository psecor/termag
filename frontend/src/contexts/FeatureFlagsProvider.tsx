import { useEffect, useState, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { featureFlagsApi } from '../services/api';
import { FLAGS, setFlagValues, useFlag } from '../flags';
import { writeRefreshHint } from '../onboarding/refreshHint';

// Loads the deployment's flag values (GET /api/flags) before rendering its
// children, so no flag flips after first paint. If the request fails, children
// render anyway and every flag uses its fallback. Sits under RequireAuth.
export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setResolved(true); return; }
    featureFlagsApi.get()
      .then(r => { if (!cancelled) setFlagValues(r.flags); })
      .catch(() => { /* fallbacks */ })
      .finally(() => { if (!cancelled) setResolved(true); });
    return () => { cancelled = true; };
  }, [user]);

  if (!resolved) return <div className="loading-screen">Loading…</div>;
  return <>{user && <RememberOnboardingRefresh />}{children}</>;
}

// Keeps what a signed-in user was served of onboarding-refresh-enabled, for
// the sign-in page, which has no user to evaluate it for (onboarding/refreshHint.ts).
function RememberOnboardingRefresh() {
  const on = useFlag(FLAGS.onboardingRefresh, false);
  useEffect(() => writeRefreshHint(on), [on]);
  return null;
}
