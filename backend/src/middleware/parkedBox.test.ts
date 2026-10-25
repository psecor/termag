import { describe, expect, it, vi } from 'vitest';
import type { RequestHandler, Router } from 'express';

const projects = new Map<string, { userId: string; instance: { status: string } | null }>();
const lookup = async ({ where }: any) => {
  const p = projects.get(where.id);
  return p && (where.userId === undefined || where.userId === p.userId) ? p : null;
};
vi.mock('../db', () => ({ prisma: { project: { findUnique: lookup, findFirst: lookup } } }));

const { refuseParkedBox } = await import('./parkedBox');
const { projectsRouter } = await import('../routes/projects');
const { workstreamsRouter } = await import('../routes/workstreams');
const { claudeLoginRouter } = await import('../routes/claudeLogin');

async function run(handler: RequestHandler, params: Record<string, string>) {
  let status = 0; let body: any = null; let nexted = false;
  const res = { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } };
  await handler({ params, user: { id: 'u1' } } as any, res as any, () => { nexted = true; });
  return { status, body, nexted };
}

describe('refuseParkedBox', () => {
  // The agent of a stopping box stays connected until EC2 powers it off, so
  // the check must not depend on agent liveness.
  it('refuses a project on a stopping box', async () => {
    projects.set('p1', { userId: 'u1', instance: { status: 'stopping' } });
    expect(await run(refuseParkedBox('id'), { id: 'p1' })).toEqual({
      status: 409, body: { error: 'This box is stopping. Start it again once it has stopped.' }, nexted: false,
    });
  });

  it('refuses stopped and starting boxes too', async () => {
    for (const status of ['stopped', 'starting']) {
      projects.set('p1', { userId: 'u1', instance: { status } });
      expect((await run(refuseParkedBox('id'), { id: 'p1' })).status).toBe(409);
    }
  });

  it('lets a ready box, a box-less project and an unknown id through', async () => {
    projects.set('p1', { userId: 'u1', instance: { status: 'ready' } });
    projects.set('p2', { userId: 'u1', instance: null });
    for (const id of ['p1', 'p2', 'nope']) {
      expect((await run(refuseParkedBox('projectId'), { projectId: id })).nexted).toBe(true);
    }
  });


  // The routes it guards are owner-only and answer 404 for anyone else's
  // project, so the 409 must not tell another user the project exists.
  it("passes another user's project on a parked box through to the route's 404", async () => {
    projects.set('theirs', { userId: 'u2', instance: { status: 'stopped' } });
    expect(await run(refuseParkedBox('id'), { id: 'theirs' })).toEqual({ status: 0, body: null, nexted: true });
  });
});

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] } }
const guarded = (router: Router) => (router.stack as Layer[])
  .filter(l => l.route?.stack.some(s => s.name === 'refuseParkedBox'))
  .map(l => `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`)
  .sort();

describe('routes that make sessions on a box', () => {
  it('declare refuseParkedBox', () => {
    expect(guarded(projectsRouter())).toEqual([
      'POST /:id/clone/retry',
      'POST /:id/clone/start-empty',
      'POST /:id/workflows',
    ]);
    expect(guarded(claudeLoginRouter())).toEqual([
      'DELETE /:id/claude-login',
      'POST /:id/claude-login',
      'POST /:id/claude-login/code',
    ]);
    expect(guarded(workstreamsRouter())).toEqual([
      'DELETE /projects/:projectId/workstreams/:id',
      'POST /projects/:projectId/workstreams',
      'POST /projects/:projectId/workstreams/:id/agent',
      'POST /projects/:projectId/workstreams/:id/rename',
    ]);
  });
});
