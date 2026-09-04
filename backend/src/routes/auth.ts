import { Router, RequestHandler, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { prisma } from '../db';
import { PROVIDER_IDS } from '../providers/registry';
import { parseAllowedUsers, resolveUnixUsername } from '../auth/allowedUsers';
import { verifyAlbIdentity } from '../auth/albOidc';
import {
  oidcConfigFromEnv, getOidcClient, newTransaction, authorizationUrl, completeLogin, type OidcIdentity,
} from '../auth/oidc';
import { autoProvisionFirstBox } from '../services/boxProvisioner';


export type AuthMode = 'google' | 'okta' | 'oidc';

/**
 * Which sign-in mechanism the app uses, controlled by the AUTH_MODE env var:
 *   - 'google' (default): in-app Google OAuth via passport-google-oauth20.
 *   - 'okta': identity is established at the edge by the ALB's authenticate-oidc
 *     (Okta) action and read from the `x-amzn-oidc-data` header by
 *     albSessionBridge; there is no in-app OAuth strategy.
 *   - 'oidc': in-app OpenID Connect authorization-code flow (auth/oidc.ts) for
 *     deployments with no ALB edge auth — e.g. the containerised orchestrator
 *     behind a Kubernetes ingress. Needs OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET.
 *
 * Defaults to 'google' so the app keeps working on deployments whose ALB does
 * not (yet) perform Okta edge auth. Set AUTH_MODE=okta once the ALB
 * authenticate-oidc gate is in place, or AUTH_MODE=oidc where the app must
 * talk to the identity provider itself.
 */
export function authMode(): AuthMode {
  const mode = process.env.AUTH_MODE;
  return mode === 'okta' || mode === 'oidc' ? mode : 'google';
}

/**
 * Turn an externally-verified identity (Okta via the ALB header, or the in-app
 * OIDC flow) into a termag user: enforce ALLOWED_USERS, upsert by email, and
 * return null when the identity is not allowlisted. Shared by both identity
 * paths so their user shape can't drift. `idPrefix` only matters on first
 * creation — the upsert is keyed by email.
 */
async function upsertAllowlistedUser(identity: OidcIdentity, idPrefix: 'okta' | 'oidc'): Promise<Express.User | null> {
  const allowedUsers = parseAllowedUsers(process.env.ALLOWED_USERS);
  const unixUsername = resolveUnixUsername(allowedUsers, identity.email);
  if (!unixUsername) {
    console.warn(`[auth] rejected sign-in for ${identity.email}: not in ALLOWED_USERS`);
    return null;
  }
  const user = await prisma.user.upsert({
    where: { googleEmail: identity.email },
    update: { displayName: identity.name ?? identity.email, unixUsername },
    create: {
      googleId: `${idPrefix}:${identity.sub}`,
      googleEmail: identity.email,
      unixUsername,
      displayName: identity.name ?? identity.email,
    },
  });
  return user as Express.User;
}

export function configurePassport(): void {
  // In google mode, identity comes from Google OAuth. In okta mode, identity is
  // established at the ALB edge (see albSessionBridge) and no OAuth strategy is
  // registered — passport is kept only for its session (serialize/deserialize).
  if (authMode() === 'google') {
    const allowedUsers = parseAllowedUsers(process.env.ALLOWED_USERS);
    const basePath = process.env.BASE_PATH ?? '';
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3040';

    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID ?? '',
          clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
          callbackURL: `${frontendUrl}${basePath}/auth/google/callback`,
        },
        async (_accessToken: string, _refreshToken: string, profile: Profile, done) => {
          try {
            const email = profile.emails?.[0]?.value ?? '';
            const unixUsername = resolveUnixUsername(allowedUsers, email);

            if (!unixUsername) {
              console.warn(`[auth] rejected sign-in for ${email || '(no email)'}: not in ALLOWED_USERS`);
              return done(null, false);
            }

            const user = await prisma.user.upsert({
              where: { googleId: profile.id },
              update: { displayName: profile.displayName },
              create: {
                googleId: profile.id,
                googleEmail: email,
                unixUsername,
                displayName: profile.displayName,
              },
            });

            return done(null, user as Express.User);
          } catch (err) {
            return done(err as Error);
          }
        }
      )
    );
  }

  passport.serializeUser((user, done) => {
    done(null, (user as Express.User).id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { id } });
      done(null, user ? (user as Express.User) : false);
    } catch (err) {
      done(err);
    }
  });
}

/**
 * Bridge the ALB-verified Okta identity into a passport session. Runs on every
 * request after passport.session():
 *   - already has a session  -> pass through
 *   - no `x-amzn-oidc-data`   -> pass through (machine/token routes that bypass
 *                                edge auth handle their own auth; human routes
 *                                without a session fall through to a 401)
 *   - valid identity in ALLOWED_USERS -> upsert + establish session
 *   - identity not allowlisted        -> 403
 *   - present but invalid (tampered/expired) -> 401 (fail closed)
 * Kolide device trust is enforced upstream by Okta before the ALB ever signs
 * this header, so reaching here means the device already passed posture checks.
 */
export const albSessionBridge: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  // Only the ALB/Okta edge model consults this header. In google mode the bridge
  // is a no-op so the header (if ever present) can't be used to bypass OAuth.
  if (authMode() !== 'okta') return next();
  if (req.user) return next();

  let identity;
  try {
    identity = await verifyAlbIdentity(req);
  } catch (err) {
    console.warn(`[auth] rejecting request with invalid ALB identity: ${(err as Error).message}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!identity) return next();

  try {
    const user = await upsertAllowlistedUser(identity, 'okta');
    if (!user) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    req.login(user, (err) => {
      if (err) return next(err);
      // First-login auto-provision (env-gated, no-op unless enabled). Fired
      // un-awaited so a slow/failed box spin-up never blocks or breaks login.
      void autoProvisionFirstBox(user);
      next();
    });
  } catch (err) {
    next(err as Error);
  }
};

export function authRouter(): Router {
  const router = Router();
  const basePath = process.env.BASE_PATH ?? '';
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3040';

  // Public: lets the login page render the right provider label and know which
  // entry point to hit. Reachable unauthenticated (albSessionBridge passes
  // through without a session/identity).
  router.get('/config', (_req, res) => {
    res.json({ mode: authMode() });
  });

  // Login entry point. `/auth/login` is the single, mode-agnostic URL the
  // frontend links to:
  //   - google mode: kick off the Google OAuth flow.
  //   - oidc mode: kick off the in-app OpenID Connect code flow.
  //   - okta mode: the ALB has already authenticated the user against Okta by
  //     the time any request reaches the app, so albSessionBridge has a verified
  //     identity to turn into a session — just bounce to the app root.
  if (authMode() === 'oidc') {
    // Fail fast at startup on a misconfigured deployment rather than 500-ing
    // the first login attempt.
    const cfg = oidcConfigFromEnv(process.env);

    const start: RequestHandler = async (req, res, next) => {
      try {
        const client = await getOidcClient(cfg);
        const tx = newTransaction();
        req.session.oidc = tx;
        // Persist the PKCE state/nonce/verifier BEFORE redirecting. express-session
        // only auto-saves when the response ends, and connect-pg-simple writes
        // asynchronously, so a synchronous res.redirect() can put the 302 on the
        // wire before the row exists. The browser then round-trips the IdP and
        // hits /callback against a session with no `oidc` transaction, which
        // surfaces to the user as `session_expired`. Waiting on save() closes
        // that race.
        req.session.save((err) => {
          if (err) return next(err);
          res.redirect(authorizationUrl(client, cfg, tx));
        });
      } catch (err) {
        next(err);
      }
    };

    const callback: RequestHandler = async (req, res, next) => {
      const tx = req.session.oidc;
      delete req.session.oidc;
      if (!tx) {
        // No pending transaction: expired session, replayed callback, or a
        // cross-site redirect. Start over rather than accept anything.
        res.redirect(`${basePath}/login?error=session_expired`);
        return;
      }

      let identity: OidcIdentity;
      try {
        identity = await completeLogin(await getOidcClient(cfg), cfg, req, tx);
      } catch (err) {
        console.warn(`[auth] OIDC callback rejected: ${(err as Error).message}`);
        res.redirect(`${basePath}/login?error=unauthorized`);
        return;
      }

      try {
        const user = await upsertAllowlistedUser(identity, 'oidc');
        if (!user) {
          res.redirect(`${basePath}/login?error=unauthorized`);
          return;
        }
        req.login(user, (err) => {
          if (err) return next(err);
          void autoProvisionFirstBox(user);
          res.redirect(`${frontendUrl}${basePath}/`);
        });
      } catch (err) {
        next(err as Error);
      }
    };

    router.get('/login', start);
    router.get('/oidc', start);
    router.get('/oidc/callback', callback);
  } else if (authMode() === 'google') {
    router.get('/login', passport.authenticate('google', { scope: ['profile', 'email'] }));
    router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
    router.get(
      '/google/callback',
      passport.authenticate('google', { failureRedirect: `${basePath}/login?error=unauthorized` }),
      (_req, res) => {
        res.redirect(`${frontendUrl}${basePath}/`);
      }
    );
  } else {
    router.get('/login', (_req, res) => {
      res.redirect(`${frontendUrl}${basePath}/`);
    });
  }

  const logout: RequestHandler = (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ ok: true });
    });
  };

  const me: RequestHandler = (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({
      id: req.user.id,
      email: req.user.googleEmail,
      displayName: req.user.displayName,
      unixUsername: req.user.unixUsername,
      defaultAgentProvider: req.user.defaultAgentProvider,
    });
  };

  const updatePreferences: RequestHandler = async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { defaultAgentProvider } = req.body as { defaultAgentProvider?: string };
    if (!defaultAgentProvider || !PROVIDER_IDS.includes(defaultAgentProvider)) {
      res.status(400).json({ error: `defaultAgentProvider must be one of: ${PROVIDER_IDS.join(', ')}` });
      return;
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { defaultAgentProvider },
    });

    req.user.defaultAgentProvider = user.defaultAgentProvider;

    res.json({
      id: user.id,
      email: user.googleEmail,
      displayName: user.displayName,
      unixUsername: user.unixUsername,
      defaultAgentProvider: user.defaultAgentProvider,
    });
  };

  // Dev-only auth bypass — visit /termag/auth/dev-login to sign in as the
  // first identity in ALLOWED_USERS without going through Google. Disabled
  // in production. Useful for local dev where the OAuth client doesn't have
  // localhost registered as a redirect URI.
  //
  // Resolution: first exact email mapping wins. If only domain rules are
  // configured, fabricate a dev@<first-domain> identity and resolve through
  // the normal helper so the unix username is consistent with prod.
  const devLogin: RequestHandler = async (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const allowed = parseAllowedUsers(process.env.ALLOWED_USERS);
    let email: string | undefined;
    let unixUsername: string | undefined;

    const firstExact = allowed.exact.entries().next();
    if (!firstExact.done) {
      [email, unixUsername] = firstExact.value;
    } else if (allowed.domains.length > 0) {
      email = `dev@${allowed.domains[0].domain}`;
      unixUsername = resolveUnixUsername(allowed, email);
    }
    if (!email || !unixUsername) {
      res.status(500).json({ error: 'ALLOWED_USERS has no resolvable identity' });
      return;
    }

    try {
      const user = await prisma.user.upsert({
        where: { googleEmail: email },
        update: { displayName: 'Dev User', unixUsername },
        create: {
          googleId: `dev:${email}`,
          googleEmail: email,
          unixUsername,
          displayName: 'Dev User',
        },
      });
      req.login(user as Express.User, (err) => {
        if (err) return next(err);
        void autoProvisionFirstBox(user);
        res.redirect(`${frontendUrl}${basePath}/`);
      });
    } catch (err) {
      next(err);
    }
  };

  router.post('/logout', logout);
  router.get('/me', me);
  router.put('/me/preferences', updatePreferences);
  router.get('/dev-login', devLogin);

  return router;
}
