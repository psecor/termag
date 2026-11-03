import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ startUpload: vi.fn(), uploaded: vi.fn(), partUrls: vi.fn(), completeUpload: vi.fn(), abortUpload: vi.fn(async () => ({})) }));
vi.mock('./api', async importOriginal => ({ ...(await importOriginal<typeof import('./api')>()), spacesApi: api }));

import { UploadConflict, conflictOf, uploadConditionFor, uploadFile } from './spaceTransfer';

/** An XMLHttpRequest that answers every PUT with `status` (and an ETag). */
function fakeXhr(status: number, etag = '"new"') {
  class X {
    status = 0; responseText = ''; upload = { onprogress: null as unknown };
    onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
    open() {} setRequestHeader() {} abort() {}
    getResponseHeader(h: string) { return h === 'ETag' ? etag : null; }
    send() { this.status = status; this.responseText = status === 412 ? '<Error><Code>PreconditionFailed</Code></Error>' : ''; queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('XMLHttpRequest', X);
}
const changed = (data: Record<string, unknown>) => Object.assign(new Error('412'), { response: { status: 412, data: { code: 'changed', ...data } } });

afterEach(() => { vi.unstubAllGlobals(); for (const f of Object.values(api)) f.mockReset(); });

describe('uploadConditionFor', () => {
  const files = [{ path: 'a/notes.md', etag: '"v1"' }, { path: 'a/old.md' }];
  it('is the shown version, or new for a name a complete listing lacks', () => {
    expect(uploadConditionFor('a/notes.md', 'a/', files, true)).toEqual({ ifMatch: '"v1"' });
    expect(uploadConditionFor('a/fresh.md', 'a/', files, true)).toEqual({ ifNoneMatch: '*' });
  });
  it('is nothing it can\'t know: no ETag, a subfolder, a listing with more pages', () => {
    expect(uploadConditionFor('a/old.md', 'a/', files, true)).toBeNull();
    expect(uploadConditionFor('a/sub/x.md', 'a/', files, true)).toBeNull();
    expect(uploadConditionFor('a/fresh.md', 'a/', files, false)).toBeNull();
  });
});

describe('uploadFile conflicts', () => {
  it('a 412 changed before signing is an UploadConflict, and nothing is sent', async () => {
    api.startUpload.mockRejectedValue(changed({ now: '"v2"', by: 'bob@example.com', at: '2026-10-27T10:00:00.000Z' }));
    const err = await uploadFile('team', 'a.md', new File(['x'], 'a.md'), () => {}, undefined, { ifMatch: '"v1"' }).catch(e => e);
    expect(err).toBeInstanceOf(UploadConflict);
    expect(err.message).toMatch(/^Changed since you opened it \(by bob@example\.com/);
    expect(api.startUpload.mock.calls[0][4]).toEqual({ ifMatch: '"v1"' });
    expect(api.uploaded).not.toHaveBeenCalled();
  });

  it('storage refusing the signed condition is a conflict, not retried', async () => {
    api.startUpload.mockResolvedValue({ kind: 'single', path: 'a.md', method: 'PUT', url: 'https://s3/x', headers: {}, expiresAt: '' });
    fakeXhr(412);
    const err = await uploadFile('team', 'a.md', new File(['x'], 'a.md'), () => {}, undefined, { ifMatch: '"v1"' }).catch(e => e);
    expect(err).toBeInstanceOf(UploadConflict);
    expect(api.uploaded).not.toHaveBeenCalled();
  });

  it('the confirm carries the condition and what the PUT wrote; its 412 is a conflict', async () => {
    api.startUpload.mockResolvedValue({ kind: 'single', path: 'a.md', method: 'PUT', url: 'https://s3/x', headers: {}, expiresAt: '' });
    fakeXhr(200, '"mine"');
    api.uploaded.mockRejectedValue(changed({ now: '"theirs"' }));
    const err = await uploadFile('team', 'a.md', new File(['x'], 'a.md'), () => {}, undefined, { ifMatch: '"v1"' }).catch(e => e);
    expect(api.uploaded).toHaveBeenCalledWith('team', 'a.md', { ifMatch: '"v1"' }, '"mine"');
    expect(err).toBeInstanceOf(UploadConflict);
  });

  it('anything else stays the error it was', () => {
    expect(conflictOf(Object.assign(new Error('x'), { response: { status: 403, data: { code: 'forbidden' } } }), 'a', null)).toBeNull();
  });
});
