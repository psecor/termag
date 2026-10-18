import express, { Router } from 'express';
import { join } from 'path';

/**
 * True for a request path (relative to the SPA's mount) that names a build
 * file rather than an app route: anything under `/assets/` (Vite's hashed
 * chunks) or ending in `.map`. A missing one of these must 404, never fall
 * through to index.html: the browser telemetry fetches
 * `assets/<chunk>.js.map` to symbolicate errors, and an HTML 200 there failed
 * every stack trace with "invalid character '<'".
 */
export function isBuildFilePath(path: string): boolean {
  return path.startsWith('/assets/') || path.endsWith('.map');
}

/**
 * The built frontend: static files from `dist`, a plain 404 for a missing
 * build file, and index.html for every other GET (the SPA's client routes).
 */
export function spaStatic(dist: string): Router {
  const router = Router();
  router.use(express.static(dist));
  router.get('*', (req, res) => {
    if (isBuildFilePath(req.path)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.sendFile(join(dist, 'index.html'));
  });
  return router;
}
