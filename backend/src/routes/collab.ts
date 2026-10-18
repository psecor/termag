/**
 * Slack collaboration routes.
 *
 *   POST /api/collab/drafts    a draft from an agent (previewed in the
 *                              sender's Slack DM) or the web form (sent at
 *                              once with send: true: the form is the preview)
 *   GET  /api/collab/requests  the caller session's requests and their
 *                              replies (the agent's inbox), or the user's own
 *
 * Box token or browser session. An agent can only ever draft: posting needs
 * the sender's own Send, in Slack or in the web form. Behind the
 * slack-collab-enabled flag (off unless TERMAG_FLAGS turns it on).
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { slackIdFor } from '../services/briefing/slack';
import { COLLAB_FLAG, draftSecrets, parseDraft, strings } from '../services/collab';
import { boolVariation } from '../services/featureFlags';
import { getSlackApp } from '../slack/app';
import { deliverPreview, resolvePeople, sendRequest } from '../slack/collab';
import { RouteResult, sendResult } from './routeResult';
import { resolveCaller } from './spawns';

/** Drafts per user per hour: an agent stuck in a loop can only fill its own person's DMs so far. */
export const DRAFTS_PER_HOUR = 20;

const disabled: RouteResult = {
  status: 403,
  body: { error: `Slack collaboration is not enabled for you (feature flag ${COLLAB_FLAG})`, code: 'collab_disabled' },
};

/**
 * `callerInstanceId` undefined = a browser session; anything else is an
 * agent token (see requireAuthOrAgentToken).
 */
export async function draftFor(user: Express.User, callerInstanceId: string | null | undefined, raw: unknown): Promise<RouteResult> {
  if (!(await boolVariation(COLLAB_FLAG, user, false))) return disabled;
  const parsed = parseDraft(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const d = parsed.value;
  const secrets = draftSecrets(d);
  if (secrets.length) {
    return { status: 400, body: { error: `the draft looks like it contains a secret (${secrets.join(', ')}); take it out and draft again`, code: 'secret' } };
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  const fromAgent = callerInstanceId !== undefined;

  const recent = await prisma.collabRequest.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } });
  if (recent >= DRAFTS_PER_HOUR) {
    return { status: 429, body: { error: `Slack collaboration rate limit: ${DRAFTS_PER_HOUR} drafts per hour`, code: 'rate_limited' } };
  }

  let projectId: string;
  let workstream: string;
  let from: { session: string; role: string | null; instanceId: string | null } | null = null;
  if (fromAgent) {
    if (typeof r.session !== 'string' || !r.session) {
      return { status: 400, body: { error: 'session required: an agent drafts from its own pane (the metaterm MCP server sends it)' } };
    }
    const found = await resolveCaller(user, r.session, callerInstanceId);
    if (!found.ok) return found.result;
    const c = found.value;
    if (c.role !== 'agent') return { status: 400, body: { error: `only an agent pane can draft (${c.session} is a ${c.role ?? 'unknown'} pane)` } };
    projectId = c.projectId;
    workstream = c.workstream;
    from = { session: c.session, role: c.role, instanceId: c.instanceId };
  } else {
    if (typeof r.projectId !== 'string' || !r.projectId) return { status: 400, body: { error: 'projectId required' } };
    const project = await prisma.project.findFirst({ where: { id: r.projectId, userId: user.id, archived: false }, select: { id: true } });
    if (!project) return { status: 404, body: { error: 'project not found' } };
    projectId = project.id;
    workstream = typeof r.workstream === 'string' && r.workstream ? r.workstream : 'main';
    // Only a real workstream: a made-up name would get its own #proj-… channel
    // and an inbox no session reads.
    if (workstream !== 'main') {
      const ws = await prisma.workstream.findFirst({ where: { projectId, name: workstream, archived: false }, select: { id: true } });
      if (!ws) return { status: 404, body: { error: `no workstream ${workstream} in that project` } };
    }
  }

  const client = getSlackApp()?.client;
  if (!client) return { status: 503, body: { error: 'Slack is not configured on this orchestrator' } };
  const senderSlackId = await slackIdFor(client, user);
  if (!senderSlackId) {
    return { status: 400, body: { error: `termag could not find a Slack account for ${user.googleEmail} in the termag Slack workspace`, code: 'no_slack' } };
  }
  const { ids: people, missing } = await resolvePeople(client, d.to.people ?? []);
  if (missing.length) return { status: 400, body: { error: `no Slack account for ${missing.join(', ')} in the termag workspace` } };

  const sendNow = !fromAgent && r.send === true;
  const row = await prisma.collabRequest.create({
    data: {
      userId: user.id,
      kind: d.kind,
      ask: d.ask,
      context: d.context,
      tried: d.tried ?? null,
      helpWanted: d.helpWanted ?? null,
      evidence: d.evidence ?? null,
      links: d.links,
      projectId,
      workstream,
      fromSession: from?.session ?? null,
      fromRole: from?.role ?? null,
      fromInstanceId: from?.instanceId ?? null,
      origin: fromAgent ? 'agent' : 'web',
      toChannel: d.to.channel ?? null,
      toPeople: people,
    },
  });

  if (sendNow) {
    const out = await sendRequest(row.id, senderSlackId, { authenticatedSender: true });
    if (!out.ok) {
      // Not posted (still a draft): the web form shows the error and is the
      // way to retry, and a draft with no preview DM could never be sent, so
      // it goes. A row Slack did accept ("sending") is kept.
      await prisma.collabRequest.deleteMany({ where: { id: row.id, state: 'draft' } }).catch(() => {});
      return { status: 502, body: { error: out.error } };
    }
    return { status: 201, body: { id: row.id, state: 'open', permalink: out.permalink } };
  }
  const previewed = await deliverPreview(row.id);
  if (!previewed) return { status: 502, body: { error: 'the draft was saved but the Slack preview could not be sent', id: row.id } };
  return {
    status: 201,
    body: {
      id: row.id,
      state: 'draft',
      note: 'A preview is in your Slack DMs from the termag bot. Nothing is posted until you press Send there.',
    },
  };
}

function view(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    ask: row.ask,
    state: row.state,
    workstream: row.workstream,
    permalink: row.permalink,
    sentAt: row.sentAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    responses: (row.responses ?? []).map((x: any) => ({
      id: x.id, from: x.responderName ?? x.responderSlackId, fromSlackId: x.responderSlackId,
      text: x.text, source: x.source, at: x.createdAt,
    })),
    toPeople: strings(row.toPeople),
  };
}

/** With a session: that pane's workstream's requests (its inbox). Without: the user's recent ones. */
export async function requestsFor(user: Express.User, callerInstanceId: string | null | undefined, session: unknown): Promise<RouteResult> {
  if (!(await boolVariation(COLLAB_FLAG, user, false))) return disabled;
  const include = { responses: { orderBy: { createdAt: 'asc' as const } } };
  if (typeof session === 'string' && session) {
    const found = await resolveCaller(user, session, callerInstanceId);
    if (!found.ok) return found.result;
    const c = found.value;
    const rows = await prisma.collabRequest.findMany({
      where: { userId: user.id, projectId: c.projectId, workstream: c.workstream, state: { not: 'canceled' } },
      orderBy: { createdAt: 'desc' }, take: 10, include,
    });
    return { status: 200, body: { session, requests: rows.map(view) } };
  }
  const rows = await prisma.collabRequest.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 20, include });
  return { status: 200, body: { requests: rows.map(view) } };
}

export function collabRouter(): Router {
  const router = Router();
  router.post('/collab/drafts', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await draftFor(req.user!, req.agentInstanceId, req.body));
  }));
  router.get('/collab/requests', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await requestsFor(req.user!, req.agentInstanceId, req.query.session));
  }));
  return router;
}
