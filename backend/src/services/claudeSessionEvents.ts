/**
 * The event log of Claude Code cloud sessions (schema.prisma,
 * ClaudeSessionEvent). One row per
 * signal, keyed by the Anthropic session id so the runs of one session (a
 * re-offer after a refusal, a resume after the idle release, each its own
 * order) read as one session in the UI.
 *
 * Writers: the spawn route for every outcome once the owner is known
 * (refusals included: `queued` carries the reason the Activity tab shows), the
 * box-facing event route for `started` and `ended`, the reconciler for
 * `lost`, and the owner's "end session" for `end-requested`. Every write is
 * best effort: a failed insert is logged and never changes the caller's
 * answer. Every write also tells the owner's browsers that something changed
 * (setCloudSessionChangeCallback, wired to the status WebSocket in index.ts).
 *
 * `detail` is a refusal reason or an exit reason: never an email, a token or
 * prompt text (the title lives on the run row, not here).
 */
import { prisma } from '../db';

export const SESSION_EVENT_KINDS = [
  'queued', 'placed', 'already-running', 'agent-failed', 'started', 'ended', 'lost', 'end-requested', 'renamed',
] as const;
export type SessionEventKind = typeof SESSION_EVENT_KINDS[number];

export interface SessionOwner {
  id: string;
  unixUsername: string;
}

export interface SessionEventInput {
  owner: SessionOwner;
  sessionId: string;
  orderId: string;
  /** The box, when the signal reached one. */
  instanceId?: string | null;
  kind: SessionEventKind;
  detail?: string | null;
  at?: Date;
}

const DETAIL_MAX = 500;

type ChangeCallback = (owner: SessionOwner, sessionId: string) => void;
let onChange: ChangeCallback | null = null;

/** index.ts sets this to push `{type: 'claude-session'}` to the owner's status WebSocket clients. */
export function setCloudSessionChangeCallback(cb: ChangeCallback | null): void {
  onChange = cb;
}

export function notifyCloudSessionChange(owner: SessionOwner, sessionId: string): void {
  try { onChange?.(owner, sessionId); } catch (err) {
    console.error('[CLAUDE-RUNNER] cloud session change push failed:', err instanceof Error ? err.message : String(err));
  }
}

/** Trim a reason to what the column should hold; null for nothing. */
export function eventDetail(detail: string | null | undefined): string | null {
  const d = detail?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!d) return null;
  return d.length > DETAIL_MAX ? `${d.slice(0, DETAIL_MAX - 1)}…` : d;
}

/**
 * Append one event and notify the owner. Never throws: the spawn route's
 * answer to the hook and the box's report must not depend on this table.
 */
export async function recordSessionEvent(input: SessionEventInput): Promise<void> {
  try {
    await prisma.claudeSessionEvent.create({
      data: {
        userId: input.owner.id,
        sessionId: input.sessionId,
        orderId: input.orderId,
        instanceId: input.instanceId ?? null,
        kind: input.kind,
        detail: eventDetail(input.detail),
        ...(input.at ? { at: input.at } : {}),
      },
    });
  } catch (err) {
    console.error(`[CLAUDE-RUNNER] order ${input.orderId}: recording the ${input.kind} event failed:`, err instanceof Error ? err.message : String(err));
  }
  notifyCloudSessionChange(input.owner, input.sessionId);
}
