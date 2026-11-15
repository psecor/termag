import { describe, expect, it } from 'vitest';
import { checkIcon, iconChoiceOf, ICON_MAX_BYTES, planIconChoice, pngSize, sniffIcon } from './projectIcons';

const png = (w = 32, h = 32) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const svg = (body: string, attrs = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"${attrs}>${body}</svg>`);

describe('sniffIcon', () => {
  it('reads the type from the bytes', () => {
    expect(sniffIcon(png())).toBe('image/png');
    expect(sniffIcon(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe('image/x-icon');
    expect(sniffIcon(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffIcon(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('is null for anything else, whatever it is called, an SVG included (a later step)', () => {
    expect(sniffIcon(svg('<path d="M0 0h16v16H0z"/>'))).toBeNull();
    expect(sniffIcon(Buffer.from([0, 0, 1, 0, 0, 0]))).toBeNull(); // an ICO with no images
    expect(sniffIcon(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffIcon(Buffer.alloc(0))).toBeNull();
  });
});

describe('pngSize', () => {
  it('reads the header', () => {
    expect(pngSize(png(180, 180))).toEqual({ width: 180, height: 180 });
    expect(pngSize(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('checkIcon', () => {
  it('stores a PNG with its type and hash', () => {
    const got = checkIcon(png());
    expect(got.ok && got.mimeType).toBe('image/png');
    expect(got.ok && got.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses one too big, empty, not an image, or an SVG', () => {
    expect(checkIcon(Buffer.concat([png(), Buffer.alloc(ICON_MAX_BYTES)]))).toEqual({ ok: false, error: 'Keep the image to 32 KB' });
    expect(checkIcon(Buffer.alloc(0)).ok).toBe(false);
    expect(checkIcon(Buffer.from('hello')).ok).toBe(false);
    expect(checkIcon(svg('<path d="M0 0h16v16H0z"/>'))).toEqual({ ok: false, error: 'That is not a PNG, ICO, GIF, JPEG or WebP image' });
  });
});

describe('the choice', () => {
  it('reads null, letter and image, and an image that is gone as automatic', () => {
    expect(iconChoiceOf({ iconChoice: null, iconId: null })).toEqual({ choice: 'auto', imageId: null });
    expect(iconChoiceOf({ iconChoice: 'letter', iconId: null })).toEqual({ choice: 'letter', imageId: null });
    expect(iconChoiceOf({ iconChoice: 'image', iconId: 'i1' })).toEqual({ choice: 'image', imageId: 'i1' });
    expect(iconChoiceOf({ iconChoice: 'image', iconId: null })).toEqual({ choice: 'auto', imageId: null });
    expect(iconChoiceOf({ iconChoice: 'something new', iconId: 'i1' })).toEqual({ choice: 'auto', imageId: null });
  });

  it('plans a PUT body', () => {
    expect(planIconChoice({ choice: 'auto' })).toEqual({ ok: true, iconChoice: null, iconId: null });
    expect(planIconChoice({ choice: 'letter', iconId: 'ignored' })).toEqual({ ok: true, iconChoice: 'letter', iconId: null });
    expect(planIconChoice({ choice: 'image', iconId: ' i1 ' })).toEqual({ ok: true, iconChoice: 'image', iconId: 'i1' });
    expect(planIconChoice({ choice: 'image' }).ok).toBe(false);
    expect(planIconChoice({ choice: 'favicon' }).ok).toBe(false);
    expect(planIconChoice(null).ok).toBe(false);
  });
});
