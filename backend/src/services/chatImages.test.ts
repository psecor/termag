import { describe, expect, it } from 'vitest';
import {
  CHAT_IMAGES_CAPABILITY, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES,
  chatImageInput, chatImagesRefusal, checkChatImages, sniffImageType,
} from './chatImages';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

describe('sniffImageType', () => {
  it('knows the four types by their bytes, and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('checkChatImages', () => {
  it('takes no images as none', () => {
    expect(checkChatImages(undefined)).toEqual({ ok: true, images: [] });
    expect(checkChatImages(null)).toEqual({ ok: true, images: [] });
    expect(checkChatImages([])).toEqual({ ok: true, images: [] });
  });

  it('replaces the declared type with the sniffed one', () => {
    const r = checkChatImages([{ mediaType: 'image/gif', data: PNG.toString('base64') }, { data: JPEG.toString('base64') }]);
    expect(r).toEqual({ ok: true, images: [
      { mediaType: 'image/png', data: PNG.toString('base64') },
      { mediaType: 'image/jpeg', data: JPEG.toString('base64') },
    ] });
  });

  it('refuses what is not a list of base64 images', () => {
    expect(checkChatImages('x')).toMatchObject({ ok: false, status: 400, code: 'bad-image' });
    expect(checkChatImages([{ data: 'not base64!' }])).toMatchObject({ ok: false, status: 400, code: 'bad-image' });
    expect(checkChatImages([{ data: 'data:image/png;base64,' + PNG.toString('base64') }])).toMatchObject({ ok: false, code: 'bad-image' });
    expect(checkChatImages([{}])).toMatchObject({ ok: false, code: 'bad-image' });
    expect(checkChatImages([{ data: SVG.toString('base64') }])).toMatchObject({ ok: false, status: 415, code: 'bad-image-type' });
  });

  it('refuses too many and too large', () => {
    const one = { data: PNG.toString('base64') };
    expect(checkChatImages(Array(MAX_CHAT_IMAGES).fill(one)).ok).toBe(true);
    expect(checkChatImages(Array(MAX_CHAT_IMAGES + 1).fill(one))).toMatchObject({ ok: false, status: 400, code: 'too-many-images' });
    const atCap = Buffer.concat([PNG, Buffer.alloc(MAX_CHAT_IMAGE_BYTES - PNG.length)]);
    expect(checkChatImages([{ data: atCap.toString('base64') }]).ok).toBe(true);
    const over = Buffer.concat([PNG, Buffer.alloc(MAX_CHAT_IMAGE_BYTES - PNG.length + 1)]);
    expect(checkChatImages([{ data: over.toString('base64') }])).toMatchObject({ ok: false, status: 413, code: 'image-too-large' });
  });

  it('keeps the cap inside the Messages API limit of 5 MB of base64', () => {
    expect(Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});

describe('chatImagesRefusal', () => {
  it('refuses images without the flag or the runner capability', () => {
    expect(chatImagesRefusal(0, false, [])).toBeNull();
    expect(chatImagesRefusal(1, false, [CHAT_IMAGES_CAPABILITY])).toMatchObject({ status: 403, code: 'images-disabled' });
    expect(chatImagesRefusal(1, true, [])).toMatchObject({ status: 409, code: 'images-unsupported' });
    expect(chatImagesRefusal(2, true, [CHAT_IMAGES_CAPABILITY])).toBeNull();
  });

  it('offers the composer images only with both', () => {
    expect(chatImageInput(true, [CHAT_IMAGES_CAPABILITY])).toBe(true);
    expect(chatImageInput(false, [CHAT_IMAGES_CAPABILITY])).toBe(false);
    expect(chatImageInput(true, [])).toBe(false);
  });
});
