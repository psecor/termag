import { describe, expect, it } from 'vitest';
import {
  CHAT_IMAGES_CAPABILITY, CHAT_PDFS_CAPABILITY, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES,
  chatImageInput, chatImagesRefusal, chatPdfInput, checkChatImages, pdfCount, sniffAttachmentType,
} from './chatImages';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const PDF = Buffer.from('%PDF-1.7\n%body', 'latin1');

describe('sniffAttachmentType', () => {
  it('knows the four image types and PDF by their bytes, and nothing else', () => {
    expect(sniffAttachmentType(PNG)).toBe('image/png');
    expect(sniffAttachmentType(JPEG)).toBe('image/jpeg');
    expect(sniffAttachmentType(GIF)).toBe('image/gif');
    expect(sniffAttachmentType(WEBP)).toBe('image/webp');
    expect(sniffAttachmentType(PDF)).toBe('application/pdf');
    expect(sniffAttachmentType(SVG)).toBeNull();
    expect(sniffAttachmentType(Buffer.alloc(0))).toBeNull();
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

  it('takes a PDF by its bytes, keeping its file name', () => {
    const r = checkChatImages([{ mediaType: 'image/png', data: PDF.toString('base64'), name: ' report\n.pdf ' }, { data: PNG.toString('base64'), name: 'x.png' }]);
    expect(r).toEqual({ ok: true, images: [
      { mediaType: 'application/pdf', data: PDF.toString('base64'), name: 'report.pdf' },
      { mediaType: 'image/png', data: PNG.toString('base64') },
    ] });
    if (r.ok) expect(pdfCount(r.images)).toBe(1);
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
  it('refuses images without the runner capability', () => {
    expect(chatImagesRefusal(0, [])).toBeNull();
    expect(chatImagesRefusal(1, [])).toMatchObject({ status: 409, code: 'images-unsupported' });
    expect(chatImagesRefusal(2, [CHAT_IMAGES_CAPABILITY])).toBeNull();
  });

  it('refuses PDFs on a runner without chat-pdfs-v1, and offers them only on one', () => {
    expect(chatImagesRefusal(1, [CHAT_IMAGES_CAPABILITY], 1)).toMatchObject({ status: 409, code: 'pdfs-unsupported' });
    expect(chatImagesRefusal(1, [CHAT_IMAGES_CAPABILITY, CHAT_PDFS_CAPABILITY], 1)).toBeNull();
    expect(chatPdfInput(true, [CHAT_IMAGES_CAPABILITY, CHAT_PDFS_CAPABILITY])).toBe(true);
    expect(chatPdfInput(true, [CHAT_IMAGES_CAPABILITY])).toBe(false);
    expect(chatPdfInput(false, [CHAT_IMAGES_CAPABILITY, CHAT_PDFS_CAPABILITY])).toBe(false);
  });

  it("refuses PDFs, and does not offer them, in a chat on another model backend", () => {
    const caps = [CHAT_IMAGES_CAPABILITY, CHAT_PDFS_CAPABILITY];
    expect(chatImagesRefusal(1, caps, 1, 'fireworks')).toMatchObject({ status: 409, code: 'pdfs-unsupported' });
    expect(chatImagesRefusal(1, caps, 0, 'fireworks')).toBeNull();
    expect(chatPdfInput(true, caps, 'fireworks')).toBe(false);
    expect(chatPdfInput(true, caps, null)).toBe(true);
  });

  it('offers the composer images only on a runner that takes them', () => {
    expect(chatImageInput([CHAT_IMAGES_CAPABILITY])).toBe(true);
    expect(chatImageInput([])).toBe(false);
  });
});
