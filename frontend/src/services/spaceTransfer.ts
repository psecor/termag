import { spacesApi } from './api';
import { partRanges } from '../utils/spaces';

// Browser side of a spaces upload: the orchestrator signs, the browser sends
// the bytes straight to S3. XHR rather than fetch because only XHR reports
// upload progress.

const PART_URL_BATCH = 8;
const RETRIES = 3;

export class UploadAborted extends Error {
  constructor() { super('Upload cancelled'); }
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
      reject(new Error(`Storage answered HTTP ${xhr.status}${code ? ` ${code}` : ''}`));
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
      if (err instanceof UploadAborted) throw err;
      last = err;
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  throw last;
}

/** Uploads `file` to `space:path`; `onProgress` gets bytes sent so far. */
export async function uploadFile(space: string, path: string, file: File, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<void> {
  const start = await spacesApi.startUpload(space, path, file.size, file.type || 'application/octet-stream');
  if (start.kind === 'single') {
    await withRetry(() => put(start.url, start.headers, file, onProgress, signal));
    await spacesApi.uploaded(space, start.path);
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
    await spacesApi.completeUpload(space, start.uploadId, start.path, parts);
  } catch (err) {
    await spacesApi.abortUpload(space, start.uploadId, start.path).catch(() => {});
    throw err;
  }
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
