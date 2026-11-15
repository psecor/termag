/**
 * The orchestrator's own presigned URLs, for spaces on local storage
 * (localSpaceObjects.ts, routes/spaceStorage.ts).
 *
 * A grant is what an S3 presigned URL signs: the operation, the key, and for
 * a write the exact size, content type, condition and upload proof. It is a
 * bearer, like S3's: the CLI on a box has no session cookie. The token is
 * `<base64url JSON>.<base64url HMAC-SHA256>`, keyed by a key derived from the
 * secret given (SESSION_SECRET), so it is not the session cookie's key.
 *
 * Pure: no filesystem, no Express.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { PutCondition } from './spaceMemory';

export type StorageGrant =
  | { op: 'get'; key: string; disposition: string; contentType?: string; exp: number }
  | { op: 'put'; key: string; size: number; contentType: string; condition: PutCondition | null; proof: string | null; exp: number }
  | { op: 'part'; key: string; uploadId: string; partNumber: number; size: number; exp: number };

const KEY_LABEL = 'termag space storage urls v1';

/** The HMAC key grants are signed with, derived so it is never the raw secret. */
export function storageSigningKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(body).digest();
}

export function signGrant(key: Buffer, grant: StorageGrant): string {
  const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${body}.${mac(key, body).toString('base64url')}`;
}

function isCondition(c: unknown): c is PutCondition | null {
  if (c === null) return true;
  if (typeof c !== 'object') return false;
  const { ifMatch, ifNoneMatch } = c as Record<string, unknown>;
  return (typeof ifMatch === 'string' && ifNoneMatch === undefined) || (ifNoneMatch === '*' && ifMatch === undefined);
}

function wellFormed(g: Record<string, unknown>): g is StorageGrant {
  if (typeof g.key !== 'string' || !g.key || typeof g.exp !== 'number') return false;
  const size = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  switch (g.op) {
    case 'get': return typeof g.disposition === 'string' && (g.contentType === undefined || typeof g.contentType === 'string');
    case 'put': return size(g.size) && typeof g.contentType === 'string' && isCondition(g.condition) && (g.proof === null || typeof g.proof === 'string');
    case 'part': return size(g.size) && typeof g.uploadId === 'string' && Number.isSafeInteger(g.partNumber) && (g.partNumber as number) >= 1;
    default: return false;
  }
}

/** The grant a token carries, or null when it is malformed, tampered with or expired. */
export function verifyGrant(key: Buffer, token: string, now = Date.now()): StorageGrant | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = mac(key, body);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let grant: unknown;
  try { grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!grant || typeof grant !== 'object' || !wellFormed(grant as Record<string, unknown>)) return null;
  return (grant as StorageGrant).exp > now ? grant as StorageGrant : null;
}
