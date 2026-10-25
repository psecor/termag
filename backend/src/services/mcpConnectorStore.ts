/**
 * Database side of MCP connectors: the mcp_connectors
 * rows, their secrets in user_credentials, and the mcp-broker-enabled reads.
 * The rules live in mcpConnectors.ts; this file only reads and writes.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import {
  getCredentialStoreConfig, openCredential, readCredential, sealCredential, writeCredentials, deleteCredentials,
} from './credentialStore';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { asSecrets, mcpCredentialProvider, MCP_BROKER_FLAG, type Secrets } from './mcpConnectors';
import { forgetOAuth, freshAccessToken, refreshTokens, revokeToken, type DiscoveredOAuth, type OAuthLockIo, type StoredOAuth } from './mcpOAuth';
import { safeOAuthHttp } from './mcpOAuthHttp';

const LD_USER_SELECT = { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } as const;

export function mcpBrokerEnabledForUser(user: FlagUser): Promise<boolean> {
  return boolVariation(MCP_BROKER_FLAG, user, false);
}

/** The flag for the owner and the box, as ext_authz and delivery read it. */
export async function mcpBrokerEnabledForBox(userId: string, instanceId: string): Promise<boolean> {
  const [user, instance] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: LD_USER_SELECT }),
    prisma.instance.findUnique({ where: { id: instanceId }, select: { id: true, name: true, kind: true } }),
  ]);
  if (!user || !instance) return false;
  return boolVariation(MCP_BROKER_FLAG, user, false, instance);
}

export const CONNECTOR_SELECT = {
  id: true, userId: true, name: true, upstream: true, authType: true, headerTemplates: true,
  oauthMetadata: true, linkStatus: true, linkError: true, createdAt: true, updatedAt: true,
} as const;

export function findConnector(id: string) {
  return prisma.mcpConnector.findUnique({ where: { id }, select: CONNECTOR_SELECT });
}

export function listConnectors(userId: string) {
  return prisma.mcpConnector.findMany({ where: { userId }, select: CONNECTOR_SELECT, orderBy: { name: 'asc' } });
}

/** The connector's secrets; {} when it has none or the store is off. */
export async function readConnectorSecrets(userId: string, connectorId: string): Promise<Secrets> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) return {};
  return asSecrets(await readCredential(cfg, userId, mcpCredentialProvider(connectorId)));
}

/** Replaces the connector's secrets; an empty set deletes the row. */
export async function writeConnectorSecrets(userId: string, connectorId: string, secrets: Secrets): Promise<void> {
  const provider = mcpCredentialProvider(connectorId);
  const n = Object.keys(secrets).length;
  if (n === 0) {
    await deleteCredentials(userId, [provider]);
    return;
  }
  const cfg = getCredentialStoreConfig();
  if (!cfg) throw new Error('the credential store is not configured');
  await writeCredentials(cfg, userId, { [provider]: { value: secrets, label: `${n} secret${n === 1 ? '' : 's'}` } });
}

/** The names of the connector's stored secrets, never their values. */
export async function connectorSecretNames(userId: string, connectorId: string): Promise<string[] | null> {
  try {
    return Object.keys(await readConnectorSecrets(userId, connectorId)).sort();
  } catch {
    return null;
  }
}

export async function deleteConnector(userId: string, connectorId: string): Promise<boolean> {
  const { count } = await prisma.mcpConnector.deleteMany({ where: { id: connectorId, userId } });
  await deleteCredentials(userId, [mcpCredentialProvider(connectorId)]);
  return count > 0;
}

// ── OAuth connectors ────────────────────────────────────────────────────────
// The credential row holds {oauth: {client, tokens}}; a static connector's row
// is a flat map of secrets, which asSecrets reads (and which ignores this).

export function asStoredOAuth(stored: unknown): StoredOAuth | null {
  const v = (stored as { oauth?: unknown } | null)?.oauth;
  return v && typeof v === 'object' && !Array.isArray(v) ? v as StoredOAuth : null;
}

const oauthLabel = (v: StoredOAuth) => v.tokens ? 'OAuth link' : 'OAuth client';

export async function readOAuth(userId: string, connectorId: string): Promise<StoredOAuth | null> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) return null;
  return asStoredOAuth(await readCredential(cfg, userId, mcpCredentialProvider(connectorId)));
}

/**
 * `fn` inside one transaction holding a per-(user, connector) advisory lock,
 * reading and writing the credential row through that transaction, so two
 * processes refreshing at once refresh once (the Codex single-use refresh
 * pattern).
 */
export async function withOAuthLock<T>(
  userId: string,
  connectorId: string,
  fn: (io: OAuthLockIo) => Promise<T>,
): Promise<T> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) throw new Error('the credential store is not configured');
  const provider = mcpCredentialProvider(connectorId);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mcp-oauth:${userId}:${connectorId}`}))`;
    return fn({
      read: async () => {
        const row = await tx.userCredential.findUnique({ where: { userId_provider: { userId, provider } }, select: { ciphertext: true } });
        return row ? asStoredOAuth(await openCredential(cfg, userId, provider, row.ciphertext)) : null;
      },
      write: async (value) => {
        const ciphertext = await sealCredential(cfg, userId, provider, { oauth: value });
        await tx.userCredential.upsert({
          where: { userId_provider: { userId, provider } },
          create: { userId, provider, label: oauthLabel(value), ciphertext },
          update: { label: oauthLabel(value), ciphertext },
        });
      },
      remove: async () => {
        await tx.userCredential.deleteMany({ where: { userId, provider } });
      },
      linked: async () => {
        await tx.mcpConnector.updateMany({ where: { id: connectorId }, data: { linkStatus: 'linked', linkError: null } });
      },
      needsLink: async (reason) => {
        await tx.mcpConnector.updateMany({
          where: reason === null ? { id: connectorId, linkStatus: 'linked' } : { id: connectorId },
          data: { linkStatus: 'needs_link', linkError: reason?.slice(0, 500) ?? null },
        });
      },
    });
  }, { timeout: 20_000, maxWait: 10_000 });
}

/**
 * Updates an oauth connector and removes its client and tokens in one
 * transaction under the connector's lock: no request ever pairs the updated
 * row (a new upstream) with the old server's tokens, a failed update (a name
 * clash) rolls the removal back, and an unlink or delete waits its turn on the
 * lock. Returns what was removed, so the caller can revoke it.
 */
export async function updateConnectorDroppingOAuth(
  userId: string,
  connectorId: string,
  data: Prisma.McpConnectorUpdateInput,
) {
  const cfg = getCredentialStoreConfig();
  const provider = mcpCredentialProvider(connectorId);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mcp-oauth:${userId}:${connectorId}`}))`;
    const cred = await tx.userCredential.findUnique({ where: { userId_provider: { userId, provider } }, select: { ciphertext: true } });
    const dropped = cred && cfg ? asStoredOAuth(await openCredential(cfg, userId, provider, cred.ciphertext)) : null;
    await tx.userCredential.deleteMany({ where: { userId, provider } });
    const row = await tx.mcpConnector.update({ where: { id: connectorId }, data, select: CONNECTOR_SELECT });
    return { row, dropped };
  }, { timeout: 20_000, maxWait: 10_000 });
}

/** Outside withOAuthLock only: inside it, use the lock's io. */
export async function setLinkStatus(connectorId: string, status: 'linked' | 'needs_link', error: string | null = null): Promise<void> {
  await prisma.mcpConnector.updateMany({ where: { id: connectorId }, data: { linkStatus: status, linkError: error?.slice(0, 500) ?? null } });
}

/** Revokes (best effort) and deletes an oauth connector's client and tokens, under its lock. */
export function forgetConnectorOAuth(connector: { id: string; userId: string; oauthMetadata?: unknown }): Promise<void> {
  const meta = connector.oauthMetadata as DiscoveredOAuth | null;
  return forgetOAuth({
    withLock: fn => withOAuthLock(connector.userId, connector.id, fn),
    revoke: (client, tokens) => (meta ? revokeToken(meta, client, tokens, safeOAuthHttp()) : Promise.resolve(false)),
  });
}

/** The upstream Authorization for an oauth connector; throws McpNeedsLinkError. */
export function oauthAccessToken(connector: { id: string; userId: string; oauthMetadata?: unknown }): Promise<string> {
  const meta = connector.oauthMetadata as DiscoveredOAuth;
  const http = safeOAuthHttp();
  return freshAccessToken({
    read: () => readOAuth(connector.userId, connector.id),
    withLock: fn => withOAuthLock(connector.userId, connector.id, fn),
    refresh: (client, refreshToken) => refreshTokens(meta, client, refreshToken, http),
    now: Date.now,
  });
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export async function createOAuthState(nonce: string, userId: string, connectorId: string, codeVerifier: string): Promise<void> {
  await prisma.mcpOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await prisma.mcpOAuthState.create({
    data: { id: nonce, userId, connectorId, codeVerifier, expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS) },
  });
}

/** Deletes and returns the state row: a state works once, and only while fresh. */
export async function consumeOAuthState(nonce: string) {
  const rows = await prisma.$queryRaw<{ userId: string; connectorId: string; codeVerifier: string; expiresAt: Date }[]>`
    DELETE FROM mcp_oauth_states WHERE id = ${nonce}
    RETURNING "userId", "connectorId", "codeVerifier", "expiresAt"`;
  const row = rows[0];
  return row && row.expiresAt.getTime() > Date.now() ? row : null;
}
