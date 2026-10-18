/**
 * /termag/api/cli/v1 — the `termag` CLI's API.
 *
 * Bearer-only. index.ts mounts it BEFORE the session, passport and ALB-bridge
 * middleware, so a cookie or an `x-amzn-oidc-data` header can never
 * authenticate here (audit F3, F7), and this is the one prefix the ALB lets
 * past Okta: from the internet only with a JWT its jwt-validation action
 * accepts, except POST /token and GET /jwks.json, which are public. Every
 * route is listed explicitly; never mount another router under it.
 *
 * The one sibling is routes/cliCredentials.ts, which index.ts mounts just ahead
 * of this router with the same bearer check.
 *
 * Accepted credentials:
 *   eyJ…     an access token (services/cliJwt.ts), minted from a device
 *            session by POST /token; what the CLI sends through the ALB
 *   tmcli_…  a device token minted by `termag login` (services/cliAuth.ts),
 *            the refresh token; accepted directly where there is no ALB
 *   tmag_…   an owner-bound, `agent`-scoped token, which is how the CLI on a
 *            box runs without logging in. Ownerless warm-pool tokens and
 *            `admin` tokens get 401 (services/cliStore.ts).
 *
 * The CLI's WebSockets (routes/cliWs.ts) sit under /api/cli/v1/ws/ and judge
 * their Authorization header with authenticateCliBearer below.
 *
 * Responses are a contract with shipped clients (services/cliViews.ts).
 */
import { Router, RequestHandler, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { mountCliTuiRoutes, type CliTui } from './cliTui';
import {
  AuthCodeStore,
  CLI_TOKEN_PREFIX,
  cliSessionAfterUse,
  cliSessionValidity,
  generateCliToken,
  sha256Hex,
  shouldTouch,
} from '../services/cliAuth';
import { isJwtShaped, type CliJwt } from '../services/cliJwt';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import { closeCliSocketsForSession } from './cliWs';
import { shapeDevices } from '../services/cliViews';
import { mountCliLifecycleRoutes, type CliLifecycle } from './cliLifecycle';
import { mountCliAskRoutes, type CliAsk } from './cliAsk';

export interface CliApiDeps {
  /** The TUI's routes (routes/cliTui.ts); unset in tests that don't need them. */
  tui?: CliTui;
  store: CliStore;
  codes: AuthCodeStore;
  /** A promise because KMS keys load asynchronously at startup. */
  jwt: Promise<CliJwt>;
  now?: () => Date;
  lifecycle?: CliLifecycle;
  /** Agent-to-agent asks (routes/cliAsk.ts). */
  ask?: CliAsk;
}

export type CliCredential =
  | { kind: 'device'; sessionId: string; deviceName: string; expiresAt: Date; maxExpiresAt: Date }
  | { kind: 'box'; boxId: string | null };

export interface CliAuth {
  user: CliUser;
  credential: CliCredential;
}

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

function authRequired(res: Response, message: string): void {
  res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: message, code: 'auth_required' });
}

function userView(u: CliUser) {
  return { email: u.googleEmail, unixUsername: u.unixUsername, displayName: u.displayName };
}

export type CliBearerDeps = Pick<CliApiDeps, 'store' | 'jwt' | 'now'>;

export type CliBearerResult = { auth: CliAuth } | { error: string };

/**
 * Judge a raw bearer credential the way every /api/cli/v1 route does. Shared
 * with the CLI's WebSockets (routes/cliWs.ts), whose upgrade has no Express
 * request, so a revoked device sign-in is refused there on the same terms.
 */
export async function authenticateCliBearer(deps: CliBearerDeps, raw: string): Promise<CliBearerResult> {
  const now = deps.now ?? (() => new Date());
  if (!raw) return { error: 'Missing bearer token; run `termag login`' };

  let session: CliSessionRecord | null | undefined;
  if (raw.startsWith(CLI_TOKEN_PREFIX)) {
    session = await deps.store.findSessionByHash(sha256Hex(raw));
  } else if (isJwtShaped(raw)) {
    const claims = (await deps.jwt).verify(raw, now().getTime());
    session = claims && await deps.store.findSessionById(claims.jti);
    if (session && session.userId !== claims?.sub) session = null;
  }
  if (session !== undefined) {
    const at = now();
    if (!session) return { error: 'Unknown token; run `termag login`' };
    const validity = cliSessionValidity(session, at);
    if (!validity.valid) {
      return {
        error: validity.reason === 'revoked'
          ? 'This device was signed out; run `termag login`'
          : 'Sign-in expired; run `termag login`',
      };
    }
    if (shouldTouch(session.lastUsedAt, at)) {
      deps.store.touchSession(session.id, at).catch(() => {});
    }
    const after = cliSessionAfterUse(session, at);
    return {
      auth: {
        user: session.user,
        credential: {
          kind: 'device', sessionId: session.id, deviceName: session.deviceName,
          expiresAt: after.expiresAt, maxExpiresAt: after.maxExpiresAt,
        },
      },
    };
  }

  if (raw.startsWith('tmag_')) {
    const agent = await deps.store.validateAgentToken(raw);
    if (agent) return { auth: { user: agent.user, credential: { kind: 'box', boxId: agent.instanceId } } };
  }
  return { error: 'Invalid token; run `termag login`' };
}

export function cliBearer(deps: CliBearerDeps): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const result = await authenticateCliBearer(deps, raw);
    if ('error' in result) { authRequired(res, result.error); return; }
    res.locals.cliAuth = result.auth satisfies CliAuth;
    next();
  });
}

export function cliApiRouter(deps: CliApiDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const bearer = cliBearer(deps);

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  if (deps.tui) mountCliTuiRoutes(router, deps.tui, bearer);

  // The ALB's jwt-validation action fetches this; it is public.
  router.get('/jwks.json', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json((await deps.jwt).jwks());
  }));

  // Public at the ALB too: the CLI has no access token yet when it calls this.
  // authorization_code trades a one-time code from /auth/cli/authorize for a
  // device token and a first access token; refresh_token trades the device
  // token for a new access token, which counts as a use of the session.
  router.post('/token', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const at = now();
    if (body.grant_type === 'refresh_token') {
      const raw = typeof body.refresh_token === 'string' ? body.refresh_token : '';
      const session = raw.startsWith(CLI_TOKEN_PREFIX) ? await deps.store.findSessionByHash(sha256Hex(raw)) : null;
      const validity = session && cliSessionValidity(session, at);
      if (!session || !validity?.valid) {
        authRequired(res, validity?.reason === 'revoked'
          ? 'This device was signed out; run `termag login`'
          : 'Sign-in expired; run `termag login`');
        return;
      }
      await deps.store.touchSession(session.id, at);
      const after = cliSessionAfterUse(session, at);
      const access = await (await deps.jwt).issue(session.userId, session.id, at.getTime());
      res.json({
        accessToken: access.token,
        accessTokenExpiresIn: access.expiresIn,
        expiresAt: after.expiresAt.toISOString(),
        maxExpiresAt: after.maxExpiresAt.toISOString(),
      });
      return;
    }
    if (body.grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'grant_type must be authorization_code or refresh_token', code: 'unsupported_grant_type' });
      return;
    }
    const grant = deps.codes.redeem(body.code as string, body.code_verifier as string, at.getTime());
    if (!grant) {
      res.status(400).json({ error: 'Invalid or expired code; run `termag login` again', code: 'invalid_grant' });
      return;
    }
    const { token, tokenHash, tokenPrefix } = generateCliToken();
    const session = await deps.store.createSession({
      userId: grant.userId, deviceName: grant.deviceName, tokenHash, tokenPrefix, now: at,
    });
    const validity = cliSessionValidity(session, at);
    const access = await (await deps.jwt).issue(session.userId, session.id, at.getTime());
    res.status(201).json({
      token,
      tokenPrefix,
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresIn,
      deviceName: session.deviceName,
      user: userView(session.user),
      expiresAt: validity.expiresAt.toISOString(),
      maxExpiresAt: validity.maxExpiresAt.toISOString(),
    });
  }));

  // `termag logout`: revoke the presented device token.
  router.delete('/token', bearer, asyncHandler(async (_req, res) => {
    const { credential } = cliAuth(res);
    if (credential.kind !== 'device') {
      res.status(400).json({ error: 'Box credentials are not a CLI sign-in and cannot be logged out', code: 'box_credential' });
      return;
    }
    await deps.store.revokeSession(credential.sessionId, now());
    closeCliSocketsForSession(credential.sessionId);
    res.status(204).end();
  }));

  router.get('/whoami', bearer, (_req, res) => {
    const { user, credential } = cliAuth(res);
    res.json({
      user: userView(user),
      credential: credential.kind === 'device'
        ? {
          kind: 'device',
          deviceName: credential.deviceName,
          expiresAt: credential.expiresAt.toISOString(),
          maxExpiresAt: credential.maxExpiresAt.toISOString(),
        }
        : { kind: 'box', boxId: credential.boxId },
    });
  });

  router.get('/boxes', bearer, asyncHandler(async (_req, res) => {
    res.json({ boxes: await deps.store.listBoxes(cliAuth(res).user.id) });
  }));

  router.get('/projects', bearer, asyncHandler(async (_req, res) => {
    res.json({ projects: await deps.store.listProjects(cliAuth(res).user.id) });
  }));

  if (deps.lifecycle) mountCliLifecycleRoutes(router, deps.lifecycle, bearer);
  if (deps.ask) mountCliAskRoutes(router, deps.ask, bearer);

  router.use((_req, res) => {
    res.status(404).json({ error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' });
  });

  return router;
}

/**
 * /termag/api/cli-devices — the web UI's view of signed-in CLI devices.
 * Cookie-auth (normal API stack), so a device can be revoked from the browser.
 */
export function cliDevicesRouter(deps: { store: CliStore; now?: () => Date }): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  router.get('/', requireAuth, asyncHandler(async (req, res) => {
    res.json(shapeDevices(await deps.store.listDevices(req.user!.id), now()));
  }));

  router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    const ok = await deps.store.revokeDevice(req.user!.id, req.params.id, now());
    if (!ok) { res.status(404).json({ error: 'Device not found' }); return; }
    closeCliSocketsForSession(req.params.id);
    res.json({ ok: true });
  }));

  return router;
}
