import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { powerStateError } from '../services/boxPowerPolicy';
import { refuseUnreadySessions } from '../services/sessionGate';
import { sendForProject, isProjectAgentConnected } from '../services/agentRegistry';
import { assertSessionAccess, SessionAccessError, type SessionAccess } from '../services/sessionAccess';
import { projectDirFor, sessionName } from '../services/tmux';
import { getAllStatuses } from '../services/status';
import { statusKey } from '../services/statusKey';
import {
  chooseGuess, isPrNumber, parseGhPrView, prFromText, reviewLaunchCommand, urlForPr, probeReviewPane, PR_OPTION, encodePrOption,
  type ReviewPaneState,
} from '../services/review';
import {
  clearReviewRecord, getReviewRecord, identityOf, markReviewSeen, registerReviewRecord, touchRecordWithProbe,
} from '../services/reviewSweep';

// The Review button (frontend/src/components/ReviewButton.tsx + ReviewDock.tsx):
//
//   GET    /api/projects/:id/review/guess?workstream=   which PR is being worked on
//   GET    /api/projects/:id/review?workstream=         is a review pane alive / is Devin still in it
//   POST   /api/projects/:id/review { workstream, pr, url? }   start (or replace) a Devin review
//   DELETE /api/projects/:id/review?workstream=         kill the review pane
//   POST   /api/projects/:id/review/seen { workstream }   the review terminal took focus while done
//
// Everything is routed to the OWNER's per-user agent via sendForProject (tmux
// is per unix user) and gated by assertSessionAccess (owner-or-share, legal
// session name rebuilt server-side). The review pane is the `review` role:
// `<user>-<project>[-<ws>]-review`, created in the workstream's directory so
// `gh` sees the right repo.
//
// Since the review ring the pane's live state ALSO
// rides on the AGENT session's status (`AgentStatus.review`, written only by
// services/reviewSweep.ts and pushed over /ws/status); the browser no longer
// polls this GET route. It stays for a deliberate, on-demand probe (first
// render after POST), and its probing is the sweep's probing
// (`probeReviewPane`) so the dock and the ring can never disagree.
//
// Which PR a pane is reviewing is remembered in the sweep's memory and, on
// agents that have the RPC, as a tmux user option on the session
// (`@termag-review-pr`), which lives as long as the pane does; after a
// backend restart the number is read back from there, or from the launch line
// echoed in the pane's scrollback on an older agent. Launch uses only RPCs
// every deployed agent already has; the gh-based guess needs the
// `git-pr-info` RPC and degrades to the pane capture + milestone on an older
// agent.

/** How long the fresh shell gets before `devin …` is typed (zsh startup + the box banner). */
const SHELL_SETTLE_MS = 700;

async function accessOr404(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], role: 'agent' | 'review'): Promise<SessionAccess | null> {
  const workstream = (typeof req.query.workstream === 'string' && req.query.workstream)
    || (typeof req.body?.workstream === 'string' && req.body.workstream)
    || 'main';
  try {
    return await assertSessionAccess(req.user!.id, req.params.id, role, workstream);
  } catch (err) {
    if (err instanceof SessionAccessError) { res.status(err.status).json({ error: err.message }); return null; }
    throw err;
  }
}

async function workstreamDir(access: SessionAccess): Promise<string> {
  const p = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: { name: true, user: { select: { unixUsername: true } }, instance: { select: { hostHome: true } } },
  });
  if (!p) throw new SessionAccessError(404, 'Project not found');
  return projectDirFor(p, access.workstream);
}

function identityFor(access: SessionAccess) {
  return identityOf({
    host: access.host,
    projectId: access.project.id,
    projectName: access.project.name,
    ownerUsername: access.project.ownerUsername,
    workstream: access.workstream,
  });
}

export function reviewRouter(): Router {
  const router = Router();

  const guess: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res, 'agent');
    if (!access) return;
    if (!isProjectAgentConnected(access.host)) { res.status(503).json({ error: "Owner's agent is offline" }); return; }

    const cwd = await workstreamDir(access);
    let gh: ReturnType<typeof parseGhPrView> = null;
    let branch: string | null = null;
    let ghError: string | null = null;
    try {
      // Newer agents only; an older one answers "Unknown command" and we fall through.
      const r = await sendForProject(access.host, 'git-pr-info', { cwd }, 15000);
      branch = typeof r?.branch === 'string' ? r.branch : null;
      gh = typeof r?.pr === 'string' ? parseGhPrView(r.pr) : null;
      ghError = typeof r?.error === 'string' ? r.error : null;
    } catch (err) {
      const msg = (err as Error).message;
      ghError = /Unknown command/.test(msg) ? 'the box agent predates the branch lookup (restart it)' : msg;
    }

    const agentSession = sessionName(access.project.ownerUsername, access.project.name, 'agent', access.workstream);
    const milestoneUrl = getAllStatuses().get(statusKey(access.host.instanceId, agentSession))?.milestone?.url ?? null;

    let pane: ReturnType<typeof prFromText> = null;
    try {
      const r = await sendForProject(access.host, 'tmux-capture', { sessionName: agentSession, lines: 400 }, 8000);
      pane = prFromText(typeof r?.content === 'string' ? r.content : '');
    } catch { /* no agent pane to read — fine */ }

    const chosen = chooseGuess({ gh, branch, milestoneUrl, pane });
    res.json({ guess: chosen, branch, ghError });
  };

  const status: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res, 'review');
    if (!access) return;
    if (!isProjectAgentConnected(access.host)) {
      // Offline is unknown, not "no pane": a 503 makes the client keep what it
      // has, so a deploy-time agent restart does not hide a still-live review.
      res.status(503).json({ error: "Owner's agent is offline", session: access.session, connected: false });
      return;
    }
    const identity = identityFor(access);
    let alive = false;
    let state: ReviewPaneState | null = null;
    let pr: number | null = null;
    let url: string | null = null;
    let startedAt: Date | null = null;
    try {
      // A failed RPC is a 503, not "no pane": the client keeps what it has, and
      // the record (and the ring) survive an agent hiccup. Only a definitive
      // `exists: false` clears them.
      const recBefore = getReviewRecord(access.host.instanceId, access.session);
      const probe = await probeReviewPane(sendForProject, access.host, access.session, recBefore ? { pr: recBefore.pr, url: recBefore.url } : null);
      // Re-read AFTER the probe: a stop/clear that landed while it was in
      // flight must not be resurrected by this detached record's result (the
      // sweep's tick does the same re-read).
      touchRecordWithProbe(getReviewRecord(access.host.instanceId, access.session), probe, identity, Date.now());
      // Populate only when the pane is really there: a gone pane answers the
      // same shape it always did, with nothing stale and running: false.
      if (probe.exists) {
        const after = getReviewRecord(access.host.instanceId, access.session);
        alive = true;
        state = probe.state ?? after?.state ?? 'reviewing';
        pr = after?.pr ?? null;
        url = after?.url ?? null;
        startedAt = after?.startedAt ?? null;
      }
    } catch (err) {
      res.status(503).json({ error: `Could not reach the owner's agent: ${(err as Error).message}` });
      return;
    }
    res.json({
      session: access.session, connected: true, alive,
      // `running` is kept for older clients: Devin is still in the pane.
      running: state === 'reviewing' || state === 'waiting' || state === 'done',
      state, pr, url, startedAt,
    });
  };

  const start: RequestHandler = async (req, res) => {
    const { pr, url } = req.body as { pr?: unknown; url?: unknown };
    if (!isPrNumber(pr)) { res.status(400).json({ error: 'pr (positive integer) required' }); return; }
    const cleanUrl = urlForPr(url, pr);
    const access = await accessOr404(req, res, 'review');
    if (!access) return;
    // Parked-box check on the PROJECT's box, whoever the caller is: the
    // refuseParkedBox middleware only looks at the caller's own projects, and a
    // collaborator would otherwise create a pane on a stopping box (its agent
    // stays connected until EC2 powers it off) that dies with it.
    const parked = await prisma.project.findUnique({
      where: { id: access.project.id },
      select: { id: true, setupStatus: true, instance: { select: { status: true } } },
    });
    const parkedError = parked?.instance ? powerStateError(parked.instance.status) : null;
    if (parkedError) { res.status(409).json({ error: parkedError }); return; }
    const unready = parked && refuseUnreadySessions(parked);
    if (unready) { res.status(409).json({ error: unready.message }); return; }
    if (!isProjectAgentConnected(access.host)) { res.status(503).json({ error: "Owner's agent is offline" }); return; }

    const cwd = await workstreamDir(access);
    try {
      // A second Review replaces the running one: fresh shell, fresh Devin.
      const has = await sendForProject(access.host, 'tmux-has-session', { sessionName: access.session }, 5000);
      if (has?.exists) await sendForProject(access.host, 'tmux-kill', { sessionName: access.session }, 5000);
      await sendForProject(access.host, 'tmux-create', { sessionName: access.session, cwd }, 15000);
      // Best effort: an older agent answers "Unknown command" and the launch echo covers recovery.
      await sendForProject(access.host, 'tmux-set-user-option', { sessionName: access.session, name: PR_OPTION, value: encodePrOption(pr, cleanUrl) }, 5000).catch(() => {});
      await new Promise(r => setTimeout(r, SHELL_SETTLE_MS));
      await sendForProject(access.host, 'tmux-send-keys', {
        sessionName: access.session, keys: reviewLaunchCommand(pr, cleanUrl), withEnter: true, literal: true,
      }, 5000);
    } catch (err) {
      res.status(503).json({ error: `Could not start the review: ${(err as Error).message}` });
      return;
    }
    const rec = registerReviewRecord(identityFor(access), { pr, url: cleanUrl }, { startedByUserId: req.user!.id });
    const startedAt = rec.startedAt;
    console.log(`[REVIEW] ${access.session}: devin review of PR #${pr} started by ${req.user!.id}`);
    res.status(201).json({ ok: true, session: access.session, pr, url: cleanUrl, startedAt });
  };

  const stop: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res, 'review');
    if (!access) return;
    if (!isProjectAgentConnected(access.host)) { res.status(503).json({ error: "Owner's agent is offline" }); return; }
    try {
      await sendForProject(access.host, 'tmux-kill', { sessionName: access.session }, 5000);
    } catch (err) {
      res.status(503).json({ error: `Could not stop the review: ${(err as Error).message}` });
      return;
    }
    // Only after the kill succeeded: a live session must keep its record.
    clearReviewRecord(identityFor(access));
    res.json({ ok: true, session: access.session });
  };

  const seen: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res, 'review');
    if (!access) return;
    const marked = markReviewSeen(access.host.instanceId, access.session);
    // A missing record answers 404: nothing to mark. (A pane whose agent is
    // offline — the sweep froze its state — still marks: seen is about the
    // viewer, not the agent.)
    if (!marked) { res.status(404).json({ error: 'No review running for this workstream' }); return; }
    res.json({ ok: true });
  };

  // asyncHandler: Express 4 drops async rejections (a DB error, a
  // SessionAccessError from workstreamDir) on the floor and the request hangs;
  // wrapped, they reach apiErrorHandler and answer with JSON.
  router.get('/projects/:id/review/guess', requireAuth, asyncHandler(guess));
  router.get('/projects/:id/review', requireAuth, asyncHandler(status));
  router.post('/projects/:id/review', requireAuth, asyncHandler(start));
  router.delete('/projects/:id/review', requireAuth, asyncHandler(stop));
  router.post('/projects/:id/review/seen', requireAuth, asyncHandler(seen));
  return router;
}
