/**
 * Publishing preview links:
 * the service behind the browser's routes (routes/previewLinks.ts) and the
 * CLI's (routes/cliPreviewLinks.ts). Each operation answers a RouteResult, so
 * both surfaces share it, and runs over a store, so its rules are unit tested
 * without a database (previewLinks.test.ts); prismaPreviewLinkStore is the
 * real one.
 *
 * Every write that touches a name runs under that name's lock
 * (`withName`, a Postgres advisory lock for the transaction), so two
 * publishes of one name, or a publish racing a revoke, see each other's
 * result. The reservation rules are services/previewLinkRules.ts's.
 *
 * A link is a delivery on a preview audience (services/previewAudience.ts):
 * who may open it, its expiry, its end, its grantees, viewers and events are
 * the audience's, written only through the core's AudienceOps; the link keeps
 * its name, port, host mode, its own token, codes and sessions. One audience
 * per link today. Ending the audience ends the link (installPreviewLinkDelivery
 * registers the end hook), whoever ends it: a revoke here, the sweep, or an
 * archived project or a removed workstream (endPreviewAudiences).
 *
 * Who: the project's owner or a collaborator on it publishes and lists; the
 * project's owner or the link's creator extends, revokes and removes a
 * viewer (LINK_MANAGE_POLICY). With `preview-links-enabled` off for the
 * project's owner and box, or for a caller with no standing on the project,
 * every route answers the same 404 `not_found`, as if it weren't there.
 */
import type { Instance, Prisma, User } from '@prisma/client';
import { prisma } from '../db';
import type { RouteResult } from '../routes/routeResult';
import { PREVIEW_LINK_CAPABILITY, previewLinkAudiencesEnabled, previewLinksEnabled, previewLinkTtlDefault } from './previewLinkFlags';
import {
  AUDIENCE_LIST_INCLUDE, audienceListView, audienceListWhere, endAudienceInTx, LINK_MANAGE_POLICY, mayChangeAudience, mayCreateAudience, prismaAudienceOps,
  registerPreviewDelivery, type AudienceEndReason, type AudienceListView, type AudienceOps, type PersonView,
} from './previewAudience';
import {
  cappedExpiry, holdUntil, isLive, laterOf, lifetimeCap, NAME_HOLD_MS, nameDecision, newHostSuffix, newLinkToken, parsePublishRequest, parseTtlHours, previewHostLabel, renewNarrowing,
  type NameReservation, type PreviewAudience, type PreviewHostMode, type PublishRequest,
} from './previewLinkRules';
import { projectDirUnder, resolveProjectRoot } from './projectPaths';
import { findUserByEmail } from './userByEmail';
import { isProjectAgentConnected, projectAgentCapabilities, sendForProject, type ProjectHost } from './agentRegistry';
import { linkPublished, linkRevoked, viewerRemoved } from './previewLinkTelemetry';
import { previewSessionsRevoked } from './previewSessionEvents';

/** Ended links stay in the list this long. */
export const RECENTLY_ENDED_MS = 7 * 24 * 3600_000;
const LIST_LIMIT = 100;
const LISTENERS_RPC_TIMEOUT_MS = 10_000;
/** What the dialog shows of a listener's command line. */
export const COMMAND_MAX = 80;
const REASON_MAX = 300;

/**
 * A link and its audience, flattened: `audienceId` and the audience's
 * project, workstream, owner, kind (as `audience`), expiry and end, beside
 * the link's own name, port, token hash, host mode and request.
 */
export interface PreviewLinkRow {
  id: string;
  name: string;
  /** Its host is `<name>--<hostSuffix>.<domain>` (SR19); kept by renew and extend. */
  hostSuffix: string;
  audienceId: string;
  projectId: string;
  workstreamId: string | null;
  ownerId: string;
  port: number;
  audience: PreviewAudience;
  linkTokenHash: string | null;
  hostMode: PreviewHostMode;
  requestId: string | null;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
}

export type { PersonView };

/** A link with what the list shows of it: its audience's grantees and viewers. */
export interface PreviewLinkListRow extends PreviewLinkRow {
  workstreamName: string | null;
  owner: PersonView;
  grantees: AudienceListView['grantees'];
  viewers: AudienceListView['viewers'];
}

export interface PreviewLinkRequestRow {
  id: string;
  projectId: string;
  workstreamId: string | null;
  boxId: string;
  port: number;
  note: string | null;
  state: string;
  createdAt: Date;
  decidedAt: Date | null;
}

export type SessionSelector =
  /** Every session of the link. */
  | { all: true }
  /** One viewer's sessions, whatever their basis. */
  | { userId: string }
  /** `grant` sessions: of these users, or (no userIds) every one. */
  | { basis: 'grant'; userIds?: string[] }
  /** `token` sessions whose token hash isn't `keep` (null: every one). */
  | { basis: 'token'; keep: string | null };

/** What the link row itself holds: everything else is its audience's. */
export interface LinkWrite {
  name: string;
  hostSuffix: string;
  audienceId: string;
  port: number;
  linkTokenHash: string | null;
  hostMode: PreviewHostMode;
  requestId: string | null;
}

/** The writes a name's transaction may make: the link's own, and the audience's through the core. */
export interface NameTx {
  /** The core's writes (services/previewAudience.ts), in this same transaction. */
  audience: AudienceOps;
  /** The name's reservation, with the link it serves. */
  readName(name: string): Promise<NameReservation | null>;
  readLink(id: string): Promise<PreviewLinkRow | null>;
  createLink(data: LinkWrite): Promise<PreviewLinkRow>;
  updateLink(id: string, data: Partial<Omit<LinkWrite, 'name' | 'audienceId' | 'hostSuffix'>>): Promise<PreviewLinkRow>;
  /** Create or rewrite the reservation. */
  writeName(row: { name: string; ownerId: string; reservedUntil: Date; linkId: string | null }): Promise<void>;
  /** Revoke the live sessions a selector picks; their id hashes, for closing WebSockets. */
  revokeSessions(linkId: string, which: SessionSelector, at: Date): Promise<string[]>;
  /** Drop the link's unused landing codes. */
  deleteCodes(linkId: string): Promise<void>;
  /** A pending request's new state. False when it was no longer pending. */
  decideRequest(id: string, state: 'approved' | 'declined', at: Date): Promise<boolean>;
  /**
   * Whether the project, and the workstream when there is a row for it,
   * exist and aren't archived, their rows share-locked for the rest of the
   * transaction. An archive (routes/projects.ts) or a workstream's removal
   * (routes/workstreams.ts, which marks the row archived before it ends the
   * audiences and deletes it) updates the row first, so the update waits for
   * this publish to commit and the endPreviewAudiences that follows sees the
   * link, or this sees the update and refuses. Either way no link outlives
   * them, and none is inserted against a deleted workstream.
   */
  scopeLive(projectId: string, workstreamId: string | null): Promise<boolean>;
}

export interface PreviewLinkStore {
  withName<T>(name: string, fn: (tx: NameTx) => Promise<T>): Promise<T>;
  findLink(id: string): Promise<PreviewLinkRow | null>;
  /** The links an audience delivers (one today), for its end hook. */
  linksOfAudience(audienceId: string): Promise<PreviewLinkRow[]>;
  /** Live links, and those ended or expired since `since`, newest first. */
  listForProject(projectId: string, since: Date): Promise<PreviewLinkListRow[]>;
  /** The live links someone created, or on a project they own, newest first. */
  listOwnedBy(userId: string, now: Date): Promise<PreviewLinkListRow[]>;
  pendingRequests(projectId: string): Promise<PreviewLinkRequestRow[]>;
  findRequest(id: string): Promise<PreviewLinkRequestRow | null>;
}

export interface PreviewLinkProject {
  id: string;
  name: string;
  userId: string;
  archived: boolean;
  instanceId: string | null;
  instance: Instance | null;
  owner: User;
}

export interface PreviewLinkDeps {
  store: PreviewLinkStore;
  findProject(projectId: string): Promise<PreviewLinkProject | null>;
  isCollaborator(projectId: string, userId: string): Promise<boolean>;
  /** A workstream the project has (not archived): its row id, or null for an implicit main. Undefined when it has none of that name. */
  findWorkstream(projectId: string, name: string): Promise<{ id: string | null } | undefined>;
  findUserByEmail(email: string): Promise<User | null>;
  /** preview-links-enabled for the project's owner and box. */
  enabled(owner: User, box: Instance | null): Promise<boolean>;
  /** preview-links-link-audience-enabled for the project's owner and box. */
  audiencesOn(owner: User, box: Instance | null): Promise<boolean>;
  ttlDefault(owner: User, box: Instance | null): Promise<number>;
  agent: {
    connected(host: ProjectHost): boolean;
    capabilities(host: ProjectHost): string[];
    send(host: ProjectHost, type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  };
  /** The landing page's base: FRONTEND_URL + BASE_PATH (a link is `<base>/previews/<name>[/<token>]`). */
  siteBase(): string;
  /** PREVIEW_LINKS_DOMAIN, or null while previews are off. */
  previewDomain(): string | null;
  now(): Date;
  random?: (n: number) => Buffer;
  /** Sessions this process revoked: PR 2's relay closes their WebSockets and drops them from its cache. */
  onSessionsRevoked?(linkId: string, idHashes: string[]): void;
}

/** Who is asking: a session's req.user or a CLI's device sign-in. */
export interface PreviewLinkCaller {
  id: string;
  googleEmail: string;
}

const NOT_FOUND: RouteResult = { status: 404, body: { error: 'Not found', code: 'not_found' } };

function err(status: number, code: string, error: string, extra: Record<string, unknown> = {}): RouteResult {
  return { status, body: { error, code, ...extra } };
}

function hostOf(p: PreviewLinkProject): ProjectHost {
  return { userId: p.userId, instanceId: p.instanceId };
}

interface Standing {
  project: PreviewLinkProject;
  isProjectOwner: boolean;
  isCollaborator: boolean;
}

/**
 * The project, when the caller is its owner or a collaborator and the flag is
 * on for its owner and box; null for the 404 otherwise.
 */
async function standing(deps: PreviewLinkDeps, caller: PreviewLinkCaller, projectId: string, opts: { archivedToo?: boolean } = {}): Promise<Standing | null> {
  const project = await deps.findProject(projectId);
  if (!project || (project.archived && !opts.archivedToo)) return null;
  const isProjectOwner = project.userId === caller.id;
  const isCollaborator = !isProjectOwner && await deps.isCollaborator(project.id, caller.id);
  if (!mayCreateAudience(LINK_MANAGE_POLICY, { isProjectOwner, isCollaborator })) return null;
  if (!(await deps.enabled(project.owner, project.instance))) return null;
  return { project, isProjectOwner, isCollaborator };
}

/**
 * A link the caller may change (the project's owner or the link's creator),
 * with its project. `narrowing` (revoke, remove a viewer) works on an
 * archived project's link too: if the archive's end of its audiences failed,
 * the owner can still end what is left.
 */
export async function changeable(deps: PreviewLinkDeps, caller: PreviewLinkCaller, linkId: string, opts: { narrowing?: boolean } = {}): Promise<{ link: PreviewLinkRow; project: PreviewLinkProject } | RouteResult> {
  const link = typeof linkId === 'string' && linkId ? await deps.store.findLink(linkId) : null;
  if (!link) return NOT_FOUND;
  const s = await standing(deps, caller, link.projectId, { archivedToo: opts.narrowing });
  if (!s) return NOT_FOUND;
  if (!mayChangeAudience(LINK_MANAGE_POLICY, s, link, caller.id)) {
    return err(403, 'forbidden', "Only the project's owner or the link's creator can change it");
  }
  return { link, project: s.project };
}

export function landingUrl(deps: Pick<PreviewLinkDeps, 'siteBase'>, name: string, token?: string | null): string {
  return `${deps.siteBase()}/previews/${name}${token ? `/${token}` : ''}`;
}

/** Thrown inside a name's transaction to roll it back: the link is at its 30-day cap (SR23). */
class LifetimeCapError extends Error {}
const LIFETIME_CAP = Symbol('lifetime_cap');
const LIFETIME_CAP_RESULT: RouteResult = { status: 409, body: { error: 'This link has reached its 30-day limit; publish it again.', code: 'lifetime_cap' } };

async function capped<T>(run: () => Promise<T>): Promise<T | typeof LIFETIME_CAP> {
  try { return await run(); } catch (e) { if (e instanceof LifetimeCapError) return LIFETIME_CAP; throw e; }
}

function linkView(deps: PreviewLinkDeps, link: PreviewLinkRow | PreviewLinkListRow, now: Date) {
  const domain = deps.previewDomain();
  const listed = 'owner' in link ? link : null;
  return {
    id: link.id,
    name: link.name,
    projectId: link.projectId,
    workstream: listed ? (listed.workstreamName ?? 'main') : undefined,
    port: link.port,
    audience: link.audience,
    hostMode: link.hostMode,
    live: isLive(link, now),
    expiresAt: link.expiresAt.toISOString(),
    // The latest any extend or renew can take it (SR23: 30 days from its first publish).
    maxExpiresAt: lifetimeCap(link.createdAt).toISOString(),
    endedAt: link.endedAt?.toISOString() ?? null,
    endReason: link.endReason ?? (link.endedAt === null && !isLive(link, now) ? 'expired' : null),
    createdAt: link.createdAt.toISOString(),
    // The bare landing URL: a link audience's token is in it only once, in the publish answer.
    url: landingUrl(deps, link.name),
    // The link's own origin (SR19); the landing URL above sends a viewer there.
    host: domain ? `${previewHostLabel(link.name, link.hostSuffix)}.${domain}` : null,
    ...(listed ? {
      owner: listed.owner,
      grantees: listed.grantees.map(g => ({ ...g, expiresAt: g.expiresAt?.toISOString() ?? null })),
      viewers: listed.viewers.map(v => ({
        ...v, firstOpenedAt: v.firstOpenedAt.toISOString(), lastOpenedAt: v.lastOpenedAt.toISOString(), revokedAt: v.revokedAt?.toISOString() ?? null,
      })),
    } : {}),
  };
}

function requestView(r: PreviewLinkRequestRow) {
  return { id: r.id, workstreamId: r.workstreamId, port: r.port, note: r.note, state: r.state, createdAt: r.createdAt.toISOString() };
}

/** GET /api/projects/:id/preview-links: live and recently ended links, with viewers, and pending agent requests. */
export async function listPreviewLinksFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller, projectId: string): Promise<RouteResult> {
  const s = await standing(deps, caller, projectId);
  if (!s) return NOT_FOUND;
  const now = deps.now();
  const [links, requests, ttlHoursDefault] = await Promise.all([
    deps.store.listForProject(s.project.id, new Date(now.getTime() - RECENTLY_ENDED_MS)),
    deps.store.pendingRequests(s.project.id),
    deps.ttlDefault(s.project.owner, s.project.instance),
  ]);
  return {
    status: 200,
    body: { links: links.slice(0, LIST_LIMIT).map(l => linkView(deps, l, now)), requests: requests.map(requestView), ttlHoursDefault, previewDomain: deps.previewDomain() },
  };
}

/** The CLI's `termag preview list` without a project: the caller's own live links. */
export async function listOwnPreviewLinksFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller): Promise<RouteResult> {
  const now = deps.now();
  const rows = await deps.store.listOwnedBy(caller.id, now);
  // Only projects the flag is on for, and the caller still has standing on.
  const out = [];
  const seen = new Map<string, boolean>();
  for (const l of rows.slice(0, LIST_LIMIT)) {
    if (!seen.has(l.projectId)) seen.set(l.projectId, !!(await standing(deps, caller, l.projectId)));
    if (seen.get(l.projectId)) out.push(linkView(deps, l, now));
  }
  return { status: 200, body: { links: out } };
}

/** Whether the project's box can answer for preview links: null when it can, else the refusal. */
function boxRefusal(deps: PreviewLinkDeps, project: PreviewLinkProject): RouteResult | null {
  const host = hostOf(project);
  if (!deps.agent.connected(host)) return err(503, 'box_not_ready', "The project's box isn't connected; start it to publish a port");
  if (!deps.agent.capabilities(host).includes(PREVIEW_LINK_CAPABILITY)) return err(501, 'box_outdated', 'Update this box to publish ports');
  return null;
}

function checkoutDir(project: PreviewLinkProject, workstream: string): string {
  const root = resolveProjectRoot({ ownerUnixUser: project.owner.unixUsername, hostHome: project.instance?.hostHome });
  return projectDirUnder(root, project.name, workstream);
}

export interface ListenerView {
  port: number;
  pid: number | null;
  command: string | null;
  verdict: { ok: true } | { ok: false; code: string; reason: string };
  /** The listener's process runs from the workstream's checkout. */
  inCheckout: boolean;
}

/** The agent's `preview-listeners` answer, as the dialog may show it: bounded, typed, anything else dropped. */
export function parseListeners(raw: unknown): ListenerView[] | null {
  const list = (raw as { listeners?: unknown } | null)?.listeners;
  if (!Array.isArray(list)) return null;
  const out: ListenerView[] = [];
  for (const l of list.slice(0, 500)) {
    if (!l || typeof l !== 'object') continue;
    const { port, pid, command, verdict, inCheckout } = l as Record<string, unknown>;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const v = verdict as { ok?: unknown; code?: unknown; reason?: unknown } | null;
    const ok = v?.ok === true;
    out.push({
      port,
      pid: typeof pid === 'number' && Number.isInteger(pid) ? pid : null,
      command: typeof command === 'string' ? command.slice(0, COMMAND_MAX) : null,
      verdict: ok ? { ok: true } : {
        ok: false,
        code: typeof v?.code === 'string' ? v.code.slice(0, 40) : 'port_refused',
        reason: typeof v?.reason === 'string' ? v.reason.slice(0, REASON_MAX) : 'the box refused this port',
      },
      inCheckout: inCheckout === true,
    });
  }
  return out;
}

/**
 * The box's listeners. `probe`: the port a publish names, which the agent
 * also probes for the DevTools protocol (SR6); the dialog's list goes by
 * command line alone, so a listing never pokes the user's databases.
 */
async function askListeners(deps: PreviewLinkDeps, project: PreviewLinkProject, workstream: string, probe?: number): Promise<ListenerView[] | RouteResult> {
  let raw: unknown;
  try {
    raw = await deps.agent.send(hostOf(project), 'preview-listeners', { cwd: checkoutDir(project, workstream), ...(probe ? { port: probe } : {}) }, LISTENERS_RPC_TIMEOUT_MS);
  } catch (e) {
    return err(503, 'box_not_ready', `The box didn't answer: ${(e as Error).message ?? String(e)}`.slice(0, REASON_MAX));
  }
  return parseListeners(raw) ?? err(502, 'box_error', 'The box sent an answer termag does not understand');
}

/** GET /api/projects/:id/preview-links/listeners?workstream=: the box's listening ports, with port-guard's verdict on each. */
export async function previewListenersFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller, projectId: string, query: unknown): Promise<RouteResult> {
  const s = await standing(deps, caller, projectId);
  if (!s) return NOT_FOUND;
  const raw = (query as { workstream?: unknown } | null)?.workstream;
  const workstream = typeof raw === 'string' && raw ? raw : 'main';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workstream) || !(await deps.findWorkstream(s.project.id, workstream))) return err(404, 'workstream_not_found', 'Workstream not found');
  const refusal = boxRefusal(deps, s.project);
  if (refusal) return refusal;
  const listeners = await askListeners(deps, s.project, workstream);
  if (!Array.isArray(listeners)) return listeners;
  return { status: 200, body: { listeners } };
}

/**
 * POST /api/projects/:id/preview-links: publish a port of a workstream under
 * a name, or renew the link the name already is for that workstream (P5).
 * 201 with the share URL for a new link, 200 for a renew; a link audience's
 * token is in the URL only when this publish made it.
 */
/**
 * A publish's checks that need no box and change nothing: standing, the body,
 * the audience flag, the workstream and the people named. The project, the
 * request and its grantees, or the refusal. routes/cliPreviewLinks.ts runs it
 * before asking a box-made sign-in's owner to confirm, so a request that could
 * never apply is refused at once.
 */
export async function checkPublishable(deps: PreviewLinkDeps, caller: PreviewLinkCaller, projectId: string, body: unknown): Promise<
  { ok: true; project: PreviewLinkProject; isProjectOwner: boolean; req: PublishRequest; workstreamId: string | null; grantees: User[] } | { ok: false; result: RouteResult }
> {
  const s = await standing(deps, caller, projectId);
  if (!s) return { ok: false, result: NOT_FOUND };
  const { project } = s;
  const parsed = parsePublishRequest(body as never);
  if (!parsed.ok) return { ok: false, result: err(parsed.status, parsed.code, parsed.error) };
  const req = parsed.request;
  if (req.audience !== 'owner' && !(await deps.audiencesOn(project.owner, project.instance))) {
    return { ok: false, result: err(403, 'audience_disabled', 'Only "owner" links can be published for now') };
  }
  const ws = await deps.findWorkstream(project.id, req.workstream);
  if (!ws) return { ok: false, result: err(404, 'workstream_not_found', 'Workstream not found') };

  // Every person named must be a termag user (A2).
  const grantees: User[] = [];
  const missing: string[] = [];
  for (const email of req.emails) {
    const u = await deps.findUserByEmail(email);
    if (u) grantees.push(u); else missing.push(email);
  }
  if (missing.length) return { ok: false, result: err(400, 'not_a_termag_user', `Not termag users: ${missing.join(', ')}`, { emails: missing }) };
  return { ok: true, project, isProjectOwner: s.isProjectOwner, req, workstreamId: ws.id, grantees };
}

export async function publishPreviewLinkFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller, projectId: string, body: unknown): Promise<RouteResult> {
  const checked = await checkPublishable(deps, caller, projectId, body);
  if (!checked.ok) return checked.result;
  const { project, req, grantees } = checked;
  const ws = { id: checked.workstreamId };

  // A debugger, shell or notebook can't be published (SR6), nor anything else
  // the guard refuses; a port nobody listens on yet can (U5).
  const refusal = boxRefusal(deps, project);
  if (refusal) return refusal;
  const listeners = await askListeners(deps, project, req.workstream, req.port);
  if (!Array.isArray(listeners)) return listeners;
  const listener = listeners.find(l => l.port === req.port);
  if (listener && !listener.verdict.ok) return err(403, 'port_refused', listener.verdict.reason);

  if (req.requestId) {
    const r = await deps.store.findRequest(req.requestId);
    if (!r || r.projectId !== project.id || r.state !== 'pending') return err(409, 'request_not_pending', 'That request was already answered, or is not this project\'s');
  }

  const now = deps.now();
  const ttl = req.ttlHours ?? await deps.ttlDefault(project.owner, project.instance);
  const grantIds = [...new Set(grantees.map(u => u.id))];
  const outcome = await capped(() => deps.store.withName(req.name, async (tx) => {
    // Archived or removed since the standing check: nothing may be published on it.
    if (!(await tx.scopeLive(project.id, ws.id))) return { kind: 'refused', result: NOT_FOUND } as const;
    const row = await tx.readName(req.name);
    const decision = nameDecision(row, { publisherId: caller.id, projectId: project.id, workstreamId: ws.id }, now);
    if (decision.kind === 'refuse') return { kind: 'refused', result: err(decision.status, decision.code, decision.error) } as const;
    // A renew changes the link's audience, people, port and token: the same
    // rule as any other change (LINK_MANAGE_POLICY), so a collaborator renews
    // only their own link, and the project's owner any. Checked before
    // anything is written.
    if (decision.kind === 'renew') {
      const current = await tx.readLink(decision.linkId);
      if (current && !mayChangeAudience(LINK_MANAGE_POLICY, { isProjectOwner: checked.isProjectOwner, isCollaborator: !checked.isProjectOwner }, current, caller.id)) {
        return { kind: 'refused', result: err(403, 'forbidden', "This name is another person's live link here; only they or the project's owner can renew it") } as const;
      }
    }
    if (req.requestId && !(await tx.decideRequest(req.requestId, 'approved', now))) {
      return { kind: 'refused', result: err(409, 'request_not_pending', 'That request was already answered') } as const;
    }

    if (decision.kind === 'renew') {
      const before = await tx.readLink(decision.linkId);
      if (!before) throw new Error(`preview link ${decision.linkId} vanished under its name's lock`);
      const beforeGrants = await tx.audience.granteeIds(before.audienceId);
      // The token follows the audience: kept while it stays link, new when it becomes link, gone otherwise.
      const minted = req.audience === 'link' && before.audience !== 'link' ? newLinkToken(deps.random) : null;
      const linkTokenHash = req.audience !== 'link' ? null : minted ? minted.hash : before.linkTokenHash;
      // At most 30 days from its first publish (SR23); refused inside the
      // transaction so nothing above (a request's approval) is kept.
      const capped = cappedExpiry(before.expiresAt, now, ttl, before.createdAt);
      if (!capped.ok) throw new LifetimeCapError();
      const { expiresAt } = capped;
      await tx.audience.update(before.audienceId, { kind: req.audience, expiresAt });
      const link = await tx.updateLink(before.id, { port: req.port, hostMode: req.hostMode, linkTokenHash, requestId: req.requestId ?? before.requestId });
      const after = { audience: req.audience, linkTokenHash, grantUserIds: req.audience === 'owner' ? [] : grantIds };
      await tx.audience.setGrantees(link.audienceId, after.grantUserIds);
      await tx.audience.unrevokeViewers(link.audienceId, after.grantUserIds);
      // Narrowing revokes at once, in this transaction.
      const narrow = renewNarrowing({ audience: before.audience, linkTokenHash: before.linkTokenHash, grantUserIds: beforeGrants }, after);
      const revoked = [
        ...(narrow.allGrants ? await tx.revokeSessions(link.id, { basis: 'grant' }, now) : []),
        ...(narrow.grantUserIds.length ? await tx.revokeSessions(link.id, { basis: 'grant', userIds: narrow.grantUserIds }, now) : []),
        ...await tx.revokeSessions(link.id, { basis: 'token', keep: narrow.keepTokenHash }, now),
      ];
      await tx.writeName({ name: req.name, ownerId: row!.ownerId, reservedUntil: laterOf(row!.reservedUntil, holdUntil(expiresAt)), linkId: link.id });
      await tx.audience.addEvent({ audienceId: link.audienceId, kind: 'created', actorId: caller.id, delivery: { kind: 'link', id: link.id }, detail: { renewed: true, port: req.port, audience: req.audience } });
      return { kind: 'published', link, token: minted?.token ?? null, renewed: true, tokenKept: req.audience === 'link' && !minted, revoked } as const;
    }

    const minted = req.audience === 'link' ? newLinkToken(deps.random) : null;
    const expiresAt = new Date(now.getTime() + ttl * 3600_000);
    const audience = await tx.audience.create({ projectId: project.id, workstreamId: ws.id, ownerId: caller.id, kind: req.audience, expiresAt });
    const link = await tx.createLink({
      // A new link, a new origin: what an earlier link's app left on this name stays on that one's (SR19).
      name: req.name, hostSuffix: newHostSuffix(deps.random), audienceId: audience.id, port: req.port, linkTokenHash: minted?.hash ?? null, hostMode: req.hostMode, requestId: req.requestId,
    });
    if (req.audience !== 'owner') await tx.audience.setGrantees(audience.id, grantIds);
    // A reclaim rewrites another owner's lapsed reservation; a take or create is the caller's own.
    await tx.writeName({ name: req.name, ownerId: caller.id, reservedUntil: laterOf(row?.reservedUntil, holdUntil(expiresAt)), linkId: link.id });
    await tx.audience.addEvent({ audienceId: audience.id, kind: 'created', actorId: caller.id, delivery: { kind: 'link', id: link.id }, detail: { port: req.port, audience: req.audience, name: decision.kind } });
    return { kind: 'published', link, token: minted?.token ?? null, renewed: false, tokenKept: false, revoked: [] as string[] } as const;
  }));
  if (outcome === LIFETIME_CAP) return LIFETIME_CAP_RESULT;
  if (outcome.kind === 'refused') return outcome.result;
  if (outcome.revoked.length) deps.onSessionsRevoked?.(outcome.link.id, outcome.revoked);
  linkPublished(caller.id, project.instanceId, { audience: req.audience, renewed: outcome.renewed, ttlHours: ttl, hostMode: req.hostMode });
  return {
    status: outcome.renewed ? 200 : 201,
    body: {
      link: linkView(deps, outcome.link, now),
      renewed: outcome.renewed,
      // Shown once: only the hash is kept. A renew that kept the token can't show it again.
      shareUrl: outcome.tokenKept ? null : landingUrl(deps, outcome.link.name, outcome.token),
      ...(outcome.tokenKept ? { note: 'The link keeps its token; share the URL you were given when it was made' } : {}),
    },
  };
}

/** POST /api/preview-links/:id/extend { ttlHours }: from now, never earlier than it already was. */
export async function extendPreviewLinkFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller, linkId: string, body: unknown): Promise<RouteResult> {
  const found = await changeable(deps, caller, linkId);
  if (!('link' in found)) return found;
  const parsed = parseTtlHours((body as { ttlHours?: unknown } | null)?.ttlHours);
  if (!parsed.ok) return err(parsed.status, parsed.code, parsed.error);
  const now = deps.now();
  const result = await capped(() => deps.store.withName(found.link.name, async (tx) => {
    const link = await tx.readLink(found.link.id);
    if (!link || !isLive(link, now) || !(await tx.scopeLive(link.projectId, link.workstreamId))) return null;
    const capped = cappedExpiry(link.expiresAt, now, parsed.hours, link.createdAt);
    if (!capped.ok) throw new LifetimeCapError();
    const { expiresAt } = capped;
    await tx.audience.update(link.audienceId, { expiresAt });
    const row = await tx.readName(link.name);
    if (row && row.link?.id === link.id) await tx.writeName({ name: row.name, ownerId: row.ownerId, reservedUntil: laterOf(row.reservedUntil, holdUntil(expiresAt)), linkId: link.id });
    await tx.audience.addEvent({ audienceId: link.audienceId, kind: 'extended', actorId: caller.id, delivery: { kind: 'link', id: link.id }, detail: { ttlHours: parsed.hours } });
    return tx.readLink(link.id);
  }));
  if (result === LIFETIME_CAP) return LIFETIME_CAP_RESULT;
  if (!result) return err(409, 'link_ended', 'This link has ended; publish it again');
  return { status: 200, body: { link: linkView(deps, result, now) } };
}

/** DELETE /api/preview-links/:id: revoke (L2). Idempotent: an ended link answers as it is. */
export async function revokePreviewLinkFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller, linkId: string): Promise<RouteResult> {
  const found = await changeable(deps, caller, linkId, { narrowing: true });
  if (!('link' in found)) return found;
  const now = deps.now();
  const result = await endPreviewLink(deps.store, found.link.id, found.link.name, 'revoked', caller.id, now);
  if (result.revoked.length) deps.onSessionsRevoked?.(found.link.id, result.revoked);
  if (result.link && found.link.endedAt === null) linkRevoked(caller.id, found.project.instanceId, { sessions: result.revoked.length });
  return { status: 200, body: { link: linkView(deps, result.link ?? found.link, now) } };
}

/**
 * End a link for `reason` (revoked here; expired, box-gone and the rest from
 * PR 2's sweep; project-gone and workstream-gone through the audience's end
 * hook), in one transaction under its name's lock: its audience stamped
 * ended (previewAudience.ts endAudienceInTx), its name held 30 days from now
 * if that's later, every session revoked and its codes dropped. A link whose
 * audience already ended is left as it is, unless `finishEnded`: the end
 * hook's, where the first of an audience's links stamps it ended and each
 * other link on it must still lose its sessions, codes and name. `actorId`
 * is a user id, or null for the sweep.
 */
export async function endPreviewLink(store: PreviewLinkStore, linkId: string, name: string, reason: AudienceEndReason, actorId: string | null, now: Date, opts: { finishEnded?: boolean } = {}): Promise<{ link: PreviewLinkRow | null; revoked: string[] }> {
  return store.withName(name, async (tx) => {
    const link = await tx.readLink(linkId);
    if (!link || (link.endedAt !== null && !opts.finishEnded)) return { link, revoked: [] };
    await endAudienceInTx(tx.audience, link.audienceId, reason, actorId, now);
    const row = await tx.readName(link.name);
    if (row && row.link?.id === link.id) {
      await tx.writeName({ name: row.name, ownerId: row.ownerId, reservedUntil: laterOf(row.reservedUntil, new Date(now.getTime() + NAME_HOLD_MS)), linkId: link.id });
    }
    const revoked = await tx.revokeSessions(link.id, { all: true }, now);
    await tx.deleteCodes(link.id);
    return { link: await tx.readLink(link.id), revoked };
  });
}

/**
 * The link delivery's end hook on the audience core: ending an audience ends
 * each link it delivers, as endPreviewLink does. `onSessionsRevoked` is
 * PreviewLinkDeps' (PR 2's relay closes the sockets).
 */
export function previewLinkDelivery(store: PreviewLinkStore, onSessionsRevoked?: (linkId: string, idHashes: string[]) => void) {
  return {
    kind: 'link',
    async end(audienceId: string, reason: AudienceEndReason, actorId: string | null, now: Date): Promise<boolean> {
      const links = await store.linksOfAudience(audienceId);
      for (const l of links) {
        // Every link on the audience, not only the first: that one stamps the audience ended.
        const { revoked } = await endPreviewLink(store, l.id, l.name, reason, actorId, now, { finishEnded: true });
        if (revoked.length) onSessionsRevoked?.(l.id, revoked);
      }
      return links.length > 0;
    },
  };
}

/** Register links as a delivery on the audience core (index.ts, once at startup). */
export function installPreviewLinkDelivery(deps: Pick<PreviewLinkDeps, 'store' | 'onSessionsRevoked'> = defaultPreviewLinkDeps): void {
  registerPreviewDelivery(previewLinkDelivery(deps.store, deps.onSessionsRevoked?.bind(deps)));
}

/** DELETE /api/preview-links/:id/viewers/:userId: remove a viewer (A3), effective on their next request. */
export async function removePreviewLinkViewerFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller, linkId: string, userId: string): Promise<RouteResult> {
  const found = await changeable(deps, caller, linkId, { narrowing: true });
  if (!('link' in found)) return found;
  if (typeof userId !== 'string' || !userId) return NOT_FOUND;
  if (userId === found.project.userId || userId === found.link.ownerId) {
    return err(400, 'invalid_request', "The project's owner and the link's creator can't be removed; revoke the link instead");
  }
  const now = deps.now();
  const revoked = await deps.store.withName(found.link.name, async (tx) => {
    await tx.audience.revokeViewer(found.link.audienceId, userId, now);
    // Their grant goes too, so the owner's list no longer names them, and only
    // naming them again in a renew lets them back in.
    await tx.audience.removeGrantee(found.link.audienceId, userId);
    const ids = await tx.revokeSessions(found.link.id, { userId }, now);
    await tx.audience.addEvent({ audienceId: found.link.audienceId, kind: 'viewer-removed', actorId: caller.id, delivery: { kind: 'link', id: found.link.id }, detail: { userId } });
    return ids;
  });
  if (revoked.length) deps.onSessionsRevoked?.(found.link.id, revoked);
  viewerRemoved(caller.id, found.project.instanceId, { sessions: revoked.length });
  return { status: 200, body: { removed: true } };
}

/** POST /api/preview-link-requests/:id/decline: the owner turns down an agent's ask. */
export async function declinePreviewLinkRequestFor(deps: PreviewLinkDeps, caller: PreviewLinkCaller, requestId: string): Promise<RouteResult> {
  const r = typeof requestId === 'string' && requestId ? await deps.store.findRequest(requestId) : null;
  if (!r) return NOT_FOUND;
  if (!(await standing(deps, caller, r.projectId))) return NOT_FOUND;
  if (r.state !== 'pending') return err(409, 'request_not_pending', 'That request was already answered');
  // A request has no name to lock; any key serializes it against a publish that approves it.
  const ok = await deps.store.withName(`request:${r.id}`, tx => tx.decideRequest(r.id, 'declined', deps.now()));
  if (!ok) return err(409, 'request_not_pending', 'That request was already answered');
  return { status: 200, body: { request: { ...requestView(r), state: 'declined' } } };
}

// ── Prisma ────────────────────────────────────────────────────────────────

const AUDIENCE_FIELDS = { select: { projectId: true, workstreamId: true, ownerId: true, kind: true, expiresAt: true, endedAt: true, endReason: true } } as const;
const LINK_SELECT = {
  id: true, name: true, hostSuffix: true, audienceId: true, port: true, linkTokenHash: true, hostMode: true, requestId: true, createdAt: true,
  audience: AUDIENCE_FIELDS,
} as const;

function asRow(l: Prisma.PreviewLinkGetPayload<{ select: typeof LINK_SELECT }>): PreviewLinkRow {
  const { audience: a, ...link } = l;
  return {
    ...link, projectId: a.projectId, workstreamId: a.workstreamId, ownerId: a.ownerId, audience: a.kind as PreviewAudience,
    expiresAt: a.expiresAt, endedAt: a.endedAt, endReason: a.endReason, hostMode: l.hostMode as PreviewHostMode,
  };
}

const LIST_INCLUDE = { audience: { include: AUDIENCE_LIST_INCLUDE } } as const;
type ListedLink = Prisma.PreviewLinkGetPayload<{ include: typeof LIST_INCLUDE }>;

function asListRow(l: ListedLink): PreviewLinkListRow {
  const a = audienceListView(l.audience);
  return {
    id: l.id, name: l.name, hostSuffix: l.hostSuffix, audienceId: l.audienceId, port: l.port, linkTokenHash: l.linkTokenHash, hostMode: l.hostMode as PreviewHostMode,
    requestId: l.requestId, createdAt: l.createdAt,
    projectId: a.projectId, workstreamId: a.workstreamId, ownerId: a.ownerId, audience: a.kind, expiresAt: a.expiresAt, endedAt: a.endedAt, endReason: a.endReason,
    workstreamName: a.workstreamName, owner: a.owner, grantees: a.grantees, viewers: a.viewers,
  };
}

function sessionWhere(linkId: string, which: SessionSelector): Prisma.PreviewLinkSessionWhereInput {
  const base = { linkId, revokedAt: null };
  if ('all' in which) return base;
  if ('userId' in which) return { ...base, userId: which.userId };
  if (which.basis === 'grant') return { ...base, basis: 'grant', ...(which.userIds ? { userId: { in: which.userIds } } : {}) };
  return { ...base, basis: 'token', ...(which.keep ? { OR: [{ tokenHash: null }, { tokenHash: { not: which.keep } }] } : {}) };
}

function prismaNameTx(tx: Prisma.TransactionClient): NameTx {
  return {
    audience: prismaAudienceOps(tx),
    async scopeLive(projectId, workstreamId) {
      const p = await tx.$queryRaw<Array<{ archived: boolean }>>`SELECT archived FROM projects WHERE id = ${projectId} FOR SHARE`;
      if (p.length !== 1 || p[0].archived) return false;
      if (workstreamId === null) return true;
      const w = await tx.$queryRaw<Array<{ archived: boolean }>>`SELECT archived FROM workstreams WHERE id = ${workstreamId} AND "projectId" = ${projectId} FOR SHARE`;
      return w.length === 1 && !w[0].archived;
    },
    async readName(name) {
      const row = await tx.previewLinkName.findUnique({ where: { name }, include: { link: { select: LINK_SELECT } } });
      return row ? { name: row.name, ownerId: row.ownerId, reservedUntil: row.reservedUntil, link: row.link ? asRow(row.link) : null } : null;
    },
    async readLink(id) {
      const l = await tx.previewLink.findUnique({ where: { id }, select: LINK_SELECT });
      return l ? asRow(l) : null;
    },
    async createLink(data) {
      return asRow(await tx.previewLink.create({ data, select: LINK_SELECT }));
    },
    async updateLink(id, data) {
      return asRow(await tx.previewLink.update({ where: { id }, data, select: LINK_SELECT }));
    },
    async writeName({ name, ownerId, reservedUntil, linkId }) {
      // The unique linkId moves with the name: a link this name served before keeps none.
      await tx.previewLinkName.upsert({ where: { name }, create: { name, ownerId, reservedUntil, linkId }, update: { ownerId, reservedUntil, linkId } });
    },
    async revokeSessions(linkId, which, at) {
      const where = sessionWhere(linkId, which);
      const rows = await tx.previewLinkSession.findMany({ where, select: { idHash: true } });
      if (rows.length) await tx.previewLinkSession.updateMany({ where: { idHash: { in: rows.map(r => r.idHash) } }, data: { revokedAt: at } });
      return rows.map(r => r.idHash);
    },
    async deleteCodes(linkId) {
      await tx.previewLinkCode.deleteMany({ where: { linkId } });
    },
    async decideRequest(id, state, at) {
      const n = await tx.previewLinkRequest.updateMany({ where: { id, state: 'pending' }, data: { state, decidedAt: at } });
      return n.count === 1;
    },
  };
}

export const prismaPreviewLinkStore: PreviewLinkStore = {
  withName: (name, fn) => prisma.$transaction(async (tx) => {
    // One name at a time, across processes: the lock is the transaction's, released with it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preview-link-name:${name}`}))`;
    return fn(prismaNameTx(tx));
  }, { timeout: 15_000 }),
  async findLink(id) {
    const l = await prisma.previewLink.findUnique({ where: { id }, select: LINK_SELECT });
    return l ? asRow(l) : null;
  },
  async linksOfAudience(audienceId) {
    return (await prisma.previewLink.findMany({ where: { audienceId }, select: LINK_SELECT })).map(asRow);
  },
  async listForProject(projectId, since) {
    const rows = await prisma.previewLink.findMany({
      where: { audience: audienceListWhere({ projectId, since }) },
      include: LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map(asListRow);
  },
  async listOwnedBy(userId, now) {
    const rows = await prisma.previewLink.findMany({
      // The caller's own links, and every live link on a project they own (they may change it too).
      where: { audience: audienceListWhere({ ownerId: userId, now }) },
      include: LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map(asListRow);
  },
  async pendingRequests(projectId) {
    return prisma.previewLinkRequest.findMany({ where: { projectId, state: 'pending' }, orderBy: { createdAt: 'desc' }, take: LIST_LIMIT });
  },
  findRequest: (id) => prisma.previewLinkRequest.findUnique({ where: { id } }),
};

export const defaultPreviewLinkDeps: PreviewLinkDeps = {
  store: prismaPreviewLinkStore,
  async findProject(projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, include: { instance: true, user: true } });
    return p ? { id: p.id, name: p.name, userId: p.userId, archived: p.archived, instanceId: p.instanceId, instance: p.instance, owner: p.user } : null;
  },
  isCollaborator: async (projectId, userId) => !!(await prisma.projectShare.findUnique({ where: { projectId_userId: { projectId, userId } } })),
  async findWorkstream(projectId, name) {
    const row = await prisma.workstream.findUnique({ where: { projectId_name: { projectId, name } }, select: { id: true, archived: true } });
    // Main is the project's own checkout, row or not; an archived row is gone.
    if (!row) return name === 'main' ? { id: null } : undefined;
    return row.archived ? undefined : { id: row.id };
  },
  findUserByEmail: (email) => findUserByEmail(email),
  enabled: (owner, box) => previewLinksEnabled(owner, box),
  audiencesOn: (owner, box) => previewLinkAudiencesEnabled(owner, box),
  ttlDefault: (owner, box) => previewLinkTtlDefault(owner, box),
  agent: {
    connected: (host) => isProjectAgentConnected(host),
    capabilities: (host) => projectAgentCapabilities(host),
    send: (host, type, payload, timeoutMs) => sendForProject(host, type, payload, timeoutMs),
  },
  siteBase: () => `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}${process.env.BASE_PATH ?? ''}`,
  previewDomain: () => process.env.PREVIEW_LINKS_DOMAIN?.trim() || null,
  now: () => new Date(),
  // The preview host closes their WebSockets and drops them from its cache (services/previewHost.ts).
  onSessionsRevoked: (linkId, idHashes) => previewSessionsRevoked(linkId, idHashes),
};
