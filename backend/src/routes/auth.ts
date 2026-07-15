import { Router, RequestHandler, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { PrismaClient } from '@prisma/client';
import { PROVIDER_IDS } from '../providers/registry';
import { parseAllowedUsers, resolveUnixUsername } from '../auth/allowedUsers';
import { verifyAlbIdentity } from '../auth/albOidc';

const prisma = new PrismaClient();

export type AuthMode = 'google' | 'okta';

/**
 * Which sign-in mechanism the app uses, controlled by the AUTH_MODE env var:
 *   - 'google' (default): in-app Google OAuth via passport-google-oauth20.
 *   - 'okta': identity is established at the edge by the ALB's authenticate-oidc
 *     (Okta) action and read from the `x-amzn-oidc-data` header by
 *     albSessionBridge; there is no in-app OAuth strategy.
 *
 * Defaults to 'google' so the app keeps working on deployments whose ALB does
 * not (yet) perform Okta edge auth. Set AUTH_MODE=okta once the ALB
 * authenticate-oidc gate is in place.
 */
export function authMode(): AuthMode {
  return process.env.AUTH_MODE === 'okta' ? 'okta' : 'google';
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

  const allowedUsers = parseAllowedUsers(process.env.ALLOWED_USERS);
  const unixUsername = resolveUnixUsername(allowedUsers, identity.email);
  if (!unixUsername) {
    console.warn(`[auth] rejected sign-in for ${identity.email}: not in ALLOWED_USERS`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  try {
    const user = await prisma.user.upsert({
      where: { googleEmail: identity.email },
      update: { displayName: identity.name ?? identity.email, unixUsername },
      create: {
        googleId: `okta:${identity.sub}`,
        googleEmail: identity.email,
        unixUsername,
        displayName: identity.name ?? identity.email,
      },
    });
    req.login(user as Express.User, (err) => {
      if (err) return next(err);
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
  //   - okta mode: the ALB has already authenticated the user against Okta by
  //     the time any request reaches the app, so albSessionBridge has a verified
  //     identity to turn into a session — just bounce to the app root.
  if (authMode() === 'google') {
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
