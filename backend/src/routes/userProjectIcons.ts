/**
 * Project icons' routes, mounted on
 * /api/user-projects by routes/userProjects.ts, behind user-projects-enabled
 * (off: 404 user_projects_disabled). Signed-in browsers only, owner only. No
 * route serves an image: each travels inline, a data: URI in the view naming it.
 *
 *   POST /icons       an upload: the image as the body, sent as image/png, JPEG, GIF or WebP (rasters only), at
 *                     most 32 KiB → { id }
 *   GET  /:id/icons   what the project's picker offers: each repository's candidates, and what it shows now;
 *                     first looks for its repositories' icons when they're due, waiting up to 10 s
 *   GET  /icon-candidates?repos=owner/a,owner/b   New project's picker, before the project exists: the same
 *                     look, then each repository's candidates
 *   PUT  /:id/icon    what the project shows: { choice: 'auto' | 'letter' } or { choice: 'image', iconId }
 */
import express, { type RequestHandler, type Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ICON_MAX_BYTES, planIconChoice } from '../services/projectIcons';
import { projectIconsFor, projectRepoKeys, PROJECT_NOT_FOUND, repoIcons, saveUpload, setProjectIcon, storedRepoIcons } from '../services/projectIconStore';
import { lastBestIcon, refreshForPicker } from '../services/projectIconRefresh';
import { isRepoKey } from '../services/projectIconDetect';
import { userProjectsEnabled } from '../services/userProjects';
import { notifyWorkspaceChange } from '../services/workspaceEvents';

const DISABLED = { error: 'Projects are not on for you', code: 'user_projects_disabled' } as const;

/**
 * The types an upload may be sent as: rasters only, and none a CORS-simple type, so another site's form can't
 * send one. The bytes are sniffed as well (saveUpload): an SVG sent as image/png is refused.
 */
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The most repositories New project's picker asks about at once: what a project holds. */
const CANDIDATE_REPOS_MAX = 8;

/** `?repos=owner/a,owner/b` as repo keys (owner/name, lowercased), or null when it isn't that. */
export function candidateRepoKeys(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const keys = [...new Set(raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean))];
  if (keys.length === 0 || keys.length > CANDIDATE_REPOS_MAX) return null;
  return keys.every(isRepoKey) ? keys : null;
}

export function mountProjectIconRoutes(router: Router): void {
  // Ahead of the body parser, so with the flag off an upload of any size answers as every other route does.
  const enabled: RequestHandler = async (req, res, next) => {
    try {
      if (!await userProjectsEnabled(req.user!)) { res.status(404).json(DISABLED); return; }
      next();
    } catch (err) {
      console.warn(`[PROJECT-ICONS] flag: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to store the icon' });
    }
  };

  const upload: RequestHandler = async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        res.status(415).json({ error: 'Send the image as the body, as image/png (or JPEG, GIF, WebP)', code: 'project_icon_invalid' });
        return;
      }
      const saved = await saveUpload(req.user!.id, req.body);
      if (!saved.ok) { res.status(400).json({ error: saved.error, code: 'project_icon_invalid' }); return; }
      res.status(201).json({ id: saved.id, mimeType: saved.mimeType });
    } catch (err) {
      console.warn(`[PROJECT-ICONS] upload: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to store the icon' });
    }
  };

  const candidates: RequestHandler = async (req, res) => {
    try {
      if (!await userProjectsEnabled(req.user!)) { res.status(404).json(DISABLED); return; }
      const keys = await projectRepoKeys(req.user!.id, String(req.params.id));
      if (!keys) { res.status(404).json(PROJECT_NOT_FOUND); return; }
      await refreshForPicker(req.user!.id, keys);
      const view = await projectIconsFor(req.user!.id, String(req.params.id));
      if (!view) { res.status(404).json(PROJECT_NOT_FOUND); return; }
      res.json(view);
    } catch (err) {
      console.warn(`[PROJECT-ICONS] ${req.params.id}: candidates: ${(err as Error).message}`);
      res.status(500).json({ error: "Failed to read the project's icons" });
    }
  };

  const forRepos: RequestHandler = async (req, res) => {
    try {
      if (!await userProjectsEnabled(req.user!)) { res.status(404).json(DISABLED); return; }
      const keys = candidateRepoKeys(req.query.repos);
      if (!keys) { res.status(400).json({ error: `repos is 1 to ${CANDIDATE_REPOS_MAX} owner/name, comma-separated`, code: 'project_icon_invalid' }); return; }
      const userId = req.user!.id;
      await refreshForPicker(userId, keys);
      // The best this process just found, else what the person's projects with the repository already show.
      const stored = await storedRepoIcons(userId, keys);
      res.json({ repos: await repoIcons(userId, keys.map(repoKey => ({ repoKey, iconId: lastBestIcon(userId, repoKey) ?? stored.get(repoKey) ?? null }))) });
    } catch (err) {
      console.warn(`[PROJECT-ICONS] candidates for repositories: ${(err as Error).message}`);
      res.status(500).json({ error: "Failed to read the repositories' icons" });
    }
  };

  const choose: RequestHandler = async (req, res) => {
    try {
      if (!await userProjectsEnabled(req.user!)) { res.status(404).json(DISABLED); return; }
      const plan = planIconChoice(req.body);
      if (!plan.ok) { res.status(400).json({ error: plan.error, code: 'project_icon_invalid' }); return; }
      const result = await setProjectIcon(req.user!.id, String(req.params.id), plan);
      if (result.status === 200) notifyWorkspaceChange(req.user!.id, 'projects');
      res.status(result.status).json(result.body);
    } catch (err) {
      console.warn(`[PROJECT-ICONS] ${req.params.id}: choose: ${(err as Error).message}`);
      res.status(500).json({ error: "Failed to change the project's icon" });
    }
  };

  // A little over the limit, so an image just over it gets checkIcon's sentence rather than a bare 413.
  router.post('/icons', requireAuth, enabled, express.raw({ type: UPLOAD_TYPES, limit: ICON_MAX_BYTES * 2 }), upload);
  router.get('/icon-candidates', requireAuth, forRepos);
  router.get('/:id/icons', requireAuth, candidates);
  router.put('/:id/icon', requireAuth, choose);
}
