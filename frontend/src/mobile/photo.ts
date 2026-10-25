// Photo attach: a camera-roll image becomes the PNG the
// box's clipboard mailbox takes (the desktop's image paste path). Phone
// photos are 12+ MP; scale the long edge down so the PNG stays well under the
// route's 20 MiB and Claude gets a sensible image, not a 40 MB one.

export const MAX_EDGE_PX = 2048;
export const MAX_PNG_BYTES = 20 * 1024 * 1024;

/** The size to draw a w×h image at so its long edge is at most `max`. Never upscales. */
export function fitWithin(w: number, h: number, max: number = MAX_EDGE_PX): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode the image'))), 'image/png');
  });
}

/** Decode, scale (honouring EXIF orientation), and re-encode as PNG; smaller again if still too big. */
export async function photoToPng(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    let max = MAX_EDGE_PX;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d canvas context');
      ctx.drawImage(bitmap, 0, 0, width, height);
      const png = await canvasToPng(canvas);
      if (png.size <= MAX_PNG_BYTES) return png;
      max = Math.round(max * 0.7);
    }
    throw new Error('the image is too large');
  } finally {
    bitmap.close();
  }
}
