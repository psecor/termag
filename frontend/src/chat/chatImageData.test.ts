import { describe, expect, it } from 'vitest';
import { admitImages, base64Bytes, createImageCache, dragHasFiles, imageFilesOf, isChatImageType, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES, scaledSize, storedImageUrl } from './chatImageData';

const file = (type: string, name = 'f') => ({ type, name }) as File;

describe('chat image helpers', () => {
  it('takes the four types the Messages API reads, never SVG', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(isChatImageType(t)).toBe(true);
    expect(isChatImageType('image/svg+xml')).toBe(false);
    expect(isChatImageType('image/heic')).toBe(false);
  });

  it('keeps the cap inside the Messages API limit of 5 MB of base64', () => {
    expect(Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('finds the images among dropped files, and knows a file drag', () => {
    const list = Object.assign([file('image/png'), file('text/plain'), file('image/heic')], { length: 3 });
    expect(imageFilesOf(list).map(f => f.type)).toEqual(['image/png', 'image/heic']);
    expect(imageFilesOf(null)).toEqual([]);
    expect(dragHasFiles(['text/plain', 'Files'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
  });

  it('admits supported images up to the per-message limit, saying what it left out', () => {
    expect(admitImages(0, [file('image/png')])).toEqual({ take: [file('image/png')], note: null });
    const r = admitImages(MAX_CHAT_IMAGES - 1, [file('image/png', 'a'), file('image/heic', 'b'), file('image/jpeg', 'c')]);
    expect(r.take.map(f => f.name)).toEqual(['a']);
    expect(r.note).toMatch(/PNG, JPEG, GIF and WebP/);
    expect(r.note).toMatch(/At most 4 images/);
    expect(admitImages(MAX_CHAT_IMAGES, [file('image/png')]).take).toEqual([]);
  });

  it('scales the long edge down to the limit, keeping the shape', () => {
    expect(scaledSize(1000, 500)).toEqual({ width: 1000, height: 500 });
    expect(scaledSize(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(scaledSize(1000, 8000)).toEqual({ width: 250, height: 2000 });
    expect(scaledSize(10000, 1)).toEqual({ width: 2000, height: 1 });
  });

  it('counts base64 bytes from the length', () => {
    expect(base64Bytes(btoa('abc'))).toBe(3);
    expect(base64Bytes(btoa('ab'))).toBe(2);
    expect(base64Bytes(btoa('a'))).toBe(1);
  });

  it('reads a stored image through the project image route', () => {
    expect(storedImageUrl('p 1', 'main', '~/.termag/chat-images/k/a.png'))
      .toBe('/termag/api/projects/p%201/image?workstream=main&path=%7E%2F.termag%2Fchat-images%2Fk%2Fa.png');
  });
});

describe('stored image cache', () => {
  const setup = (max = 2) => {
    const revoked: string[] = [];
    const loads: string[] = [];
    const cache = createImageCache(async url => {
      loads.push(url);
      return url.startsWith('bad') ? { kind: 'error', message: 'HTTP 404' } : { kind: 'image', url: `blob:${url}` };
    }, u => revoked.push(u), max);
    return { cache, revoked, loads };
  };
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('reads each image once while it stays cached', async () => {
    const { cache, loads } = setup();
    cache.hold('a').release();
    cache.hold('a').release();
    await settle();
    expect(loads).toEqual(['a']);
  });

  it('keeps a shown image\'s URL past eviction, and revokes it when its last thumbnail goes', async () => {
    const { cache, revoked } = setup(2);
    const a = cache.hold('a');
    const a2 = cache.hold('a');
    cache.hold('b').release();
    cache.hold('c').release();
    await settle();
    expect(cache.size()).toBe(2);
    expect(revoked).toEqual([]);
    expect(await a.loaded).toEqual({ kind: 'image', url: 'blob:a' });
    a.release();
    a.release();
    await settle();
    expect(revoked).toEqual([]);
    a2.release();
    await settle();
    expect(revoked).toEqual(['blob:a']);
  });

  it('revokes an evicted image nobody shows', async () => {
    const { cache, revoked } = setup(1);
    cache.hold('a').release();
    cache.hold('b').release();
    await settle();
    expect(revoked).toEqual(['blob:a']);
  });

  it('drops a failed read, so the next thumbnail tries again', async () => {
    const { cache, loads } = setup();
    const h = cache.hold('bad');
    expect(await h.loaded).toEqual({ kind: 'error', message: 'HTTP 404' });
    h.release();
    await settle();
    cache.hold('bad').release();
    expect(loads).toEqual(['bad', 'bad']);
  });
});
