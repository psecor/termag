import { Router, RequestHandler, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { PrismaClient } from '@prisma/client';
import { PROVIDER_IDS } from '../providers/registry';
import { parseAllowedUsers, resolveUnixUsername } from '../auth/allowedUsers';
import { verifyAlbIdentity } from '../auth/albOidc';

const prisma = new PrismaClient();

export function configurePassport(): void {
  // Identity comes from the ALB's authenticate-oidc (Okta) edge auth, verified
  // by albSessionBridge below — there is no in-app OAuth strategy. Passport is
  // kept only for its session (serialize/deserialize by user id).
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

  // Login entry point. The ALB has already authenticated the user against Okta
  // by the time any request reaches the app, so albSessionBridge has a verified
  // identity to turn into a session — just bounce to the app root.
  router.get('/login', (_req, res) => {
    res.redirect(`${frontendUrl}${basePath}/`);
  });

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
