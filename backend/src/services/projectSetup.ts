/**
 * A repo project's setup: the pure decisions. `projectClone.ts` owns every
 * RPC, launch and Prisma write; this module only decides, so the rules are
 * unit-testable.
 *
 * A project picked from a repository on a box starts `pending`. The box's
 * agent either clones it durably (`project-clone-v1`: the box reports
 * `cloning`, then `ready` or `failed`) or, without that capability, gets the
 * pane checkout typed ahead of the agent and the project becomes `none`.
 * Every other project is `none` from the start. Only `none` and `ready` may
 * have tmux sessions (sessionGate.ts), because `tmux-create` makes the dir
 * and `git init`s it, which would poison the clone target.
 */

import { PROVIDERS } from '../providers/registry';
import { isBranchName } from './repoCreate';

export const PROJECT_CLONE_CAPABILITY = 'project-clone-v1';

export const SETUP_STATUSES = ['none', 'pending', 'cloning', 'ready', 'failed'] as const;
export type SetupStatus = typeof SETUP_STATUSES[number];

/** Null for text no release wrote; every reader treats that as unready. */
export function toSetupStatus(raw: string): SetupStatus | null {
  return SETUP_STATUSES.find(status => status === raw) ?? null;
}

export type AgentView =
  | { kind: 'absent' }
  | { kind: 'awaiting-hello' }
  | { kind: 'present'; capabilities: readonly string[] };

export type CloneRoute = 'durable' | 'pane' | 'unsupported';

/**
 * How a box's agent can set the project up. A bridge provider (codex) starts
 * its agent through the bridge, which takes over the pane, so the pane
 * checkout has nowhere to chain the clone.
 */
export function cloneRoute(capabilities: readonly string[], provider: string | null): CloneRoute {
  if (capabilities.includes(PROJECT_CLONE_CAPABILITY)) return 'durable';
  return provider && PROVIDERS[provider]?.needsBridge ? 'unsupported' : 'pane';
}

export type CloneReport =
  | { status: 'pending' }
  | { status: 'cloning' }
  | { status: 'ready'; branch: string | null }
  | { status: 'failed'; error: string };

export interface CloneStatusFrame {
  projectId: string;
  instanceId: string;
  attempt: number;
  report: CloneReport;
}

const MAX_ERROR_LENGTH = 256;

export function parseCloneStatusFrame(raw: unknown): CloneStatusFrame | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const { projectId, instanceId, attempt } = fields;
  if (typeof projectId !== 'string' || !projectId) return null;
  if (typeof instanceId !== 'string' || !instanceId) return null;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) return null;
  const report = parseCloneReport(fields);
  return report && { projectId, instanceId, attempt, report };
}

function parseCloneReport(fields: Record<string, unknown>): CloneReport | null {
  switch (fields.status) {
    case 'pending':
    case 'cloning':
      return { status: fields.status };
    case 'ready':
      return {
        status: 'ready',
        branch: typeof fields.branch === 'string' && isBranchName(fields.branch) ? fields.branch : null,
      };
    case 'failed': {
      const error = typeof fields.error === 'string'
        ? fields.error.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH)
        : '';
      return { status: 'failed', error: error || 'clone failed' };
    }
    default:
      return null;
  }
}

export type SetupEvent =
  | { kind: 'agent-connected'; capabilities: readonly string[] }
  | { kind: 'report'; attempt: number; report: CloneReport }
  | { kind: 'retry' }
  | { kind: 'start-empty' };

export type SetupEffect = 'dispatch' | 'pane-checkout' | 'launch' | 'empty-dir';

type EventKey = `connected-${CloneRoute}` | `report-${CloneReport['status']}` | 'retry' | 'start-empty';

interface Transition {
  to: SetupStatus;
  effects: readonly SetupEffect[];
}

/**
 * Every legal move. A pair missing here is ignored for an agent event and
 * refused for a request. `cloning` meeting a pane-only agent fails rather
 * than falling back: the box's unit may still be running after an agent
 * rollback, and a second clone typed into the same dir would collide. Retry
 * from `failed` takes the pane route from `pending`.
 */
const SETUP_TRANSITIONS: Readonly<Record<SetupStatus, Partial<Record<EventKey, Transition>>>> = {
  none: {},
  pending: {
    'connected-durable': { to: 'pending', effects: ['dispatch'] },
    'connected-pane': { to: 'none', effects: ['pane-checkout'] },
    'connected-unsupported': { to: 'failed', effects: [] },
    'report-cloning': { to: 'cloning', effects: [] },
    'report-ready': { to: 'ready', effects: ['launch'] },
    'report-failed': { to: 'failed', effects: [] },
  },
  cloning: {
    'connected-durable': { to: 'cloning', effects: ['dispatch'] },
    'connected-pane': { to: 'failed', effects: [] },
    'connected-unsupported': { to: 'failed', effects: [] },
    'report-pending': { to: 'pending', effects: [] },
    'report-ready': { to: 'ready', effects: ['launch'] },
    'report-failed': { to: 'failed', effects: [] },
  },
  ready: {},
  failed: {
    retry: { to: 'pending', effects: [] },
    'start-empty': { to: 'none', effects: ['empty-dir', 'launch'] },
  },
};

export interface SetupSnapshot {
  status: SetupStatus;
  attempt: number;
  provider: string | null;
}

export interface SetupWrite {
  setupStatus: SetupStatus;
  setupError?: string | null;
  bumpAttempt?: true;
  repoUrl?: null;
  repoDefaultBranch?: string | null;
}

export interface SetupMove {
  kind: 'move';
  from: SetupStatus;
  to: SetupStatus;
  effects: readonly SetupEffect[];
  write: SetupWrite | null;
  mainBranch: string | null;
}

export type SetupDecision =
  | SetupMove
  | { kind: 'ignore'; why: string }
  | { kind: 'refuse'; error: string };

/**
 * The move committed in place of one whose effect could not do its part, so
 * no setup waits on an event that may never come: Retry and Start empty
 * recover it.
 */
export function effectFailure(from: SetupStatus, error: string): SetupMove {
  return { kind: 'move', from, to: 'failed', effects: [], write: { setupStatus: 'failed', setupError: error }, mainBranch: null };
}

const NO_LONGER_DURABLE = "This box's agent no longer runs durable clones. Retry to clone in the terminal.";

export function unsupportedCloneError(provider: string): string {
  const name = PROVIDERS[provider]?.displayName ?? provider;
  return `This box's agent can't clone a repository for ${name}. Update the box or start empty.`;
}

export function decideSetup(row: SetupSnapshot, event: SetupEvent): SetupDecision {
  if (event.kind === 'report' && event.attempt !== row.attempt) return { kind: 'ignore', why: 'stale attempt' };
  const key = eventKey(event, row.provider);
  const transition = SETUP_TRANSITIONS[row.status][key];
  if (!transition) {
    if (event.kind === 'retry') return { kind: 'refuse', error: 'Only a failed clone can be retried.' };
    if (event.kind === 'start-empty') return { kind: 'refuse', error: 'Only a failed clone can start empty.' };
    return { kind: 'ignore', why: `${key} while ${row.status}` };
  }
  const { to, effects } = transition;
  const change = to === row.status
    ? { write: null, mainBranch: null }
    : changeFor(to, key, event, row.provider);
  return { kind: 'move', from: row.status, to, effects, ...change };
}

function eventKey(event: SetupEvent, provider: string | null): EventKey {
  switch (event.kind) {
    case 'agent-connected': return `connected-${cloneRoute(event.capabilities, provider)}`;
    case 'report': return `report-${event.report.status}`;
    case 'retry': return 'retry';
    case 'start-empty': return 'start-empty';
  }
}

function changeFor(
  to: SetupStatus,
  key: EventKey,
  event: SetupEvent,
  provider: string | null,
): { write: SetupWrite; mainBranch: string | null } {
  switch (event.kind) {
    case 'agent-connected': {
      if (to !== 'failed') return { write: { setupStatus: to }, mainBranch: null };
      const setupError = key === 'connected-unsupported' ? unsupportedCloneError(provider ?? '') : NO_LONGER_DURABLE;
      return { write: { setupStatus: to, setupError }, mainBranch: null };
    }
    case 'report': {
      const { report } = event;
      if (report.status === 'failed') return { write: { setupStatus: to, setupError: report.error }, mainBranch: null };
      if (report.status !== 'ready') return { write: { setupStatus: to }, mainBranch: null };
      if (!report.branch) return { write: { setupStatus: to, setupError: null }, mainBranch: null };
      return { write: { setupStatus: to, setupError: null, repoDefaultBranch: report.branch }, mainBranch: report.branch };
    }
    case 'retry':
      return { write: { setupStatus: to, setupError: null, bumpAttempt: true }, mainBranch: null };
    case 'start-empty':
      return { write: { setupStatus: to, repoUrl: null, repoDefaultBranch: null, setupError: null }, mainBranch: 'main' };
  }
}
