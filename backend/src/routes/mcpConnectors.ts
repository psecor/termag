import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { pasteLinkAllowed, type OAuthReturnTo } from '../services/mcpConnectorStore';
import { apiCatalog, apiOAuthMetadata, isApiConnector, type ApiCatalogEntry } from '../services/apiBroker';
import { LOOPBACK_REDIRECT_URI, parsePastedRedirect } from '../services/mcpOAuthLoopback';
import { preflightAuthorize, RedirectRefusedError } from '../services/mcpOAuthRedirectHelp';
import { termagUrlFromEnv } from '../services/claudeRunnerNotices';
import { getCredentialStoreConfig } from '../services/credentialStore';
import { deliverToUserBoxes } from '../services/credentialDelivery';
import {
  connectorSecretNames, consumeOAuthState, CONNECTOR_SELECT, createOAuthState, deleteConnector, findConnector, forgetConnectorOAuth,
  apiBrokerEnabledForUser, catalogForUser, listConnectors, scopeLabelsForUser, readConnectorSecrets, readOAuth, setLinkStatus, updateConnectorDroppingOAuth, withOAuthLock, writeConnectorSecrets,
} from '../services/mcpConnectorStore';
import {
  applySecretsPatch, assertPatchFitsAuth, connectorNameTaken, connectorNaming, getMcpBrokerUrl, McpConnectorError, referencedSecrets, upstreamTestAllow,
  validateHeaderTemplates, validateSecretsPatch, validateUpstream, type HeaderTemplates,
} from '../services/mcpConnectors';
import {
  authorizeUrl, callbackIssuerProblem, cimdClientId, clientIsStale, clientMetadataDocument, commitLink, discoverOAuth, exchangeCode, newStateNonce, OAuthGrantError, oauthRedirectUri,
  pkcePair, preregisteredClientFor, registerClient, registeredRow, registrationPath, revokeToken, signState, stateNonce, verifyState, type DiscoveredOAuth,
} from '../services/mcpOAuth';
import { checkOAuthUrl, safeOAuthHttp } from '../services/mcpOAuthHttp';
import { authorizeTeam } from '../services/mcpOAuthSlackTeam';
import { getSlackApp } from '../slack/app';
import { connectorScopes, grantedScopesFrom, parseScopeLabels, scopeChoice, scopeLabel, scopesToRequest, type ScopeLabels } from '../services/mcpOAuthScopes';

const STORE_OFF = 'The credential store is not configured on this orchestrator, so connector secrets cannot be saved.';
const BASE_PATH = process.env.BASE_PATH ?? '';
const stateSecret = () => process.env.SESSION_SECRET ?? 'dev-secret';

type Row = NonNullable<Awaited<ReturnType<typeof findConnector>>>;

/**
 * A connector as Settings → MCP servers shows it; also the CLI API's read-only
 * list (routes/cliMcpConnectors.ts). `labels` is the user's scope label table
 * (scopeLabelsForUser); without it, the built-in Slack labels.
 */
export async function view(row: Row, broker: string | null, labels: ScopeLabels = parseScopeLabels(null)) {
  const base = {
    id: row.id,
    // The connector name: the mcpServers key and the mcp__<name>__ tool prefix.
    name: row.name,
    // What Settings shows; a connector with no display text shows its name.
    displayName: row.displayName ?? row.name,
    upstream: row.upstream,
    authType: row.authType,
    // "api": a provider's REST API for the API broker (services/apiBroker.ts),
    // never delivered to a box as an MCP server, so it has no broker URL.
    kind: isApiConnector(row) ? 'api' : 'mcp',
    brokerUrl: broker && !isApiConnector(row) ? `${broker}/c/${row.id}` : null,
    updatedAt: row.updatedAt,
  };
  if (row.authType === 'oauth') {
    const meta = row.oauthMetadata as unknown as DiscoveredOAuth | null;
    const scopes = connectorScopes(row.oauthScopes);
    const named = (list: string[] | null) => list && meta ? list.map(name => ({ name, label: scopeLabel(labels, meta.issuer, name) })) : null;
    return {
      ...base,
      headers: {},
      // The server is on the user's mcp-oauth-loopback-servers list: Settings
      // shows the paste box for the localhost address its sign-in ends on.
      pasteLink: await pasteLinkAllowed(row.userId, row.upstream),
      secretNames: [],
      missingSecrets: [],
      linkStatus: row.linkStatus ?? 'needs_link',
      linkError: row.linkError,
      oauth: meta
        ? {
          issuer: meta.issuer,
          scopes: meta.scopes,
          // The checklist Settings shows before the redirect; null when there is nothing to choose.
          scopeChoice: scopeChoice(meta, preregisteredClientFor(meta), labels),
          // The last sign-in's scopes: what it asked for, and what the token
          // response said was granted (null when it named none).
          requestedScopes: named(scopes?.requested ?? null),
          grantedScopes: named(scopes?.granted ?? null),
        }
        : null,
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

/**
 * Starts sign-in for an OAuth connector and returns the URL to send the
 * browser to. Registers termag as a client with the server first when the
 * connector holds no current registration. `chosenScopes` is the request's `scopes`: the
 * authorize URL asks for exactly those (all advertised scopes when absent),
 * and the state row keeps them for the callback to store. `returnTo` is where
 * the callback sends the browser afterwards (linkRedirect).
 */
async function startLink(userId: string, connector: Row, chosenScopes: unknown, returnTo: OAuthReturnTo = null): Promise<string> {
  if (connector.authType !== 'oauth') throw new McpConnectorError('this connector uses static headers, not OAuth');
  if (!getCredentialStoreConfig()) throw new McpConnectorError(STORE_OFF, 503);
  const termagUrl = termagUrlOrFail();
  const meta = connector.oauthMetadata as unknown as DiscoveredOAuth;
  // A server on the user's loopback list signs in to LOOPBACK_REDIRECT_URI
  // and is registered by DCR for it: a CIMD document and a pre-registered
  // client both name termag's own callback.
  const loopback = await pasteLinkAllowed(userId, connector.upstream);
  const redirectUri = loopback ? LOOPBACK_REDIRECT_URI : oauthRedirectUri(termagUrl);
  const cimd = loopback ? null : cimdClientId(termagUrl);
  const preregistered = preregisteredClientFor(meta);
  const scopes = scopesToRequest(meta, chosenScopes, preregistered);
  const stored = await readOAuth(userId, connector.id);
  let client = stored?.client;
  if (clientIsStale(client, meta, { redirectUri, cimdClientId: cimd, preregistered: loopback ? null : preregistered })) {
    const fresh = await registerClient(meta, { http: safeOAuthHttp(), cimdClientId: cimd, redirectUri, preregistered: loopback ? null : preregistered });
    client = fresh;
    await withOAuthLock(userId, connector.id, async io => {
      const { row, droppedTokens } = registeredRow(await io.read(), fresh);
      await io.write(row);
      if (droppedTokens) await io.needsLink('registered again with the server; link it again');
    });
  }
  // Slack's pre-registered client signs in to the termag app's own workspace.
  const team = await authorizeTeam(meta, client!, preregistered, () => getSlackApp()?.client);
  // A server that refuses the redirect URI before login (New Relic) answers
  // here, in Settings, rather than on its own error page. The pre-flight asks
  // for the same scopes as the sign-in, with a throwaway state and challenge.
  await preflightAuthorize(authorizeUrl(meta, client!, { state: newStateNonce(), challenge: pkcePair().challenge, scopes, team }),
    { redirectUri: client!.redirectUri, issuer: meta.issuer }, safeOAuthHttp());
  const nonce = newStateNonce();
  const { verifier, challenge } = pkcePair();
  await createOAuthState(nonce, userId, connector.id, verifier, scopes, returnTo);
  return authorizeUrl(meta, client!, { state: signState(stateSecret(), nonce, userId, connector.id), challenge, scopes, team });
}

/** Revoke (best effort) and forget the user's tokens and client for an oauth connector. */
async function unlink(row: Row): Promise<void> {
  if (row.authType !== 'oauth') return;
  if (getCredentialStoreConfig()) await forgetConnectorOAuth(row);
  else await writeConnectorSecrets(row.userId, row.id, {});
}

type Naming = ReturnType<typeof connectorNaming>;

// `naming` is the name the request set: the only unique key a write can clash on is (userId, name).
function fail(res: Response, err: unknown, naming?: Naming): boolean {
  if (err instanceof McpConnectorError) {
    if (err instanceof RedirectRefusedError) {
      // The URL is shown under the message, with Copy; the provider's reason is only logged.
      console.log(`[MCP] redirect URI refused uri=${err.redirectUri} reason=${JSON.stringify(err.reason)}`);
      res.status(err.status).json({ error: err.message, redirectUri: err.redirectUri });
      return true;
    }
    res.status(err.status).json({ error: err.message });
    return true;
  }
  if ((err as { code?: string }).code === 'P2002') {
    res.status(409).json({ error: naming ? connectorNameTaken(naming).message : 'You already have an MCP connector with that name' });
    return true;
  }
  return false;
}

/** The flag's catalog, then the API providers this user may connect (api-broker-enabled). */
async function fullCatalog(user: Parameters<typeof catalogForUser>[0]): Promise<Array<{ name: string; label?: string; upstream: string; kind?: ApiCatalogEntry['kind'] }>> {
  const [mcp, api] = await Promise.all([catalogForUser(user), apiBrokerEnabledForUser(user)]);
  return [...mcp, ...(api ? apiCatalog().filter(a => !mcp.some(d => d.name === a.name)) : [])];
}

/** A request body's `returnTo`: 'welcome' for a sign-in started in the setup wizard, else Settings. */
function returnToOf(body: unknown): OAuthReturnTo {
  return (body as { returnTo?: unknown } | undefined)?.returnTo === 'welcome' ? 'welcome' : null;
}

/**
 * The end of a sign-in: Settings → MCP, or the setup wizard's MCP step when
 * the sign-in started there. Both read `server`, `linked` and `error` the same
 * way (frontend mcpForm.ts linkResult).
 */
function linkRedirect(res: Response, returnTo: OAuthReturnTo, params: Record<string, string>): void {
  const page = returnTo === 'welcome' ? `${BASE_PATH}/welcome?step=mcp&` : `${BASE_PATH}/settings/mcp?`;
  res.redirect(303, `${page}${new URLSearchParams(params).toString()}`);
}

function settingsRedirect(res: Response, params: Record<string, string>): void {
  linkRedirect(res, null, params);
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
 * Settings API for the user's MCP connectors. No route
 * returns a secret value or token: secrets are write-only, listed by name.
 */
export function mcpConnectorsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', asyncHandler(async (req, res) => {
    const broker = getMcpBrokerUrl();
    const rows = await listConnectors(req.user!.id);
    const labels = await scopeLabelsForUser(req.user!);
    const catalog = await fullCatalog(req.user!);
    res.json({
      available: broker !== null,
      storeAvailable: getCredentialStoreConfig() !== null,
      connectors: await Promise.all(rows.map(r => view(r, broker, labels))),
      // The orchestrator's servers this user hasn't connected yet, which Settings
      // offers under "Available to connect". Once the user has a connector for a
      // server's URL, it is one of their connectors instead and drops out of here.
      catalog: catalog.filter(d => !rows.some(r => r.upstream === d.upstream)),
    });
  }));

  // Connect a catalog server: create the user's OAuth connector for it, which
  // looks up the server's OAuth settings just as adding a server by hand does,
  // and answer with the sign-in URL. If the user already has an OAuth connector
  // for that URL (a second click, a second tab, or one added by hand), it is
  // reused rather than duplicated. The body's `scopes` are passed to the
  // sign-in as for /:id/oauth/start. With `chooseScopes: true` and no
  // `scopes`, a connector whose server offers a choice answers no URL
  // (`authorizeUrl: null`) and its `connector` view, so Settings can show the
  // checklist first and then call /:id/oauth/start.
  router.post('/catalog/:name/connect', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const def = (await fullCatalog(req.user!)).find(d => d.name === req.params.name);
    if (!def) {
      res.status(404).json({ error: 'No such MCP server in the catalog' });
      return;
    }
    const existing = async () => (await listConnectors(userId)).find(r => r.authType === 'oauth' && r.upstream === def.upstream) ?? null;
    try {
      if (!getCredentialStoreConfig()) throw new McpConnectorError(STORE_OFF, 503);
      termagUrlOrFail();
      let connector = await existing();
      if (!connector) {
        // An API provider's metadata is fixed (services/apiBroker.ts); a server's is discovered.
        const meta = (def.kind === 'api' && apiOAuthMetadata(def.name)) || await discover((await validateUpstream(def.upstream)).url);
        try {
          connector = await prisma.mcpConnector.create({
            data: { userId, name: def.name, displayName: def.label ?? null, upstream: def.upstream, authType: 'oauth', oauthMetadata: meta as object, linkStatus: 'needs_link' },
            select: CONNECTOR_SELECT,
          });
          void deliverToUserBoxes(userId);
        } catch (err) {
          if ((err as { code?: string }).code !== 'P2002') throw err;
          // Another connect for this server got there first: use its connector.
          // Otherwise the name is taken by one of the user's own connectors for
          // a different server, and only the user can free it.
          connector = await existing();
          if (!connector) {
            throw new McpConnectorError(`You already have an MCP connector named "${def.name}" for another server. Rename or delete it, then connect again.`, 409);
          }
        }
      }
      const shown = await view(connector, getMcpBrokerUrl(), await scopeLabelsForUser(req.user!));
      if (req.body?.chooseScopes === true && req.body?.scopes === undefined && 'oauth' in shown && shown.oauth?.scopeChoice) {
        res.json({ id: connector.id, authorizeUrl: null, connector: shown });
        return;
      }
      res.json({ id: connector.id, authorizeUrl: await startLink(userId, connector, req.body?.scopes, returnToOf(req.body)), connector: shown });
    } catch (err) {
      if (!fail(res, err)) throw err;
    }
  }));

  // `name` is display text ("Claude Docs"); the connector name is derived from it (connectorNaming).
  router.post('/', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    let naming: Naming | undefined;
    try {
      naming = connectorNaming(req.body?.name);
      const { name, displayName } = naming;
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
          data: { userId, name, displayName, upstream: upstream.url, authType: 'oauth', oauthMetadata: meta as object, linkStatus: 'needs_link' },
          select: CONNECTOR_SELECT,
        });
        void deliverToUserBoxes(userId);
        res.status(201).json(await view(row, getMcpBrokerUrl(), await scopeLabelsForUser(req.user!)));
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
        data: { userId, name, displayName, upstream: upstream.url, authType: 'static', headerTemplates: headers },
        select: CONNECTOR_SELECT,
      });
      try {
        await writeConnectorSecrets(userId, row.id, secrets);
      } catch (err) {
        await deleteConnector(userId, row.id);
        throw err;
      }
      void deliverToUserBoxes(userId);
      res.status(201).json(await view(row, getMcpBrokerUrl(), await scopeLabelsForUser(req.user!)));
    } catch (err) {
      if (!fail(res, err, naming)) throw err;
    }
  }));

  // The authorization server sends the browser back here with ?code&state.
  // POST /:id/oauth/paste runs it too, on the query of a pasted address.
  const finishLink = asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const nonce = stateNonce(req.query.state);
    const row = nonce ? await consumeOAuthState(nonce) : null;
    if (!row || row.userId !== userId || !verifyState(stateSecret(), String(req.query.state), userId, row.connectorId)) {
      settingsRedirect(res, { error: 'That sign-in link is invalid or has expired; start it again from Settings' });
      return;
    }
    const server = row.connectorId;
    const back = (params: Record<string, string>) => linkRedirect(res, row.returnTo, params);
    if (typeof req.query.error === 'string') {
      const why = typeof req.query.error_description === 'string' ? req.query.error_description : req.query.error;
      back({ server, error: `The server did not grant access: ${why.slice(0, 200)}` });
      return;
    }
    const connector = await findConnector(row.connectorId);
    const meta = connector?.oauthMetadata as unknown as DiscoveredOAuth | null;
    const stored = connector ? await readOAuth(userId, connector.id) : null;
    if (!connector || connector.userId !== userId || connector.authType !== 'oauth' || !meta || !stored?.client || typeof req.query.code !== 'string') {
      back({ server, error: 'termag could not finish linking this server; start it again from Settings' });
      return;
    }
    const issProblem = callbackIssuerProblem(meta, req.query.iss);
    if (issProblem) {
      console.warn(`[MCP] callback refused connector=${connector.id} user=${userId}: ${issProblem}`);
      back({ server, error: `Linking failed: ${issProblem}; start it again from Settings` });
      return;
    }
    try {
      const client = stored.client;
      const tokens = await exchangeCode(meta, client, { code: req.query.code, verifier: row.codeVerifier }, safeOAuthHttp());
      const linked = await withOAuthLock(userId, connector.id, async io => {
        if (!(await commitLink(io, client, tokens))) return false;
        await io.linked({ requested: row.scopes, granted: grantedScopesFrom(tokens.scope) });
        return true;
      });
      if (!linked) {
        await revokeToken(meta, client, tokens, safeOAuthHttp());
        back({ server, error: 'This server was unlinked or registered again while you signed in; start it again from Settings' });
        return;
      }
      console.log(`[MCP] linked connector=${connector.id} user=${userId}`);
      back({ server, linked: '1' });
    } catch (err) {
      if (!(err instanceof McpConnectorError) && !(err instanceof OAuthGrantError)) throw err;
      // A failed re-link (or a second tab) leaves tokens that still work: only a
      // connector with none needs a link.
      const message = err.message;
      await withOAuthLock(userId, connector.id, async io => {
        if (!(await io.read())?.tokens) await io.needsLink(message);
      });
      back({ server, error: `Linking failed: ${err.message}` });
    }
  });
  router.get('/oauth/callback', finishLink);

  router.patch('/:id', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const existing = await findConnector(req.params.id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: 'No such MCP connector' });
      return;
    }
    let naming: Naming | undefined;
    try {
      if (req.body?.auth !== undefined && authType(req.body.auth) !== existing.authType) {
        throw new McpConnectorError('a connector cannot change how it signs in; delete it and add it again');
      }
      const data: { name?: string; displayName?: string | null; upstream?: string; headerTemplates?: HeaderTemplates; oauthMetadata?: object; linkStatus?: string; linkError?: null } = {};
      if (req.body?.name !== undefined) {
        naming = connectorNaming(req.body.name);
        data.name = naming.name;
        data.displayName = naming.displayName;
      }
      let relinked = false;
      let previousSecrets: Awaited<ReturnType<typeof readConnectorSecrets>> | null = null;
      if (req.body?.upstream !== undefined && isApiConnector(existing) && req.body.upstream !== existing.upstream) {
        throw new McpConnectorError('an API connector\'s address is fixed; delete it and connect it again');
      }
      if (req.body?.upstream !== undefined && !isApiConnector(existing)) {
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
      res.json(await view(row, getMcpBrokerUrl(), await scopeLabelsForUser(req.user!)));
    } catch (err) {
      if (!fail(res, err, naming)) throw err;
    }
  }));

  // Link (or re-link): register with the server if needed, then hand the
  // browser the authorize URL. The body's optional `scopes` lists the scopes
  // to ask for (services/mcpOAuthScopes.ts scopesToRequest).
  router.post('/:id/oauth/start', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const connector = await findConnector(req.params.id);
    if (!connector || connector.userId !== userId) {
      res.status(404).json({ error: 'No such MCP connector' });
      return;
    }
    try {
      res.json({ authorizeUrl: await startLink(userId, connector, req.body?.scopes, returnToOf(req.body)) });
    } catch (err) {
      if (!fail(res, err)) throw err;
    }
  }));

  // Finish a sign-in that ended on LOOPBACK_REDIRECT_URI: the Settings form
  // posts the address the browser was sent to (`url`), and this answers with
  // the same redirect as the callback, to Settings or the setup wizard. Only for a server on the
  // user's mcp-oauth-loopback-servers list. The pasted address and its code
  // are never logged or echoed.
  router.post('/:id/oauth/paste', express.urlencoded({ extended: false, limit: '16kb' }), asyncHandler(async (req, res, next) => {
    const userId = req.user!.id;
    const connector = await findConnector(req.params.id);
    if (!connector || connector.userId !== userId || connector.authType !== 'oauth') {
      res.status(404).json({ error: 'No such OAuth MCP connector' });
      return;
    }
    const server = connector.id;
    // The form's own `returnTo` for the answers before the sign-in's state row is read.
    const back = (params: Record<string, string>) => linkRedirect(res, returnToOf(req.body), params);
    if (!(await pasteLinkAllowed(userId, connector.upstream))) {
      back({ server, error: 'This server is not set up for pasting a sign-in address; use Link' });
      return;
    }
    const pasted = parsePastedRedirect(req.body?.url);
    if (!pasted.ok) {
      back({ server, error: pasted.error });
      return;
    }
    // Checked before the callback uses up the pending sign-in, so a wrong
    // address can be followed by the right one.
    if (!verifyState(stateSecret(), pasted.query.state, userId, connector.id)) {
      back({ server, error: "That address is not from this server's sign-in. Copy the address from the tab where you signed in to it, or start again with Link" });
      return;
    }
    if ((await readOAuth(userId, connector.id))?.client?.redirectUri !== LOOPBACK_REDIRECT_URI) {
      back({ server, error: 'This server\'s sign-in no longer ends on a localhost address. Link it again' });
      return;
    }
    req.query = pasted.query;
    finishLink(req, res, next);
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
    res.json(await view(row, getMcpBrokerUrl(), await scopeLabelsForUser(req.user!)));
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
