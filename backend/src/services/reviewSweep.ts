// The review sweep: the backend's single writer of a
// Devin review pane's live state. Every few seconds it probes the review
// panes it knows about — one classifier, `probeReviewPane` in
// services/review.ts, shared with the GET /review route — and writes the
// result as `AgentStatus.review` on the AGENT session's status, which the
// status WebSocket pushes like `milestone`. The sidebar's review ring and the
// review dock both read that field; neither polls tmux.
//
// The record map is in memory: nothing is persisted (no migration). On a
// backend restart, and whenever a host's agent (re)connects, the sweep lists
// that host's tmux sessions once (`tmux-list`) and adopts every `-review`
// session a project legally owns, reading its PR from the
// `@termag-review-pr` option or the launch echo (probeReviewPane).
//
// Every write goes through `updateStatusMeta`-shaped helpers that only touch
// the meta, so a review never changes the underlying working/waiting/idle
// status an agent or hook reported.

import { prisma } from '../db';
import { connectedProjectHosts, isProjectAgentConnected, sendForProject, type ProjectHost } from './agentRegistry';
import { getAllStatuses, notifyStatusChange, setStatus, updateStatusMeta } from './status';
import { statusKey } from './statusKey';
import { sessionName } from './tmux';
import { probeReviewPane, type ReviewPaneState, type SendForHost } from './review';
import type { SessionReview } from '../types';

/** Strip the PR link for recipients who are not the session's owner — the milestoneForSharedViewer pattern. */
export function reviewForSharedViewer(review: SessionReview | null | undefined): SessionReview | null | undefined {
  return review ? { ...review, url: null } : review;
}

export const SWEEP_INTERVAL_MS = 5_000;
/** Full re-discovery cadence for hosts whose agent never dropped (renames, missed adopts). */
export const REDISCOVERY_INTERVAL_MS = 30_000;
/** A pane whose Devin was just launched keeps reading as reviewing this long: a fresh shell's bare prompt would classify as done. */
export const START_SETTLE_MS = 12_000;

export type SendForReviewSweep = SendForHost;

export interface ReviewRecord {
  pr: number;
  url: string | null;
  /** Null when the record was recovered from the pane after a restart. */
  startedAt: Date | null;
  startedByUserId: string | null;

  host: ProjectHost;
  projectId: string;
  projectName: string;
  ownerUsername: string;
  workstream: string;
  reviewSession: string;
  agentSession: string;

  /** Last classified pane state; never null once written, since adoption probes in the same tick. */
  state: ReviewPaneState;
  at: Date;
  doneAt: Date | null;
  seenAt: Date | null;
  /** The state that last reached the status channel: a write publishes only what changed. */
  lastPushedState: ReviewPaneState | null;
}

const records = new Map<string, ReviewRecord>();
// Panes whose launch line could not be read back (scrollback rotated, or a
// hand-made session): remembered so the deep capture runs once, not on every probe.
const unrecoverable = new Set<string>();
const recordKey = (instanceId: string | null, reviewSession: string) => statusKey(instanceId, reviewSession);

export function getReviewRecord(instanceId: string | null, reviewSession: string): ReviewRecord | null {
  return records.get(recordKey(instanceId, reviewSession)) ?? null;
}

export function allReviewRecords(): ReviewRecord[] {
  return [...records.values()];
}

export function reviewMetaOf(rec: ReviewRecord): SessionReview {
  return {
    state: rec.state,
    pr: rec.pr,
    url: rec.url,
    at: rec.at,
    doneAt: rec.doneAt,
    seenAt: rec.seenAt,
  };
}

/** The identity one project+workstream's review pane is filed under. */
export interface ReviewIdentity {
  host: ProjectHost;
  projectId: string;
  projectName: string;
  ownerUsername: string;
  workstream: string;
  /** Session names built server-side from the parts, never a caller string. */
  reviewSession: string;
  agentSession: string;
}

/**
 * Everything the status of a project's workstreams implies for this module,
 * minus the reviews: identity given the workstream names.
 */
export function identityOf(input: {
  host: ProjectHost;
  projectId: string;
  projectName: string;
  ownerUsername: string;
  workstream: string;
}): ReviewIdentity {
  return {
    ...input,
    reviewSession: sessionName(input.ownerUsername, input.projectName, 'review', input.workstream),
    agentSession: sessionName(input.ownerUsername, input.projectName, 'agent', input.workstream),
  };
}

/**
 * Write the record's review onto the AGENT session's status and push it, once
 * per state (lastPushedState): a no-op when nothing new would reach the
 * channel. `force` publishes even an unchanged state — seen stamps, and
 * records that replace a dead one. When no status entry exists yet (a project
 * whose agent never reported — e.g. the review was started on a workstream
 * whose agent pane is gone) the not_running-shaped entry the client's own
 * `getStatus` fallback produces is materialised, so the review still reaches
 * /ws/status; nothing else in the entry is claimed.
 */
function writeMeta(rec: ReviewRecord, opts: { force?: boolean } = {}): void {
  if (!opts.force && rec.lastPushedState === rec.state) return;
  const st = statusKey(rec.host.instanceId, rec.agentSession);
  if (!getAllStatuses().has(st)) {
    setStatus(rec.agentSession, 'not_running', { review: reviewMetaOf(rec) }, undefined, rec.host.instanceId);
  } else {
    updateStatusMeta(rec.agentSession, { review: reviewMetaOf(rec) }, rec.host.instanceId);
  }
  rec.lastPushedState = rec.state;
  notifyStatusChange(rec.agentSession, rec.host.instanceId);
}

/** Clear the review field on the AGENT session's status (record-less clear path). */
function writeClearedMeta(identity: ReviewIdentity): void {
  const st = statusKey(identity.host.instanceId, identity.agentSession);
  if (!getAllStatuses().has(st)) return; // nothing carries a stale review
  updateStatusMeta(identity.agentSession, { review: null }, identity.host.instanceId);
  notifyStatusChange(identity.agentSession, identity.host.instanceId);
}

function fileRecord(
  identity: ReviewIdentity,
  pr: { pr: number; url: string | null },
  opts: { startedAt?: Date | null; startedByUserId?: string | null; now?: number; state?: ReviewPaneState } = {},
): ReviewRecord {
  const now = opts.now ?? Date.now();
  const rec: ReviewRecord = {
    pr: pr.pr,
    url: pr.url,
    // `?? null` on purpose: an explicit null means "recovered from the pane",
    // not "start the clock now".
    startedAt: opts.startedAt === undefined ? new Date(now) : opts.startedAt,
    startedByUserId: opts.startedByUserId ?? null,
    host: identity.host,
    projectId: identity.projectId,
    projectName: identity.projectName,
    ownerUsername: identity.ownerUsername,
    workstream: identity.workstream,
    reviewSession: identity.reviewSession,
    agentSession: identity.agentSession,
    state: opts.state ?? 'reviewing',
    at: new Date(now),
    // A replacement review starts its ring story over: the old seenAt must
    // not suppress the new one's done.
    doneAt: null,
    seenAt: null,
    // Nothing has been published under this record yet: writes skip unchanged
    // states, so a recovered pane is published exactly once — with its real
    // first state, never a phantom `reviewing` before it (which would re-flash
    // the sidebar's ready flash for every rediscovered done review).
    lastPushedState: null,
  };
  records.set(recordKey(identity.host.instanceId, identity.reviewSession), rec);
  unrecoverable.delete(recordKey(identity.host.instanceId, identity.reviewSession));
  return rec;
}

/**
 * File a fresh review: the POST /review path (a launch by the user).
 * Replaces any prior record for the pane and publishes `reviewing` now.
 */
export function registerReviewRecord(
  identity: ReviewIdentity,
  pr: { pr: number; url: string | null },
  opts: { startedAt?: Date | null; startedByUserId?: string | null; now?: number } = {},
): ReviewRecord {
  const rec = fileRecord(identity, pr, opts);
  writeMeta(rec, { force: true });
  return rec;
}

/** The record is gone (stop route, or the probe said the pane is gone): sever it and clear the ring. */
export function clearReviewRecord(identity: ReviewIdentity): void {
  records.delete(recordKey(identity.host.instanceId, identity.reviewSession));
  unrecoverable.delete(recordKey(identity.host.instanceId, identity.reviewSession));
  writeClearedMeta(identity);
}

/** Visible for tests: panes whose PR could not be read back and will not be re-probed. */
export function unrecoverableFor(instanceId: string | null, reviewSession: string): boolean {
  return unrecoverable.has(recordKey(instanceId, reviewSession));
}

/** POST /review/seen: stamp seenAt and republish (forced: the state alone would not change). */
export function markReviewSeen(instanceId: string | null, reviewSession: string, now: number = Date.now()): boolean {
  const rec = records.get(recordKey(instanceId, reviewSession));
  if (!rec) return false;
  rec.seenAt = new Date(now);
  if (rec.doneAt && rec.seenAt < rec.doneAt) rec.seenAt = rec.doneAt;
  writeMeta(rec, { force: true });
  return true;
}

/**
 * One probe result folded into a record: state transition bookkeeping and
 * the meta write on change. Coerces the settle window (above) so a just-
 * launched pane's bare prompt does not read as `done`. `state === null`
 * means the foreground-cmd RPC failed: the last state stands.
 */
export function touchRecordWithProbe(
  rec: ReviewRecord | null,
  probe: { exists: boolean; state: ReviewPaneState | null; recovered: { pr: number; url: string | null } | null; unrecoverable: boolean } | null,
  identity: ReviewIdentity,
  now: number = Date.now(),
): void {
  if (!probe) return;
  if (!probe.exists) {
    clearReviewRecord(identity);
    return;
  }
  if (probe.recovered) {
    // probeReviewPane only recovers when the caller had no record, so
    // recovered implies rec was null on entry: file it without publishing —
    // the state fold below publishes the record once, with its real first
    // state (a rediscovered done review must not flash reviewing first).
    rec = fileRecord(identity, { pr: probe.recovered.pr, url: probe.recovered.url }, { startedAt: null, now });
  }
  if (!rec) {
    if (probe.unrecoverable) unrecoverable.add(recordKey(identity.host.instanceId, identity.reviewSession));
    return; // adopting-without-number: nothing to publish yet, the next pass retries
  }
  if (!probe.state) {
    // An RPC hiccup, not information: the next pass re-probes — but a record
    // that has never reached the channel announces itself as reviewing.
    if (probe.recovered) writeMeta(rec, { force: true });
    return;
  }
  let next = probe.state;
  if (rec.startedAt && now - rec.startedAt.getTime() < START_SETTLE_MS && next !== 'waiting') {
    // A fresh shell's bare prompt classifies as done; a review just launched
    // has not read anything yet. Only an approval prompt is trusted early.
    next = 'reviewing';
  }
  if (rec.state !== next) {
    rec.state = next;
    rec.at = new Date(now);
    if (next === 'done') rec.doneAt = new Date(now);
  }
  // Skips itself when the state was already the pushed one (a recovered
  // 'reviewing' pane that probed 'reviewing' publishes once, here).
  writeMeta(rec, { force: !!probe.recovered });
}

/**
 * Adopt a *-review session found in a host's tmux list. Recovery of the PR is
 * the caller's (it owns the probe): this files the record and returns it.
 * Used by both the sweep's discovery and (via touchRecordWithProbe's
 * recovered path) the GET route.
 */
// ── Discovery ────────────────────────────────────────────────────────────

export interface DiscoveryProject {
  projectId: string;
  projectName: string;
  ownerUsername: string;
  workstreams: string[];
}

/** One host's candidate projects, keyed by the agentRegistry host key. */
export interface DiscoveryHost {
  host: ProjectHost;
  projects: DiscoveryProject[];
}

/**
 * Every non-archived project grouped per HOST, keeping only hosts whose agent
 * is connected (the sweep cannot ask a tmux it cannot reach). Legacy
 * host-less projects group under their owner's per-user agent. One query is
 * shared by the whole pass; when only a subset of hosts needs discovery the
 * caller passes their keys and the rest are answered from memory.
 */
export async function discoverCandidates(onlyHosts?: Set<string>): Promise<Map<string, DiscoveryHost>> {
  const projects = await prisma.project.findMany({
    where: { archived: false },
    select: {
      id: true, name: true, userId: true, instanceId: true,
      user: { select: { unixUsername: true } },
      workstreams: { where: { archived: false }, select: { name: true } },
    },
  });
  const out = new Map<string, DiscoveryHost>();
  for (const p of projects) {
    const host: ProjectHost = { userId: p.userId, instanceId: p.instanceId };
    if (!isProjectAgentConnected(host)) continue;
    const key = hostKeyOf(host);
    if (onlyHosts && !onlyHosts.has(key)) continue;
    let group = out.get(key);
    if (!group) { group = { host, projects: [] }; out.set(key, group); }
    group.projects.push({
      projectId: p.id,
      projectName: p.name,
      ownerUsername: p.user.unixUsername,
      workstreams: p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'],
    });
  }
  return out;
}

/**
 * One discovery pass for one host: `tmux-list` ONCE, intersect with every
 * candidate project's legal `-review` session names, and adopt the panes that
 * have no record yet (probe, read the PR back, publish once). Returns ok so
 * the caller only marks the host seen after a list that actually worked.
 */
export async function adoptHostPanels(
  send: SendForReviewSweep,
  groupHost: DiscoveryHost,
  now: number,
): Promise<{ ok: boolean; adopted: number }> {
  let list: unknown;
  try {
    list = await send(groupHost.host, 'tmux-list', {}, 5000);
  } catch {
    // the agent hiccuped; the caller does not mark the host seen, so the
    // next tick retries instead of leaving the pane undiscovered
    return { ok: false, adopted: 0 };
  }
  const sessions = (list as { sessions?: unknown } | null)?.sessions;
  const live = new Set<string>(Array.isArray(sessions) ? sessions : []);
  let adopted = 0;
  for (const proj of groupHost.projects) {
    for (const ws of proj.workstreams) {
      const identity: ReviewIdentity = {
        host: groupHost.host,
        projectId: proj.projectId,
        projectName: proj.projectName,
        ownerUsername: proj.ownerUsername,
        workstream: ws,
        reviewSession: sessionName(proj.ownerUsername, proj.projectName, 'review', ws),
        agentSession: sessionName(proj.ownerUsername, proj.projectName, 'agent', ws),
      };
      if (!live.has(identity.reviewSession)) continue;
      const key = recordKey(groupHost.host.instanceId, identity.reviewSession);
      if (records.has(key)) continue;
      // A pane whose launch line could not be read back was deep-captured once
      // already; re-probing it every pass buys nothing.
      if (unrecoverable.has(key)) continue;
      const probe = await probeReviewPane(send, groupHost.host, identity.reviewSession, null);
      if (!probe.exists) continue;
      touchRecordWithProbe(null, probe, identity, now); // self-files on recovery
      adopted++;
    }
  }
  return { ok: true, adopted };
}

// ── The sweep loop ──────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let ticks = 0;
const seenHosts = new Set<string>();

function hostKeyOf(host: ProjectHost): string {
  return `${host.userId}|${host.instanceId ?? ''}`;
}

/**
 * One sweep pass. Exported for tests: drive it with a fake `sendForProject`
 * and assert on the status map / records.
 */
export async function runReviewSweepTick(
  send: SendForReviewSweep = sendForProject,
  now: number = Date.now(),
): Promise<void> {
  // 1. Probe the records we know about (three RPCs per active review). Uses
  //    no database.
  for (const rec of allReviewRecords()) {
    if (!isProjectAgentConnected(rec.host)) continue; // offline: the last pushed state stands
    const identity: ReviewIdentity = {
      host: rec.host,
      projectId: rec.projectId,
      projectName: rec.projectName,
      ownerUsername: rec.ownerUsername,
      workstream: rec.workstream,
      reviewSession: rec.reviewSession,
      agentSession: rec.agentSession,
    };
    let probe;
    try {
      probe = await probeReviewPane(send, rec.host, rec.reviewSession, { pr: rec.pr, url: rec.url });
    } catch {
      continue; // an agent error is not "no pane"; the record survives an agent hiccup
    }
    // Re-read AFTER the probe: a stop/clear that landed while it was in
    // flight must not be resurrected by the detached record's result.
    touchRecordWithProbe(records.get(recordKey(rec.host.instanceId, rec.reviewSession)) ?? null, probe, identity, now);
  }

  // 2. Discovery. Hosts newly seen adopt immediately; every known host
  //    re-adopts (rename recovery, a missed adopt) on the rediscovery
  //    cadence. Quiet ticks (nothing new, not a full pass) never hit the DB:
  //    the connected-host check comes from the agent registry.
  ticks++;
  const full = ticks % Math.max(1, Math.round(REDISCOVERY_INTERVAL_MS / SWEEP_INTERVAL_MS)) === 0;
  const connected = connectedProjectHosts();
  const connectedKeys = new Set(connected.map(hostKeyOf));
  // Drop hosts whose agent stops connecting so their next connect is "new".
  for (const key of [...seenHosts]) {
    if (!connectedKeys.has(key)) seenHosts.delete(key);
  }
  if (!full && connectedKeys.size === seenHosts.size) return; // quiet tick
  const grouped = await discoverCandidates(
    full ? undefined : new Set([...connectedKeys].filter(k => !seenHosts.has(k))),
  );
  for (const [key, group] of grouped) {
    if (seenHosts.has(key) && !full) continue;
    // Only a pass that managed to list tmux marks the host seen, so a failed
    // list retries on the next tick.
    const r = await adoptHostPanels(send, group, now);
    if (r.ok) seenHosts.add(key);
  }
}

export function startReviewSweep(): void {
  if (timer) return;
  console.log('[REVIEW-SWEEP] started');
  timer = setInterval(() => {
    void runReviewSweepTick().catch(err => {
      console.error('[REVIEW-SWEEP] sweep failed:', (err as Error).message);
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopReviewSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
  seenHosts.clear();
  ticks = 0;
}

/** Test-only: reset the module (records, unrecoverable, seen hosts). */
export function resetReviewSweepForTests(): void {
  records.clear();
  unrecoverable.clear();
  seenHosts.clear();
  ticks = 0;
}
