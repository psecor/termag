/**
 * Every S3 call spaces make, behind an interface so routes and tests need no
 * AWS.
 *
 * All of it, presigning included, uses a session of the presigner role, never
 * the host role's own credentials: the org SCP instance_credential_vpc_restriction
 * refuses EC2 instance-role credentials outside the termag VPC, so a URL signed
 * with them would work from a box and fail from a browser or laptop. A chained
 * session lasts at most an hour, and a URL cannot outlive the session that
 * signed it, so the session is renewed whenever less than the longest TTL
 * (plus a minute) is left.
 *
 * There is one session per acting identity (presignerSession), so CloudTrail's
 * S3 data events say who made each call: the session name is what acted
 * (user-<email>, box-<name>, system-<task>) and SourceIdentity the person (a
 * box's owner). Until the presigner's trust policy allows
 * sts:SetSourceIdentity, AssumeRole with one answers AccessDenied; sessions are
 * then made without it (still named per identity) and it is tried again after
 * SOURCE_IDENTITY_RETRY_MS.
 *
 * Every write names the KMS key: the bucket's default encryption is SSE-S3 and
 * its policy refuses any other algorithm or key on PutObject,
 * CreateMultipartUpload and CopyObject. The SSE headers are signed into a PUT
 * URL as unhoistable headers, so the client must send them exactly; so is
 * Content-Length, so a client cannot send more than it declared.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SpaceResources } from './spaceConfig';

export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export const DOWNLOAD_TTL_S = 5 * 60;
/** The PDF viewer and <video> keep sending Range requests after the first load; a 5-minute URL breaks seeking. */
export const VIEW_TTL_S = 30 * 60;
export const PUT_TTL_S = 15 * 60;
export const PART_TTL_S = 30 * 60;
export const SESSION_TTL_S = 60 * 60;
export const MIN_SESSION_LEFT_MS = (PART_TTL_S + 60) * 1000;

export interface ListedFile { key: string; size: number; modifiedAt: string | null; etag: string | null }
export interface ListResult { prefixes: string[]; files: ListedFile[]; nextCursor: string | null }
export interface PresignedUrl { url: string; expiresAt: string }
export interface PresignedPut extends PresignedUrl { method: 'PUT'; headers: Record<string, string> }

export interface SpaceObjects {
  list(prefix: string, opts?: { cursor?: string | null; delimiter?: boolean; max?: number }): Promise<ListResult>;
  head(key: string): Promise<{ size: number; contentType: string | null; lastModified: Date | null } | null>;
  /** `ttlS` is at most VIEW_TTL_S, which MIN_SESSION_LEFT_MS covers. */
  presignGet(key: string, response: { contentDisposition: string; contentType?: string }, ttlS?: number): Promise<PresignedUrl>;
  /**
   * At most the first `maxBytes + 1` bytes of the object (a ranged GET, so the
   * object changing after a HEAD can't make it buffer more), or null when it
   * is gone. More than `maxBytes` back means the object is over the limit.
   */
  read(key: string, maxBytes: number): Promise<Buffer | null>;
  presignPut(key: string, size: number, contentType: string): Promise<PresignedPut>;
  createMultipart(key: string, contentType: string): Promise<string>;
  /** Each part URL signs its exact Content-Length, so a part can't carry more than the declared upload. */
  presignParts(key: string, uploadId: string, parts: Array<{ partNumber: number; size: number }>): Promise<Array<{ partNumber: number } & PresignedUrl>>;
  completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Deletes current versions (a delete marker each); returns the keys S3 refused. */
  deleteKeys(keys: string[]): Promise<string[]>;
  /** Bytes in every version under the prefix, current and noncurrent. */
  sumVersions(prefix: string, watch: Set<string>): Promise<{ total: bigint; watched: ObjectVersion[] }>;
  /** Permanently deletes every version and delete marker under the prefix. */
  purgePrefix(prefix: string): Promise<number>;
  /**
   * In-progress multipart uploads under the prefix, which ListObjectVersions
   * doesn't see but S3 stores and bills: aborts those started before
   * `abortBefore` and returns the rest, each with the parts it holds.
   */
  sweepMultipart(prefix: string, abortBefore: Date): Promise<{ aborted: number; inProgress: OpenUpload[] }>;
}

export interface ObjectVersion { key: string; size: bigint; lastModified: Date }
export interface OpenUpload { key: string; uploadId: string; parts: Array<{ partNumber: number; bytes: bigint }> }

/** The SSE-KMS headers every write carries. */
export function sseHeaders(kmsKeyId: string): Record<string, string> {
  return {
    'x-amz-server-side-encryption': 'aws:kms',
    'x-amz-server-side-encryption-aws-kms-key-id': kmsKeyId,
    'x-amz-server-side-encryption-bucket-key-enabled': 'true',
  };
}

/** Who an S3 call is made for. */
export type PresignerIdentity =
  | { kind: 'user'; userId: string; email: string | null }
  | { kind: 'box'; instanceId: string; name: string | null; ownerUserId: string; ownerEmail: string | null }
  | { kind: 'system'; task: string };

export const SWEEP_IDENTITY: PresignerIdentity = { kind: 'system', task: 'sweep' };

export interface PresignerSession {
  /** Cache key: changes when the identity or either name does. */
  key: string;
  roleSessionName: string;
  sourceIdentity: string | null;
}

/** STS's rule for RoleSessionName and SourceIdentity: 2-64 characters of [\w+=,.@-]. */
export function stsName(raw: string): string {
  const name = raw.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
  return name.length >= 2 ? name : name.padEnd(2, '_');
}

export function presignerSession(identity: PresignerIdentity): PresignerSession {
  let id: string;
  let roleSessionName: string;
  let sourceIdentity: string | null;
  switch (identity.kind) {
    case 'user':
      id = `user:${identity.userId}`;
      roleSessionName = stsName(`user-${identity.email ?? identity.userId}`);
      sourceIdentity = stsName(identity.email ?? identity.userId);
      break;
    case 'box':
      id = `box:${identity.instanceId}`;
      roleSessionName = stsName(`box-${identity.name ?? identity.instanceId}`);
      sourceIdentity = stsName(identity.ownerEmail ?? identity.ownerUserId);
      break;
    case 'system':
      id = `system:${identity.task}`;
      roleSessionName = stsName(`system-${identity.task}`);
      sourceIdentity = null;
      break;
  }
  return { key: `${id} ${roleSessionName} ${sourceIdentity ?? ''}`, roleSessionName, sourceIdentity };
}

export const SOURCE_IDENTITY_RETRY_MS = 15 * 60 * 1000;

/**
 * Whether to send SourceIdentity, shared by every session: after an
 * AccessDenied with it (the trust policy predates sts:SetSourceIdentity), not
 * for retryMs.
 */
export class SourceIdentityGate {
  private deniedAt: number | null = null;
  constructor(private readonly retryMs = SOURCE_IDENTITY_RETRY_MS) {}
  allowed(now: number): boolean { return this.deniedAt === null || now - this.deniedAt >= this.retryMs; }
  denied(now: number, err: Error): void {
    if (this.deniedAt === null) console.warn(`[SPACES] AssumeRole with SourceIdentity was denied (${err.message}); signing without it until the presigner trust allows sts:SetSourceIdentity`);
    this.deniedAt = now;
  }
  accepted(): void {
    if (this.deniedAt !== null) console.log('[SPACES] AssumeRole with SourceIdentity accepted again');
    this.deniedAt = null;
  }
}

function isAccessDenied(err: unknown): boolean {
  const e = err as { name?: string; Code?: string };
  return e?.name === 'AccessDenied' || e?.Code === 'AccessDenied';
}

export type PresignerCredentialProvider = (() => Promise<AwsCredentialIdentity>) & { memoized: true };

/**
 * Keeps one presigner session and renews it before it could cut a URL short.
 *
 * Marked `memoized` so the SDK calls it on every request: otherwise the SDK
 * wraps it in its own cache, which only refreshes five minutes before expiry,
 * and a 30-minute part URL could be signed by a session with minutes left.
 */
export function presignerCredentials(
  roleArn: string,
  opts: {
    session?: Pick<PresignerSession, 'roleSessionName' | 'sourceIdentity'>;
    sts?: Pick<STSClient, 'send'>;
    gate?: SourceIdentityGate;
    now?: () => number;
  } = {},
): PresignerCredentialProvider {
  const sts = opts.sts ?? new STSClient({});
  const now = opts.now ?? Date.now;
  const gate = opts.gate ?? new SourceIdentityGate();
  const { roleSessionName, sourceIdentity } = opts.session ?? presignerSession(SWEEP_IDENTITY);
  let current: AwsCredentialIdentity | null = null;
  let inFlight: Promise<AwsCredentialIdentity> | null = null;

  const assume = (withSource: boolean) => sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: roleSessionName,
    DurationSeconds: SESSION_TTL_S,
    ...(withSource && sourceIdentity ? { SourceIdentity: sourceIdentity } : {}),
  }));

  const provider = async () => {
    if (current?.expiration && current.expiration.getTime() - now() > MIN_SESSION_LEFT_MS) return current;
    inFlight ??= (async () => {
      const withSource = sourceIdentity !== null && gate.allowed(now());
      let out;
      try {
        out = await assume(withSource);
        if (withSource) gate.accepted();
      } catch (err) {
        if (!withSource || !isAccessDenied(err)) throw err;
        gate.denied(now(), err as Error);
        out = await assume(false);
      }
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('AssumeRole returned no credentials');
      const expiration = c.Expiration ?? new Date(now() + SESSION_TTL_S * 1000);
      if (expiration.getTime() - now() <= MIN_SESSION_LEFT_MS) {
        throw new Error(`AssumeRole returned a session that ends in ${Math.round((expiration.getTime() - now()) / 1000)}s, shorter than the longest URL`);
      }
      current = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration };
      return current;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  return Object.assign(provider, { memoized: true as const });
}

export const MAX_PRESIGNER_SESSIONS = 256;

/**
 * SpaceObjects per identity, each over its own presigner session, kept in a
 * small LRU. The clients share one STS client, one SourceIdentityGate and one
 * HTTP handler.
 */
export function presignerObjects(
  resources: SpaceResources,
  opts: {
    sts?: Pick<STSClient, 'send'>;
    gate?: SourceIdentityGate;
    now?: () => number;
    max?: number;
    s3?: (credentials: PresignerCredentialProvider) => S3Client;
  } = {},
): (identity: PresignerIdentity) => SpaceObjects {
  const sts = opts.sts ?? new STSClient({});
  const gate = opts.gate ?? new SourceIdentityGate();
  const max = opts.max ?? MAX_PRESIGNER_SESSIONS;
  let shared: S3Client | null = null;
  const s3For = opts.s3 ?? ((credentials: PresignerCredentialProvider) => {
    const client: S3Client = new S3Client({
      ...spacesS3ClientConfig(resources, credentials),
      ...(shared ? { requestHandler: shared.config.requestHandler } : {}),
    });
    shared ??= client;
    return client;
  });
  const cache = new Map<string, SpaceObjects>();

  return identity => {
    const session = presignerSession(identity);
    let objects = cache.get(session.key);
    if (objects) {
      cache.delete(session.key);
    } else {
      const credentials = presignerCredentials(resources.roleArn, { session, sts, gate, now: opts.now });
      objects = s3SpaceObjects(resources, { s3: s3For(credentials) });
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
    }
    cache.set(session.key, objects);
    return objects;
  };
}

/**
 * A key as a CopySource: every segment percent-encoded, including the
 * `!'()*` that encodeURIComponent leaves alone (paths may hold them).
 */
export function copySource(bucket: string, key: string): string {
  const enc = (seg: string) => encodeURIComponent(seg).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${bucket}/${key.split('/').map(enc).join('/')}`;
}

function expiresAt(ttlS: number): string {
  return new Date(Date.now() + ttlS * 1000).toISOString();
}

/**
 * `requestChecksumCalculation: WHEN_REQUIRED`: by default the SDK signs a
 * CRC32 of the request body into the URL, which for a presign is the empty
 * body, so S3 would refuse every upload made with it as a bad digest.
 */
export function spacesS3ClientConfig(
  resources: SpaceResources,
  credentials: () => Promise<AwsCredentialIdentity> = presignerCredentials(resources.roleArn),
) {
  return {
    region: resources.region,
    credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
}

export function s3SpaceObjects(resources: SpaceResources, opts: { s3?: S3Client } = {}): SpaceObjects {
  const s3 = opts.s3 ?? new S3Client(spacesS3ClientConfig(resources));
  const Bucket = resources.bucket;
  const sse = {
    ServerSideEncryption: 'aws:kms' as const,
    SSEKMSKeyId: resources.kmsKeyId,
    BucketKeyEnabled: true,
  };

  return {
    async list(prefix, o = {}) {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket,
        Prefix: prefix,
        Delimiter: o.delimiter === false ? undefined : '/',
        MaxKeys: o.max ?? 1000,
        ContinuationToken: o.cursor ?? undefined,
      }));
      return {
        prefixes: (out.CommonPrefixes ?? []).map(p => p.Prefix!).filter(Boolean),
        files: (out.Contents ?? []).filter(c => c.Key).map(c => ({
          key: c.Key!,
          size: Number(c.Size ?? 0),
          modifiedAt: c.LastModified ? c.LastModified.toISOString() : null,
          etag: c.ETag ?? null,
        })),
        nextCursor: out.IsTruncated ? out.NextContinuationToken ?? null : null,
      };
    },

    async head(key) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(out.ContentLength ?? 0), contentType: out.ContentType ?? null, lastModified: out.LastModified ?? null };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (err as Error).name === 'NotFound') return null;
        throw err;
      }
    },

    async read(key, maxBytes) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${maxBytes}` }));
        return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : Buffer.alloc(0);
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (err as Error).name === 'NoSuchKey') return null;
        // S3 refuses any range of an empty object.
        if (status === 416 || (err as Error).name === 'InvalidRange') return Buffer.alloc(0);
        throw err;
      }
    },

    async presignGet(key, response, ttlS = DOWNLOAD_TTL_S) {
      const expiresIn = Math.min(ttlS, VIEW_TTL_S);
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket, Key: key,
        ResponseContentDisposition: response.contentDisposition,
        ResponseContentType: response.contentType,
      }), { expiresIn });
      return { url, expiresAt: expiresAt(expiresIn) };
    },

    async presignPut(key, size, contentType) {
      const headers = { 'content-type': contentType, ...sseHeaders(resources.kmsKeyId) };
      const url = await getSignedUrl(s3, new PutObjectCommand({
        Bucket, Key: key, ContentLength: size, ContentType: contentType, ...sse,
      }), {
        expiresIn: PUT_TTL_S,
        signableHeaders: new Set(['content-length', 'content-type']),
        unhoistableHeaders: new Set(Object.keys(sseHeaders(resources.kmsKeyId))),
      });
      return { method: 'PUT', url, headers, expiresAt: expiresAt(PUT_TTL_S) };
    },

    async createMultipart(key, contentType) {
      const out = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, ...sse }));
      if (!out.UploadId) throw new Error('CreateMultipartUpload returned no upload id');
      return out.UploadId;
    },

    async presignParts(key, uploadId, parts) {
      return Promise.all(parts.map(async ({ partNumber, size }) => ({
        partNumber,
        url: await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: size }), {
          expiresIn: PART_TTL_S,
          signableHeaders: new Set(['content-length']),
        }),
        expiresAt: expiresAt(PART_TTL_S),
      })));
    },

    async completeMultipart(key, uploadId, parts) {
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket, Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }));
    },

    async abortMultipart(key, uploadId) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
    },

    async copy(fromKey, toKey) {
      await s3.send(new CopyObjectCommand({
        Bucket, Key: toKey,
        CopySource: copySource(Bucket, fromKey),
        ...sse,
      }));
    },

    async deleteKeys(keys) {
      const failed: string[] = [];
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const out = await s3.send(new DeleteObjectsCommand({
          Bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true },
        }));
        for (const e of out.Errors ?? []) if (e.Key) failed.push(e.Key);
      }
      return failed;
    },

    async sumVersions(prefix, watch) {
      let total = 0n;
      const watched: ObjectVersion[] = [];
      let KeyMarker: string | undefined;
      let VersionIdMarker: string | undefined;
      do {
        const out = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
        for (const v of out.Versions ?? []) {
          total += BigInt(v.Size ?? 0);
          if (v.Key && v.LastModified && watch.has(v.Key)) watched.push({ key: v.Key, size: BigInt(v.Size ?? 0), lastModified: v.LastModified });
        }
        KeyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
        VersionIdMarker = out.IsTruncated ? out.NextVersionIdMarker : undefined;
      } while (KeyMarker);
      return { total, watched };
    },

    async purgePrefix(prefix) {
      let removed = 0;
      for (;;) {
        const out = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: prefix, MaxKeys: 1000 }));
        const objects = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])]
          .filter(v => v.Key && v.Key.startsWith(prefix))
          .map(v => ({ Key: v.Key!, VersionId: v.VersionId }));
        if (objects.length === 0) return removed;
        // DeleteObjects takes at most 1000 entries, and a page can hold more versions plus markers.
        for (let i = 0; i < objects.length; i += 1000) {
          const batch = objects.slice(i, i + 1000);
          const del = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch, Quiet: true } }));
          if (del.Errors?.length) throw new Error(`purge ${prefix}: ${del.Errors.length} versions could not be deleted (${del.Errors[0].Code})`);
          removed += batch.length;
        }
      }
    },

    async sweepMultipart(prefix, abortBefore) {
      let aborted = 0;
      const inProgress: OpenUpload[] = [];
      let KeyMarker: string | undefined;
      let UploadIdMarker: string | undefined;
      do {
        const out = await s3.send(new ListMultipartUploadsCommand({ Bucket, Prefix: prefix, KeyMarker, UploadIdMarker }));
        for (const u of out.Uploads ?? []) {
          if (!u.Key || !u.UploadId || !u.Key.startsWith(prefix)) continue;
          if (!u.Initiated || u.Initiated < abortBefore) {
            await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: u.Key, UploadId: u.UploadId }));
            aborted++;
            continue;
          }
          const held: OpenUpload['parts'] = [];
          let PartNumberMarker: string | undefined;
          do {
            const parts = await s3.send(new ListPartsCommand({ Bucket, Key: u.Key, UploadId: u.UploadId, PartNumberMarker }));
            for (const p of parts.Parts ?? []) held.push({ partNumber: p.PartNumber ?? 0, bytes: BigInt(p.Size ?? 0) });
            PartNumberMarker = parts.IsTruncated ? parts.NextPartNumberMarker : undefined;
          } while (PartNumberMarker);
          inProgress.push({ key: u.Key, uploadId: u.UploadId, parts: held });
        }
        KeyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
        UploadIdMarker = out.IsTruncated ? out.NextUploadIdMarker : undefined;
      } while (KeyMarker);
      return { aborted, inProgress };
    },
  };
}
