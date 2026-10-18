/**
 * Owner SSH public keys: parsing/validation and the termag-managed block in a
 * box's ~/.ssh/authorized_keys. Pure — the DB and agent side lives in
 * sshKeySync.ts.
 */

import { createHash } from 'crypto';

export const MANAGED_BEGIN = '# termag-managed begin';
export const MANAGED_END = '# termag-managed end';

// Cap on one user's key lines combined: they ride base64'd in cold-path
// user_data, which EC2 limits to 16 KB.
const MAX_MANAGED_KEY_BYTES = 6 * 1024;

/** Whether this set of key lines fits the cap (lines are ASCII, so length is bytes). */
export function fitsManagedKeyBudget(lines: string[]): boolean {
  return lines.reduce((n, l) => n + l.length + 1, 0) <= MAX_MANAGED_KEY_BYTES;
}

const MIN_RSA_BITS = 3072;
const MAX_KEY_LINE = 16 * 1024;
const MAX_COMMENT = 200;

const ECDSA_POINT_BYTES: Record<string, number> = {
  nistp256: 65,
  nistp384: 97,
  nistp521: 133,
};

export interface ParsedSshKey {
  type: string;
  /** Canonical `type base64 [comment]`, the exact line written to authorized_keys. */
  line: string;
  comment: string;
  /** `SHA256:<unpadded base64>`, what `ssh-keygen -l` prints. */
  fingerprint: string;
  bits: number;
}

export class SshKeyError extends Error {}

class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}

  bytes(): Buffer {
    if (this.off + 4 > this.buf.length) throw new SshKeyError('key blob is truncated');
    const len = this.buf.readUInt32BE(this.off);
    this.off += 4;
    if (this.off + len > this.buf.length) throw new SshKeyError('key blob is truncated');
    const out = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return out;
  }

  string(): string {
    return this.bytes().toString('latin1');
  }

  done(): boolean {
    return this.off === this.buf.length;
  }
}

function mpintBits(b: Buffer): number {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  if (i === b.length) return 0;
  return (b.length - i - 1) * 8 + (32 - Math.clz32(b[i]));
}

function keyBits(type: string, r: Reader): number {
  if (type === 'ssh-ed25519') {
    if (r.bytes().length !== 32) throw new SshKeyError('ssh-ed25519 key has the wrong length');
    return 256;
  }
  if (type === 'ssh-rsa') {
    const e = r.bytes();
    const n = r.bytes();
    if (mpintBits(e) === 0) throw new SshKeyError('ssh-rsa key has an invalid exponent');
    const bits = mpintBits(n);
    if (bits < MIN_RSA_BITS) {
      throw new SshKeyError(`ssh-rsa keys must be at least ${MIN_RSA_BITS} bits (this one is ${bits})`);
    }
    return bits;
  }
  const curve = type.slice('ecdsa-sha2-'.length);
  if (r.string() !== curve) throw new SshKeyError(`${type} key names a different curve`);
  const point = r.bytes();
  if (point.length !== ECDSA_POINT_BYTES[curve] || point[0] !== 0x04) {
    throw new SshKeyError(`${type} key has an invalid public point`);
  }
  return Number(curve.slice('nistp'.length));
}

function isAllowedType(type: string): boolean {
  return type === 'ssh-ed25519' || type === 'ssh-rsa'
    || (type.startsWith('ecdsa-sha2-') && type.slice('ecdsa-sha2-'.length) in ECDSA_POINT_BYTES);
}

/**
 * Parse one OpenSSH public key line (`type base64 [comment]`). Accepts
 * ssh-ed25519, ecdsa-sha2-nistp{256,384,521}, and ssh-rsa >= 3072 bits.
 * Options prefixes, certificates and security-key types are rejected.
 */
export function parseSshPublicKey(input: string): ParsedSshKey {
  if (typeof input !== 'string') throw new SshKeyError('public key must be a string');
  const text = input.trim();
  if (!text) throw new SshKeyError('public key is empty');
  if (text.length > MAX_KEY_LINE) throw new SshKeyError('public key is too long');
  if (/[\r\n\0]/.test(text)) throw new SshKeyError('paste exactly one public key line');

  const [type, b64, ...rest] = text.split(/[ \t]+/);
  if (!isAllowedType(type)) {
    throw new SshKeyError('unsupported key type; use ssh-ed25519, ecdsa-sha2-nistp256/384/521, or ssh-rsa (3072+ bits)');
  }
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new SshKeyError('key data is not base64');
  const blob = Buffer.from(b64, 'base64');
  if (blob.toString('base64') !== b64) throw new SshKeyError('key data is not canonical base64');

  const r = new Reader(blob);
  if (r.string() !== type) throw new SshKeyError('key data does not match its declared type');
  const bits = keyBits(type, r);
  if (!r.done()) throw new SshKeyError('key blob has trailing data');

  const comment = rest.join(' ');
  if (comment.length > MAX_COMMENT) throw new SshKeyError(`key comment must be at most ${MAX_COMMENT} characters`);
  if (/[^\x20-\x7e]/.test(comment)) throw new SshKeyError('key comment must be printable ASCII');

  const fingerprint = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return {
    type,
    line: comment ? `${type} ${b64} ${comment}` : `${type} ${b64}`,
    comment,
    fingerprint,
    bits,
  };
}

/** The managed block for `lines`, newline-terminated; empty when there are none. */
export function managedBlock(lines: string[]): string {
  if (lines.length === 0) return '';
  return [MANAGED_BEGIN, ...lines, MANAGED_END].join('\n') + '\n';
}

/**
 * Replace the termag-managed block in an authorized_keys file with `lines`,
 * leaving every other line alone. The block goes at the end; with no keys it
 * is removed. An unterminated block runs to end of file, so a removed key
 * cannot survive a hand-deleted end marker.
 */
export function rewriteAuthorizedKeys(existing: string | null, lines: string[]): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of (existing ?? '').split('\n')) {
    const bare = line.replace(/\r$/, '').trim();
    if (!inBlock && bare === MANAGED_BEGIN) { inBlock = true; continue; }
    if (inBlock) {
      if (bare === MANAGED_END) inBlock = false;
      continue;
    }
    kept.push(line);
  }
  if (inBlock) kept.push('');
  let head = kept.join('\n');
  if (lines.length > 0 && head !== '' && !head.endsWith('\n')) head += '\n';
  return head + managedBlock(lines);
}
