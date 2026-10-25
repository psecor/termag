// The sidebar's Archived list (Henry's option C): an archived chat's box is
// stopped or hibernated, so it costs only storage. Reopen starts the box again
// with the history on its disk. Delete permanently terminates the box, and
// the history on it, only when this chat is the last project there; a shared
// box stays. The confirm says which of those will happen.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useMatch, useNavigate } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { chatsApi, type ArchivedChat } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';
import { announceChatsChanged, applyRunningBoxes, archiveSettling, archivedBoxLabel, canReopen, CHATS_CHANGED_EVENT, chatsAfterPermanentDelete, clearRunningBox, deleteLeavesOpenChat, offerRunningBox, permanentDeleteDetail, reopenCatchUp, reopenOpensChat, runningBoxSnapshot, settleRunningBoxes, subscribeRunningBoxes } from '../../chat/archive';
import { chatHref, repoSlug } from '../../chat/simpleChat';

const SETTLE_POLL_MS = 5000;

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function ArchivedChats() {
  const navigate = useNavigate();
  // The sidebar sits beside the conversation route, so this match is the
  // chat on screen. useParams would not see :projectId from here.
  const openId = useMatch('/chat/p/:projectId')?.params.projectId ?? null;
  const { reloadProjects } = useProjects();
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<ArchivedChat[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // The open confirm reads the current row, not the one from the click. A
  // sibling delete recounts otherProjects before the next paint.
  const confirmDelete = chats?.find(c => c.id === confirmDeleteId) ?? null;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const recoveries = useSyncExternalStore(subscribeRunningBoxes, runningBoxSnapshot);
  const pendingFlight = useRef(false);

  // A GET that started before a delete must not put the deleted chat, or its
  // old otherProjects, back over the recount below.
  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    chatsApi.archived().then(rows => {
      if (gen !== loadGen.current) return;
      setChats(rows);
    }).catch(() => {});
  }, []);
  // A recovery remembered in this tab is stale once the row says the box is parked or gone.
  useEffect(() => {
    if (!chats) return;
    applyRunningBoxes(settleRunningBoxes(runningBoxSnapshot(), chats.map(c => ({ id: c.id, status: c.box?.status }))));
  }, [chats]);
  useEffect(() => {
    load();
    window.addEventListener(CHATS_CHANGED_EVENT, load);
    return () => window.removeEventListener(CHATS_CHANGED_EVENT, load);
  }, [load]);
  // A box still on its way down (or up) is looked at again until it settles.
  const settling = archiveSettling((chats ?? []).map(c => c.box?.status));
  useEffect(() => {
    if (!settling) return;
    const t = setInterval(load, SETTLE_POLL_MS);
    return () => clearInterval(t);
  }, [settling, load]);

  const openReopened = useCallback(async (chatId: string, res: { box: ArchivedChat['box'] }) => {
    setPendingId(null);
    setNotice('');
    // The project has to be back in the live list before the recovery goes,
    // or the open chat URL falls through to the missing conversation.
    await reloadProjects();
    clearRunningBox(chatId);
    const catchUp = reopenCatchUp(res.box);
    navigate(chatHref(chatId, 'main'), catchUp ? { state: catchUp } : undefined);
    await boxFeed.reload();
    // The start is accepted before this returns, but the list can still
    // say stopped or hibernated. Publish starting so the chat narrates
    // the box coming up on the first paint.
    const box = res.box;
    if (catchUp && box) {
      const current = boxFeed.getSnapshot().find(b => b.id === box.id);
      if (current && current.status !== 'starting') boxFeed.upsert({ ...current, status: 'starting' });
    }
    announceChatsChanged();
  }, [navigate, reloadProjects]);

  const reopen = async (chat: ArchivedChat) => {
    setBusy(chat.id); setError('');
    try {
      const res = await chatsApi.reopen(chat.id);
      // Still archived: the agent was not up, so the parked turn is not
      // dropped yet. Opening now would load history and resume that queue.
      if (!reopenOpensChat(res)) {
        setPendingId(chat.id);
        setNotice('The box is starting. This session stays archived until its agent connects and the parked turn is dropped.');
        load();
        return;
      }
      await openReopened(chat.id, res);
    } catch (err) {
      setPendingId(null);
      setError(apiError(err, 'Could not reopen the session'));
    } finally {
      setBusy(null);
    }
  };

  // Retry while the row is held archived. Once the agent is connected the
  // same call clears the parked turn and only then returns the chat as live.
  useEffect(() => {
    if (!pendingId) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (pendingFlight.current) return;
      pendingFlight.current = true;
      void chatsApi.reopen(pendingId).then(async res => {
        if (cancelled || !reopenOpensChat(res)) return;
        await openReopened(pendingId, res);
      }).catch(err => {
        if (cancelled) return;
        setPendingId(null);
        setNotice('');
        setError(apiError(err, 'Could not reopen the session'));
      }).finally(() => { pendingFlight.current = false; });
    }, SETTLE_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [openReopened, pendingId]);

  const remove = async (chat: ArchivedChat) => {
    setConfirmDeleteId(null);
    setBusy(chat.id); setError('');
    try {
      await chatsApi.remove(chat.id);
      // Recount siblings before GET /archived returns. The next confirm has
      // to say this delete terminates the box when the sibling was the last
      // other project on it.
      setChats(prev => (prev ? chatsAfterPermanentDelete(prev, { id: chat.id, boxId: chat.box?.id ?? null }) : prev));
      void boxFeed.reload();
      announceChatsChanged();
      // Leave only when this chat is the one on screen, and leave before
      // dropping its recovery. Clearing first, while this page is still the
      // open chat, is the missing-conversation error. Another open
      // conversation stays put.
      if (deleteLeavesOpenChat(openId, chat.id)) navigate('/chat');
      clearRunningBox(chat.id);
    } catch (err) {
      setError(apiError(err, 'Could not delete the session'));
    } finally {
      setBusy(null);
    }
  };

  if (!chats || chats.length === 0) return null;
  return (
    <div className="chat-archived">
      <button type="button" className="chat-archived-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Archived <span className="chat-archived-count">{chats.length}</span>
      </button>
      {open && (
        <ul className="chat-archived-list">
          {chats.map(c => (
            <li key={c.id} className="chat-archived-row">
              <div className="chat-archived-main">
                <span className="chat-row-name">{c.name}</span>
                <span className="chat-archived-meta">{repoSlug(c.repoUrl) ? `${repoSlug(c.repoUrl)} · ` : ''}{archivedBoxLabel(c.box?.status)}</span>
              </div>
              <div className="chat-archived-actions">
                {offerRunningBox(Boolean(recoveries[c.id]), c.box?.status) && (
                  <button type="button" className="btn-tiny" disabled={busy !== null}
                    title="The box is still running. Stop or hibernate it."
                    onClick={() => navigate(chatHref(c.id, 'main'))}>Box still running</button>
                )}
                <button type="button" className="btn-tiny chat-archived-reopen" disabled={busy !== null || pendingId !== null || !canReopen(c.box?.status)}
                  title={canReopen(c.box?.status) ? 'Start the box again and open the session' : 'Wait for the box to settle'}
                  onClick={() => { void reopen(c); }}>{busy === c.id || pendingId === c.id ? '…' : 'Reopen'}</button>
                <button type="button" className="btn-tiny chat-archived-delete" disabled={busy !== null}
                  title="Delete this session and its history for good. Asks first."
                  onClick={() => setConfirmDeleteId(c.id)}>Delete forever…</button>
              </div>
            </li>
          ))}
          {notice && <li className="chat-archived-error" role="status">{notice}</li>}
          {error && <li className="chat-archived-error" role="alert">{error}</li>}
        </ul>
      )}
      {confirmDelete && createPortal(
        <ConfirmDialog
          message={<>Delete <strong>{confirmDelete.name}</strong> permanently? {permanentDeleteDetail(confirmDelete.box, confirmDelete.otherProjects)}</>}
          confirmLabel="Delete permanently"
          onConfirm={() => { void remove(confirmDelete); }}
          onCancel={() => setConfirmDeleteId(null)}
        />,
        document.body,
      )}
    </div>
  );
}
