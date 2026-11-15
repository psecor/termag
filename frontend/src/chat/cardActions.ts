// What a session card's Archive does, and what its toast and confirm say
// ("What Archive archives"). Pure, so it's
// tested on its own; pages/chat/useCardActions.tsx runs it.
import type { InboxRow } from '../mobile/inbox';

/**
 * How a card archives its session. `chat`: the chat archive (POST
 * /api/chats/:id/archive), which takes the whole checkout and may stop its box,
 * only for a checkout's last live session: its main, run by the chat runner,
 * with no other live session beside it. `session`: the per-session archive mark
 * (Workstream.explorerArchivedAt, as a space's Files sets it), for any other
 * session of the person's own. Null: nothing to archive from here (a shared
 * session, an automation's run, a cloud session, a session not yet saved).
 */
export type ArchiveWay = 'chat' | 'session';

export function archiveWay(
  row: Pick<InboxRow, 'shared' | 'kind' | 'workstream' | 'workstreamId'>,
  checkout: { chatRunner: boolean; liveSiblings: number },
): ArchiveWay | null {
  // A session not yet saved (a checkout with no workstream rows) has nothing to archive from here either way.
  if (row.shared || row.kind === 'automation' || row.kind === 'cloud' || !row.workstreamId) return null;
  return row.workstream === 'main' && checkout.chatRunner && checkout.liveSiblings === 0 ? 'chat' : 'session';
}

/**
 * The checkout's other sessions still in the list (`listed`: the sidebar's rows, Archived's taken out), which keep
 * the chat archive off it. One marked archived but still working, needing you or open is in the list, so it counts:
 * the chat archive would stop it.
 */
export function liveSiblings(row: Pick<InboxRow, 'projectId' | 'key'>, listed: readonly Pick<InboxRow, 'projectId' | 'key'>[]): number {
  return listed.filter(r => r.projectId === row.projectId && r.key !== row.key).length;
}

/** A title short enough for a toast's one line. */
export function toastTitle(title: string, max = 48): string {
  const t = title.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * What the archive's box did, from its answer (routes/chats.ts archiveChatFor): stopping (by the dry run's name for
 * it, null when the dry run couldn't be read), kept up, or a stop that failed.
 */
export type ArchivedBox = { stopping: string | null } | { failed: string } | null;

export function archivedBox(box: { action: string | null; status?: string | null; error?: string } | null | undefined, name: string | null): ArchivedBox {
  if (!box || !box.action) return null;
  if (box.error) return { failed: box.error };
  return { stopping: name };
}

/** The Undo toast: what was archived, and what happened to its box. */
export function archiveToast(title: string, box: ArchivedBox = null): { title: string; description?: string; status: 'info' | 'error' } {
  const what = `Archived “${toastTitle(title)}”`;
  if (box && 'stopping' in box) return { title: what, description: `${box.stopping ?? 'Its box'} is stopping: nothing else runs on it.`, status: 'info' };
  if (box && 'failed' in box) return { title: what, description: `Its box is still running: ${box.failed}`, status: 'error' };
  return { title: what, status: 'info' };
}

/**
 * The confirm an archive asks first, only when it would stop the box: `boxName` from the dry run, or null when the
 * dry run couldn't be read, so it may stop it.
 */
export function archiveConfirm(title: string, boxName: string | null): { heading: string; body: string; confirm: string } {
  if (boxName === null) {
    return {
      heading: 'Archive it?',
      body: `Couldn't check whether anything else runs on the box of “${title.trim()}”. If nothing does, archiving it stops the box. Undo, or Reopen from Archived, starts it again.`,
      confirm: 'Archive',
    };
  }
  return {
    heading: 'Archive and stop its box?',
    body: `“${title.trim()}” is the only thing on its box, ${boxName}, so archiving it stops the box. Undo, or Reopen from Archived, starts it again.`,
    confirm: 'Archive and stop the box',
  };
}

/** Whether a reopen's refusal is the box still on its way down or up, so Undo asks again shortly. */
export function reopenSettling(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { error?: string } } } | null)?.response;
  return res?.status === 409 && /still (stopping|hibernating|starting)/.test(res.data?.error ?? '');
}

/** One item of a card's session menu: about the session, never a tab. */
export interface SessionMenuItem {
  id: 'rename' | 'pin' | 'unread' | 'copy' | 'desktop' | 'archive';
  label: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * A card's ⋯ menu, in order: Rename…, Pin to top or Unpin, Mark as unread (or as read, when it's unread), Copy link,
 * Open in termag desktop, Archive. Each only where it applies: Rename and Archive on the person's own sessions,
 * Pin under the server's pins, the desktop where it can open the session. `unread`: 'unread' marks it unread,
 * 'read' marks it read, or why it can't be unread yet.
 */
export function sessionMenuItems(i: {
  canRename: boolean;
  /** null: pins aren't on. */
  pinned: boolean | null;
  /** null: it never shows as unread (an automation's run), so it isn't offered. */
  unread: 'unread' | 'read' | { why: string } | null;
  desktop: boolean;
  archive: boolean;
}): SessionMenuItem[] {
  const items: SessionMenuItem[] = [];
  if (i.canRename) items.push({ id: 'rename', label: 'Rename…' });
  if (i.pinned !== null) items.push({ id: 'pin', label: i.pinned ? 'Unpin' : 'Pin to top' });
  if (i.unread !== null) {
    items.push(typeof i.unread === 'object'
      ? { id: 'unread', label: 'Mark as unread', hint: i.unread.why, disabled: true }
      : { id: 'unread', label: i.unread === 'read' ? 'Mark as read' : 'Mark as unread' });
  }
  items.push({ id: 'copy', label: 'Copy link' });
  if (i.desktop) items.push({ id: 'desktop', label: 'Open in termag desktop' });
  if (i.archive) items.push({ id: 'archive', label: 'Archive' });
  return items;
}

/** Why a session can't be marked unread yet: it's still going, or it stopped too long ago for a blue dot. */
export function unreadWhy(kind: string): string {
  return kind === 'done' || kind === 'off' ? 'Only one that stopped in the last 8 hours' : 'Once it has finished its turn';
}

/** A session's address to share: the page's own origin and termag's base path. */
export function sessionLink(origin: string, base: string, href: string): string {
  return `${origin}${base.replace(/\/$/, '')}${href}`;
}
