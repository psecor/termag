import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadImagePreview } from './TerminalImagePreview';

const fetchMock = vi.fn();
let clock = 1_000_000;
// A distinct URL and clock per test, so the module cache never leaks between them.
const nextUrl = () => `/termag/api/projects/p1/image?workstream=main&path=%2Ftmp%2F${clock += 100_000}.png`;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const png = () => new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), { status: 200 });

describe('loadImagePreview', () => {
  it('never follows a redirect, so an expired edge session cannot send it to the identity provider', async () => {
    fetchMock.mockResolvedValueOnce(png());
    const url = nextUrl();
    expect((await loadImagePreview(url, clock)).kind).toBe('image');
    expect(fetchMock).toHaveBeenCalledWith(url, { credentials: 'same-origin', redirect: 'manual' });
  });

  it('reads an opaque redirect or a 401 as signed out', async () => {
    fetchMock.mockResolvedValueOnce({ type: 'opaqueredirect', status: 0, ok: false });
    expect(await loadImagePreview(nextUrl(), clock))
      .toEqual({ kind: 'error', message: 'Signed out. Reload the page to sign in again' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 401 }));
    expect(await loadImagePreview(nextUrl(), clock))
      .toEqual({ kind: 'error', message: 'Signed out. Reload the page to sign in again' });
  });

  it("shows the backend's reason for a refusal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'No such file' }), { status: 404 }));
    expect(await loadImagePreview(nextUrl(), clock)).toEqual({ kind: 'error', message: 'No such file' });
  });

  it('keeps an image for a while but asks again after an error', async () => {
    const shot = nextUrl();
    fetchMock.mockResolvedValueOnce(png());
    await loadImagePreview(shot, clock);
    await loadImagePreview(shot, clock + 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const missing = nextUrl();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'No such file' }), { status: 404 }));
    await loadImagePreview(missing, clock);
    fetchMock.mockResolvedValueOnce(png());
    expect((await loadImagePreview(missing, clock + 1_000)).kind).toBe('image');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
