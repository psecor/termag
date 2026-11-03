import { spacesApi, type SpaceWriteCondition } from './api';
import { partRanges } from '../utils/spaces';

// Browser side of a spaces upload: the orchestrator signs, the browser sends
// the bytes straight to S3. XHR rather than fetch because only XHR reports
// upload progress.

const PART_URL_BATCH = 8;
const RETRIES = 3;

export class UploadAborted extends Error {
  constructor() { super('Upload cancelled'); }
}

/**
 * The file changed since this page read it:
 * nothing was written. `now` is its version now (null: gone, or unknown when
 * storage itself refused), `by` and `at` who wrote it last and when.
 */
export class UploadConflict extends Error {
  constructor(readonly path: string, readonly now: string | null, readonly by: string | null, readonly at: string | null, readonly exists: boolean) {
    super(exists
      ? `Changed since you opened it${by ? ` (by ${by}${at ? `, ${new Date(at).toLocaleString()}` : ''})` : ''}`
      : 'Someone else made this file since you opened the folder');
  }
}

/** The conflict a 412 `changed` answer (orchestrator) or a 412 PreconditionFailed (storage) is, or null. */
export function conflictOf(err: unknown, path: string, condition: SpaceWriteCondition): UploadConflict | null {
  const res = (err as { response?: { status?: number; data?: { code?: string; now?: string | null; by?: string | null; at?: string | null } } })?.response;
  if (res?.status === 412 && res.data?.code === 'changed') {
    return new UploadConflict(path, res.data.now ?? null, res.data.by ?? null, res.data.at ?? null, !(condition && 'ifNoneMatch' in condition) || res.data.now != null);
  }
  if (err instanceof StorageRefused && err.status === 412) return new UploadConflict(path, null, null, null, true);
  return null;
}

class StorageRefused extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function put(url: string, headers: Record<string, string>, body: Blob, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new UploadAborted()); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = e => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(xhr.getResponseHeader('ETag')); return; }
      const code = /<Code>([^<]+)<\/Code>/.exec(xhr.responseText ?? '')?.[1];
      reject(new StorageRefused(xhr.status, `Storage answered HTTP ${xhr.status}${code ? ` ${code}` : ''}`));
    };
    xhr.onerror = () => reject(new Error('Could not reach storage'));
    xhr.onabort = () => reject(new UploadAborted());
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // A cancel, and a refused condition, are answers: trying again changes neither.
      if (err instanceof UploadAborted || (err instanceof StorageRefused && err.status === 412)) throw err;
      last = err;
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  throw last;
}

/**
 * Uploads `file` to `space:path`; `onProgress` gets bytes sent so far.
 * `condition` is the version the page shows (or that the file is new): a
 * newer one rejects with UploadConflict and nothing is written. Null overwrites.
 */
export async function uploadFile(space: string, path: string, file: File, onProgress: (sent: number) => void, signal?: AbortSignal, condition: SpaceWriteCondition = null): Promise<void> {
  try {
    await upload(space, path, file, onProgress, signal, condition);
  } catch (err) {
    throw conflictOf(err, path, condition) ?? err;
  }
}

async function upload(space: string, path: string, file: File, onProgress: (sent: number) => void, signal: AbortSignal | undefined, condition: SpaceWriteCondition): Promise<void> {
  const start = await spacesApi.startUpload(space, path, file.size, file.type || 'application/octet-stream', condition);
  if (start.kind === 'single') {
    const etag = await withRetry(() => put(start.url, start.headers, file, onProgress, signal));
    await spacesApi.uploaded(space, start.path, condition, etag);
    onProgress(file.size);
    return;
  }

  const ranges = partRanges(file.size, start.partBytes, start.partCount);
  const done = new Map<number, number>();
  const report = () => onProgress([...done.values()].reduce((a, b) => a + b, 0));
  const parts: Array<{ partNumber: number; etag: string }> = [];
  try {
    for (let i = 0; i < ranges.length; i += PART_URL_BATCH) {
      const batch = ranges.slice(i, i + PART_URL_BATCH);
      const { parts: urls } = await spacesApi.partUrls(space, start.uploadId, start.path, file.size, batch.map(r => r.partNumber));
      for (const range of batch) {
        const url = urls.find(u => u.partNumber === range.partNumber)?.url;
        if (!url) throw new Error(`No URL for part ${range.partNumber}`);
        const etag = await withRetry(() => put(url, {}, file.slice(range.start, range.end), sent => {
          done.set(range.partNumber, sent);
          report();
        }, signal));
        if (!etag) throw new Error('Storage returned no ETag; the bucket must expose it to the browser (CORS)');
        done.set(range.partNumber, range.end - range.start);
        report();
        parts.push({ partNumber: range.partNumber, etag });
      }
    }
    await spacesApi.completeUpload(space, start.uploadId, start.path, parts, condition);
  } catch (err) {
    await spacesApi.abortUpload(space, start.uploadId, start.path).catch(() => {});
    throw err;
  }
}

/**
 * What an upload to `path` says it read, from the folder listing the page
 * shows (`files`, all of `prefix` when `complete`): the shown file's version,
 * or "new" for a name the complete listing doesn't have. A path in a
 * subfolder, or a listing with more pages, isn't known, and goes unconditional.
 */
export function uploadConditionFor(path: string, prefix: string, files: ReadonlyArray<{ path: string; etag?: string }>, complete: boolean): SpaceWriteCondition {
  const shown = files.find(f => f.path === path);
  if (shown) return shown.etag ? { ifMatch: shown.etag } : null;
  if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/') || !complete) return null;
  return { ifNoneMatch: '*' };
}

/** Starts a download through a presigned URL; the browser saves it under the file's name. */
export async function downloadFile(space: string, path: string): Promise<void> {
  const { url } = await spacesApi.download(space, path);
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The message an API or storage error carries, for an error banner. */
export function errorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  if (data?.error) return data.error;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
