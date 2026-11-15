// The redesigned sidebar's Archive: one click,
// with an Undo toast, asking first only when it would stop a box. A checkout's
// last live session goes through the chat archive, whose dry run (GET
// /api/chats/:id/archive-plan) says whether the box stops; any other session
// gets the per-session archive mark (chat/cardActions.ts archiveWay). Undo puts
// it back: the mark cleared, or the chat reopened (its box started again when
// the archive stopped it, which may take a while: the toast says so and the
// reopen is asked again until the box's agent is back). Archiving the session on
// screen leaves it for the sidebar's home; its Undo goes back to it. The card's
// Archive button and the `e` key call the same `archive`. The toast is
// LaunchPad's snackbar and the confirm its alert dialog, both in termag's
// colours (LP_THEME).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button, ButtonGroup, Dialog, Heading, Modal, ModalOverlay, SnackbarRegion, Text, Toast, snackbarQueue, toastRegionStyles,
} from '@launchpad-ui/components';
import type { InboxRow } from '../../mobile/inbox';
import { chatsApi, workstreamsApi } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';
import {
  announceChatsChanged, archiveBoxNotice, clearRunningBox, reopenCatchUp, reopenOpensChat, runningBoxFromNotice, saveRunningBox,
} from '../../chat/archive';
import { archiveConfirm, archivedBox, archiveToast, reopenSettling, toastTitle, type ArchiveWay } from '../../chat/cardActions';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';

// SnackbarRegion spreads its props after its own className, so a className passed to it replaces the region's styles:
// build the full class with LaunchPad's own toastRegionStyles (as ChatNudge.tsx does). sessionCard.css puts it over
// the sidebar's bottom left, above the bottom row.
const REGION_CLASS = toastRegionStyles({ placement: 'bottom', className: `${LP_THEME} sb-toast-region` });
const UNDO_MS = 8000;
/** Where archiving the session on screen leaves the person: the sidebar's home. */
const LEFT_TO = '/chat';
const REOPEN_POLL_MS = 5000;
const REOPEN_TRIES = 36;

export interface ArchiveTarget {
  row: Pick<InboxRow, 'key' | 'projectId' | 'workstream' | 'workstreamId'>;
  /** The card's title, for the toast and the confirm. */
  title: string;
  way: ArchiveWay;
  /** The checkout, for a box the archive couldn't stop (chat/archive.ts's running-box recovery). */
  project: { id: string; name: string; instanceId?: string | null };
  /** The session is the one on screen: archiving it leaves for the home, and Undo comes back. */
  open: boolean;
  href: string;
}

const errorText = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || (err instanceof Error ? err.message : '') || fallback;

export function useCardActions({ reloadProjects }: { reloadProjects: () => Promise<unknown> }): {
  archive: (t: ArchiveTarget) => void;
  /** The session an archive (or its confirm) is under way for. */
  busy: ReadonlySet<string>;
  /** A toast of the sidebar's own (the card menu's Copy link). */
  notify: (content: { title: string; description?: string; status: 'info' | 'error' }) => void;
  /** The toast region and the confirm, drawn once with the list. */
  ui: React.ReactNode;
} {
  const navigate = useNavigate();
  // The sessions an archive is under way for: a ref, so two clicks before a render can't both start one, and a state
  // for the buttons. Held from the click through the dry run, the confirm and the archive itself.
  const busyRef = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<{ target: ArchiveTarget; box: string | null } | null>(null);
  const undos = useRef(new Map<string, () => void>());
  const reload = useCallback(() => reloadProjects().catch(() => { /* the list's own alert says so */ }), [reloadProjects]);
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  // Where the person is now, so an Undo that lands later goes back to the session only if they're still where the
  // archive left them; and Undo's retries, which stop with the list.
  const location = useLocation();
  const here = useRef('');
  here.current = `${location.pathname}${location.search}`;
  const retries = useRef(new Set<number>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const pending = retries.current;
    return () => { live.current = false; for (const id of pending) window.clearTimeout(id); pending.clear(); };
  }, []);
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => { retries.current.delete(id); if (live.current) fn(); }, ms);
    retries.current.add(id);
  };
  // Back to the session Undo brought back, if it was the one on screen and the person hasn't gone anywhere since.
  const backTo = (t: ArchiveTarget, state?: unknown) => {
    if (t.open && here.current === LEFT_TO) navigate(t.href, state ? { state } : undefined);
  };

  const mark = (key: string, on: boolean) => {
    if (on) busyRef.current.add(key); else busyRef.current.delete(key);
    setBusy(new Set(busyRef.current));
  };
  const say = (content: { title: string; description?: string; status: 'info' | 'error' }, undo?: () => void) => {
    const key = snackbarQueue.add(content, { timeout: UNDO_MS, onClose: () => { undos.current.delete(key); } });
    if (undo) undos.current.set(key, undo);
  };

  // Undo of a chat archive: reopen, and again while the box comes back up (the parked turn is dropped only once its
  // agent is connected, so the row stays archived until then: chat/archive.ts reopenOpensChat), or while it's still on
  // its way down. Once reopened it goes as Archived's Reopen does (ArchivedChats.tsx openReopened): back in the live
  // list before its recovery goes or it's opened, opened with the box's catch-up state, and the box shown starting.
  const reopen = async (t: ArchiveTarget, tries = 0): Promise<void> => {
    const name = toastTitle(t.title);
    const again = () => {
      if (tries === 0) say({ title: `Bringing “${name}” back`, description: 'Its box is on its way; it reappears once the box is up.', status: 'info' });
      if (tries < REOPEN_TRIES) { later(() => { void reopen(t, tries + 1); }, REOPEN_POLL_MS); return; }
      say({ title: `Couldn't bring “${name}” back yet`, description: 'Its box is taking a while. Reopen it from Archived once it is up.', status: 'error' });
    };
    let res: Awaited<ReturnType<typeof chatsApi.reopen>>;
    try {
      res = await chatsApi.reopen(t.project.id);
    } catch (err) {
      // Undo straight after a stop: the box is still stopping, and the reopen waits for it to settle.
      if (reopenSettling(err)) { again(); return; }
      say({ title: `Couldn't bring “${name}” back`, description: `${errorText(err, 'The reopen failed')}. Reopen it from Archived.`, status: 'error' });
      return;
    }
    if (!reopenOpensChat(res)) { again(); return; }
    try {
      await reloadProjects();
    } catch {
      // Reopened, but the list didn't land: opening it now would find no conversation. It is live on the server
      // all the same, so its running-box recovery goes (or the chat would read as archived on its next visit).
      clearRunningBox(t.project.id);
      announceChatsChanged();
      say({ title: `“${name}” is back`, description: "The list didn't refresh; reload the page to see it.", status: 'info' });
      return;
    }
    clearRunningBox(t.project.id);
    const catchUp = reopenCatchUp(res.box);
    backTo(t, catchUp);
    await boxFeed.reload();
    const box = res.box;
    if (catchUp && box) {
      const current = boxFeed.getSnapshot().find(b => b.id === box.id);
      if (current && current.status !== 'starting') boxFeed.upsert({ ...current, status: 'starting' });
    }
    announceChatsChanged();
  };
  const unmark = async (t: ArchiveTarget) => {
    if (!t.row.workstreamId) return;
    try {
      await workstreamsApi.explorerArchive(t.row.projectId, t.row.workstreamId, false);
      await reload();
      backTo(t);
    } catch (err) {
      say({ title: `Couldn't bring “${toastTitle(t.title)}” back`, description: `${errorText(err, 'The unarchive failed')}. Unarchive it from Archived.`, status: 'error' });
    }
  };

  // The archive itself; the session is already marked busy.
  const run = async (t: ArchiveTarget, stopping: string | null) => {
    try {
      if (t.way === 'session') {
        await workstreamsApi.explorerArchive(t.row.projectId, t.row.workstreamId!, true);
        await reload();
        if (t.open) navigate(LEFT_TO);
        say(archiveToast(t.title), () => { void unmark(t); });
        return;
      }
      const res = await chatsApi.archive(t.project.id);
      announceChatsChanged();
      void boxFeed.reload();
      const box = archivedBox(res.box, stopping);
      // A box left running (a stop that failed, others still on it, a self-managed host): Archived offers "Box still
      // running", as the chat's own archive does.
      const notice = archiveBoxNotice(res.box);
      if (!notice.leave) saveRunningBox(runningBoxFromNotice(t.project, notice));
      await reload();
      if (t.open) navigate(LEFT_TO);
      say(archiveToast(t.title, box), () => { void reopen(t); });
    } catch (err) {
      say({ title: `Couldn't archive “${toastTitle(t.title)}”`, description: errorText(err, 'The archive failed'), status: 'error' });
    } finally {
      mark(t.row.key, false);
    }
  };

  // One confirm at a time: a newer one (two dry runs that both ask) replaces it, and the one it replaces lets go of
  // its card, which can be archived again.
  const ask = (next: { target: ArchiveTarget; box: string | null }) => setConfirm(prev => {
    if (prev && prev.target.row.key !== next.target.row.key) mark(prev.target.row.key, false);
    return next;
  });
  const archive = (t: ArchiveTarget) => {
    if (busyRef.current.has(t.row.key)) return;
    mark(t.row.key, true);
    if (t.way === 'session') { void run(t, null); return; }
    // The dry run: ask first only when the box would stop. One that can't be read asks too, since it may.
    chatsApi.archivePlan(t.project.id)
      .then(plan => {
        if (plan.box.action === 'stop') ask({ target: t, box: plan.box.name });
        else void run(t, null);
      })
      .catch(() => ask({ target: t, box: null }));
  };
  const cancel = () => {
    if (confirm) mark(confirm.target.row.key, false);
    setConfirm(null);
  };

  const words = confirm ? archiveConfirm(confirm.target.title, confirm.box) : null;
  const ui = (
    <>
      <SnackbarRegion className={REGION_CLASS} aria-label="Sidebar notices">
        {({ toast }) => (
          <Toast toast={toast} variant="snackbar" className="sb-toast">
            {undos.current.has(toast.key) && (
              <ButtonGroup className="sb-toast-actions">
                <Button variant="minimal" size="small" onPress={() => {
                  const undo = undos.current.get(toast.key);
                  snackbarQueue.close(toast.key);
                  undo?.();
                }}>Undo</Button>
              </ButtonGroup>
            )}
          </Toast>
        )}
      </SnackbarRegion>
      {confirm && words && (
        <ModalOverlay isOpen isDismissable onOpenChange={o => { if (!o) cancel(); }} className={LP_THEME}>
          <Modal size="small" className="chat-archived-confirm">
            <Dialog role="alertdialog" className="chat-archived-confirm-dialog">
              <Heading slot="title" level={2} size="medium">{words.heading}</Heading>
              <Text elementType="p" slot="subtitle">{words.body}</Text>
              <ButtonGroup className="chat-archived-confirm-buttons">
                <Button variant="minimal" onPress={cancel}>Cancel</Button>
                <Button variant="primary" autoFocus onPress={() => {
                  const c = confirm;
                  setConfirm(null);
                  void run(c.target, c.box);
                }}>{words.confirm}</Button>
              </ButtonGroup>
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </>
  );
  return { archive, busy, notify: content => say(content), ui };
}
