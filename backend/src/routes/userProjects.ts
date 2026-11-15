/**
 * GET /api/user-projects and /:id ("Read
 * API"): the caller's projects, each with its repositories and its checkouts
 * on their boxes. POST /api/user-projects
 * (+ New project): make one, with no checkout yet. Behind user-projects-enabled:
 * off, each answers 404 `{ code: 'user_projects_disabled' }`. On, the caller's
 * checkouts without a project get one first (ensureUserProjects), as GET
 * /api/projects does, so a new project's name is checked against theirs too.
 * POST /api/user-projects/:id/repos adds one repository to a project.
 * Owner only, with the same sign-ins as GET and POST /api/projects.
 *
 * PATCH /api/user-projects/:id and GET /:id/archive-plan:
 * rename, archive and
 * unarchive, and (milestone 8) `filesSpace`, in routes/userProjectWrites.ts.
 * Owner only, signed in.
 *
 * POST /api/user-projects/:id/files:
 * the project's Project files, made now if it has none, as its Files tab
 * opens; answers the project's view, whose `filesSpace` names it. Behind
 * project-files-enabled too (else 404 project_files_disabled).
 *
 * Project icons: GET /icons/:id, POST
 * /icons, GET /:id/icons and PUT /:id/icon, in routes/userProjectIcons.ts.
 */
import { Router, type RequestHandler } from 'express';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { MULTI_REPO_MAX } from '../services/projectRepos';
import { multiRepoEnabled } from '../services/multiRepoFlag';
import { addUserProjectRepo, createPersonUserProject, ensureUserProjects, planNewUserProject, userProjectsEnabled } from '../services/userProjects';
import { notifyWorkspaceChange } from '../services/workspaceEvents';
import { listUserProjectViews, userProjectViewFor } from '../services/userProjectViews';
import { archivePlanFor, patchUserProjectFor } from './userProjectWrites';
import { mountProjectIconRoutes } from './userProjectIcons';
import { refreshDueIconsInBackground } from '../services/projectIconRefresh';
import { ensureProjectFiles, projectFilesEnabled } from '../services/projectFiles';
import { sendResult } from './routeResult';

export const USER_PROJECTS_DISABLED = 'user_projects_disabled';

async function ready(user: Express.User): Promise<boolean> {
  if (!await userProjectsEnabled(user)) return false;
  const backfill = await ensureUserProjects(user.id).catch(err => { console.warn(`[USER-PROJECTS] ${user.id}: backfill on read failed: ${(err as Error).message}`); return null; });
  // Its raw-SQL attach pushes nothing of itself: the person's other tabs re-read their project list.
  if (backfill && backfill.attached > 0) notifyWorkspaceChange(user.id, 'projects');
  return true;
}

export function userProjectsRouter(): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    try {
      if (!await ready(req.user!)) { res.status(404).json({ error: 'Projects are not on for you', code: USER_PROJECTS_DISABLED }); return; }
      res.json({ projects: await listUserProjectViews(req.user!.id) });
      // Their repositories' icons, looked for again when due; a change pushes `projects`.
      void refreshDueIconsInBackground(req.user!.id);
    } catch (err) {
      console.warn(`[USER-PROJECTS] list: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  };

  const one: RequestHandler = async (req, res) => {
    try {
      if (!await ready(req.user!)) { res.status(404).json({ error: 'Projects are not on for you', code: USER_PROJECTS_DISABLED }); return; }
      const view = await userProjectViewFor(req.user!.id, String(req.params.id));
      if (!view) { res.status(404).json({ error: 'No such project', code: 'user_project_not_found' }); return; }
      res.json(view);
    } catch (err) {
      console.warn(`[USER-PROJECTS] ${req.params.id}: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to read the project' });
    }
  };

  const create: RequestHandler = async (req, res) => {
    try {
      if (!await userProjectsEnabled(req.user!)) { res.status(404).json({ error: 'Projects are not on for you', code: USER_PROJECTS_DISABLED }); return; }
      // Unlike a read, a create waits for the backfill: a name it takes first would send a checkout's project to "termag 2".
      try {
        await ensureUserProjects(req.user!.id);
      } catch (err) {
        console.warn(`[USER-PROJECTS] ${req.user!.id}: backfill before create failed: ${(err as Error).message}`);
        res.status(503).json({ error: 'Could not read your projects; try again', code: 'user_projects_unavailable' });
        return;
      }
      const plan = planNewUserProject(req.body, await multiRepoEnabled(req.user!) ? MULTI_REPO_MAX : 1);
      if (!plan.ok) {
        const { ok: _ok, ...why } = plan;
        res.status(400).json({ ...why, code: 'user_project_invalid' });
        return;
      }
      const made = await createPersonUserProject(req.user!.id, plan.project);
      if (!made.ok) {
        const { id, name, archived } = made.taken;
        res.status(409).json({ error: `You already have a project called ${name}`, code: 'user_project_name_taken', field: 'name', projectId: id, archived });
        return;
      }
      const view = await userProjectViewFor(req.user!.id, made.id);
      if (!view) throw new Error(`project ${made.id} vanished after its create`);
      // The sidebar lists a project with no session yet (Unify UX 7): it reads them again.
      notifyWorkspaceChange(req.user!.id, 'projects');
      // Its repositories' icons now: New project's picker just looked, so this is usually that look, reused.
      void refreshDueIconsInBackground(req.user!.id, {}, { force: true });
      res.status(201).json(view);
    } catch (err) {
      console.warn(`[USER-PROJECTS] create: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to make the project' });
    }
  };

  const patch: RequestHandler = async (req, res) => {
    try {
      if (!await ready(req.user!)) { res.status(404).json({ error: 'Projects are not on for you', code: USER_PROJECTS_DISABLED }); return; }
      sendResult(res, await patchUserProjectFor(req.user!, String(req.params.id), req.body));
    } catch (err) {
      console.warn(`[USER-PROJECTS] patch ${req.params.id}: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to change the project' });
    }
  };

  const archivePlan: RequestHandler = async (req, res) => {
    try {
      if (!await ready(req.user!)) { res.status(404).json({ error: 'Projects are not on for you', code: USER_PROJECTS_DISABLED }); return; }
      sendResult(res, await archivePlanFor(req.user!, String(req.params.id)));
    } catch (err) {
      console.warn(`[USER-PROJECTS] archive plan ${req.params.id}: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to read what archiving would do' });
    }
  };

  // POST /api/user-projects/:id/repos.
  const addRepo: RequestHandler = async (req, res) => {
    try {
      if (!await userProjectsEnabled(req.user!)) { res.status(404).json({ error: 'Projects are not on for you', code: USER_PROJECTS_DISABLED }); return; }
      const id = String(req.params.id);
      const added = await addUserProjectRepo(req.user!.id, id, req.body, await multiRepoEnabled(req.user!) ? MULTI_REPO_MAX : 1);
      if (!added.ok) { res.status(added.status).json({ error: added.error, code: added.code }); return; }
      const view = await userProjectViewFor(req.user!.id, id);
      if (!view) throw new Error(`project ${id} vanished after a repository was added`);
      notifyWorkspaceChange(req.user!.id, 'projects');
      void refreshDueIconsInBackground(req.user!.id, {}, { force: true });
      res.json(view);
    } catch (err) {
      console.warn(`[USER-PROJECTS] ${req.params.id}: add repository: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to add the repository' });
    }
  };

  // POST /api/user-projects/:id/files: Project files for a project that has none yet, made as its Files open.
  const files: RequestHandler = async (req, res) => {
    try {
      if (!await ready(req.user!)) { res.status(404).json({ error: 'Projects are not on for you', code: USER_PROJECTS_DISABLED }); return; }
      if (!await projectFilesEnabled(req.user!)) { res.status(404).json({ error: 'Project files are not on for you', code: 'project_files_disabled' }); return; }
      const id = String(req.params.id);
      const space = await ensureProjectFiles(id, req.user!.id);
      if (!space) { res.status(404).json({ error: 'No such project', code: 'user_project_not_found' }); return; }
      const view = await userProjectViewFor(req.user!.id, id);
      if (!view) { res.status(404).json({ error: 'No such project', code: 'user_project_not_found' }); return; }
      notifyWorkspaceChange(req.user!.id, 'projects');
      res.json(view);
    } catch (err) {
      console.warn(`[USER-PROJECTS] ${req.params.id}: Project files: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to set up Project files' });
    }
  };

  // Project icons: their images, an upload, a project's picker and its choice.
  mountProjectIconRoutes(router);
  router.get('/', requireAuthOrAgentToken, list);
  router.post('/', requireAuth, create);
  router.post('/:id/repos', requireAuth, addRepo);
  router.post('/:id/files', requireAuth, files);
  router.get('/:id', requireAuthOrAgentToken, one);
  router.get('/:id/archive-plan', requireAuth, archivePlan);
  router.patch('/:id', requireAuth, patch);
  return router;
}
