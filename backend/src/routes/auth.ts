import { Router, RequestHandler, Request, Response, NextFunction } from 'express';
import type { Prisma, User } from '@prisma/client';
import passport from 'passport';
import { takePostLoginRedirect } from '../auth/postLoginReturn';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { prisma } from '../db';
import { SELECTABLE_PROVIDER_IDS } from '../providers/registry';
import { normalizeTheme, validateTheme } from '../theme/schema';
import { parseAllowedUsers, resolveUnixUsername } from '../auth/allowedUsers';
import { albVerifierConfigFromEnv, verifyAlbIdentity } from '../auth/albOidc';
import {
  oidcConfigFromEnv, getOidcClient, newTransaction, authorizationUrl, completeLogin, type OidcIdentity,
} from '../auth/oidc';
import { assertLocalLoginAllowed, forwardedClients, isSameHostRequest } from '../auth/localLogin';
import { peerAddress } from '../auth/peerAddress';
import { ensureHostSetup } from '../services/hostSetup';
import { parseDotfilesRepoUrl } from '../services/dotfilesUrl';
import { isAdminUser } from '../services/admin/adminAccess';
import { findUserByEmail, sameEmail } from '../services/userByEmail';
import { ownerPlacementKey, serializeByKey } from '../services/claudeRunnerSpawn';


export type AuthMode = 'google' | 'okta' | 'oidc' | 'local';

/**
 * The provider id prefix of a row the cloud-session spawn route made for an
 * engineer who never signed in (services/claudeRunnerOwner.ts). The first
 * sign-in replaces it with the real provider id.
 */
const PLACEHOLDER_ID_PREFIX = 'claude:';

/**
 * Create-or-update by email under sameEmail. A plain upsert keyed on
 * googleEmail misses a row stored in another casing and then fails the create
 * on the unixUsername unique constraint; this updates the existing row instead,
 * keeping its stored email. A row whose provider id is a `claude:` placeholder
 * takes the signing-in provider's id from
 * `create`; any other existing row keeps its id.
 */
export async function upsertUserByEmail(
  email: string,
  update: Prisma.UserUpdateInput,
  create: Prisma.UserCreateInput,
) {
  const adoptOrUpdate = (existing: User) => {
    const adopt = typeof existing.googleId === 'string' && existing.googleId.startsWith(PLACEHOLDER_ID_PREFIX) && typeof create.googleId === 'string' ? { googleId: create.googleId } : {};
    return prisma.user.update({ where: { id: existing.id }, data: { ...update, ...adopt } });
  };
  // Under the spawn route's per-email create lock: a first cloud session for
  // this address may be making its placeholder row at this moment. In this
  // process the key serializes the two; across processes the unique index
  // decides, and a lost race is recovered by reading the row the spawn made
  // and adopting it, as the lookup above would have (Bugbot on #288).
  return serializeByKey(newUserKey(email), async () => {
    const existing = await findUserByEmail(email);
    if (existing) return adoptOrUpdate(existing);
    try {
      return await prisma.user.create({ data: create });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const made = await findUserByEmail(email);
      if (!made) throw err;
      return adoptOrUpdate(made);
    }
  });
}

/** The spawn route's lock for creating a user for an address (routes/claudeRunner.ts); sign-in's creates take it too. */
const newUserKey = (email: string) => `claude-runner:new:${email.toLowerCase()}`;
/** Postgres's unique violation as Prisma reports it. */
const isUniqueViolation = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';

/**
 * A returning user signs in with an address a `claude:` placeholder holds.
 * Under the same per-email lock the spawn route creates placeholders under
 * and the placeholder's placement lock, which its box purchases run under
 * (one backend process serves a host), and in one serializable transaction,
 * so a spawn cannot recreate the placeholder between the delete and the
 * update, nor give it a box between the count and the delete: the count,
 * the delete and the address move see one snapshot, and a concurrent insert
 * for the placeholder conflicts rather than being cascaded away. Any box
 * row at all keeps the placeholder: the returning row then takes only the
 * display name and one warning line names both unix usernames.
 */
async function adoptPlaceholderAddress(returning: User, holder: User, email: string, displayName: string): Promise<User> {
  // The create key, then the placeholder's placement key: the spawn route
  // releases the first before it buys the owner a box under the second
  // (getOwnerABox), so the count here has to hold both to see no box arrive
  // between it and the delete (Bugbot on #288). The spawn never holds the
  // placement key while waiting for the create key, so the order cannot
  // deadlock.
  return serializeByKey(newUserKey(email), () => serializeByKey(ownerPlacementKey(holder.id), () => prisma.$transaction(async (tx) => {
    const boxes = await tx.instance.count({ where: { userId: holder.id } });
    if (boxes > 0) {
      console.warn(`[auth] returning user ${returning.unixUsername} signed in with an address held by placeholder user ${holder.unixUsername}, which has ${boxes} box row(s); not merged, the row keeps its stored address`);
      return tx.user.update({ where: { id: returning.id }, data: { displayName } });
    }
    await tx.user.delete({ where: { id: holder.id } });
    console.log(`[auth] removed placeholder user ${holder.unixUsername}: its address belongs to returning user ${returning.unixUsername}`);
    return tx.user.update({ where: { id: returning.id }, data: { displayName, googleEmail: email } });
  }, { isolationLevel: 'Serializable' })));
}

/**
 * Which sign-in mechanism the app uses, controlled by the AUTH_MODE env var:
 *   - 'google' (default): in-app Google OAuth via passport-google-oauth20.
 *   - 'okta': identity is established at the edge by the ALB's authenticate-oidc
 *     (Okta) action and read from the `x-amzn-oidc-data` header by
 *     albSessionBridge; there is no in-app OAuth strategy.
 *   - 'oidc': in-app OpenID Connect authorization-code flow (auth/oidc.ts) for
 *     deployments with no ALB edge auth — e.g. the containerised orchestrator
 *     behind a Kubernetes ingress. Needs OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET.
 *   - 'local': no identity provider; /auth/login signs in as the first
 *     ALLOWED_USERS identity. For the local e2e stack only: authRouter()
 *     refuses to start unless NODE_ENV is development/test and BIND_HOST is
 *     loopback, and each sign-in must come from this host (auth/localLogin.ts).
 *
 * Defaults to 'google' so the app keeps working on deployments whose ALB does
 * not (yet) perform Okta edge auth. Set AUTH_MODE=okta once the ALB
 * authenticate-oidc gate is in place, or AUTH_MODE=oidc where the app must
 * talk to the identity provider itself.
 */
export function authMode(): AuthMode {
  const mode = process.env.AUTH_MODE;
  return mode === 'okta' || mode === 'oidc' || mode === 'local' ? mode : 'google';
}

/**
 * Turn an externally-verified identity (Okta via the ALB header, or the in-app
 * OIDC flow) into a termag user: enforce ALLOWED_USERS, upsert by email, and
 * return null when the identity is not allowlisted. Shared by both identity
 * paths so their user shape can't drift. `idPrefix` only matters on first
 * creation — the upsert is keyed by email.
 */
export async function upsertAllowlistedUser(identity: OidcIdentity, idPrefix: 'okta' | 'oidc'): Promise<Express.User | null> {
  const allowedUsers = parseAllowedUsers(process.env.ALLOWED_USERS);
  const unixUsername = resolveUnixUsername(allowedUsers, identity.email);
  if (!unixUsername) {
    console.warn(`[auth] rejected sign-in for ${identity.email}: not in ALLOWED_USERS`);
    return null;
  }
  const user = await upsertUserByEmail(
    identity.email,
    { displayName: identity.name ?? identity.email, unixUsername },
    {
      googleId: `${idPrefix}:${identity.sub}`,
      googleEmail: identity.email,
      unixUsername,
      displayName: identity.name ?? identity.email,
    },
  );
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

            // Main's rule, unchanged: a Google user is their subject (googleId),
            // and a returning one takes only the current display name. The
            // only new paths are the ones a `claude:` placeholder row opens, a
            // row the cloud-session spawn route made for this address behind
            // claude-runner-auto-user-enabled: a subject termag has never seen adopts the placeholder for
            // its address instead of creating a second row, and a returning
            // subject whose current address a placeholder holds takes the
            // address (adoptPlaceholderAddress). Without a placeholder, both
            // branches are the upsert by subject they were.
            const returning = await prisma.user.findUnique({ where: { googleId: profile.id } });
            const holder = returning && sameEmail(returning.googleEmail, email) ? returning : await findUserByEmail(email);
            const placeholder = holder && holder.id !== returning?.id && typeof holder.googleId === 'string' && holder.googleId.startsWith(PLACEHOLDER_ID_PREFIX) ? holder : null;
            let user;
            if (returning && placeholder) {
              user = await adoptPlaceholderAddress(returning, placeholder, email, profile.displayName);
            } else if (!returning && placeholder) {
              user = await upsertUserByEmail(
                email,
                { displayName: profile.displayName, unixUsername },
                { googleId: profile.id, googleEmail: email, unixUsername, displayName: profile.displayName },
              );
            } else {
              // Under the spawn route's per-email create lock, and recovering
              // from a lost race with it: a placeholder made for this address
              // between the lookup above and this upsert fails the create on
              // the unique index, and the sign-in adopts that row as the
              // branch above would rather than failing (Bugbot on #288).
              user = await serializeByKey(newUserKey(email), async () => {
                try {
                  return await prisma.user.upsert({
                    where: { googleId: profile.id },
                    update: { displayName: profile.displayName },
                    create: {
                      googleId: profile.id,
                      googleEmail: email,
                      unixUsername,
                      displayName: profile.displayName,
                    },
                  });
                } catch (err) {
                  if (!isUniqueViolation(err)) throw err;
                  const made = await findUserByEmail(email);
                  if (!made || typeof made.googleId !== 'string' || !made.googleId.startsWith(PLACEHOLDER_ID_PREFIX)) throw err;
                  return prisma.user.update({ where: { id: made.id }, data: { googleId: profile.id, displayName: profile.displayName, unixUsername } });
                }
              });
            }

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
 * request after passport.session(). In okta mode the header, not the cookie, is
 * the identity: a session only stands when the request carries a valid
 * `x-amzn-oidc-data` for the same user, because some callers reach :3040
 * without passing the ALB and a cookie can be stolen or tossed from a sibling
 * host.
 *   - no `x-amzn-oidc-data`   -> unauthenticated: req.user is cleared, the
 *                                session row is left alone (bearer-token routes
 *                                that bypass edge auth handle their own auth)
 *   - session for the header's user -> pass through
 *   - no session, or a session for someone else -> upsert + log in as the
 *                                header's user in a fresh session
 *   - identity not allowlisted        -> 403
 *   - present but invalid (tampered/expired) -> 401 (fail closed)
 * Any device-trust policy is enforced upstream by the IdP before the ALB ever
 * signs this header.
 */
export const albSessionBridge: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  // Only the ALB/Okta edge model consults this header. In google mode the bridge
  // is a no-op so the header (if ever present) can't be used to bypass OAuth.
  if (authMode() !== 'okta') return next();

  let identity;
  try {
    identity = await verifyAlbIdentity(req);
  } catch (err) {
    console.warn(`[auth] rejecting request with invalid ALB identity: ${(err as Error).message}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!identity) {
    req.user = undefined;
    return next();
  }
  if (req.user && sameEmail(req.user.googleEmail, identity.email)) return next();

  try {
    const user = await upsertAllowlistedUser(identity, 'okta');
    if (!user) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    // req.login regenerates, which destroys the current session row. When that
    // row is another user's (a tossed or replayed cookie), detach from it first
    // so a mismatched request can't log its owner out.
    if (req.user) req.sessionStore.generate(req);
    req.login(user, (err) => {
      if (err) return next(err);
      void ensureHostSetup(user);
      next();
    });
  } catch (err) {
    next(err as Error);
  }
};

/**
 * The user a WebSocket upgrade acts as. Runs after the session middleware, with
 * no response to log anyone in on, so okta mode applies albSessionBridge's rule
 * by reading the header's user directly: no valid header, no user.
 */
export async function upgradeUserId(req: Request): Promise<string | null> {
  if (authMode() !== 'okta') {
    const sessionUser = (req.session as { passport?: { user?: unknown } } | undefined)?.passport?.user;
    return typeof sessionUser === 'string' && sessionUser ? sessionUser : null;
  }
  let identity;
  try {
    identity = await verifyAlbIdentity(req);
  } catch (err) {
    console.warn(`[ws] rejecting upgrade with invalid ALB identity: ${(err as Error).message}`);
    return null;
  }
  if (!identity) return null;
  if (!resolveUnixUsername(parseAllowedUsers(process.env.ALLOWED_USERS), identity.email)) return null;
  const user = await findUserByEmail(identity.email);
  return user?.id ?? null;
}

export function authRouter(): Router {
  const router = Router();
  const basePath = process.env.BASE_PATH ?? '';
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3040';

  // Fail fast at startup on a misconfigured okta deployment, as oidc mode does:
  // without the ALB ARN, issuer and client id every request would 401.
  if (authMode() === 'okta') albVerifierConfigFromEnv(process.env);
  if (authMode() === 'local') assertLocalLoginAllowed(process.env);

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
  //   - local mode: sign in straight away (localLogin, below).
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
        const returnTo = takePostLoginRedirect(req.session, basePath, frontendUrl);
        req.login(user, (err) => {
          if (err) return next(err);
          void ensureHostSetup(user);
          res.redirect(returnTo);
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
      // passport.authenticate regenerates the session, so read the stash first.
      (req, res, next) => {
        res.locals.returnTo = takePostLoginRedirect(req.session, basePath, frontendUrl);
        next();
      },
      passport.authenticate('google', { failureRedirect: `${basePath}/login?error=unauthorized` }),
      (_req, res) => {
        res.redirect(res.locals.returnTo as string);
      }
    );
  } else if (authMode() === 'okta') {
    router.get('/login', (req, res) => {
      res.redirect(takePostLoginRedirect(req.session, basePath, frontendUrl));
    });
  }

  const logout: RequestHandler = (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ ok: true });
    });
  };

  // The user as the frontend sees it (frontend/src/types User). /me and the
  // preferences update both return it so the two shapes cannot drift.
  const userPayload = (user: Express.User) => ({
    id: user.id,
    email: user.googleEmail,
    displayName: user.displayName,
    unixUsername: user.unixUsername,
    defaultAgentProvider: user.defaultAgentProvider,
    dotfilesRepoUrl: user.dotfilesRepoUrl,
    // First-run wizard: when it was finished/skipped (null = never). /me adds
    // `needsOnboarding`, which also requires the user to have no projects, so
    // existing users never see the wizard without opting in from Settings.
    onboardedAt: user.onboardedAt ? user.onboardedAt.toISOString() : null,
    theme: normalizeTheme(user.theme),
    // Phone push replaces Slack/Discord "needs input" posts.
    pushMutesChat: user.pushMutesChat ?? false,
    // Simple UI: notify when a chat finishes its turn.
    chatTurnNotify: user.chatTurnNotify ?? false,
    // Effective role (users.role or an ADMIN_USERS match). Drives the admin
    // nav entry only; requireAdmin re-derives it on every admin request.
    role: isAdminUser(user) ? 'admin' : 'member',
  });

  const me: RequestHandler = async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    let needsOnboarding = false;
    if (!req.user.onboardedAt) {
      // Fail closed: if the count cannot be read, do not send anyone to the wizard.
      try {
        const projects = await prisma.project.count({ where: { userId: req.user.id, archived: false } });
        needsOnboarding = projects === 0;
      } catch { needsOnboarding = false; }
    }
    res.json({ ...userPayload(req.user), needsOnboarding });
  };

  // PUT /auth/me/onboarding { done: boolean } — the first-run wizard was
  // finished or skipped (done: true), or the user wants it offered again
  // (done: false, from Settings).
  const setOnboarding: RequestHandler = async (req, res) => {
    if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const { done } = (req.body ?? {}) as { done?: unknown };
    if (typeof done !== 'boolean') { res.status(400).json({ error: 'done must be a boolean' }); return; }
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { onboardedAt: done ? new Date() : null } });
    req.user.onboardedAt = user.onboardedAt;
    res.json({ ...userPayload(req.user), needsOnboarding: false });
  };

  // Partial update: any subset of the preference fields, each validated on its
  // own. The theme arrives whole (the client holds the full object), so there
  // is no read-modify-write and no merge here.
  const updatePreferences: RequestHandler = async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as { defaultAgentProvider?: unknown; dotfilesRepoUrl?: unknown; theme?: unknown; pushMutesChat?: unknown; chatTurnNotify?: unknown };
    const data: { defaultAgentProvider?: string; dotfilesRepoUrl?: string | null; theme?: Prisma.InputJsonValue; pushMutesChat?: boolean; chatTurnNotify?: boolean } = {};
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

    if (has('defaultAgentProvider')) {
      if (typeof body.defaultAgentProvider !== 'string' || !SELECTABLE_PROVIDER_IDS.includes(body.defaultAgentProvider)) {
        res.status(400).json({ error: `defaultAgentProvider must be one of: ${SELECTABLE_PROVIDER_IDS.join(', ')}` });
        return;
      }
      data.defaultAgentProvider = body.defaultAgentProvider;
    }

    if (has('dotfilesRepoUrl')) {
      const parsed = parseDotfilesRepoUrl(body.dotfilesRepoUrl);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      data.dotfilesRepoUrl = parsed.value;
    }

    if (has('theme')) {
      const theme = validateTheme(body.theme);
      if (!theme.ok) {
        res.status(400).json({ error: theme.error });
        return;
      }
      data.theme = theme.theme as unknown as Prisma.InputJsonValue;
    }

    if (has('pushMutesChat')) {
      if (typeof body.pushMutesChat !== 'boolean') {
        res.status(400).json({ error: 'pushMutesChat must be a boolean' });
        return;
      }
      data.pushMutesChat = body.pushMutesChat;
    }

    if (has('chatTurnNotify')) {
      if (typeof body.chatTurnNotify !== 'boolean') {
        res.status(400).json({ error: 'chatTurnNotify must be a boolean' });
        return;
      }
      data.chatTurnNotify = body.chatTurnNotify;
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'No supported preference supplied' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
    });

    req.user.defaultAgentProvider = user.defaultAgentProvider;
    req.user.dotfilesRepoUrl = user.dotfilesRepoUrl;
    req.user.theme = user.theme;
    req.user.pushMutesChat = user.pushMutesChat;
    req.user.chatTurnNotify = user.chatTurnNotify;

    res.json(userPayload(user));
  };

  // Local mode: sign in as the first identity in ALLOWED_USERS without an
  // identity provider. Registered only when AUTH_MODE=local.
  //
  // Resolution: first exact email mapping wins. If only domain rules are
  // configured, fabricate a dev@<first-domain> identity and resolve through
  // the normal helper so the unix username is consistent with prod.
  const localLogin: RequestHandler = async (req, res, next) => {
    if (!isSameHostRequest(req)) {
      const fwd = forwardedClients(req);
      console.warn(`[auth] refused AUTH_MODE=local sign-in from a non-local caller (peer ${peerAddress(req)}${
        fwd.length ? `, forwarded for ${fwd.join(', ')}` : ''})`);
      res.status(403).json({ error: 'AUTH_MODE=local only signs in callers on this host' });
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
      const user = await upsertUserByEmail(
        email,
        { displayName: 'Dev User', unixUsername },
        {
          googleId: `dev:${email}`,
          googleEmail: email,
          unixUsername,
          displayName: 'Dev User',
        },
      );
      const returnTo = takePostLoginRedirect(req.session, basePath, frontendUrl);
      req.login(user as Express.User, (err) => {
        if (err) return next(err);
        void ensureHostSetup(user);
        res.redirect(returnTo);
      });
    } catch (err) {
      next(err);
    }
  };

  router.post('/logout', logout);
  router.get('/me', me);
  router.put('/me/preferences', updatePreferences);
  router.put('/me/onboarding', setOnboarding);
  if (authMode() === 'local') router.get('/login', localLogin);

  return router;
}
