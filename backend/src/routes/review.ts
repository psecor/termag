import { Router, RequestHandler, type Request, type Response } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { powerStateError } from '../services/boxPowerPolicy';
import { refuseUnreadySessions } from '../services/sessionGate';
import { sendForProject, isProjectAgentConnected } from '../services/agentRegistry';
import { noteBoxActivity } from '../services/boxActivity';
import { assertSessionAccess, parseReviewSlot, SessionAccessError, type SessionAccess } from '../services/sessionAccess';
import { MAX_REVIEW_SLOTS, exactPaneTarget, projectDirFor, reviewSessionName, reviewSessionNames, reviewSlotOf, sessionName } from '../services/tmux';
import { boolVariation } from '../services/featureFlags';
import { AGENT_OFFLINE, HeldReviewStarts, type StartAnswer } from '../services/reviewHeld';
import { resolveProjectRoot } from '../services/projectPaths';
import { getAllStatuses } from '../services/status';
import { statusKey } from '../services/statusKey';
import {
  chooseGuess, chooseReviewSlot, guessRepoIndex, isPrNumber, parseGhPrView, prFromText, reviewLaunchCommand, urlForPr, probeReviewPane, PR_OPTION, encodePrOption,
  buildGroupReviewPrompt, buildReviewPrompt, parseGroupReview, parseReviewBody, reviewPromptPath, reviewPromptFooter, reviewTemplateCandidates, chooseReviewTemplate,
  type ResolvedReviewTemplate,
  type ReviewPaneState,
} from '../services/review';
import { DEFAULT_REVIEWER, REVIEWER_IDS, isReviewerId, reviewerName, reviewerNote } from '../services/reviewers';
import { prUrlFor, reviewTarget, workspaceRepos, workstreamRepo, type WorkstreamRepo } from '../services/reviewRepo';
import { isWorkspace, repoCheckoutDir, repoSlug } from '../services/projectRepos';
import {
  clearReviewRecord, getReviewRecord, identityOf, markReviewSeen, registerReviewRecord, reviewMetaOf, reviewRecordsOf, touchRecordWithProbe,
} from '../services/reviewSweep';

// The Review button (frontend/src/components/ReviewButton.tsx + ReviewDock.tsx):
//
//   GET    /api/projects/:id/review/guess?workstream=   which PR is being worked on
//   GET    /api/projects/:id/review?workstream=&session=   is a review pane alive / is the reviewer still in it
//                                                       (+ `reviews`: every slot the sweep knows)
//   POST   /api/projects/:id/review { workstream, pr, url?, prompt?, reviewer?, slot? }   start (or restart) a review
//                                                       (slot: that pane, replacing whatever runs there; the phone
//                                                       sends 1 until it shows more than one)
//                                                       (reviewer: services/reviewers.ts REVIEWER_IDS, default devin;
//                                                       a bare pr needs the workstream's GitHub remote:
//                                                       services/reviewRepo.ts)
//   DELETE /api/projects/:id/review?workstream=&session=   kill a review pane
//   POST   /api/projects/:id/review/seen { workstream, session? }   its review terminal took focus while done
//
// A workstream has up to MAX_REVIEW_SLOTS review panes:
// `session` names one, slot 1 (the `review` role's own name) when absent, so a
// client that knows one pane addresses the same one it always did. With
// parallel-reviews-enabled a start takes the PR's own pane or the lowest free
// one; off, it replaces slot 1 as before.
//
// Everything is routed to the OWNER's per-user agent via sendForProject (tmux
// is per unix user) and gated by assertSessionAccess (owner-or-share, legal
// session name rebuilt server-side). The review pane is the `review` role:
// `<user>-<project>[-<ws>]-review`, created in the workstream's directory so
// `gh` sees the right repo.
//
// Since the review ring the panes' live state ALSO
// rides on the AGENT session's status (`AgentStatus.reviews`, and slot 1's as
// `AgentStatus.review`, written only by
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

/**
 * The review pane a request names: `session` (query or body), compared
 * against the workstream's slot names and never passed on as given; absent
 * is slot 1. A name that is none of them is a 404.
 */
async function reviewPaneOr404(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]): Promise<SessionAccess | null> {
  const access = await accessOr404(req, res, 'review');
  if (!access) return null;
  const asked = (typeof req.query.session === 'string' && req.query.session)
    || (typeof req.body?.session === 'string' && req.body.session)
    || null;
  if (asked === null) return access;
  const slot = reviewSlotOf(asked, access.project.ownerUsername, access.project.name, access.workstream);
  if (slot === null) { res.status(404).json({ error: 'No such review pane in this workstream' }); return null; }
  return withSlot(access, slot);
}

function withSlot(access: SessionAccess, slot: number): SessionAccess {
  return { ...access, slot, session: reviewSessionName(access.project.ownerUsername, access.project.name, access.workstream, slot) };
}

/** What the start route needs beyond the agent and the sweep; injectable so its slot choice and the wake are testable. */
export interface ReviewRouteDeps {
  /** parallel-reviews-enabled for the user starting the review. */
  parallelOn: (user: Express.User) => Promise<boolean>;
  /** box-wake-on-action-enabled for the user starting the review: a parked box of theirs is woken, the start held. */
  wakeOn: (user: Express.User) => Promise<boolean>;
  /** Asks a box of the user's to start: the owner-only path POST /instances/:id/start takes. */
  startBox: (user: Express.User, instanceId: string) => Promise<StartAnswer>;
  /** A box's status now, from the database; null when it's gone. */
  boxStatus: (instanceId: string) => Promise<string | null>;
  /** Where starts wait for their box (services/reviewHeld.ts). */
  held: HeldReviewStarts;
}

/**
 * A box's status for a held start. One the 60-day hibernation refresh woke (rehibernatePending, from its start until
 * its stop settles; services/boxPower.ts rehibernateRefreshedBoxes) reads as `refreshing`: it's going straight back
 * down, so a held start neither runs on it nor reads its stop as someone stopping it, and wakes it once it's down.
 */
const boxStatusOf = (id: string) => prisma.instance.findUnique({ where: { id }, select: { status: true, rehibernatePending: true } })
  .then(i => (!i ? null : i.rehibernatePending && ['starting', 'awaiting-agent', 'ready', 'stopping'].includes(i.status) ? 'refreshing' : i.status));

const defaultDeps: ReviewRouteDeps = {
  parallelOn: user => boolVariation('parallel-reviews-enabled', user, false),
  wakeOn: user => boolVariation('box-wake-on-action-enabled', user, false),
  // Imported when first used: routes/instances.ts pulls in the provisioning stack.
  startBox: async (user, instanceId) => (await import('./instances')).powerOwnedBox(user, instanceId, 'start'),
  boxStatus: boxStatusOf,
  held: new HeldReviewStarts({ boxStatus: boxStatusOf, now: () => Date.now() }),
};

/** A box a held start waits through: asleep (woken), or on its way up or down. */
const WAKEABLE = new Set(['stopping', 'stopped', 'starting', 'hibernating', 'hibernated']);
/** A box on its way up: a start refused by it was beaten to it, not refused. */
const COMING_UP = new Set(['starting', 'provisioning', 'awaiting-agent', 'ready', 'refreshing']);

/** Runs a route handler on a request of its own and resolves with what it answered: a held start's replay. */
function captureAnswer(handler: RequestHandler, req: Request): Promise<StartAnswer> {
  return new Promise(resolve => {
    let code = 200;
    const res = {
      status(c: number) { code = c; return res; },
      json(body: unknown) { resolve({ status: code, body }); return res; },
    } as unknown as Response;
    const failed = (err: unknown) => resolve({ status: 500, body: { error: err instanceof Error ? err.message : 'The review could not start' } });
    // The first answer wins; a handler that returned without one answered nothing, which is a failure.
    Promise.resolve(handler(req, res, failed)).then(() => failed(null), failed);
  });
}

// One start at a time per workstream: two quick ones would otherwise both
// read the same slot as free, and the second would kill the first's pane.
const startLocks = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = startLocks.get(key) ?? Promise.resolve();
  const run = before.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  startLocks.set(key, settled);
  try { return await run; } finally { if (startLocks.get(key) === settled) startLocks.delete(key); }
}

type WorkspaceRepoRow = { name: string; url: string; position: number };

/**
 * `repos` is set for a multi-repo project: `cwd`
 * is then a folder holding a worktree of each, not a checkout.
 */
async function workstreamPaths(access: SessionAccess): Promise<{ cwd: string; home: string; repos: WorkspaceRepoRow[] | null }> {
  const p = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: {
      name: true, layout: true, user: { select: { unixUsername: true } }, instance: { select: { hostHome: true } },
      // A repository still cloning (one added since) has no worktree to read yet.
      repos: { where: { setupStatus: 'ready' }, select: { name: true, url: true, position: true }, orderBy: { position: 'asc' } },
    },
  });
  if (!p) throw new SessionAccessError(404, 'Project not found');
  return {
    cwd: projectDirFor(p, access.workstream),
    home: resolveProjectRoot({ ownerUnixUser: p.user.unixUsername, hostHome: p.instance?.hostHome }),
    repos: isWorkspace(p) ? p.repos : null,
  };
}

type PrInfo = { gh: ReturnType<typeof parseGhPrView>; branch: string | null; ghError: string | null };

/** The checkout's branch and its PR (gh), from the newer agents' `git-pr-info`; an older one answers "Unknown command". */
async function prInfoAt(access: SessionAccess, cwd: string): Promise<PrInfo> {
  try {
    const r = await sendForProject(access.host, 'git-pr-info', { cwd }, 15000);
    return {
      branch: typeof r?.branch === 'string' ? r.branch : null,
      gh: typeof r?.pr === 'string' ? parseGhPrView(r.pr) : null,
      ghError: typeof r?.error === 'string' ? r.error : null,
    };
  } catch (err) {
    const msg = (err as Error).message;
    return { gh: null, branch: null, ghError: /Unknown command/.test(msg) ? 'the box agent predates the branch lookup (restart it)' : msg };
  }
}

/**
 * The prompt template for this workstream: repo file, then the owner's home
 * files, then the built-in one (services/review.ts chooseReviewTemplate). One
 * read-file per candidate, in parallel; a failed read (old agent, permissions)
 * counts as absent. read-file goes through the agent's path_remap, like the
 * prompt file's write-file.
 */
async function resolveTemplate(access: SessionAccess, cwd: string, home: string): Promise<ResolvedReviewTemplate> {
  const candidates = reviewTemplateCandidates(cwd, home);
  const contents = await Promise.all(candidates.map(c =>
    sendForProject(access.host, 'read-file', { path: c.path }, 5000)
      .then(r => (typeof r?.content === 'string' ? r.content : null))
      .catch(() => null)));
  return chooseReviewTemplate(candidates, contents);
}

function identityFor(access: SessionAccess) {
  return identityOf({
    host: access.host,
    projectId: access.project.id,
    projectName: access.project.name,
    ownerUsername: access.project.ownerUsername,
    workstream: access.workstream,
    slot: access.slot ?? 1,
  });
}

/** Every pane the sweep knows in the access's workstream, slot order. */
function workstreamReviews(access: SessionAccess) {
  const agentSession = sessionName(access.project.ownerUsername, access.project.name, 'agent', access.workstream);
  return reviewRecordsOf(access.host.instanceId, agentSession).map(reviewMetaOf);
}

export function reviewRouter(overrides: Partial<ReviewRouteDeps> = {}): Router {
  const deps: ReviewRouteDeps = { ...defaultDeps, ...overrides };
  const router = Router();

  /**
   * A start on a parked box, with box-wake-on-action-enabled ("A review target on a box
   * that's asleep"): the caller's own box is woken and the start held until it's ready (services/reviewHeld.ts),
   * answered 202 now. Someone else's box is a 409 that says who can wake it. Null: refused as before (the flag off,
   * or a status a start can't wait through).
   */
  async function holdForWake(
    req: Request, workstream: string, instance: { id: string; name: string; userId: string | null; status: string }, pr: number, reviewer: string,
    url: string | null, session: string,
  ): Promise<StartAnswer | null> {
    if (!WAKEABLE.has(instance.status) || !(await deps.wakeOn(req.user!))) return null;
    if (instance.userId !== req.user!.id) {
      return { status: 409, body: { error: `${instance.name} is ${instance.status}, and only its owner can start it. Ask them to, then Review again.` } };
    }
    const asleep = instance.status === 'stopped' || instance.status === 'hibernated';
    const wake = () => deps.startBox(req.user!, instance.id);
    // Whether this start woke the box: a box another start is waking (beaten to it, below) isn't, so the sweep wakes
    // it itself should that start fail and the box go back to sleep.
    let woken = false;
    // What the box was after a refused wake: `refreshing`, the hibernation refresh beat this start to it.
    let seen: string | null = null;
    if (asleep) {
      const asked = await wake();
      woken = asked.status < 300;
      // Refused because something else woke it first (another Review, the Boxes list): it's coming up, so the start
      // is held all the same. Anything else (terminated, quarantined) is the refusal.
      seen = woken ? null : await deps.boxStatus(instance.id).catch(() => null);
      if (!woken && !COMING_UP.has(seen ?? '')) {
        const why = (asked.body as { error?: unknown } | null)?.error;
        return { status: 409, body: { error: `Couldn't wake ${instance.name}: ${typeof why === 'string' ? why.replace(/\.$/, '') : 'the start was refused'}. Start it from your boxes, then Review again.` } };
      }
    }
    // The start as it was asked, run again once the box is ready: the same checks, from the top.
    const again = { user: req.user, params: { ...req.params }, query: { ...req.query }, body: req.body } as unknown as Request;
    const held = deps.held.hold({
      projectId: req.params.id, workstream, instanceId: instance.id, box: instance.name, pr, reviewer, woken, beaten: asleep && !woken,
      refreshSeen: seen === 'refreshing',
      wake, replay: () => captureAnswer(start, again),
    });
    // The start's own fields as far as they're known, for clients that read them (Lab opens `session`, the phone keeps
    // it): the pane the start asked for, or the workstream's first, where the replay starts it unless parallel reviews
    // pick another.
    return { status: 202, body: { ok: true, held: true, box: instance.name, state: held.state, pr, url, reviewer, session } };
  }

  const guess: RequestHandler = async (req, res) => {
    const access = await accessOr404(req, res, 'agent');
    if (!access) return;
    if (!isProjectAgentConnected(access.host)) { res.status(503).json({ error: "Owner's agent is offline" }); return; }

    const { cwd, home, repos } = await workstreamPaths(access);
    let templateP: Promise<ResolvedReviewTemplate>;
    let repoTemplatesP: Promise<Array<ResolvedReviewTemplate & { repo: string }>> | null = null;
    let repoP: Promise<WorkstreamRepo>;
    let info: PrInfo;
    if (repos) {
      // Every repository's worktree, read for the one guessRepoIndex picks. Start
      // reads the template in the confirmed PR's repository, or at the workstream
      // folder for a PR of none of them, so the dialog gets each repository's
      // and the folder's, and shows the one Start will use.
      const infos = await Promise.all(repos.map(r => prInfoAt(access, `${cwd}/${r.name}`)));
      const hit = guessRepoIndex(infos.map(i => i.gh));
      info = hit >= 0 ? infos[hit] : (infos.find(i => i.branch) ?? infos[0] ?? { gh: null, branch: null, ghError: null });
      templateP = resolveTemplate(access, cwd, home);
      const slugged = repos.flatMap(r => { const slug = repoSlug(r.url); return slug ? [{ slug, dir: `${cwd}/${r.name}` }] : []; });
      repoTemplatesP = Promise.all(slugged.map(r => resolveTemplate(access, r.dir, home).then(t => ({ ...t, repo: r.slug }))));
      repoP = Promise.resolve(workspaceRepos(repos));
    } else {
      templateP = resolveTemplate(access, cwd, home);
      repoP = workstreamRepo(sendForProject, access.host, cwd);
      info = await prInfoAt(access, cwd);
    }
    const { gh, branch, ghError } = info;

    const agentSession = sessionName(access.project.ownerUsername, access.project.name, 'agent', access.workstream);
    const milestoneUrl = getAllStatuses().get(statusKey(access.host.instanceId, agentSession))?.milestone?.url ?? null;

    let pane: ReturnType<typeof prFromText> = null;
    try {
      const r = await sendForProject(access.host, 'tmux-capture', { sessionName: agentSession, lines: 400 }, 8000);
      pane = prFromText(typeof r?.content === 'string' ? r.content : '');
    } catch { /* no agent pane to read — fine */ }

    let chosen = chooseGuess({ gh, branch, milestoneUrl, pane });
    // `repo` / `repoKnown` let the dialog name the repository a typed number
    // is in, and refuse one when the directory has no GitHub remote. A guess
    // without a URL ("PR #12" in the pane) is in the workstream's repository.
    const ws = await repoP;
    if (chosen && !chosen.url && ws.repo) chosen = { ...chosen, url: prUrlFor(ws.repo, chosen.number) };
    // The prompt body the dialog shows (and lets the user edit) before Start;
    // `{{pr}}` / `{{url}}` are filled in for whichever PR is confirmed. The
    // footer (attribution for anything the reviewer posts) is shown, not
    // editable, and names the reviewer: one per entry of `reviewers`.
    const template = await templateP;
    const repoTemplates = repoTemplatesP ? await repoTemplatesP : null;
    res.json({
      guess: chosen, branch, ghError, repo: ws.repo, repoKnown: ws.known, ...(ws.repos ? { repos: ws.repos } : {}),
      promptTemplate: template.template, promptSource: template.source, promptSourceLabel: template.label,
      promptWarnings: template.warnings, promptFooter: reviewPromptFooter(reviewerName(DEFAULT_REVIEWER)),
      ...(repoTemplates ? { promptTemplates: repoTemplates } : {}),
      reviewers: REVIEWER_IDS.map(id => ({ id, name: reviewerName(id), note: reviewerNote(id), footer: reviewPromptFooter(reviewerName(id)) })),
      defaultReviewer: DEFAULT_REVIEWER,
    });
  };

  const status: RequestHandler = async (req, res) => {
    const access = await reviewPaneOr404(req, res);
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
    let reviewer: string | null = null;
    try {
      // A failed RPC is a 503, not "no pane": the client keeps what it has, and
      // the record (and the ring) survive an agent hiccup. Only a definitive
      // `exists: false` clears them.
      const recBefore = getReviewRecord(access.host.instanceId, access.session);
      const probe = await probeReviewPane(sendForProject, access.host, access.session, recBefore ? { pr: recBefore.pr, url: recBefore.url, reviewer: recBefore.reviewer } : null);
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
        reviewer = after?.reviewer ?? probe.reviewer;
      }
    } catch (err) {
      res.status(503).json({ error: `Could not reach the owner's agent: ${(err as Error).message}` });
      return;
    }
    res.json({
      session: access.session, slot: access.slot, connected: true, alive,
      // `running` is kept for older clients: the reviewer is still in the pane.
      running: state === 'reviewing' || state === 'waiting' || state === 'done',
      state, pr, url, startedAt, reviewer,
      reviews: workstreamReviews(access),
    });
  };

  const start: RequestHandler = async (req, res) => {
    const { pr, url, prompt, reviewer: rawReviewer, group: rawGroup, slot: rawSlot } = req.body as { pr?: unknown; url?: unknown; prompt?: unknown; reviewer?: unknown; group?: unknown; slot?: unknown };
    if (!isPrNumber(pr)) { res.status(400).json({ error: 'pr (positive integer) required' }); return; }
    const slotAsked = rawSlot == null ? null : parseReviewSlot(rawSlot);
    if (slotAsked && !slotAsked.ok) { res.status(400).json({ error: slotAsked.error }); return; }
    const askedSlot = slotAsked?.ok ? slotAsked.slot : null;
    // Review all with Devin (a review group): one session over its members, in order; `pr` is the first.
    const grouped = parseGroupReview(rawGroup);
    if (!grouped.ok) { res.status(400).json({ error: grouped.error }); return; }
    const group = grouped.group;
    if (group && (group.members[0].number !== pr || prompt != null)) {
      res.status(400).json({ error: 'A group review starts on its first pull request and takes no edited prompt' });
      return;
    }
    if (rawReviewer != null && !isReviewerId(rawReviewer)) {
      res.status(400).json({ error: `reviewer must be one of ${REVIEWER_IDS.join(', ')}` });
      return;
    }
    const reviewer = rawReviewer ?? DEFAULT_REVIEWER;
    const body = parseReviewBody(prompt);
    if (!body.ok) { res.status(400).json({ error: body.error }); return; }
    const wsAccess = await accessOr404(req, res, 'review');
    if (!wsAccess) return;
    const parallel = await deps.parallelOn(req.user!);
    // The checkout's remote is read while the checks below run: on an agent
    // that is connected but slow it can take seconds (services/reviewRepo.ts).
    // Nothing is awaited on an early return, so neither promise may reject unseen.
    const pathsP = workstreamPaths(wsAccess);
    const repoP = pathsP.then(p => (p.repos ? workspaceRepos(p.repos) : workstreamRepo(sendForProject, wsAccess.host, p.cwd)));
    repoP.catch(() => {});
    // Parked-box check on the PROJECT's box, whoever the caller is: the
    // refuseParkedBox middleware only looks at the caller's own projects, and a
    // collaborator would otherwise create a pane on a stopping box (its agent
    // stays connected until EC2 powers it off) that dies with it.
    const parked = await prisma.project.findUnique({
      where: { id: wsAccess.project.id },
      select: { id: true, setupStatus: true, instance: { select: { id: true, name: true, userId: true, status: true } } },
    });
    const parkedError = parked?.instance ? powerStateError(parked.instance.status) : null;
    const unready = parked && refuseUnreadySessions(parked);
    if (parkedError) {
      // A project whose checkout isn't there (its clone failed, or never ran) can't take a review once its box is up
      // either: with the wake on, it says so now rather than waking the box for a start that will be refused.
      if (unready && await deps.wakeOn(req.user!)) { res.status(409).json({ error: unready.message }); return; }
      const session = askedSlot !== null ? withSlot(wsAccess, askedSlot).session : wsAccess.session;
      const held = await holdForWake(req, wsAccess.workstream, parked!.instance!, pr, reviewer, typeof url === 'string' ? url : null, session);
      if (held) { res.status(held.status).json(held.body); return; }
      res.status(409).json({ error: parkedError });
      return;
    }
    if (unready) { res.status(409).json({ error: unready.message }); return; }
    // Before anything runs on the box: the one 503 a held start's replay tries again (services/reviewHeld.ts).
    if (!isProjectAgentConnected(wsAccess.host)) { res.status(503).json({ error: AGENT_OFFLINE }); return; }

    const paths = await pathsP;
    const { home } = paths;
    // A group review names its first member's own PR, whatever `url` says (Devin, #668): the record,
    // the PR option and the review tab must name the PR the prompt opens on.
    const asked = group ? `https://github.com/${group.members[0].repo}/pull/${group.members[0].number}` : urlForPr(url, pr);
    const target = reviewTarget(pr, asked, await repoP);
    if ('refuse' in target) { res.status(400).json({ error: target.refuse }); return; }
    // A multi-repo workstream's pane opens in the PR's repository, so gh and the
    // reviewer see it; a PR of none of them opens at the workstream folder.
    const cwd = paths.repos ? repoCheckoutDir(paths.cwd, paths.repos, target.repo) ?? paths.cwd : paths.cwd;
    const cleanUrl = target.url;
    // No edited body (unedited dialog, mobile, older client): the same
    // template the dialog would have shown, resolved again now.
    const template = body.body == null && !group ? await resolveTemplate(wsAccess, cwd, home) : null;
    noteBoxActivity(wsAccess.host.instanceId);
    const lockKey = `${wsAccess.host.instanceId ?? ''}|${wsAccess.project.id}|${wsAccess.workstream}`;
    await oneAtATime(lockKey, async () => {
      // Which pane: the one asked for; else off, slot 1 as always; on, the PR's own pane or the lowest
      // free one.
      let access = askedSlot !== null ? withSlot(wsAccess, askedSlot) : wsAccess;
      let replaced = false;
      if (parallel && askedSlot === null) {
        let live: Set<string>;
        try {
          const list = await sendForProject(wsAccess.host, 'tmux-list', {}, 5000);
          live = new Set<string>(Array.isArray(list?.sessions) ? list.sessions : []);
        } catch (err) {
          res.status(503).json({ error: `Could not start the review: ${(err as Error).message}` });
          return;
        }
        const names = reviewSessionNames(wsAccess.project.ownerUsername, wsAccess.project.name, wsAccess.workstream);
        const choice = chooseReviewSlot(names.map((name, i) => {
          const rec = getReviewRecord(wsAccess.host.instanceId, name);
          return { slot: i + 1, alive: live.has(name), pr: rec?.pr ?? null, url: rec?.url ?? null };
        }), { pr, url: cleanUrl });
        if ('full' in choice) {
          res.status(409).json({ error: `All ${MAX_REVIEW_SLOTS} review panes in this workstream are in use: stop or close one.`, code: 'reviews_full', reviews: workstreamReviews(wsAccess) });
          return;
        }
        access = withSlot(wsAccess, choice.slot);
        replaced = choice.replaces;
      }
      const promptPath = reviewPromptPath(home, access.session);
      const pane = exactPaneTarget(access.session);
      try {
        // The prompt goes in a file Devin reads (--prompt-file), never through
        // shell quoting, so an edited prompt may hold quotes and newlines.
        const content = group
          ? buildGroupReviewPrompt(group, reviewerName(reviewer))
          : buildReviewPrompt(pr, cleanUrl, body.body ?? template!.template, reviewerName(reviewer));
        await sendForProject(access.host, 'write-file', { path: promptPath, content, mode: 0o600 }, 5000);
        // A review in this pane already (off: any review; on: this PR's) is replaced: fresh shell, fresh reviewer.
        // Exact targets throughout: a bare name prefix-matches a sibling slot once its own pane is gone.
        const has = await sendForProject(access.host, 'tmux-has-session', { sessionName: pane }, 5000);
        if (has?.exists) {
          replaced = true;
          await sendForProject(access.host, 'tmux-kill', { sessionName: pane }, 5000);
        }
        await sendForProject(access.host, 'tmux-create', { sessionName: access.session, cwd }, 15000);
        // Best effort: an older agent answers "Unknown command" and the launch echo covers recovery.
        await sendForProject(access.host, 'tmux-set-user-option', { sessionName: pane, name: PR_OPTION, value: encodePrOption(pr, cleanUrl, reviewer) }, 5000).catch(() => {});
        await new Promise(r => setTimeout(r, SHELL_SETTLE_MS));
        await sendForProject(access.host, 'tmux-send-keys', {
          sessionName: pane, keys: reviewLaunchCommand(access.session, reviewer), withEnter: true, literal: true,
        }, 5000);
      } catch (err) {
        res.status(503).json({ error: `Could not start the review: ${(err as Error).message}` });
        return;
      }
      const rec = registerReviewRecord(identityFor(access), { pr, url: cleanUrl, reviewer }, { startedByUserId: req.user!.id });
      const startedAt = rec.startedAt;
      const slots = parallel ? ` (slot ${access.slot} of ${workstreamReviews(access).length} running${replaced ? ', restarted' : ''})` : '';
      console.log(`[REVIEW] ${access.session}: ${reviewer} review of PR #${pr} started by ${req.user!.id}${slots}${target.mismatch ? ` (checkout is ${target.mismatch})` : ''}${group ? ` (review group "${group.name}", ${group.members.length} PRs)` : body.body ? ' (edited prompt)' : ` (prompt: ${template!.label ?? 'built-in'})`}`);
      res.status(201).json({ ok: true, session: access.session, slot: access.slot, replaced, pr, url: cleanUrl, reviewer, startedAt });
    });
  };

  const stop: RequestHandler = async (req, res) => {
    const access = await reviewPaneOr404(req, res);
    if (!access) return;
    if (!isProjectAgentConnected(access.host)) { res.status(503).json({ error: "Owner's agent is offline" }); return; }
    try {
      // Exact: stopping a gone `…-review` must not kill `…-review-2`.
      await sendForProject(access.host, 'tmux-kill', { sessionName: exactPaneTarget(access.session) }, 5000);
    } catch (err) {
      res.status(503).json({ error: `Could not stop the review: ${(err as Error).message}` });
      return;
    }
    // Only after the kill succeeded: a live session must keep its record.
    clearReviewRecord(identityFor(access));
    res.json({ ok: true, session: access.session });
  };

  const seen: RequestHandler = async (req, res) => {
    const access = await reviewPaneOr404(req, res);
    if (!access) return;
    const marked = markReviewSeen(access.host.instanceId, access.session);
    // A missing record answers 404: nothing to mark. (A pane whose agent is
    // offline — the sweep froze its state — still marks: seen is about the
    // viewer, not the agent.)
    if (!marked) { res.status(404).json({ error: 'No review running for this workstream' }); return; }
    res.json({ ok: true });
  };

  // asyncHandler: Express 4 drops async rejections (a DB error, a
  // SessionAccessError from workstreamPaths) on the floor and the request hangs;
  // wrapped, they reach apiErrorHandler and answer with JSON.
  router.get('/projects/:id/review/guess', requireAuth, asyncHandler(guess));
  router.get('/projects/:id/review', requireAuth, asyncHandler(status));
  router.post('/projects/:id/review', requireAuth, asyncHandler(start));
  router.delete('/projects/:id/review', requireAuth, asyncHandler(stop));
  router.post('/projects/:id/review/seen', requireAuth, asyncHandler(seen));
  // A start held while its box wakes (box-wake-on-action-enabled): its state and, failed, why, for the Review tab.
  router.get('/projects/:id/review/held', requireAuth, asyncHandler(async (req, res) => {
    const access = await accessOr404(req, res, 'review');
    if (!access) return;
    res.json({ held: deps.held.get(access.project.id, access.workstream) });
  }));
  return router;
}
