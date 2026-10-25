import { Router, Request, RequestHandler } from 'express';
import { prisma } from '../db';
import {
  setStatus, getStatus, getAllStatuses, updateStatusMeta, notifyStatusChange, armMilestoneTimer, clearMilestoneTimer,
} from '../services/status';
import { milestoneOnReading, parseMilestoneBody } from '../services/milestone';
import { recordCreatedLink } from '../services/workstreamPrs';
import { AgentStatus } from '../types/index';
import { validateAgentToken } from './agentTokens';
import { getAllNotificationTargets } from '../slack/lts';
import { getSlackApp } from '../slack/app';
import { getDiscordClient } from '../discord/app';
import { formatPaneForSlack, sessionBelongsToUser, sessionName } from '../services/tmux';
import { SESSION_ROLES } from '../services/sessionAccess';
// Capture must route through the per-user agent (the backend can't see the
// user's tmux in-process), same as the /t command path. Without this, the
// needs-input notification rendered "(unable to capture pane)".
import { capturePaneForSlack } from '../slack/tmuxAgent';
import { formatPaneForDiscord } from '../discord/formatting';
import { recordHeartbeat } from '../services/humanActivity';
import { noteBoxActivity } from '../services/boxActivity';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { isLocalPeer } from '../auth/peerAddress';
import { resolveSessionProject } from '../services/sessionResolver';
import { recordContextSample } from '../services/contextSampler';
import { debugLog } from '../services/debugLog';
import { statusKey } from '../services/statusKey';
import { isRunnerSessionOf } from '../services/claudeRunnerSpawn';
import { sendResult, type RouteResult } from './routeResult';
import { pushOnWaitingTransition, waitingChatMuted } from '../services/pushWaiting';
import { settleTurnPost, T3_SERVER_SESSION } from '../services/sessionTurns';


const statusTracking = new Map<string, {
  workingStartedAt: number | null;
  lastNotifiedAt: number | null;
}>();

const NOTIFY_COOLDOWN = 30_000; // 30s between notifications
const MIN_WORKING_DURATION = 30_000; // only notify "finished" if worked > 30s

// Status writes: same-host callers (the Claude Code hooks curl localhost:3040)
// are trusted as they always have been — the orchestrator host is the local
// trust boundary. Remote callers (e.g. a box, which now reaches :3040 directly
// over the private VPC rather than only through the Okta-gated ALB) must present
// a valid agent token or browser session; postStatus then scopes them to their
// own sessions.
//
// isLocalPeer() is what makes "same host" survive the nginx gateway: once nginx
// fronts the backend every socket peer is loopback, so the socket alone would
// hand this trust to every ALB and VPC client. See auth/peerAddress.ts.
const authStatusWrite: RequestHandler = (req, res, next) => {
  if (isLocalPeer(req)) {
    next();
    return;
  }
  void requireAuthOrAgentToken(req, res, next);
};

// Loopback posts are the orchestrator (instance null) even when they carry no
// token. Remote posts are authenticated; the instance comes from the agent
// token requireAuthOrAgentToken already validated.
function writeInstanceId(req: Request): string | null {
  if (!req.user) return null;
  return req.agentInstanceId ?? null;
}

/**
 * May this authenticated remote caller write `session`? Its own sessions
 * (`<unixUsername>-...`), and, for an instance-bound token, the runner
 * sessions of that box: a Claude Code cloud session's status hooks post under
 * the runner's tmux name, which starts with the box's unix user
 * (services/claudeRunnerSpawn.ts, isRunnerSessionOf). The box row is read
 * once per post; the hooks post a few times a minute at most. Also, for an
 * instance-bound token, that box's t3 server session: a desktop thread
 * outside every project's checkout posts there (services/sessionTurns.ts),
 * and the key is the box's own, so it reaches no project.
 */
async function callerMayWrite(req: Request, session: string): Promise<boolean> {
  if (!req.user) return true; // loopback: the orchestrator's own hooks
  if (sessionBelongsToUser(session, req.user.unixUsername)) return true;
  if (!req.agentInstanceId) return false;
  if (session === T3_SERVER_SESSION) return true;
  try {
    const box = await prisma.instance.findUnique({ where: { id: req.agentInstanceId }, select: { hostUnixUser: true } });
    return isRunnerSessionOf(session, box?.hostUnixUser);
  } catch (err) {
    // Fail closed: a post that cannot be attributed is refused, not trusted.
    console.warn(`[STATUS] could not read box ${req.agentInstanceId} for the ownership check:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * POST heartbeat { project, instanceId? }: the user is typing into this project
 * right now, for human-activity attribution. Shared by the cookie route and
 * POST /api/cli/v1/heartbeat (routes/cliTui.ts), which a remote attach in the
 * TUI sends while keys flow. Takes the project NAME, as the browser sends it.
 */
export function heartbeatFor(user: { id: string; unixUsername: string }, body: unknown): RouteResult {
  const { project, instanceId } = (body ?? {}) as { project?: unknown; instanceId?: unknown };
  if (!project || typeof project !== 'string') {
    return { status: 400, body: { error: 'project required' } };
  }
  const instance = instanceId === undefined ? undefined : typeof instanceId === 'string' ? instanceId : null;
  recordHeartbeat(user.unixUsername, project, instance ?? null);
  // Touch lastActiveAt for sort ordering. When the client names an instance
  // (including null for this host), only that project moves.
  prisma.project.updateMany({
    where: {
      userId: user.id,
      name: project,
      ...(instance !== undefined ? { instanceId: instance } : {}),
    },
    data: { lastActiveAt: new Date() },
  }).then(moved => {
    // Only a box the caller has a project on: the body's instanceId is the client's word.
    if (moved.count > 0 && instance) noteBoxActivity(instance);
  }).catch(() => {});
  return { status: 200, body: { ok: true } };
}

export function statusRouter(): Router {
  const router = Router();

  const postStatus: RequestHandler = async (req, res) => {
    const { session, status, message, notify, source, waitingReason, activityScore, tokenBurst, activeTurn, threadId, contextTokens, rateLimited } = req.body as {
      session?: string;
      status?: AgentStatus['status'];
      message?: string;
      notify?: boolean;
      source?: AgentStatus['source'];
      waitingReason?: AgentStatus['waitingReason'];
      activityScore?: number;
      tokenBurst?: number;
      activeTurn?: boolean;
      threadId?: string;
      contextTokens?: number;
      rateLimited?: string | null;
    };

    if (!session) {
      res.status(400).json({ error: 'session required' });
      return;
    }

    // Scope authenticated (remote) callers to their OWN sessions. Session names
    // are "<unixuser>-<project>-agent"; the leading segment is the owning unix
    // user, which must match the agent token's / session's user. Loopback
    // writers (same-host Claude hooks — see authStatusWrite) carry no req.user
    // and keep their prior trust. This stops a compromised box, which now
    // reaches :3040 directly over the VPC, from forging status + notifications
    // for another user's sessions across projects.
    if (!(await callerMayWrite(req, session))) {
      res.status(403).json({ error: 'forbidden: session not owned by caller' });
      return;
    }

    const instanceId = writeInstanceId(req);

    // Metadata-only update (e.g. contextTokens from agent scanner, rateLimited from pane scanner)
    if (!status && (contextTokens !== undefined || rateLimited !== undefined)) {
      // A pending "PR opened — compact or clear?" prompt follows the context
      // reading: a reading that DROPS to a fraction of the recorded size means
      // the conversation was compacted or cleared, so the prompt is resolved;
      // a reading in the same ballpark refreshes the recorded size; a NULL
      // reading is ignored — the scanner posts null whenever the transcript is
      // merely 10 minutes stale, which every idle session hits long before the
      // prompt's 30-minute TTL and says nothing about a reset.
      const key = statusKey(instanceId, session);
      const pending = getAllStatuses().get(key)?.milestone ?? null;
      let milestonePatch: { milestone: AgentStatus['milestone'] } | Record<string, never> = {};
      if (pending && contextTokens !== undefined) {
        const verdict = milestoneOnReading(pending, contextTokens);
        if (verdict === 'resolve') { milestonePatch = { milestone: null }; clearMilestoneTimer(session, instanceId); }
        else if (verdict === 'update') milestonePatch = { milestone: { ...pending, contextTokens: contextTokens as number } };
      }
      updateStatusMeta(session, {
        ...(contextTokens !== undefined && { contextTokens }),
        ...(rateLimited !== undefined && { rateLimited }),
        ...milestonePatch,
      }, instanceId);
      notifyStatusChange(session, instanceId);
      // Persist context occupancy over time (fire-and-forget; never block the
      // response). null tokens = expired context → recordContextSample gaps it.
      if (contextTokens !== undefined) {
        resolveSessionProject(session, instanceId).then(r => {
          if (r && 'projectId' in r && r.projectId && r.workstream) {
            recordContextSample(r.projectId, r.workstream, contextTokens as number | null);
          }
        }).catch(() => {});
      }
      res.json({ ok: true, status: getStatus(session, instanceId) });
      return;
    }

    if (!status) {
      res.status(400).json({ error: 'status required' });
      return;
    }

    const validStatuses: AgentStatus['status'][] = ['working', 'waiting', 'idle', 'not_running'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'invalid status' });
      return;
    }

    // One per status hook, so a debug line (TERMAG_DEBUG=STATUS); the
    // transition itself is the agent.status.changed product event.
    debugLog('STATUS', () => `POST session=${session} status=${status} notify=${notify} source=${source ?? 'unknown'} thread=${threadId ?? '-'} waitingReason=${waitingReason ?? 'null'} message=${message?.slice(0, 50)}`);

    // Read before the write: the web push fires on the transition INTO waiting.
    const previousStatus = getAllStatuses().get(statusKey(instanceId, session))?.status;

    // The post reports one turn; with desktop threads in the same checkout
    // the session's status is the busiest turn's (services/sessionTurns.ts).
    // Anywhere else `effective` is the post itself.
    const effective = settleTurnPost(statusKey(instanceId, session), { status, source, threadId, message, waitingReason });

    const updated = setStatus(session, effective.status, {
      message: effective.message,
      source: effective.source,
      waitingReason: effective.waitingReason,
      activityScore,
      tokenBurst,
      activeTurn,
      threadId: effective.threadId,
      contextTokens,
      rateLimited,
    }, undefined, instanceId);
    notifyStatusChange(session, instanceId);

    // Web push to the session owner's devices (services/pushWaiting.ts). Not
    // behind `notify` or the Slack/Discord targets; fire and forget, it never
    // throws and never holds up this response. Like the Slack and Discord
    // posts below, it follows the post rather than the session's settled
    // status: a turn that needs input says so while another turn works.
    pushOnWaitingTransition({ session, instanceId, prev: previousStatus, next: status, message, waitingReason });

    // Touch lastActiveAt when agent starts working (for project sort order).
    if (effective.status === 'working') {
      const sessionMatch = session.match(/^(.+?)-(.+)-agent$/);
      if (sessionMatch) {
        const [, username, projectName] = sessionMatch;
        prisma.project.updateMany({
          where: { name: projectName, instanceId, user: { unixUsername: username } },
          data: { lastActiveAt: new Date() },
        }).catch(() => {});
      }
    }

    const now = Date.now();
    const trackKey = statusKey(instanceId, session);
    const existing = statusTracking.get(trackKey) || { workingStartedAt: null, lastNotifiedAt: null };

    if (status === 'working' && !existing.workingStartedAt) {
      existing.workingStartedAt = now;
    }

    const workingDuration = (status !== 'working' && existing.workingStartedAt)
      ? now - existing.workingStartedAt
      : 0;

    if (status !== 'working') {
      existing.workingStartedAt = null;
    }

    // Notifications to all registered platforms. An owner with pushMutesChat
    // and a live push subscription gets "needs input" on the phone instead;
    // this post is waiting-or-done, so skipping it whole keeps Done intact.
    if (notify && !(status === 'waiting' && await waitingChatMuted(session, instanceId))) {
      const targets = await getAllNotificationTargets(session, instanceId);
      const timeSinceNotify = existing.lastNotifiedAt ? now - existing.lastNotifiedAt : Infinity;

      if (targets.length > 0 && timeSinceNotify > NOTIFY_COOLDOWN) {
        const pane = await capturePaneForSlack(session, 200, instanceId);

        for (const target of targets) {
          try {
            if (target.platform === 'slack') {
              const slackApp = getSlackApp();
              if (!slackApp) continue;

              if (status === 'waiting') {
                existing.lastNotifiedAt = now;
                const { trackPaneMessage, addReactionHints } = await import('../slack/events');
                const msg = await slackApp.client.chat.postMessage({
                  channel: target.channel,
                  ...formatPaneForSlack(pane, message || null, session, 'idle'),
                });
                trackPaneMessage(target.channel, msg.ts, session, target.userId, instanceId);
                await addReactionHints(slackApp.client, target.channel, msg.ts, pane);
              } else if (status === 'idle' && workingDuration > MIN_WORKING_DURATION) {
                existing.lastNotifiedAt = now;
                await slackApp.client.chat.postMessage({
                  channel: target.channel,
                  text: `Done — \`${session}\``,
                });
              }
            } else if (target.platform === 'discord') {
              const discord = getDiscordClient();
              if (!discord) continue;

              const channel = await discord.channels.fetch(target.channel);
              if (!channel?.isTextBased() || !('send' in channel)) continue;

              if (status === 'waiting') {
                existing.lastNotifiedAt = now;
                const { trackDiscordPaneMessage, addDiscordReactionHints } = await import('../discord/events');
                const msg = await (channel as any).send(formatPaneForDiscord(pane, message || null, session));
                trackDiscordPaneMessage(target.channel, msg.id, session, target.userId, instanceId);
                await addDiscordReactionHints(msg, pane);
              } else if (status === 'idle' && workingDuration > MIN_WORKING_DURATION) {
                existing.lastNotifiedAt = now;
                await (channel as any).send(`Done — \`${session}\``);
              }
            }
          } catch (err) {
            console.error(`[STATUS] ${target.platform} notification failed:`, (err as Error).message);
          }
        }
      }
    }

    statusTracking.set(trackKey, existing);

    res.json({ ok: true, status: updated });
  };

  const getStatusHandler: RequestHandler = async (req, res) => {
    // The per-user agent reads this to correct a stale "waiting". This handler
    // is the route's only gate: boxes reach it past the ALB's Okta gate, and a
    // box's token may be ownerless (warm pool), which requireAuthOrAgentToken
    // refuses. An `agent`-scoped token scopes the read to that token's box; any
    // other presented token (admin, client, revoked, expired) is refused even
    // from this host. A same-host caller without one reads the orchestrator
    // key. Anyone else gets nothing.
    let instanceId: string | null = null;
    const authHeader = req.headers.authorization ?? '';
    if (authHeader.startsWith('Bearer ')) {
      const token = await validateAgentToken(authHeader.slice(7)).catch(() => null);
      if (!token || token.token.scope !== 'agent') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      instanceId = token.instance?.id ?? null;
    } else if (!isLocalPeer(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // This read is not project-scoped (a tokenless caller gets the orchestrator
    // key), so never hand out the milestone here: its URL names a repo and PR
    // the caller may not be allowed to see. Same for the review's PR URL — the
    // same leak, same omission. The agent that reads this route uses neither.
    const { milestone: _omit, review: _omitReview, ...status } = getStatus(req.params.session, instanceId);
    res.json(status);
  };

  const heartbeat: RequestHandler = (req, res) => sendResult(res, heartbeatFor(req.user!, req.body));

  // POST /api/status/milestone { session, kind, url? } — from the PostToolUse
  // hook (deploy/termag-status post-tool) when the agent opened or merged a PR.
  // Same trust model as status writes: loopback is the orchestrator's own
  // hooks; remote callers carry the agent token and may only name their own
  // sessions. The UI turns this into "PR opened — Compact / Clear / Keep".
  const postMilestone: RequestHandler = async (req, res) => {
    const parsed = parseMilestoneBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const { session, kind, url } = parsed;
    if (!(await callerMayWrite(req, session))) {
      res.status(403).json({ error: 'forbidden: session not owned by caller' });
      return;
    }
    const instanceId = writeInstanceId(req);
    // The hook's own `working` post normally precedes this, so an entry exists;
    // if not (first event we ever saw for the session), create one as working —
    // the tool call that produced the milestone is still in flight.
    const key = statusKey(instanceId, session);
    const existing = getAllStatuses().get(key);
    // Capture the current context size: the prompt gates and displays on this,
    // not on the live reading, which goes null on its own once idle (see the
    // metadata-only path above).
    const milestone = { kind, url, at: new Date(), contextTokens: existing?.contextTokens ?? null };
    if (existing) updateStatusMeta(session, { milestone }, instanceId);
    else setStatus(session, 'working', { milestone }, undefined, instanceId);
    notifyStatusChange(session, instanceId);
    console.log(`[STATUS] milestone ${kind} for ${session}${url ? ` (${url})` : ''}`);
    // The PR belongs to this workstream from now on (services/workstreamPrs.ts), wherever its worktree is.
    if (kind === 'pr_created') {
      recordCreatedLink(session, instanceId, url).catch(err => {
        console.warn(`[STATUS] could not store the PR link for ${session}:`, err instanceof Error ? err.message : String(err));
      });
    }

    // Nobody acted on it → drop it after the TTL so a stale prompt never shows.
    armMilestoneTimer(session, instanceId);
    res.json({ ok: true });
  };

  // POST /api/status/milestone/dismiss { session, instanceId? } — the user
  // clicked Keep (or acted on it). Browser-authenticated. Allowed for the
  // session's owner, or a collaborator on its project (ProjectShare is the
  // product's session ACL — the same people send-keys lets act on the pane).
  const dismissMilestone: RequestHandler = async (req, res) => {
    const { session, instanceId } = req.body as { session?: string; instanceId?: string | null };
    if (typeof session !== 'string' || !session) { res.status(400).json({ error: 'session required' }); return; }
    const inst = typeof instanceId === 'string' ? instanceId : null;
    let allowed = sessionBelongsToUser(session, req.user!.unixUsername);
    if (!allowed) {
      // Collaborator: rebuild the legal session names of every project shared
      // with the caller and look for an exact match (same approach as
      // assertSessionAccess). Parsing the owner out of the session string is
      // not an option — unix usernames can contain hyphens.
      const shares = await prisma.projectShare.findMany({
        where: { userId: req.user!.id },
        include: { project: { include: { user: { select: { unixUsername: true } }, workstreams: { select: { name: true } } } } },
      });
      allowed = shares.some(({ project: p }) => {
        if ((p.instanceId ?? null) !== inst) return false;
        const wsNames = p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'];
        return wsNames.some(ws => SESSION_ROLES.some(role => sessionName(p.user.unixUsername, p.name, role, ws) === session));
      });
    }
    if (!allowed) {
      res.status(403).json({ error: 'forbidden: not the owner or a collaborator on this session' });
      return;
    }
    clearMilestoneTimer(session, inst);
    updateStatusMeta(session, { milestone: null }, inst);
    notifyStatusChange(session, inst);
    res.json({ ok: true });
  };

  router.post('/', authStatusWrite, postStatus);
  router.post('/milestone', authStatusWrite, postMilestone);
  router.post('/milestone/dismiss', requireAuth, dismissMilestone);
  router.post('/heartbeat', requireAuth, heartbeat);
  // Was unauthenticated: anyone who knew a session name could read its status.
  // The UI gets status over the WebSocket, so nothing legitimate loses access.
  router.get('/:session', getStatusHandler);

  return router;
}
