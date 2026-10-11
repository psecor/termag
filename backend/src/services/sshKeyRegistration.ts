/**
 * Owner SSH public keys. The Settings page route (routes/sshKeys.ts)
 * registers and lists them; the CLI (routes/cliCredentials.ts) only lists them.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { fitsManagedKeyBudget, parseSshPublicKey, SshKeyError } from './sshKeys';
import { pushSshKeysToBoxes, SshKeySyncResult } from './sshKeySync';

export interface SshKeyInfo {
  id: string;
  type: string;
  bits: number;
  comment: string;
  fingerprint: string;
  createdAt: Date;
}

export function toKeyInfo(row: { id: string; publicKey: string; fingerprint: string; createdAt: Date }): SshKeyInfo {
  const parsed = parseSshPublicKey(row.publicKey);
  return {
    id: row.id,
    type: parsed.type,
    bits: parsed.bits,
    comment: parsed.comment,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

export async function listSshKeys(userId: string): Promise<SshKeyInfo[]> {
  const rows = await prisma.sshPublicKey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  return rows.map(toKeyInfo);
}

// The key change is already committed, so a failure here is reported as
// `boxes: null` rather than failing the request.
export async function pushKeys(userId: string): Promise<SshKeySyncResult | null> {
  try {
    return await pushSshKeysToBoxes(userId);
  } catch (err) {
    console.error('[SSH-KEYS] push failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export type RegisterSshKeyResult =
  | { kind: 'created'; key: SshKeyInfo; boxes: SshKeySyncResult | null }
  | { kind: 'exists'; key: SshKeyInfo }
  | { kind: 'invalid'; message: string };

export async function registerSshKey(userId: string, publicKey: unknown): Promise<RegisterSshKeyResult> {
  let parsed;
  try {
    parsed = parseSshPublicKey(publicKey as string);
  } catch (err) {
    if (err instanceof SshKeyError) return { kind: 'invalid', message: err.message };
    throw err;
  }
  const existing = await prisma.sshPublicKey.findMany({
    where: { userId },
    select: { id: true, publicKey: true, fingerprint: true, createdAt: true },
  });
  const same = existing.find((k) => k.fingerprint === parsed.fingerprint);
  if (same) return { kind: 'exists', key: toKeyInfo(same) };
  if (!fitsManagedKeyBudget([...existing.map((k) => k.publicKey), parsed.line])) {
    return { kind: 'invalid', message: 'Too many keys registered; remove one before adding another' };
  }
  let row;
  try {
    row = await prisma.sshPublicKey.create({
      data: { userId, publicKey: parsed.line, fingerprint: parsed.fingerprint },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.sshPublicKey.findUnique({
        where: { userId_fingerprint: { userId, fingerprint: parsed.fingerprint } },
      });
      if (raced) return { kind: 'exists', key: toKeyInfo(raced) };
    }
    throw err;
  }
  return { kind: 'created', key: toKeyInfo(row), boxes: await pushKeys(userId) };
}
