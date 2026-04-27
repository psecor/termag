import { Router, RequestHandler } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { PrismaClient } from '@prisma/client';
import { PROVIDER_IDS } from '../providers/registry';

const prisma = new PrismaClient();

// Build allowed user map from env: "email:unixuser,email2:unixuser2"
function parseAllowedUsers(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.ALLOWED_USERS ?? '';
  for (const entry of raw.split(',')) {
    const [email, unixUser] = entry.trim().split(':');
    if (email && unixUser) map.set(email.trim(), unixUser.trim());
  }
  return map;
}

export function configurePassport(): void {
  const allowedUsers = parseAllowedUsers();
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
          const unixUsername = allowedUsers.get(email);

          if (!unixUsername) {
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

export function authRouter(): Router {
  const router = Router();
  const basePath = process.env.BASE_PATH ?? '';
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3040';

  router.get(
    '/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
  );

  router.get(
    '/google/callback',
    passport.authenticate('google', { failureRedirect: `${basePath}/login?error=unauthorized` }),
    (_req, res) => {
      res.redirect(`${frontendUrl}${basePath}/`);
    }
  );

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

  router.post('/logout', logout);
  router.get('/me', me);
  router.put('/me/preferences', updatePreferences);

  return router;
}
