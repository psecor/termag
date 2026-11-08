import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { sendForProject, isProjectAgentConnected } from '../services/agentRegistry';
import { noteBoxActivity } from '../services/boxActivity';
import { powerStateError } from '../services/boxPowerPolicy';
import { refuseUnreadySessions } from '../services/sessionGate';
import { assertSessionAccess, parseSlot, SessionAccessError, type SessionAccess } from '../services/sessionAccess';
import { boolVariation } from '../services/featureFlags';
import { chooseTerminalSlot, FIRST_EXTRA_TERMINAL_SLOT, terminalTabLabel } from '../services/terminalSlots';
import { exactPaneTarget, MAX_TERMINAL_SLOTS, projectDirFor, terminalSessionNames } from '../services/tmux';

// Terminal slots: the workspace's terminal tab list —
// the ctrl pane (slot 1) plus the shells the user adds with + and closes with
// ✕. The shape is the review slots' (routes/review.ts): access is
// allowlist-by-reconstruction (services/sessionAccess.ts), the pane is created
// with RPCs every deployed agent already has (tmux-has-session / tmux-create —
// no agent change), and every kill uses the exact pane target so a bare name
// never prefix-matches a sibling slot.
//
//   GET    /api/projects/:id/terminals?workstream=   which slots are live (one tmux-list)
//   POST   /api/projects/:id/terminals { workstream }   add a tab: the lowest free slot, 409 when all are in use
//   DELETE /api/projects/:id/terminals?workstream=&slot=   close a tab (kills the session)
//
// tmux is the only record of a tab: a slot holds a plain shell, so there is
// nothing to persist — the tab list is what tmux says, and a slot whose pane
// died (box stop, killed shell) is simply closed. Slot 1 is never created or
// killed here: the ctrl pane belongs to the agent workflow (agentRuntime).

export const TERMINAL_SLOTS_FLAG = 'terminal-tabs-enabled';

/** What the route needs beyond the agent; injectable so the slot choice is testable. */
export interface TerminalSlotRouteDeps {
  /** terminal-tabs-enabled for the user adding a tab. */
  flagOn: (user: Express.User) => Promise<boolean>;
}

const defaultDeps: TerminalSlotRouteDeps = {
  flagOn: user => boolVariation(TERMINAL_SLOTS_FLAG, user, false),
};

// One add at a time per workstream: two quick adds would otherwise both read
// the same slot as free and the second would land on the first's shell.
const addLocks = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = addLocks.get(key) ?? Promise.resolve();
  const run = before.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  addLocks.set(key, settled);
  try { return await run; } finally { if (addLocks.get(key) === settled) addLocks.delete(key); }
}

async function accessOr404(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]): Promise<SessionAccess | null> {
  const workstream = (typeof req.query.workstream === 'string' && req.query.workstream)
    || (typeof req.body?.workstream === 'string' && req.body.workstream)
    || 'main';
  try {
    return await assertSessionAccess(req.user!.id, req.params.id, 'ctrl', workstream);
  } catch (err) {
    if (err instanceof SessionAccessError) { res.status(err.status).json({ error: err.message }); return null; }
    throw err;
  }
}

/** The workstream directory a new pane opens in — the same cwd a review pane gets. */
async function workstreamDir(access: SessionAccess): Promise<string> {
  const p = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: { name: true, user: { select: { unixUsername: true } }, instance: { select: { hostHome: true } } },
  });
  if (!p) throw new SessionAccessError(404, 'Project not found');
  return projectDirFor(p, access.workstream);
}

/** The live slot names from one tmux-list. A failed RPC throws; the callers turn that into a 503 — offline is unknown, not "no tabs", so a deploy-time agent restart does not close anyone's tabs. */
async function liveSlotNames(access: SessionAccess): Promise<Set<string>> {
  const list = await sendForProject(access.host, 'tmux-list', {}, 5000);
  return new Set<string>(Array.isArray(list?.sessions) ? list.sessions : []);
}

function workstreamSlotNames(access: SessionAccess): string[] {
  return terminalSessionNames(access.project.ownerUsername, access.project.name, access.workstream);
}

export function terminalSlotsRouter(deps: TerminalSlotRouteDeps = defaultDeps): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res);
    if (!access) return;
    if (!isProjectAgentConnected(access.host)) {
      res.status(503).json({ error: "Owner's agent is offline" });
      return;
    }
    try {
      const live = await liveSlotNames(access);
      const terminals = workstreamSlotNames(access)
        .map((session, i) => ({ session, slot: i + 1, label: terminalTabLabel(i + 1) }))
        .filter(t => live.has(t.session));
      res.json({ terminals, max: MAX_TERMINAL_SLOTS });
    } catch (err) {
      res.status(503).json({ error: `Could not list the workstream's terminals: ${(err as Error).message}` });
    }
  };

  const add: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res);
    if (!access) return;
    if (!(await deps.flagOn(req.user!))) {
      res.status(403).json({ error: `terminal tabs are not enabled for you (flag ${TERMINAL_SLOTS_FLAG})`, code: 'terminal_tabs_disabled' });
      return;
    }
    // The same parked-box and setup checks a review start gets: a collaborator
    // would otherwise create a pane on a stopping box that dies with it, and
    // tmux-create would git-init a directory a clone is about to own.
    const project = await prisma.project.findUnique({
      where: { id: access.project.id },
      select: { id: true, setupStatus: true, instance: { select: { status: true } } },
    });
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    const parked = project.instance ? powerStateError(project.instance.status) : null;
    if (parked) { res.status(409).json({ error: parked }); return; }
    const unready = refuseUnreadySessions(project);
    if (unready) { res.status(409).json({ error: unready.message }); return; }
    if (!isProjectAgentConnected(access.host)) { res.status(503).json({ error: "Owner's agent is offline" }); return; }

    noteBoxActivity(access.host.instanceId);
    const lockKey = `${access.host.instanceId ?? ''}|${access.project.id}|${access.workstream}`;
    await oneAtATime(lockKey, async () => {
      const names = workstreamSlotNames(access);
      let live: Set<string>;
      try {
        live = await liveSlotNames(access);
      } catch (err) {
        res.status(503).json({ error: `Could not add a terminal: ${(err as Error).message}` });
        return;
      }
      const choice = chooseTerminalSlot(live, names);
      if ('full' in choice) {
        res.status(409).json({ error: `All ${MAX_TERMINAL_SLOTS} terminals in this workstream are in use: close one first.`, code: 'terminals_full' });
        return;
      }
      const session = names[choice.slot - 1];
      try {
        // The pane opens in the workstream's directory, so git and gh see the
        // same checkout the ctrl pane does. Plain name — tmux-create names the
        // new session; every other RPC gets the exact target.
        const cwd = await workstreamDir(access);
        await sendForProject(access.host, 'tmux-create', { sessionName: session, cwd }, 15000);
      } catch (err) {
        res.status(503).json({ error: `Could not add a terminal: ${(err as Error).message}` });
        return;
      }
      console.log(`[TERMINAL] ${session}: terminal slot ${choice.slot} of ${MAX_TERMINAL_SLOTS} added by ${req.user!.id} (${live.size - 1} other slot${live.size - 1 === 1 ? '' : 's'} live)`);
      res.json({ ok: true, session, slot: choice.slot, label: terminalTabLabel(choice.slot) });
    });
  };

  const close: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res);
    if (!access) return;
    const slot = parseSlot(req.query.slot, MAX_TERMINAL_SLOTS);
    if (!slot.ok || slot.slot < FIRST_EXTRA_TERMINAL_SLOT) {
      res.status(400).json({ error: `slot must be ${FIRST_EXTRA_TERMINAL_SLOT} to ${MAX_TERMINAL_SLOTS}` });
      return;
    }
    // The name is rebuilt, never taken from the request, and killed by its
    // exact target: a bare `…-ctrl-2` would reach `…-ctrl-22` once its own
    // pane is gone.
    const session = workstreamSlotNames(access)[slot.slot - 1];
    if (!isProjectAgentConnected(access.host)) { res.status(503).json({ error: "Owner's agent is offline" }); return; }
    try {
      await sendForProject(access.host, 'tmux-kill', { sessionName: exactPaneTarget(session) }, 5000);
      noteBoxActivity(access.host.instanceId);
      res.json({ ok: true, session });
    } catch (err) {
      res.status(503).json({ error: `Could not close the terminal: ${(err as Error).message}` });
    }
  };

  router.get('/projects/:id/terminals', requireAuth, asyncHandler(list));
  router.post('/projects/:id/terminals', requireAuth, asyncHandler(add));
  router.delete('/projects/:id/terminals', requireAuth, asyncHandler(close));
  return router;
}
