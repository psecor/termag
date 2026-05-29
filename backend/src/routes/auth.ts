import { Router, RequestHandler } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { PrismaClient } from '@prisma/client';
import { PROVIDER_IDS } from '../providers/registry';

const prisma = new PrismaClient();

// Domain wildcard rule. `unixUser` null means "derive the unix username from
// the email's local part" (e.g. jane@launchdarkly.com -> jane).
interface DomainRule {
  domain: string; // lowercased, includes leading "@" stripped, e.g. "launchdarkly.com"
  unixUser: string | null;
}

export interface AllowedUsers {
  exact: Map<string, string>;
  domains: DomainRule[];
}

// Build allowed users from env. Each comma-separated entry is one of:
//   email:unixuser              exact mapping (highest priority)
//   @domain.com                 anyone in domain; unix username = email local part
//   @domain.com:unixuser        anyone in domain mapped to a fixed unix username
function parseAllowedUsers(): AllowedUsers {
  const exact = new Map<string, string>();
  const domains: DomainRule[] = [];
  const raw = process.env.ALLOWED_USERS ?? '';
  for (const rawEntry of raw.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const [left, right] = entry.split(':');
    const key = left.trim();
    const unixUser = right?.trim();
    if (key.startsWith('@')) {
      const domain = key.slice(1).toLowerCase();
      if (domain) domains.push({ domain, unixUser: unixUser || null });
    } else if (key && unixUser) {
      exact.set(key, unixUser);
    }
  }
  return { exact, domains };
}

// Resolve the unix username for an email, honoring exact matches first and then
// domain wildcards. Returns undefined if the email is not allowed.
export function resolveUnixUsername(
  allowed: AllowedUsers,
  email: string
): string | undefined {
  if (!email) return undefined;
  const exact = allowed.exact.get(email);
  if (exact) return exact;

  const at = email.lastIndexOf('@');
  if (at <= 0) return undefined;
  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  for (const rule of allowed.domains) {
    if (rule.domain === domain) {
      return rule.unixUser ?? localPart.toLowerCase();
    }
  }
  return undefined;
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
          const unixUsername = resolveUnixUsername(allowedUsers, email);

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
