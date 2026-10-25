/**
 * Direct browser links to space files:
 * `<origin><BASE_PATH>/files/<space>/<path>`, answered by routes/spaceFiles.ts
 * with a 302 to a presigned GET.
 *
 * The prefix is `/files`, not `/assets`: under BASE_PATH `/assets/` is Vite's
 * build directory (spaStatic serves it and 404s a missing chunk), and outside
 * BASE_PATH the browser never sends the `/termag`-scoped session cookie and
 * the nginx gateway hands the path to hosted apps.
 *
 * Pure: no S3, no Prisma.
 */
import { SPACE_NAME_RE, downloadResponseHeaders, extensionOf } from './spacePaths';

export const FILE_LINK_PREFIX = '/files';

/** `<basePath>/files/<space>/<path>`, every segment percent-encoded; `path` must already be normalized. */
export function spaceFileLinkPath(basePath: string, space: string, path: string): string {
  return `${basePath}${FILE_LINK_PREFIX}/${encodeURIComponent(space)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The space and raw file path a link names, from the request path below the
 * `/files` mount (`/<space>/<path...>`, still percent-encoded). Null for
 * anything that can't be one; the caller still runs the path through
 * normalizeFilePath.
 */
export function parseSpaceFileLink(rawPath: string): { space: string; path: string } | null {
  if (!rawPath.startsWith('/')) return null;
  const segments = rawPath.slice(1).split('/');
  if (segments.length < 2) return null;
  let decoded: string[];
  try { decoded = segments.map(decodeURIComponent); } catch { return null; }
  const [space, ...rest] = decoded;
  if (!SPACE_NAME_RE.test(space)) return null;
  const path = rest.join('/');
  return path ? { space, path } : null;
}

/**
 * What a link's presigned GET is signed with. Inline, with a content type
 * chosen from the extension, only where downloadResponseHeaders allows it
 * (images, PDF, video, audio, and text-like files such as Markdown, JSON and
 * logs, served as text/plain). Media is a redirect to S3, which answers the
 * player's Range requests itself, so seeking works. Everything else, HTML
 * and SVG included, is an
 * attachment typed application/octet-stream, so the uploader's stored
 * Content-Type never reaches the browser and nothing renders, let alone runs
 * script, on the bucket's origin.
 */
export function fileLinkResponseHeaders(path: string): { contentDisposition: string; contentType: string } {
  const headers = downloadResponseHeaders(path, true);
  return { contentDisposition: headers.contentDisposition, contentType: headers.contentType ?? 'application/octet-stream' };
}

/**
 * HTML a link renders as a page (behind spaces-html-links-enabled). S3 can't
 * attach a CSP to a presigned GET, so the orchestrator reads the file and
 * answers it itself, sandboxed: the page gets an opaque origin, so it can't
 * read the session cookie or call the API as the viewer, runs no script,
 * submits no form, loads nothing from the network (only inline styles and
 * data: images and fonts) and can't be framed. Larger files stay attachments.
 */
export const HTML_LINK_MAX_BYTES = 10 * 1024 * 1024;

export function isHtmlLink(path: string): boolean {
  const ext = extensionOf(path);
  return ext === 'html' || ext === 'htm';
}

export const HTML_LINK_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
