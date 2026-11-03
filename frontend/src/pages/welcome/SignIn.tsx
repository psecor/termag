import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Heading, LinkButton, Text } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import './welcome.css';

/**
 * What the backend's `/login?error=…` redirects mean, in words: `unauthorized`
 * when the account isn't on the allowlist, `session_expired` when the OIDC
 * transaction was lost (routes/auth.ts).
 */
export const SIGN_IN_ERRORS: Record<string, string> = {
  unauthorized: "This account doesn't have access to termag yet. Ask a termag admin to add it, then sign in again.",
  session_expired: 'Sign-in took too long and timed out. Try again.',
};

export function signInError(search: string): string | null {
  return SIGN_IN_ERRORS[new URLSearchParams(search).get('error') ?? ''] ?? null;
}

/**
 * The sign-in page under onboarding-refresh-enabled, in LaunchPad and the UI font, with the reason a sign-in was
 * refused. `label` names the provider (App.tsx's Login reads it from
 * /auth/config).
 */
export default function SignIn({ label }: { label: string }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const error = signInError(useLocation().search);
  return (
    <div className={`wel-root wel-login ${LP_THEME}`}>
      <main className="wel-card" aria-labelledby="wel-login-h">
        <span className="wel-login-mark"><Icon name="terminal" size="medium" aria-hidden="true" /></span>
        <div className="wel-head">
          <Heading level={1} id="wel-login-h" className="wel-title">Sign in to termag</Heading>
          <Text className="wel-sub">Run coding agents on boxes of your own.</Text>
        </div>
        {error && <Alert status="error" variant="inline" className="wel-login-alert">{error}</Alert>}
        <LinkButton href="/termag/auth/login" variant="primary" size="large" className="wel-login-button">{label}</LinkButton>
      </main>
    </div>
  );
}
