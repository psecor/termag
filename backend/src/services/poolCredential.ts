/**
 * The environment pool's GitHub credential ("The
 * pool's GitHub credential, through the broker"): one credential that belongs
 * to no user, which the GitHub broker swaps in for a preparing pool box's git
 * fetches (services/githubAuthz.ts). A PAT for now, supplied by the person
 * running the pools; a GitHub App token later, which changes only
 * `poolGithubTokenSource`.
 *
 * Stored like a user's credential (credentialStore.ts): one `pool_credentials` row whose ciphertext is an AWS Encryption
 * SDK message under the credential store's KMS key, with the encryption
 * context { purpose: termag-pool-credential, provider }. A user credential's
 * row can never open as the pool's, or the pool's as a user's. Never on a user
 * row, never delivered to a box, never logged.
 */

import type { KeyringNode } from '@aws-crypto/client-node';
import { prisma } from '../db';
import { getCredentialStoreConfig, type CredentialStoreConfig } from './credentialStore';
import {
  CredentialInputError, fetchGithubIdentity, GithubApiError, GITHUB_REJECTED_SENTENCE, githubLabel, looksLikeGithubToken,
} from './githubCredential';
import { kmsKeyring, openBytes, sealBytes } from './sealedMessages';

export const POOL_CREDENTIAL_PURPOSE = 'termag-pool-credential';
export const POOL_PROVIDERS = ['github'] as const;
export type PoolProvider = typeof POOL_PROVIDERS[number];

export function isPoolProvider(value: string): value is PoolProvider {
  return (POOL_PROVIDERS as readonly string[]).includes(value);
}

export function poolEncryptionContext(provider: PoolProvider): Record<string, string> {
  if (!isPoolProvider(provider)) throw new Error('invalid pool credential provider');
  return { purpose: POOL_CREDENTIAL_PURPOSE, provider };
}

function keyringFor(cfg: CredentialStoreConfig): KeyringNode {
  return cfg.keyring ?? kmsKeyring(cfg.kmsKeyArn);
}

export async function sealPoolCredential(cfg: CredentialStoreConfig, provider: PoolProvider, value: unknown): Promise<Buffer> {
  return sealBytes(keyringFor(cfg), Buffer.from(JSON.stringify(value), 'utf8'), poolEncryptionContext(provider));
}

export async function openPoolCredential(cfg: CredentialStoreConfig, provider: PoolProvider, ciphertext: Uint8Array): Promise<unknown> {
  const plain = await openBytes(keyringFor(cfg), ciphertext, poolEncryptionContext(provider), `stored pool ${provider} credential was not encrypted as the pool's`);
  return JSON.parse(plain.toString('utf8'));
}

/** What the pool's GitHub credential holds: the token, and who it is on GitHub. */
export interface PoolGithubSecret { token: string; login: string }

/** What an admin sees of a pool credential: never any part of the value. */
export interface PoolCredentialSummary { provider: PoolProvider; set: boolean; label: string | null; updatedAt: string | null; updatedByUserId: string | null }

/** The row access poolCredential needs; prisma's in production, a map in tests. */
export interface PoolCredentialRows {
  find(provider: PoolProvider): Promise<{ label: string; ciphertext: Uint8Array; updatedAt: Date; updatedByUserId: string | null } | null>;
  upsert(provider: PoolProvider, row: { label: string; ciphertext: Buffer; updatedByUserId: string }): Promise<void>;
  remove(provider: PoolProvider): Promise<boolean>;
}

export const prismaPoolCredentialRows: PoolCredentialRows = {
  find: provider => prisma.poolCredential.findUnique({
    where: { provider }, select: { label: true, ciphertext: true, updatedAt: true, updatedByUserId: true },
  }),
  async upsert(provider, row) {
    await prisma.poolCredential.upsert({ where: { provider }, create: { provider, ...row }, update: row });
  },
  async remove(provider) {
    return (await prisma.poolCredential.deleteMany({ where: { provider } })).count > 0;
  },
};

export interface PoolCredentialDeps {
  rows?: PoolCredentialRows;
  /** The credential store's config; null when it is off (no CREDENTIAL_STORE_KMS_KEY_ID). */
  cfg?: CredentialStoreConfig | null;
  fetchImpl?: typeof fetch;
}

const rowsOf = (d: PoolCredentialDeps) => d.rows ?? prismaPoolCredentialRows;
const cfgOf = (d: PoolCredentialDeps) => ('cfg' in d ? d.cfg ?? null : getCredentialStoreConfig());

export async function poolCredentialSummary(provider: PoolProvider, deps: PoolCredentialDeps = {}): Promise<PoolCredentialSummary> {
  const row = await rowsOf(deps).find(provider);
  return {
    provider, set: !!row, label: row?.label ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null, updatedByUserId: row?.updatedByUserId ?? null,
  };
}

/**
 * Stores a pasted GitHub token as the pool's, replacing any stored one, after
 * GitHub says whose it is (GET /user). Errors never carry the token. Unlike a
 * user's token no scope is required: a fine-grained PAT with read-only
 * Contents and Metadata is the recommended one, and the broker passes only
 * fetches whatever the token could do.
 */
export async function setPoolGithubCredential(token: unknown, actorUserId: string, deps: PoolCredentialDeps = {}): Promise<PoolCredentialSummary> {
  const cfg = cfgOf(deps);
  if (!cfg) throw new PoolCredentialUnavailable();
  if (typeof token !== 'string' || !looksLikeGithubToken(token.trim())) {
    throw new CredentialInputError('That is not a GitHub token: paste a fine-grained PAT (github_pat_…) or a classic one (ghp_…).');
  }
  const value = token.trim();
  let login: string;
  try {
    login = (await fetchGithubIdentity(value, deps.fetchImpl)).login;
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 401) throw new CredentialInputError(GITHUB_REJECTED_SENTENCE);
    throw err;
  }
  const secret: PoolGithubSecret = { token: value, login };
  const ciphertext = await sealPoolCredential(cfg, 'github', secret);
  await rowsOf(deps).upsert('github', { label: githubLabel(login), ciphertext, updatedByUserId: actorUserId });
  notifyPoolCredentialChange();
  return poolCredentialSummary('github', deps);
}

/** Deletes the pool's credential (a row delete, no KMS call). True when one was stored. */
export async function deletePoolCredential(provider: PoolProvider, deps: PoolCredentialDeps = {}): Promise<boolean> {
  const removed = await rowsOf(deps).remove(provider);
  if (provider === 'github') notifyPoolCredentialChange();
  return removed;
}

/** The pool's GitHub token, read and opened now; null when none is stored or the store is off. */
export async function readPoolGithubToken(deps: PoolCredentialDeps = {}): Promise<string | null> {
  const cfg = cfgOf(deps);
  if (!cfg) return null;
  const row = await rowsOf(deps).find('github');
  if (!row) return null;
  const secret = await openPoolCredential(cfg, 'github', row.ciphertext) as Partial<PoolGithubSecret> | null;
  return typeof secret?.token === 'string' && secret.token ? secret.token : null;
}

export class PoolCredentialUnavailable extends Error {
  constructor() { super('The credential store is off (CREDENTIAL_STORE_KMS_KEY_ID is unset), so no pool credential can be stored'); }
}

const listeners = new Set<() => void>();

/** Calls `listener` after the pool credential is set or deleted on this process; returns the unsubscribe. */
export function onPoolCredentialChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forgets the cached pool token and tells every listener (poolEnvironmentRepos.ts drops its cache). */
export function notifyPoolCredentialChange(): void {
  poolGithubTokenSource.forget();
  for (const l of listeners) {
    try { l(); } catch (err) { console.warn(`[POOL-CRED] a credential-change listener failed: ${(err as Error).message}`); }
  }
}

export interface PoolTokenSourceDeps extends PoolCredentialDeps {
  /** Opens a row's ciphertext (a KMS Decrypt); openPoolCredential unless a test watches it. */
  open?: typeof openPoolCredential;
}

/**
 * The broker's pool token source. It reads the pool_credentials row on every
 * call (one small Postgres read; only a preparing pool box's requests ask), so
 * a delete or replace made by any process counts from the next request on.
 * Opening the row (the KMS Decrypt) happens only when its ciphertext differs
 * from the one last opened.
 */
export function createPoolTokenSource(deps: PoolTokenSourceDeps = {}): (() => Promise<string | null>) & { forget(): void } {
  const open = deps.open ?? openPoolCredential;
  let opened: { ciphertext: Buffer; token: string | null } | null = null;
  const source = async () => {
    const cfg = cfgOf(deps);
    if (!cfg) return null;
    const row = await rowsOf(deps).find('github');
    if (!row) { opened = null; return null; }
    const ciphertext = Buffer.from(row.ciphertext);
    if (opened && opened.ciphertext.equals(ciphertext)) return opened.token;
    const secret = await open(cfg, 'github', ciphertext) as Partial<PoolGithubSecret> | null;
    const token = typeof secret?.token === 'string' && secret.token ? secret.token : null;
    opened = { ciphertext, token };
    return token;
  };
  return Object.assign(source, { forget() { opened = null; } });
}

export const poolGithubTokenSource = createPoolTokenSource();
