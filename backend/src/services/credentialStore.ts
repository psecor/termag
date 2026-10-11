/**
 * Per-user credential store: each credential is
 * one user_credentials row whose `ciphertext` is an AWS Encryption SDK
 * message, i.e. the value under a fresh AES-256-GCM data key (with key
 * commitment) plus that data key encrypted by the KMS key
 * alias/termag-user-credentials. The encryption context names the purpose,
 * the user and the provider. KMS binds the data key to it and the SDK binds
 * the ciphertext to it; reading also checks it against the row, so a row
 * copied onto another user or provider never decrypts as theirs.
 *
 * Only the orchestrator role can use the key, and only with that context
 * (terraform auth_once.tf); the box permissions boundary grants no KMS use.
 *
 * Off unless CREDENTIAL_STORE_KMS_KEY_ID holds the key's ARN: strict-mode
 * decryption matches the ARN recorded with the data key, never an alias.
 */

import {
  AlgorithmSuiteIdentifier,
  buildClient,
  CommitmentPolicy,
  KmsKeyringNode,
  type KeyringNode,
} from '@aws-crypto/client-node';
import { prisma } from '../db';
import { githubLabel } from './githubCredential';
import { publicOrgStatuses, type OrgAccess } from './githubRepos';

export const CREDENTIAL_PURPOSE = 'termag-user-credential';
const KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
// Without signing: the one role that decrypts is also the one that encrypts,
// so a signature would prove nothing a GCM tag doesn't.
const SUITE = AlgorithmSuiteIdentifier.ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY;

const { encrypt, decrypt } = buildClient({
  commitmentPolicy: CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT,
  maxEncryptedDataKeys: 1,
});

export interface CredentialStoreConfig {
  kmsKeyArn: string;
  // Tests hand in a raw AES keyring; production builds the KMS one.
  keyring?: KeyringNode;
}

let warnedNotArn = false;

export function getCredentialStoreConfig(env: NodeJS.ProcessEnv = process.env): CredentialStoreConfig | null {
  const kmsKeyArn = env.CREDENTIAL_STORE_KMS_KEY_ID?.trim();
  if (!kmsKeyArn) return null;
  if (!KEY_ARN.test(kmsKeyArn)) {
    if (!warnedNotArn) {
      console.warn('[CRED] CREDENTIAL_STORE_KMS_KEY_ID must be a KMS key ARN (not an alias or key id); the credential store is off');
      warnedNotArn = true;
    }
    return null;
  }
  return { kmsKeyArn };
}

export function encryptionContextFor(userId: string, provider: string): Record<string, string> {
  if (!/^[a-z0-9]{8,64}$/i.test(userId)) throw new Error('invalid user id for the credential store');
  if (!PROVIDER.test(provider)) throw new Error('invalid credential provider');
  return { purpose: CREDENTIAL_PURPOSE, userId, provider };
}

const kmsKeyrings = new Map<string, KeyringNode>();

function keyringFor(cfg: CredentialStoreConfig): KeyringNode {
  if (cfg.keyring) return cfg.keyring;
  let keyring = kmsKeyrings.get(cfg.kmsKeyArn);
  if (!keyring) {
    keyring = new KmsKeyringNode({ generatorKeyId: cfg.kmsKeyArn });
    kmsKeyrings.set(cfg.kmsKeyArn, keyring);
  }
  return keyring;
}

export async function sealCredential(cfg: CredentialStoreConfig, userId: string, provider: string, value: unknown): Promise<Buffer> {
  const { result } = await encrypt(keyringFor(cfg), Buffer.from(JSON.stringify(value), 'utf8'), {
    encryptionContext: encryptionContextFor(userId, provider),
    suiteId: SUITE,
  });
  return result;
}

export async function openCredential(cfg: CredentialStoreConfig, userId: string, provider: string, ciphertext: Uint8Array): Promise<unknown> {
  const expected = encryptionContextFor(userId, provider);
  const { plaintext, messageHeader } = await decrypt(keyringFor(cfg), Buffer.from(ciphertext));
  const actual = messageHeader.encryptionContext;
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length || keys.some(k => actual[k] !== expected[k])) {
    throw new Error(`stored ${provider} credential was not encrypted for this user and provider`);
  }
  return JSON.parse(plaintext.toString('utf8'));
}

export async function readCredential(cfg: CredentialStoreConfig, userId: string, provider: string): Promise<unknown | null> {
  const row = await prisma.userCredential.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { ciphertext: true },
  });
  return row ? openCredential(cfg, userId, provider, row.ciphertext) : null;
}

/** A value and its display label to store, or null to delete that provider's row. */
export type CredentialChange = { value: unknown; label: string } | null;

/**
 * Applies every change in one transaction. Encryption (the KMS calls) happens
 * first, outside it, so a KMS failure writes nothing.
 */
export async function writeCredentials(
  cfg: CredentialStoreConfig,
  userId: string,
  changes: Record<string, CredentialChange>,
): Promise<void> {
  const entries = Object.entries(changes);
  const sealed = await Promise.all(entries.map(([provider, change]) =>
    change ? sealCredential(cfg, userId, provider, change.value) : Promise.resolve(null)));
  await prisma.$transaction(entries.map(([provider, change], i) => {
    const ciphertext = sealed[i];
    if (!change || !ciphertext) return prisma.userCredential.deleteMany({ where: { userId, provider } });
    return prisma.userCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, label: change.label, ciphertext },
      update: { label: change.label, ciphertext },
    });
  }));
  if ('github' in changes) notifyGithubCredentialChange(userId);
}

/**
 * Row delete; needs no KMS call, so it works with the store unconfigured.
 * Database backups keep the old ciphertext, decryptable by the orchestrator
 * role, until they expire.
 */
export async function deleteCredentials(userId: string, providers: string[]): Promise<void> {
  await prisma.userCredential.deleteMany({ where: { userId, provider: { in: providers } } });
  if (providers.includes('github')) notifyGithubCredentialChange(userId);
}

export interface GithubSecret {
  login: string;
  githubUserId: number;
  token: string;
  /** Absent on rows sealed before the probe existed. New writes always set it. */
  orgs?: Record<string, OrgAccess>;
}

export interface GithubAccess {
  readonly token: string;
  readonly login: string;
}

const ACCESS_TTL_MS = 60_000;
const accessByUser = new Map<string, { at: number; access: GithubAccess | null }>();

async function loadGithubAccess(userId: string): Promise<GithubAccess | null> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) return null;
  const secret = await readCredential(cfg, userId, 'github') as GithubSecret | null;
  if (!secret || typeof secret.token !== 'string' || !secret.token || typeof secret.login !== 'string' || !secret.login) return null;
  return { token: secret.token, login: secret.login };
}

/** Throws on a KMS or decrypt failure; that result is not cached. */
export async function readGithubAccess(userId: string): Promise<GithubAccess | null> {
  const hit = accessByUser.get(userId);
  const now = Date.now();
  if (hit && now - hit.at < ACCESS_TTL_MS) return hit.access;
  const access = await loadGithubAccess(userId);
  accessByUser.set(userId, { access, at: now });
  return access;
}

/** The GitHub broker's token source: the owner's stored `gh` token. */
export const githubTokenSource = Object.assign(
  async (userId: string) => (await readGithubAccess(userId))?.token ?? null,
  { forget(userId: string) { accessByUser.delete(userId); } },
);

const githubChangeListeners = new Set<(userId: string) => void>();

export function onGithubCredentialChange(listener: (userId: string) => void): () => void {
  githubChangeListeners.add(listener);
  return () => { githubChangeListeners.delete(listener); };
}

function notifyGithubCredentialChange(userId: string): void {
  githubTokenSource.forget(userId);
  for (const listener of githubChangeListeners) listener(userId);
}

/**
 * The org map from the stored secret, never the token.
 * null when the secret cannot be decrypted. {} when the row or orgs field is missing.
 */
export async function readGithubOrgAccess(userId: string): Promise<Record<string, OrgAccess> | null> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) return null;
  try {
    const secret = await readCredential(cfg, userId, 'github');
    return publicOrgStatuses(secret);
  } catch {
    console.warn('[CRED] could not read GitHub org access');
    return null;
  }
}

export interface GithubCredentialSnapshot {
  readonly secret: GithubSecret;
  /** Ciphertext of the row that was read. A later write matches this and does not insert. */
  readonly ciphertext: Buffer;
}

async function readGithubSnapshot(cfg: CredentialStoreConfig, userId: string): Promise<GithubCredentialSnapshot | null> {
  const row = await prisma.userCredential.findUnique({
    where: { userId_provider: { userId, provider: 'github' } },
    select: { ciphertext: true },
  });
  if (!row) return null;
  const secret = await openCredential(cfg, userId, 'github', row.ciphertext) as GithubSecret;
  return { secret, ciphertext: Buffer.from(row.ciphertext) };
}

/**
 * Update the GitHub row only when its ciphertext is still `expected`.
 * updateMany does not insert, so a disconnect during recheck stays deleted,
 * and a newer connect is not overwritten by the probe that started earlier.
 */
export async function replaceGithubCredentialIfUnchanged(
  cfg: CredentialStoreConfig,
  userId: string,
  expectedCiphertext: Buffer,
  github: GithubSecret,
): Promise<boolean> {
  const ciphertext = await sealCredential(cfg, userId, 'github', github);
  const updated = await prisma.userCredential.updateMany({
    where: { userId, provider: 'github', ciphertext: expectedCiphertext },
    data: { label: githubLabel(github.login), ciphertext },
  });
  if (updated.count === 0) return false;
  notifyGithubCredentialChange(userId);
  return true;
}

/** read/write of the user's GitHub credential; deleteCredentials removes it. */
export function githubStoreDeps(cfg: CredentialStoreConfig, userId: string) {
  return {
    read: async () => (await readGithubSnapshot(cfg, userId))?.secret ?? null,
    readSnapshot: () => readGithubSnapshot(cfg, userId),
    write: async (github: GithubSecret) => {
      await writeCredentials(cfg, userId, { github: { value: github, label: githubLabel(github.login) } });
    },
    replaceIfUnchanged: (ciphertext: Uint8Array, github: GithubSecret) =>
      replaceGithubCredentialIfUnchanged(cfg, userId, Buffer.from(ciphertext), github),
  };
}
