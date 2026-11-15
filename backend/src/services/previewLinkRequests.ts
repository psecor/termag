/**
 * An agent on a box asking for a preview link
 * ("CLI"; PRD P4; security review SR5): `termag preview request <port>
 * [--note]`, POST /api/cli/v1/preview-link-requests, the one preview route a
 * box's own token may call.
 *
 * The ask names a port of a workstream of a project on the token's own box,
 * and an optional note. Nothing else: an agent can't choose the audience, the
 * name, the lifetime or the people, can't publish, approve or decline, and
 * sees no link. A body naming any of those is refused, so an agent is told so
 * rather than believing it chose.
 *
 * It records a PreviewLinkRequest (rows 1 and 3 built the rest: the links
 * list shows it with Publish… and Decline, a publish naming it marks it
 * approved, and the sweep expires it after 24 h), then tells the owner: a
 * workspace push, so an open links list shows it, and a Slack DM. The DM
 * carries a one-time confirm page for the defaults (SR5's browser confirm,
 * services/previewLinkConfirmations.ts): "only me", the suggested name, the
 * server's lifetime. One click there publishes; Decline declines the request.
 * The note is the agent's words, shown only as quoted, escaped text.
 *
 * At most REQUESTS_PER_HOUR per box; a repeat of a pending ask (same
 * project, workstream and port) answers that request again without a new DM.
 */
import { prisma } from '../db';
import type { RouteResult } from '../routes/routeResult';
import { askForAgentRequest, defaultConfirmationDeps, type ConfirmationDeps } from './previewLinkConfirmations';
import { previewLinkRequestsEnabled } from './previewLinkFlags';
import type { PreviewLinkProject } from './previewLinks';
import { nameDecision, nameRefusal, suggestName } from './previewLinkRules';
import { linkRequested } from './previewLinkTelemetry';
import { notifyWorkspaceChange } from './workspaceEvents';

export const REQUESTS_PER_HOUR = 10;
/**
 * How long an answered request (approved, declined, expired) answers a repeat ask for its port instead of asking
 * the owner again: about a working day, so a looping or prompt-injected agent can't turn a decline into a fresh
 * one-click DM every few minutes, and the next day's work can still ask once more (#1568).
 */
export const ANSWERED_COOLDOWN_HOURS = 12;
export const NOTE_MAX = 200;
const HOUR_MS = 3600_000;
/** What an agent may say; anything else in the body is refused (an agent can only ask). */
const ALLOWED_KEYS = new Set(['project', 'workstream', 'port', 'note']);

export interface RequestRow {
  id: string;
  projectId: string;
  workstreamId: string | null;
  boxId: string;
  port: number;
  note: string | null;
  state: string;
  createdAt: Date;
  /** When the owner (or the 24 h expiry) answered it. */
  decidedAt?: Date | null;
}

export type RequestClaim = { kind: 'repeat'; row: RequestRow } | { kind: 'answered'; row: RequestRow } | { kind: 'limited' } | { kind: 'created'; row: RequestRow };

export interface RequestStore {
  /**
   * In one step, under the box's lock (Bugbot, #1568): a pending request for the same port of the same
   * workstream answers as `repeat`; one the owner answered (approved, declined or expired) since `answeredSince`,
   * as `answered`, with no new request; past `limit` requests since `since` from this box, `limited`; else the
   * new row, `created`. Two asks at once can't both insert, nor slip past the limit.
   */
  claim(row: Omit<RequestRow, 'id' | 'state' | 'createdAt'>, since: Date, limit: number, answeredSince: Date): Promise<RequestClaim>;
  /** Take back a request whose owner couldn't be asked: it no longer stands in the way of a retry. */
  withdraw(id: string, at: Date): Promise<void>;
}

export interface Owner { id: string; googleEmail: string; displayName: string; slackUserId: string | null }

export interface RequestDeps {
  store: RequestStore;
  confirm: ConfirmationDeps;
  /** The box's live project named `name`, with its owner; null when there is none. */
  findProjectOnBox(boxId: string, name: string): Promise<(PreviewLinkProject & { owner: Owner }) | null>;
  /** preview-links-agent-requests-enabled for the owner and box. */
  requestsOn(project: PreviewLinkProject): Promise<boolean>;
  notifySlack(owner: Owner, text: string): Promise<void>;
  workspaceChanged(ownerId: string): void;
  event(userId: string, boxId: string, detail: Record<string, unknown>): void;
  now(): Date;
}

function err(status: number, code: string, error: string, extra: Record<string, unknown> = {}): RouteResult {
  return { status, body: { error, code, ...extra } };
}

const NOT_FOUND: RouteResult = { status: 404, body: { error: 'Not found', code: 'not_found' } };

/** A note as the agent wrote it, on one line, bounded; control characters dropped. */
export function cleanNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  // C0 and C1 controls, and the line and paragraph separators, as spaces.
  const s = String(raw).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, NOTE_MAX) : null;
}

/** Slack mrkdwn treats &, < and > as markup (links, @-mentions, @channel): an agent's note is text only. */
export function slackText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * An agent's note as Slack shows it: escaped, inside an inline code span, where
 * Slack neither auto-links a bare URL nor reads formatting; its own backticks
 * become quotes, so it can't close the span or open a block beside the real
 * confirm link (Bugbot, #1568).
 */
export function slackQuote(note: string): string {
  return '`' + slackText(note).replace(/`/g, "'") + '`';
}

/** POST /api/cli/v1/preview-link-requests, for a box's own token: the box is `boxId`. */
export async function requestPreviewLinkFor(deps: RequestDeps, boxId: string, body: unknown): Promise<RouteResult> {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const extra = Object.keys(b).filter(k => !ALLOWED_KEYS.has(k));
  if (extra.length) {
    return err(400, 'not_allowed', `An agent can only ask for a port; the owner chooses who sees it, its name and how long (not: ${extra.slice(0, 5).join(', ')})`);
  }
  const port = b.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return err(400, 'bad_port', 'port must be 1 to 65535');
  if (typeof b.project !== 'string' || !b.project) return err(400, 'bad_request', 'Name the project');
  const workstream = typeof b.workstream === 'string' && b.workstream ? b.workstream : 'main';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workstream)) return err(400, 'bad_request', 'Bad workstream');
  const note = cleanNote(b.note);

  const project = await deps.findProjectOnBox(boxId, b.project);
  // Off, or nothing of that name on this box: the same 404.
  if (!project || !(await deps.confirm.links.enabled(project.owner as never, project.instance)) || !(await deps.requestsOn(project))) return NOT_FOUND;
  const ws = await deps.confirm.links.findWorkstream(project.id, workstream);
  if (!ws) return err(404, 'workstream_not_found', 'Workstream not found');

  const now = deps.now();
  const claimed = await deps.store.claim({ projectId: project.id, workstreamId: ws.id, boxId, port, note }, new Date(now.getTime() - HOUR_MS), REQUESTS_PER_HOUR, new Date(now.getTime() - ANSWERED_COOLDOWN_HOURS * HOUR_MS));
  if (claimed.kind === 'answered') {
    // Answered lately: the agent learns how, and when; the owner isn't asked again (#1568). Never the
    // link or its address, which only the owner sees.
    const r = claimed.row;
    return { status: 200, body: { state: r.state, decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null, askAgainAfter: new Date((r.decidedAt ?? r.createdAt).getTime() + ANSWERED_COOLDOWN_HOURS * HOUR_MS).toISOString(), request: view(r), repeated: true } };
  }
  if (claimed.kind === 'limited') {
    return err(429, 'rate_limited', `At most ${REQUESTS_PER_HOUR} requests an hour from one box`, { retryAfterSeconds: 3600 });
  }
  if (claimed.kind === 'repeat') {
    // Asked already: answered again, no second notice. A request whose owner never was asked (the ask failed and
    // so did taking it back, or the process went away between the two) asks them now (Bugbot, #1568).
    // An ask still telling the owner about it is joined, not raced: no second confirm or DM, and no withdraw of the
    // request it is telling them about (Bugbot, #1568).
    const inFlight = asking.get(claimed.row.id);
    if (!inFlight && await deps.confirm.store.askedFor(claimed.row.id)) return { status: 200, body: { state: 'pending', request: view(claimed.row), repeated: true } };
    const failed = await (inFlight ?? tellOwnerOnce(deps, project, claimed.row, workstream));
    return failed ?? { status: 200, body: { state: 'pending', request: view(claimed.row), repeated: true } };
  }
  const row = claimed.row;
  deps.event(project.owner.id, boxId, { port, hasNote: note !== null });
  return (await tellOwnerOnce(deps, project, row, workstream)) ?? { status: 201, body: { state: 'pending', request: view(row) } };
}

/**
 * The asks of the owner in flight, by request id. The claim's per-box lock ends before the owner is told, so a
 * repeat of the same request arriving meanwhile awaits this one instead of telling them a second time or, when its
 * own try fails, withdrawing the request this one is telling them about (Bugbot, #1568). In memory: the
 * orchestrator is one process (AGENTS.md, single replica).
 */
const asking = new Map<string, Promise<RouteResult | null>>();

function tellOwnerOnce(deps: RequestDeps, project: PreviewLinkProject & { owner: Owner }, row: RequestRow, workstream: string): Promise<RouteResult | null> {
  const inFlight = asking.get(row.id);
  if (inFlight) return inFlight;
  const told = tellOwner(deps, project, row, workstream).finally(() => { asking.delete(row.id); });
  asking.set(row.id, told);
  return told;
}

/** Ask the owner about `row`: its one-time confirm, a workspace push and a Slack DM. A RouteResult only when they couldn't be asked. */
async function tellOwner(deps: RequestDeps, project: PreviewLinkProject & { owner: Owner }, row: RequestRow, workstream: string): Promise<RouteResult | null> {
  const { port, note } = row;
  // The defaults, held for one click in the owner's browser: never wider than "only me".
  const name = await askName(deps, project, row, workstream);
  let confirmUrl: string;
  try {
    confirmUrl = await askForAgentRequest(deps.confirm, { id: project.owner.id, googleEmail: project.owner.googleEmail }, {
      projectId: project.id, fromBoxId: row.boxId, request: { workstream, port, name, audience: 'owner', requestId: row.id },
    });
  } catch {
    // The owner wasn't asked: the request is taken back, so a retry asks them afresh (Bugbot, #1568).
    await deps.store.withdraw(row.id, deps.now()).catch(() => {});
    return err(503, 'try_again', "termag couldn't ask the owner just now; try again in a moment");
  }
  deps.workspaceChanged(project.owner.id);
  const where = workstream === 'main' ? project.name : `${project.name}@${workstream}`;
  const said = note ? ` It says, in its own words (not checked): ${slackQuote(note)}` : '';
  await deps.notifySlack(project.owner,
    `An agent on your box asks to share port ${port} of ${slackText(where)} as a preview link, for you and the project's collaborators only.${said}\n`
    + `Publish it, as \`${name}\`: ${confirmUrl} (works once, for 10 minutes). Or decide in the project's Share dialog, where it waits 24 hours.`,
  ).catch(() => {});
  return null;
}

/**
 * The name an ask's one click publishes: the workstream's suggested name, with the port when that name is a live link
 * already or another pending request of the workstream would share it, so approving one never meets another's
 * name (Bugbot, #1568; the publish refuses a request's renew besides).
 */
async function askName(deps: RequestDeps, project: PreviewLinkProject, row: RequestRow, workstream: string): Promise<string> {
  const base = suggestName(project.name, workstream);
  const ok = (n: string) => nameRefusal(n) === null;
  // The port's own names, in order: base-port, then base-port-2 and on (app-port, and on, for a base too long or
  // reserved to carry it).
  const stem = base && ok(`${base}-${row.port}`) ? `${base}-${row.port}` : `app-${row.port}`;
  const portNames = [stem, ...Array.from({ length: 8 }, (_, i) => `${stem}-${i + 2}`)].filter(ok);
  const now = deps.now();
  const store = deps.confirm.links.store;
  // Preview names are global: one is usable only where this owner's publish here would make it, as the publish
  // itself decides (create, take or reclaim). A live link of this workstream would be a renew, which a request's
  // publish refuses; anyone else's live link or reservation, a refusal. Either spends the one-time confirm on a
  // refusal (Bugbot, #1568).
  const usable = async (n: string) => {
    const reservation = await store.withName(n, tx => tx.readName(n));
    const decision = nameDecision(reservation, { publisherId: project.userId, projectId: project.id, workstreamId: row.workstreamId }, now);
    return decision.kind === 'create' || decision.kind === 'take' || decision.kind === 'reclaim';
  };
  try {
    const pending = await store.pendingRequests(project.id);
    const others = pending.some(r => r.id !== row.id && r.workstreamId === row.workstreamId && r.port !== row.port);
    if (base && !others && await usable(base)) return base;
    for (const n of portNames) if (await usable(n)) return n;
  } catch {
    // Can't tell: the port's own name, which no other ask of this workstream shares.
  }
  return stem;
}

function view(r: RequestRow) {
  return { id: r.id, port: r.port, note: r.note, createdAt: r.createdAt.toISOString(), expiresAt: new Date(r.createdAt.getTime() + 24 * HOUR_MS).toISOString() };
}

export const prismaRequestStore: RequestStore = {
  async claim(row, since, limit, answeredSince) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preview-request:${row.boxId}`}))`;
      const pending = await tx.previewLinkRequest.findFirst({ where: { projectId: row.projectId, workstreamId: row.workstreamId, port: row.port, state: 'pending' }, orderBy: { createdAt: 'desc' } });
      if (pending) return { kind: 'repeat', row: pending } as const;
      const answered = await tx.previewLinkRequest.findFirst({ where: { projectId: row.projectId, workstreamId: row.workstreamId, port: row.port, state: { in: ['approved', 'declined', 'expired'] }, decidedAt: { gte: answeredSince } }, orderBy: { decidedAt: 'desc' } });
      if (answered) return { kind: 'answered', row: answered } as const;
      // An ask taken back because the owner was never told (withdrawn) doesn't count: retries through an outage
      // would spend the hour without asking anyone (Devin, #1568). Delivered ones count however they ended.
      if (await tx.previewLinkRequest.count({ where: { boxId: row.boxId, createdAt: { gte: since }, state: { not: 'withdrawn' } } }) >= limit) return { kind: 'limited' } as const;
      return { kind: 'created', row: await tx.previewLinkRequest.create({ data: row }) } as const;
    });
  },
  async withdraw(id, at) {
    await prisma.previewLinkRequest.updateMany({ where: { id, state: 'pending' }, data: { state: 'withdrawn', decidedAt: at } });
  },
};

export const defaultRequestDeps: RequestDeps = {
  store: prismaRequestStore,
  confirm: defaultConfirmationDeps,
  async findProjectOnBox(boxId, name) {
    const p = await prisma.project.findFirst({ where: { instanceId: boxId, name, archived: false }, include: { user: true, instance: true } });
    if (!p) return null;
    return { id: p.id, name: p.name, userId: p.userId, archived: p.archived, instanceId: p.instanceId, instance: p.instance, owner: p.user } as never;
  },
  requestsOn: (project) => previewLinkRequestsEnabled(project.owner, project.instance),
  async notifySlack(owner, text) {
    const { getSlackApp } = await import('../slack/app');
    const { slackIdFor } = await import('./briefing/slack');
    const client = getSlackApp()?.client;
    if (!client) return;
    const channel = await slackIdFor(client, owner);
    if (channel) await client.chat.postMessage({ channel, text });
  },
  workspaceChanged: (ownerId) => notifyWorkspaceChange(ownerId, 'preview-links'),
  event: (userId, boxId, detail) => linkRequested(userId, boxId, detail as { port: number; hasNote: boolean }),
  now: () => new Date(),
};
