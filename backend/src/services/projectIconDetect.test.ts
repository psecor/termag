import { describe, expect, it } from 'vitest';
import {
  detectRepoIcons, htmlIconRefs, ICON_DIRS, iconScore, ICON_MAX_IMAGES, isRepoKey, manifestIconRefs, nameScore, resolveIconRef,
} from './projectIconDetect';
import { ICON_MAX_BYTES } from './projectIcons';

const png = (w: number, h = w) => {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const svg = (viewBox = '0 0 32 32') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path d="M0 0h1v1z"/></svg>`);
const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);

describe('resolving a manifest or page ref', () => {
  it('resolves relative refs beside the file, root-relative ones against each site root', () => {
    expect(resolveIconRef('icons/a.png', 'public', ['public'])).toEqual(['public/icons/a.png']);
    expect(resolveIconRef('./a.png?v=2#x', 'public', ['public'])).toEqual(['public/a.png']);
    expect(resolveIconRef('/favicon.svg', '', ['public', ''])).toEqual(['public/favicon.svg', 'favicon.svg']);
    expect(resolveIconRef('%PUBLIC_URL%/logo192.png', 'public', ['public'])).toEqual(['public/logo192.png']);
    expect(resolveIconRef('../img/a.png', 'web/public', ['web/public'])).toEqual(['web/img/a.png']);
  });

  it('drops refs outside the repository', () => {
    for (const ref of ['https://cdn.example.com/a.png', '//cdn.example.com/a.png', 'data:image/png;base64,AA', '../../a.png', '']) {
      expect(resolveIconRef(ref, 'public', ['public'])).toEqual([]);
    }
  });

  it("reads a manifest's icons and an index.html's icon links, not its mask-icon", () => {
    expect(manifestIconRefs('public/manifest.json', JSON.stringify({ icons: [{ src: 'logo192.png' }, { src: '/icons/512.png' }, { src: 5 }] })))
      .toEqual(['public/logo192.png', 'public/icons/512.png']);
    expect(manifestIconRefs('site.webmanifest', 'not json')).toEqual([]);
    expect(htmlIconRefs('index.html', `
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <link rel='apple-touch-icon' href=/apple-touch-icon.png>
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <link rel="stylesheet" href="/style.css">`))
      .toEqual(['public/favicon.svg', 'favicon.svg', 'public/apple-touch-icon.png', 'apple-touch-icon.png']);
  });
});

describe('ranking', () => {
  it('prefers an SVG favicon, then an app icon, a PNG favicon, favicon.ico, a logo', () => {
    const order = ['logo.png', 'favicon.ico', 'favicon-32x32.png', 'apple-touch-icon.png', 'favicon.svg'].sort((a, b) => nameScore(b) - nameScore(a));
    expect(order).toEqual(['favicon.svg', 'apple-touch-icon.png', 'favicon-32x32.png', 'favicon.ico', 'logo.png']);
  });

  it('drops a wordmark and a tiny raster, and raises a large square one', () => {
    // An SVG isn't taken until step 6 (services/projectIconSvg.ts), whatever it's called.
    expect(iconScore('favicon.svg', svg())).toBeNull();
    expect(iconScore('logo.png', png(400, 100))).toBeNull();
    expect(iconScore('favicon.png', png(8))).toBeNull();
    expect(iconScore('logo.png', png(512))!).toBeGreaterThan(iconScore('favicon-32x32.png', png(32))!);
    expect(iconScore('favicon.png', Buffer.from('not an image'))).toBeNull();
  });

  it('checks repo keys', () => {
    expect(isRepoKey('example-org/termag')).toBe(true);
    expect(isRepoKey('e2e-org/sample.api_2')).toBe(true);
    for (const bad of ['../x', 'a/..', 'a/b/c', '-a/b', 'a', 'a/']) expect(isRepoKey(bad)).toBe(false);
  });
});

type Entry = { name: string; type: 'file' | 'dir'; size?: number };
/** A fake GitHub contents API: directory listings as JSON, files raw; every call recorded. */
function fakeGithub(tree: Record<string, Entry[]>, files: Record<string, Buffer | string>, opts: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: Array<{ url: string; accept: string | null; auth: string | null; redirect: string | undefined }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    calls.push({ url, accept: h.get('accept'), auth: h.get('authorization'), redirect: init?.redirect });
    if (opts.status) return new Response('{}', { status: opts.status, headers: opts.headers });
    const m = /\/repos\/o\/r\/contents\/?(.*)$/.exec(url);
    const path = m ? decodeURIComponent(m[1]) : '';
    if (path in tree && h.get('accept')?.includes('json')) {
      return Response.json(tree[path].map(e => ({ ...e, path: path ? `${path}/${e.name}` : e.name, size: e.size ?? 0 })));
    }
    const file = files[path];
    if (file === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(typeof file === 'string' ? file : new Uint8Array(file), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('detectRepoIcons', () => {
  it('lists every parent of a nested directory ahead of it, or the nested one is never reached', () => {
    ICON_DIRS.forEach((dir, i) => {
      if (!dir.includes('/')) return;
      const parent = dir.slice(0, dir.lastIndexOf('/'));
      expect(ICON_DIRS.indexOf(parent), `${dir} needs ${parent} before it`).toBeGreaterThanOrEqual(0);
      expect(ICON_DIRS.indexOf(parent)).toBeLessThan(i);
    });
  });

  it("finds a monorepo frontend's public favicon (termag's frontend/public)", async () => {
    const gh = fakeGithub({
      '': [{ name: 'frontend', type: 'dir' }, { name: 'backend', type: 'dir' }],
      frontend: [{ name: 'public', type: 'dir' }],
      'frontend/public': [{ name: 'favicon.png', type: 'file', size: 40 }],
    }, { 'frontend/public/favicon.png': png(32) });
    const got = await detectRepoIcons('o/r', 't', { fetch: gh.fetchImpl });
    expect(got.status === 'ok' && got.icons.map(i => i.path)).toEqual(['frontend/public/favicon.png']);
  });

  it("lists the root and the directories it has, follows a manifest, and answers what passes, best first, read with the owner's token", async () => {
    const big = Buffer.alloc(ICON_MAX_BYTES + 1);
    const gh = fakeGithub({
      '': [{ name: 'public', type: 'dir' }, { name: 'src', type: 'dir' }, { name: 'logo-wide.svg', type: 'file', size: 100 }, { name: 'favicon.ico', type: 'file', size: 10 }, { name: 'README.md', type: 'file', size: 9 }],
      public: [{ name: 'favicon.png', type: 'file', size: 40 }, { name: 'favicon.svg', type: 'file', size: 120 }, { name: 'manifest.json', type: 'file', size: 60 }, { name: 'icon-huge.png', type: 'file', size: ICON_MAX_BYTES + 1 }],
      src: [{ name: 'assets', type: 'dir' }],
      'src/assets': [],
    }, {
      'logo-wide.svg': svg('0 0 300 60'),
      'favicon.ico': ico,
      'public/favicon.png': png(32),
      'public/favicon.svg': svg(),
      'public/manifest.json': JSON.stringify({ icons: [{ src: 'icons/icon-512.png' }] }),
      'public/icons/icon-512.png': png(512),
      'public/icon-huge.png': big,
    });
    const got = await detectRepoIcons('o/r', 'gho_token', { fetch: gh.fetchImpl, apiBase: 'https://gh.test' });
    expect(got.status).toBe('ok');
    if (got.status !== 'ok') return;
    // public/favicon.svg is fetched but not taken until step 6; the wide logo isn't either.
    expect(got.icons.map(i => i.path)).toEqual(['public/icons/icon-512.png', 'public/favicon.png', 'favicon.ico']);
    // Only the directories the root has (and src/assets under src), never public/icon-huge.png (over the limit by its listed size).
    const paths = gh.calls.map(c => c.url.replace('https://gh.test/repos/o/r/contents', ''));
    expect(paths).toContain('/src/assets');
    expect(paths).not.toContain('/static');
    expect(paths).not.toContain('/public/icon-huge.png');
    // Not fetched at all until step 6 takes SVGs: the request budget is for what can be the icon.
    expect(paths.some(p => p.endsWith('.svg'))).toBe(false);
    expect(gh.calls.every(c => c.auth === 'Bearer gho_token' && c.redirect === 'manual')).toBe(true);
    expect(gh.calls.filter(c => c.url.endsWith('.svg') || c.url.endsWith('.png')).every(c => c.accept === 'application/vnd.github.raw')).toBe(true);
  });

  it(`stops at ${ICON_MAX_IMAGES} images`, async () => {
    const names = Array.from({ length: 12 }, (_, i) => `favicon-${i}.png`);
    const gh = fakeGithub({ '': names.map(name => ({ name, type: 'file' as const, size: 40 })) }, Object.fromEntries(names.map((n, i) => [n, png(32 + i)])));
    const got = await detectRepoIcons('o/r', 't', { fetch: gh.fetchImpl });
    expect(got.status === 'ok' && got.icons.length).toBe(ICON_MAX_IMAGES);
    expect(gh.calls.length).toBe(1 + ICON_MAX_IMAGES);
  });

  it('skips a file whose body runs past the limit, whatever its listing said', async () => {
    const gh = fakeGithub({ '': [{ name: 'favicon.png', type: 'file', size: 40 }] }, { 'favicon.png': Buffer.concat([png(32), Buffer.alloc(ICON_MAX_BYTES)]) });
    const got = await detectRepoIcons('o/r', 't', { fetch: gh.fetchImpl });
    expect(got).toEqual({ status: 'ok', icons: [] });
  });

  it('is no-access on a 403, a retryable error on a 500, a rate limit or a timeout', async () => {
    expect(await detectRepoIcons('o/r', 't', { fetch: fakeGithub({}, {}, { status: 403 }).fetchImpl })).toEqual({ status: 'no-access' });
    expect((await detectRepoIcons('o/r', 't', { fetch: fakeGithub({}, {}, { status: 500 }).fetchImpl })).status).toBe('error');
    expect((await detectRepoIcons('o/r', 't', { fetch: fakeGithub({}, {}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }).fetchImpl })).status).toBe('error');
    const hang = ((_: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as typeof fetch;
    expect(await detectRepoIcons('o/r', 't', { fetch: hang, requestMs: 20 })).toEqual({ status: 'error', why: 'timed out' });
  });

  it('times out a body that stalls after its headers, as it does a request that never answers', async () => {
    const stall = ((_: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('['));
          init?.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const t = Date.now();
    expect(await detectRepoIcons('o/r', 't', { fetch: stall, requestMs: 30 })).toEqual({ status: 'error', why: 'timed out' });
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('answers no icons for a repository it cannot find, and refuses a bad key without a request', async () => {
    const gh = fakeGithub({}, {});
    expect(await detectRepoIcons('o/r', 't', { fetch: gh.fetchImpl })).toEqual({ status: 'ok', icons: [] });
    expect(await detectRepoIcons('../etc', 't', { fetch: gh.fetchImpl })).toEqual({ status: 'no-access' });
    expect(gh.calls.length).toBe(1);
  });
});
