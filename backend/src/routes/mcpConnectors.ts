import { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { termagUrlFromEnv } from '../services/claudeRunnerNotices';
import { getCredentialStoreConfig } from '../services/credentialStore';
import { deliverToUserBoxes } from '../services/credentialDelivery';
import {
  connectorSecretNames, consumeOAuthState, CONNECTOR_SELECT, createOAuthState, deleteConnector, findConnector, forgetConnectorOAuth,
  listConnectors, mcpBrokerEnabledForUser, readConnectorSecrets, readOAuth, setLinkStatus, updateConnectorDroppingOAuth, withOAuthLock, writeConnectorSecrets,
} from '../services/mcpConnectorStore';
import {
  applySecretsPatch, assertPatchFitsAuth, getMcpBrokerUrl, McpConnectorError, referencedSecrets, upstreamTestAllow, validateConnectorName,
  validateHeaderTemplates, validateSecretsPatch, validateUpstream, type HeaderTemplates,
} from '../services/mcpConnectors';
import {
  authorizeUrl, callbackIssuerProblem, cimdClientId, clientMetadataDocument, commitLink, discoverOAuth, exchangeCode, newStateNonce, OAuthGrantError, oauthRedirectUri,
  pkcePair, registerClient, registeredRow, registrationPath, revokeToken, signState, stateNonce, verifyState, type DiscoveredOAuth,
} from '../services/mcpOAuth';
import { checkOAuthUrl, safeOAuthHttp } from '../services/mcpOAuthHttp';

const STORE_OFF = 'The credential store is not configured on this orchestrator, so connector secrets cannot be saved.';
const BASE_PATH = process.env.BASE_PATH ?? '';
const stateSecret = () => process.env.SESSION_SECRET ?? 'dev-secret';

type Row = NonNullable<Awaited<ReturnType<typeof findConnector>>>;

async function view(row: Row, broker: string | null) {
  const base = {
    id: row.id,
    name: row.name,
    upstream: row.upstream,
    authType: row.authType,
    brokerUrl: broker ? `${broker}/c/${row.id}` : null,
    updatedAt: row.updatedAt,
  };
  if (row.authType === 'oauth') {
    const meta = row.oauthMetadata as unknown as DiscoveredOAuth | null;
    return {
      ...base,
      headers: {},
      secretNames: [],
      missingSecrets: [],
      linkStatus: row.linkStatus ?? 'needs_link',
      linkError: row.linkError,
      oauth: meta ? { issuer: meta.issuer, scopes: meta.scopes } : null,
    };
  }
  const templates = (row.headerTemplates ?? {}) as HeaderTemplates;
  const secretNames = await connectorSecretNames(row.userId, row.id);
  const needed = referencedSecrets(templates);
  return {
    ...base,
    headers: templates,
    secretNames,
    missingSecrets: secretNames === null ? [] : needed.filter(n => !secretNames.includes(n)),
  };
}

function authType(raw: unknown): 'static' | 'oauth' {
  const t = (raw as { type?: unknown } | undefined)?.type;
  if (t === 'static' || t === 'oauth') return t;
  throw new McpConnectorError('auth.type must be "static" or "oauth"');
}

function staticAuth(raw: unknown): HeaderTemplates {
  return validateHeaderTemplates((raw as { headers?: unknown } | undefined)?.headers);
}

function termagUrlOrFail(): string {
  const url = termagUrlFromEnv();
  if (!url) throw new McpConnectorError('OAuth connectors need FRONTEND_URL on this orchestrator, for the sign-in redirect', 503);
  return url;
}

/** Discovery for an oauth connector, failing early when termag could not register with the server. */
async function discover(upstream: string): Promise<DiscoveredOAuth> {
  const allow = upstreamTestAllow();
  const meta = await discoverOAuth(upstream, { http: safeOAuthHttp(allow), check: url => { checkOAuthUrl(url, allow); } });
  registrationPath(meta, cimdClientId(termagUrlFromEnv()));
  return meta;
}

/** Revoke (best effort) and forget the user's tokens and client for an oauth connector. */
async function unlink(row: Row): Promise<void> {
  if (row.authType !== 'oauth') return;
  if (getCredentialStoreConfig()) await forgetConnectorOAuth(row);
  else await writeConnectorSecrets(row.userId, row.id, {});
}

function fail(res: Response, err: unknown): boolean {
  if (err instanceof McpConnectorError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  if ((err as { code?: string }).code === 'P2002') {
    res.status(409).json({ error: 'You already have an MCP connector with that name' });
    return true;
  }
  return false;
}

function settingsRedirect(res: Response, params: Record<string, string>): void {
  res.redirect(303, `${BASE_PATH}/settings/mcp?${new URLSearchParams(params).toString()}`);
}

/**
 * termag's Client ID Metadata Document, fetched by authorization servers with
 * no session. 404 unless MCP_OAUTH_CIMD=on. It names no user and no secret.
 */
export function mcpClientMetadataHandler(_req: Request, res: Response): void {
  const termagUrl = termagUrlFromEnv();
  const clientId = cimdClientId(termagUrl);
  if (!termagUrl || !clientId) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.set('cache-control', 'public, max-age=300').json(clientMetadataDocument(clientId, oauthRedirectUri(termagUrl)));
}

/**
 * Settings API for the user's MCP connectors. Every
 * route answers 404 while mcp-broker-enabled is off for the user. No route
 * returns a secret value or token: secrets are write-only, listed by name.
 */
export function mcpConnectorsRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (await mcpBrokerEnabledForUser(req.user!)) {
      next();
      return;
    }
    res.status(404).json({ error: 'Not found' });
  }));

  router.get('/', asyncHandler(async (req, res) => {
    const broker = getMcpBrokerUrl();
    const rows = await listConnectors(req.user!.id);
    res.json({
      available: broker !== null,
      storeAvailable: getCredentialStoreConfig() !== null,
      connectors: await Promise.all(rows.map(r => view(r, broker))),
    });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    try {
      const name = validateConnectorName(req.body?.name);
      const type = authType(req.body?.auth);
      if (type === 'oauth') {
        if (!getCredentialStoreConfig()) {
          res.status(503).json({ error: STORE_OFF });
          return;
        }
        termagUrlOrFail();
        const upstream = await validateUpstream(req.body?.upstream);
        const meta = await discover(upstream.url);
        const row = await prisma.mcpConnector.create({
          data: { userId, name, upstream: upstream.url, authType: 'oauth', oauthMetadata: meta as object, linkStatus: 'needs_link' },
          select: CONNECTOR_SELECT,
        });
        void deliverToUserBoxes(userId);
        res.status(201).json(await view(row, getMcpBrokerUrl()));
        return;
      }
      const headers = staticAuth(req.body?.auth);
      const patch = validateSecretsPatch(req.body?.secrets);
      const secrets = applySecretsPatch({}, patch);
      if (Object.keys(secrets).length > 0 && !getCredentialStoreConfig()) {
        res.status(503).json({ error: STORE_OFF });
        return;
      }
      const upstream = await validateUpstream(req.body?.upstream);
      const row = await prisma.mcpConnector.create({
        data: { userId, name, upstream: upstream.url, authType: 'static', headerTemplates: headers },
        select: CONNECTOR_SELECT,
      });
      try {
        await writeConnectorSecrets(userId, row.id, secrets);
      } catch (err) {
        await deleteConnector(userId, row.id);
        throw err;
      }
      void deliverToUserBoxes(userId);
      res.status(201).json(await view(row, getMcpBrokerUrl()));
    } catch (err) {
      if (!fail(res, err)) throw err;
    }
  }));

  // The authorization server sends the browser back here with ?code&state.
  router.get('/oauth/callback', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const nonce = stateNonce(req.query.state);
    const row = nonce ? await consumeOAuthState(nonce) : null;
    if (!row || row.userId !== userId || !verifyState(stateSecret(), String(req.query.state), userId, row.connectorId)) {
      settingsRedirect(res, { error: 'That sign-in link is invalid or has expired; start it again from Settings' });
      return;
    }
    const server = row.connectorId;
    if (typeof req.query.error === 'string') {
      const why = typeof req.query.error_description === 'string' ? req.query.error_description : req.query.error;
      settingsRedirect(res, { server, error: `The server did not grant access: ${why.slice(0, 200)}` });
      return;
    }
    const connector = await findConnector(row.connectorId);
    const meta = connector?.oauthMetadata as unknown as DiscoveredOAuth | null;
    const stored = connector ? await readOAuth(userId, connector.id) : null;
    if (!connector || connector.userId !== userId || connector.authType !== 'oauth' || !meta || !stored?.client || typeof req.query.code !== 'string') {
      settingsRedirect(res, { server, error: 'termag could not finish linking this server; start it again from Settings' });
      return;
    }
    const issProblem = callbackIssuerProblem(meta, req.query.iss);
    if (issProblem) {
      console.warn(`[MCP] callback refused connector=${connector.id} user=${userId}: ${issProblem}`);
      settingsRedirect(res, { server, error: `Linking failed: ${issProblem}; start it again from Settings` });
      return;
    }
    try {
      const client = stored.client;
      const tokens = await exchangeCode(meta, client, { code: req.query.code, verifier: row.codeVerifier }, safeOAuthHttp());
      const linked = await withOAuthLock(userId, connector.id, async io => {
        if (!(await commitLink(io, client, tokens))) return false;
        await io.linked();
        return true;
      });
      if (!linked) {
        await revokeToken(meta, client, tokens, safeOAuthHttp());
        settingsRedirect(res, { server, error: 'This server was unlinked or registered again while you signed in; start it again from Settings' });
        return;
      }
      console.log(`[MCP] linked connector=${connector.id} user=${userId}`);
      settingsRedirect(res, { server, linked: '1' });
    } catch (err) {
      if (!(err instanceof McpConnectorError) && !(err instanceof OAuthGrantError)) throw err;
      // A failed re-link (or a second tab) leaves tokens that still work: only a
      // connector with none needs a link.
      const message = err.message;
      await withOAuthLock(userId, connector.id, async io => {
        if (!(await io.read())?.tokens) await io.needsLink(message);
      });
      settingsRedirect(res, { server, error: `Linking failed: ${err.message}` });
    }
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const existing = await findConnector(req.params.id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: 'No such MCP connector' });
      return;
    }
    try {
      if (req.body?.auth !== undefined && authType(req.body.auth) !== existing.authType) {
        throw new McpConnectorError('a connector cannot change how it signs in; delete it and add it again');
      }
      const data: { name?: string; upstream?: string; headerTemplates?: HeaderTemplates; oauthMetadata?: object; linkStatus?: string; linkError?: null } = {};
      if (req.body?.name !== undefined) data.name = validateConnectorName(req.body.name);
      let relinked = false;
      let previousSecrets: Awaited<ReturnType<typeof readConnectorSecrets>> | null = null;
      if (req.body?.upstream !== undefined) {
        data.upstream = (await validateUpstream(req.body.upstream)).url;
        if (existing.authType === 'oauth' && data.upstream !== existing.upstream) {
          data.oauthMetadata = await discover(data.upstream) as object;
          data.linkStatus = 'needs_link';
          data.linkError = null;
          relinked = true;
        }
      }
      assertPatchFitsAuth(existing.authType, req.body);
      if (existing.authType === 'static') {
        if (req.body?.auth !== undefined) data.headerTemplates = staticAuth(req.body.auth);
        const patch = validateSecretsPatch(req.body?.secrets);
        if (Object.keys(patch).length > 0) {
          if (!getCredentialStoreConfig()) {
            res.status(503).json({ error: STORE_OFF });
            return;
          }
          const before = await readConnectorSecrets(userId, existing.id);
          await writeConnectorSecrets(userId, existing.id, applySecretsPatch(before, patch));
          previousSecrets = before;
        }
      }
      let row = existing;
      if (relinked) {
        const { row: moved, dropped } = await updateConnectorDroppingOAuth(userId, existing.id, data);
        row = moved;
        const oldMeta = existing.oauthMetadata as unknown as DiscoveredOAuth | null;
        if (dropped?.client && dropped.tokens && oldMeta) await revokeToken(oldMeta, dropped.client, dropped.tokens, safeOAuthHttp());
      } else if (Object.keys(data).length > 0) {
        try {
          row = await prisma.mcpConnector.update({ where: { id: existing.id }, data, select: CONNECTOR_SELECT });
        } catch (err) {
          // The request failed as a whole, so its secret change must not stick.
          if (previousSecrets) await writeConnectorSecrets(userId, existing.id, previousSecrets);
          throw err;
        }
      }
      void deliverToUserBoxes(userId);
      res.json(await view(row, getMcpBrokerUrl()));
    } catch (err) {
      if (!fail(res, err)) throw err;
    }
  }));

  // Link (or re-link): register with the server if needed, then hand the
  // browser the authorize URL.
  router.post('/:id/oauth/start', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const connector = await findConnector(req.params.id);
    if (!connector || connector.userId !== userId) {
      res.status(404).json({ error: 'No such MCP connector' });
      return;
    }
    try {
      if (connector.authType !== 'oauth') throw new McpConnectorError('this connector uses static headers, not OAuth');
      if (!getCredentialStoreConfig()) throw new McpConnectorError(STORE_OFF, 503);
      const termagUrl = termagUrlOrFail();
      const meta = connector.oauthMetadata as unknown as DiscoveredOAuth;
      const redirectUri = oauthRedirectUri(termagUrl);
      const cimd = cimdClientId(termagUrl);
      const stored = await readOAuth(userId, connector.id);
      let client = stored?.client;
      const stale = !client || client.redirectUri !== redirectUri || client.issuer !== meta.issuer
        || (client.via === 'cimd' && client.clientId !== cimd);
      if (stale) {
        const fresh = await registerClient(meta, { http: safeOAuthHttp(), cimdClientId: cimd, redirectUri });
        client = fresh;
        await withOAuthLock(userId, connector.id, async io => {
          const { row, droppedTokens } = registeredRow(await io.read(), fresh);
          await io.write(row);
          if (droppedTokens) await io.needsLink('registered again with the server; link it again');
        });
      }
      const nonce = newStateNonce();
      const { verifier, challenge } = pkcePair();
      await createOAuthState(nonce, userId, connector.id, verifier);
      res.json({ authorizeUrl: authorizeUrl(meta, client!, { state: signState(stateSecret(), nonce, userId, connector.id), challenge }) });
    } catch (err) {
      if (!fail(res, err)) throw err;
    }
  }));

  router.delete('/:id/oauth', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const connector = await findConnector(req.params.id);
    if (!connector || connector.userId !== userId || connector.authType !== 'oauth') {
      res.status(404).json({ error: 'No such OAuth MCP connector' });
      return;
    }
    await unlink(connector);
    await setLinkStatus(connector.id, 'needs_link');
    const row = await findConnector(connector.id);
    if (!row) {
      res.status(404).json({ error: 'No such OAuth MCP connector' });
      return;
    }
    res.json(await view(row, getMcpBrokerUrl()));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const existing = await findConnector(req.params.id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: 'No such MCP connector' });
      return;
    }
    await unlink(existing);
    await deleteConnector(userId, existing.id);
    void deliverToUserBoxes(userId);
    res.status(204).end();
  }));

  return router;
}
