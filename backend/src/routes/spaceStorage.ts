/**
 * The storage end of spaces on local storage (docs/spaces-local-storage.md):
 * answers the URLs LocalSpaceObjects signs, as S3 answers presigned ones.
 *
 * The token is the whole authority, as a presigned URL's signature is: no
 * session cookie, because the CLI on a box has none. A PUT must declare the
 * signed Content-Length (and for an object, the signed Content-Type), and the
 * body may not run past it. Failures answer S3's XML error shape, the 412
 * included, which the CLI (cli/src/space.ts s3Fetch) and the browser
 * (frontend/src/services/spaceTransfer.ts) already read.
 *
 * Mount it before express.json(): an upload whose type is application/json
 * would otherwise be parsed and consumed there.
 *
 * S3 serves from its own origin; these files come from termag's. So every GET
 * is nosniff, and every type outside SAFE_INLINE is also served under
 * `Content-Security-Policy: sandbox`: an uploaded HTML or SVG file opened from
 * its URL runs no script in termag's origin. PDF is in SAFE_INLINE because
 * Chrome's viewer won't render in a sandboxed document.
 *
 * `ready` is the storage's prepare() (spacesRuntime.prepareLocalSpaceStorage):
 * null once the directory is private, else why it refused. While it refuses,
 * every request here is 503, so a URL signed before the refusal cannot keep
 * serving from a directory other accounts can read.
 */
import { Router, type Request, type Response } from 'express';
import { StorageError, type LocalSpaceObjects } from '../services/spaces/localSpaceObjects';

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+)$/;

/** Whether a response of this type may render in termag's origin without a sandbox. */
export function safeInline(contentType: string): boolean {
  return SAFE_INLINE.test(contentType.split(';')[0].trim().toLowerCase());
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
}

function s3Error(res: Response, status: number, code: string, message: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.status(status).type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message></Error>`);
}

/** Refuses without reading the body, and closes rather than drain up to 64 MiB of it. */
function refuse(res: Response, status: number, code: string, message: string): void {
  res.setHeader('Connection', 'close');
  s3Error(res, status, code, message);
}

function failed(res: Response, err: unknown, what: string): void {
  if (err instanceof StorageError) { s3Error(res, err.status, err.code, err.message); return; }
  console.error(`[SPACES] storage ${what} failed:`, err);
  s3Error(res, 500, 'InternalError', 'We encountered an internal error. Please try again.');
}

export interface SpaceStorageRouterOptions {
  /** Resolves null when the storage may serve, else the reason it may not (answered 503). */
  ready?: () => Promise<string | null>;
}

export function spaceStorageRouter(objects: LocalSpaceObjects, opts: SpaceStorageRouterOptions = {}): Router {
  const router = Router();
  const ready = opts.ready ?? (() => Promise.resolve(null));

  /** 503 and false while the storage refuses to serve; true when it may. */
  async function serving(res: Response): Promise<boolean> {
    let refused: string | null;
    try {
      refused = await ready();
    } catch (err) {
      refused = (err as Error).message;
    }
    if (refused === null) return true;
    refuse(res, 503, 'ServiceUnavailable', `Local space storage is unavailable: ${refused}`);
    return false;
  }

  router.put('/:token', async (req: Request, res: Response) => {
    if (!await serving(res)) return;
    const grant = objects.grantOf(req.params.token);
    if (!grant || grant.op === 'get') { refuse(res, 403, 'AccessDenied', 'Request has expired or is not a signed upload'); return; }
    const declared = req.headers['content-length'];
    if (declared === undefined || !/^\d+$/.test(declared) || Number(declared) !== grant.size) {
      refuse(res, 403, 'SignatureDoesNotMatch', `Content-Length must be the signed ${grant.size}`);
      return;
    }
    if (grant.op === 'put' && req.headers['content-type'] !== grant.contentType) {
      refuse(res, 403, 'SignatureDoesNotMatch', 'Content-Type must be the signed type');
      return;
    }
    try {
      const { etag } = grant.op === 'put' ? await objects.receivePut(grant, req) : await objects.receivePart(grant, req);
      res.setHeader('ETag', etag);
      res.status(200).end();
    } catch (err) {
      if (err instanceof StorageError && err.code === 'IncompleteBody') res.setHeader('Connection', 'close');
      failed(res, err, 'PUT');
    }
  });

  router.get('/:token', async (req: Request, res: Response) => {
    if (!await serving(res)) return;
    const grant = objects.grantOf(req.params.token);
    if (!grant || grant.op !== 'get') { refuse(res, 403, 'AccessDenied', 'Request has expired or is not a signed download'); return; }
    let file;
    try {
      file = await objects.currentFile(grant.key);
    } catch (err) {
      failed(res, err, 'GET');
      return;
    }
    if (!file) { s3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.'); return; }
    const type = grant.contentType ?? file.contentType ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', grant.disposition);
    res.setHeader('ETag', file.etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!safeInline(type)) res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Cache-Control', 'private');
    // send keeps the Content-Type and ETag set here, and answers Range, If-Range and If-None-Match from them.
    res.sendFile(file.path, { etag: false, lastModified: true, acceptRanges: true, cacheControl: false, dotfiles: 'allow' }, err => {
      if (!err) return;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') s3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
      else if (!res.headersSent) failed(res, err, 'GET');
    });
  });

  return router;
}
