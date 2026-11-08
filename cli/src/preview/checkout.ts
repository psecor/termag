import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { Api, type Project, type WhoamiResponse } from '../api.js';
import type { Session } from '../commands.js';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { listProjects } from '../lifecycle.js';

/**
 * `termag preview publish <port>` in a workstream's checkout on its box
 * (PRD P6): which box, project and workstream the working directory is. A
 * box's checkouts are `~/termag/projects/<project>` (main) and
 * `~/termag/projects/<project>/.worktrees/<workstream>`, as the orchestrator
 * lays them out (backend services/projectPaths.ts); anywhere inside one counts.
 */

/** The project and workstream a directory is in, under `home`; null when it is in no checkout. */
export function checkoutOf(dir: string, home: string): { project: string; workstream: string } | null {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  // Symlinked homes and checkouts (project-dir-symlinks): compare resolved paths, and the paths as given.
  for (const [d, h] of [[real(dir), real(home)], [dir, home]]) {
    const rel = relative(`${h}/termag/projects`, d);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const [project, sub, workstream] = rel.split('/');
    if (!project || project.startsWith('.')) continue;
    if (sub === '.worktrees') {
      if (!workstream) continue;
      return { project, workstream };
    }
    return { project, workstream: 'main' };
  }
  return null;
}

/**
 * Whether a preview link may name this workstream. `main` always may: the
 * orchestrator takes it as the project's main checkout when there is no
 * `main` row (services/previewLinks.ts findWorkstream), while the project
 * list shows `main` only for a project with no workstream rows at all.
 */
export function hasWorkstream(project: Pick<Project, 'workstreams'>, workstream: string): boolean {
  return workstream === 'main' || project.workstreams.includes(workstream);
}

const NOT_A_CHECKOUT = "This isn't a termag checkout: run it in a workstream's checkout on its box (~/termag/projects/<project>), or name the project: termag preview publish <box>/<project>[@<workstream>] <port>";

/** The project and workstream of the working directory, on the box this runs on. Throws a usage-shaped error elsewhere. */
export async function projectOfCwd(ctx: Ctx, s: Session, api: Api): Promise<{ project: Project; workstream: string }> {
  const at = checkoutOf((ctx.cwd ?? (() => process.cwd()))(), ctx.home);
  const box = s.target.box;
  if (!at || !box) throw new CliError('usage', NOT_A_CHECKOUT);
  // Which box this is: its own credential says, whoever is signed in.
  const who = await new Api({ host: s.target.host, token: box.token, fetch: ctx.fetch }).request<WhoamiResponse>('GET', '/whoami');
  const boxId = who.credential.kind === 'box' ? who.credential.boxId : null;
  if (!boxId) throw new CliError('usage', NOT_A_CHECKOUT);
  const project = (await listProjects(api)).find(p => p.box?.id === boxId && p.name === at.project);
  if (!project) throw new CliError('not_found', `No project "${at.project}" on this box. Run \`termag project list\`.`);
  if (!hasWorkstream(project, at.workstream)) {
    throw new CliError('not_found', `No workstream "${at.workstream}" in ${project.ref} (it has ${project.workstreams.join(', ')})`);
  }
  return { project, workstream: at.workstream };
}
