// The words on a session's sidebar card (pages/chat/SessionCard.tsx):
// its status chip's colour and what it means, and
// the tooltips of its box icon and its project icon. Pure, so they're tested
// on their own.
import type { Instance } from '../types';
import { opensReview, stateSince, type InboxRow } from '../mobile/inbox';
import type { RowState, RowStateKind } from './rowState';

/** What a chip is coloured by: Needs you is one colour (amber) whatever it waits on; a failed turn is red. */
export type ChipKind = 'working' | 'needs' | 'error' | 'done' | 'off';

export function chipKind(kind: RowStateKind): ChipKind {
  return kind === 'approval' || kind === 'unread' ? 'needs' : kind;
}

/**
 * What the chip says, in words, for the card's tooltip: the status, how long
 * it has been in it, and what that means. Needs you leads with the row's own
 * words (`state.text`: "Needs you · approval", "Needs you · review #12
 * ready"), so a finished review never reads as a question. `parked`: the
 * session's box is stopped, so opening the session wakes it first.
 */
export function chipTip(state: Pick<RowState, 'kind' | 'unseen'> & { text?: string }, age: string | null, parked = false): string {
  const t = age ?? '';
  const unseen = state.unseen ? ", and you haven't looked yet" : '';
  switch (state.kind) {
    case 'working': return age ? `Working for ${t}` : 'Working';
    case 'approval':
    case 'unread': {
      const words = state.text || 'Needs you';
      return age ? `${words}, waiting ${t}` : words;
    }
    case 'error': {
      const words = state.text || 'Needs you · failed';
      return age ? `${words}, ${t} ago` : words;
    }
    case 'off': {
      const how = parked ? 'its box is parked, and opening it wakes the box' : 'opening it starts it again';
      return `${age ? `Not running for ${t}` : 'Not running'}${unseen}: ${how}`;
    }
    case 'done': {
      const lead = age ? `Idle for ${t}` : 'Idle';
      return state.unseen ? `${lead}${unseen}` : `${lead}: it finished its turn`;
    }
  }
}

/**
 * A span in its largest unit, as the redesigned sidebar's card shows it: "1m", "8m", "3h", "2d".
 * Under a minute is "1m": "<1m" said nothing more. Only the
 * card's chip and its tooltips read this; the old sidebar rows, the phone's session rows and Lab
 * keep utils/format.ts fmtAge, "<1m", until the redesign reaches everyone.
 */
export function shortAge(ms: number): string {
  if (ms < 60_000) return '1m';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/**
 * The time a card's chip counts from: the session's own, never its project's. A row with no status of its
 * own has nothing to count from (`ownStatus` false: mobile/inbox.ts buildRows gives such a row its
 * project's lastActiveAt for a clock, so a not-running session read "Not running for 1m" whenever another
 * session in its project had just worked). Otherwise a review-led row counts from its review
 * (stateSince), unless the open chat's live status leads it (`live`); else from when the session entered
 * its status (the status frame's statusSince), then its last status write.
 */
export function chipSince(
  row: Pick<InboxRow, 'status' | 'ring' | 'review' | 'updatedAt' | 'statusSince'>, opts: { ownStatus: boolean; live: boolean },
): string | null {
  if (!opts.ownStatus) return null;
  const since = stateSince(row);
  return opensReview(row) && !opts.live ? since : (row.statusSince ?? since);
}

/** How long since `since` (ISO), as the chip shows it; null when unknown. */
export function chipAge(since: string | null | undefined, now: number): string | null {
  const at = since ? Date.parse(since) : NaN;
  return Number.isNaN(at) ? null : shortAge(Math.max(0, now - at));
}

type BoxFacts = Pick<Instance, 'name' | 'status'> & Partial<Pick<Instance, 'instanceType' | 'lastConnectedAt'>>;

const BOX_STATE: Partial<Record<Instance['status'], string>> = {
  ready: 'Running',
  warm: 'Running',
  stopped: 'Parked',
  hibernated: 'Parked',
  stopping: 'Parking',
  hibernating: 'Parking',
  starting: 'Starting',
  provisioning: 'Starting',
  'awaiting-agent': 'Starting',
  warming: 'Starting',
  failed: 'Failed',
  quarantined: 'Quarantined',
  terminated: 'Gone',
};

/** Whether opening a session on this box has to wake it first. */
export const boxParked = (box: Pick<Instance, 'status'> | null | undefined): boolean =>
  box?.status === 'stopped' || box?.status === 'hibernated';

/**
 * The box icon's tooltip: which box, whether it's running or parked, its size,
 * and how long it's been up. `label` is the sidebar's name for it (a shared
 * project's box is its owner's, "Ada's box", and its details aren't ours).
 */
export function boxTip(box: BoxFacts | null | undefined, label: string, now: number): string {
  if (!box) return label;
  const state = BOX_STATE[box.status] ?? box.status;
  const lines = [label, [state, box.instanceType].filter(Boolean).join(' · ')];
  const since = box.lastConnectedAt ? Date.parse(box.lastConnectedAt) : NaN;
  if (state === 'Running' && !Number.isNaN(since)) lines.push(`up ${shortAge(Math.max(0, now - since))}`);
  if (boxParked(box)) lines.push('Opening a session here wakes it');
  return lines.join('\n');
}

/** The project icon's tooltip: the project, its repositories, its sessions and PRs, and this session's model. */
export function projectTip(p: { name: string; repos: readonly string[]; sessions: number; prs: number; model: string }): string {
  return [
    p.name,
    ...(p.repos.length ? p.repos : ['No repository']),
    `${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'} · ${p.prs} ${p.prs === 1 ? 'PR' : 'PRs'}`,
    `Model: ${p.model}`,
  ].join('\n');
}

/**
 * An archived chat's card tooltip (pages/chat/ArchivedRows.tsx): its session's title, its project when that's
 * another name, its repository, how long ago it was archived, and where its box is.
 */
export function archivedCardTip(a: { title: string; project: string; repo: string | null; age: string | null; box: string }): string {
  return [a.title, a.project !== a.title ? a.project : null, a.repo, a.age ? `Archived ${a.age} ago` : 'Archived', a.box].filter(Boolean).join('\n');
}

/** A PR's pill text: "#123" from the pipeline's "owner/repo#123". */
export function prPill(pr: string | null | undefined): string | null {
  if (!pr) return null;
  const at = pr.lastIndexOf('#');
  return at >= 0 ? pr.slice(at) : pr;
}
