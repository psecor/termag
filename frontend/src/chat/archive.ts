// The simple UI's archived chats (backend routes/chats.ts): archiving stops or
// hibernates the box when this chat is the only thing on it, so it costs only
// storage; reopening starts it again with the history on its disk; deleting
// terminates it. A box that stays up is reported back on the archive response.
import type { InstanceStatus } from '../types';

/** The few words beside an archived chat saying where its box is. */
export function archivedBoxLabel(status: InstanceStatus | null | undefined): string {
  switch (status) {
    case 'stopped': return 'box stopped';
    case 'hibernated': return 'box hibernated';
    case 'stopping': return 'box stopping…';
    case 'hibernating': return 'box hibernating…';
    case 'starting': return 'box starting…';
    case 'ready': return 'box running';
    case 'terminated': case 'failed': return 'box gone';
    case null: case undefined: return 'no box';
    default: return `box ${status.replace(/-/g, ' ')}`;
  }
}

/** Reopen waits while the box is still going down, and is gone with the box. */
export function canReopen(status: InstanceStatus | null | undefined): boolean {
  return status != null && !['stopping', 'hibernating', 'terminated', 'failed'].includes(status);
}

/** Whether the archived list should look again soon: a box is still on its way down or up. */
export function archiveSettling(statuses: Array<InstanceStatus | null | undefined>): boolean {
  return statuses.some(s => s === 'stopping' || s === 'hibernating' || s === 'starting');
}

/**
 * A box coming back from a stop or hibernate (a reopened chat): its checkout
 * is already on disk, so the setup narration has no clone step then.
 */
export function isPowerRestart(status: InstanceStatus | null | undefined): boolean {
  return status === 'starting' || status === 'stopped' || status === 'hibernated' || status === 'stopping' || status === 'hibernating';
}

/**
 * Navigation state for a reopen whose box was parked. The API has accepted
 * the start, but the box list the chat reads can still say stopped or
 * hibernated until its refresh lands.
 */
export interface ReopenNavigationState {
  reopenStarting: true;
  reopenBoxName: string;
}

/**
 * Open the chat only after reopen cleared the parked turn. A pending answer
 * leaves the row archived, so the chat view is not mounted and its history
 * load cannot resume that queue.
 */
export function reopenOpensChat(body: { reopened?: boolean } | null | undefined): boolean {
  return body?.reopened === true;
}

/**
 * A successful reopen of a stopped or hibernated box. The response box is
 * `starting` once the start is stored, and still the old status when the
 * row has not flipped yet. A box that was already ready is not this case.
 */
export function reopenCatchUp(box: { status?: string | null; name?: string | null } | null | undefined): ReopenNavigationState | null {
  const status = box?.status;
  if (status !== 'starting' && status !== 'stopped' && status !== 'hibernated') return null;
  return { reopenStarting: true, reopenBoxName: box?.name || 'box' };
}

/**
 * Offline history is the setup narration while the feed already says the box
 * is starting, or while a reopen is waiting for that feed to catch up from
 * stopped, hibernated, or not loaded yet. A ready box, including one whose
 * reopen found it already up, is an offline error.
 */
export function historyComingUp(feedStatus: string | null | undefined, reopenStarting: boolean): boolean {
  if (feedStatus === 'starting') return true;
  if (!reopenStarting) return false;
  return feedStatus == null || feedStatus === 'stopped' || feedStatus === 'hibernated';
}

/**
 * A history load's error code is the setup narration only while the project
 * is actually still setting up, or while the box is coming up (`historyComingUp`).
 * An established chat whose agent drops is offline.
 */
export function historyFailureIsSetup(code: string | null, comingUp: boolean): boolean {
  if (code === 'setup') return true;
  return code === 'offline' && comingUp;
}

/**
 * Where to send someone whose chat is archived but whose box is still running.
 * `/?project=<id>` cannot show that chat: live project fetches omit archived
 * rows and session access 404s them, so the workspace has no project and no
 * path to the box menu. The workspace home lists boxes.
 */
export function stillRunningWorkspaceHref(): string {
  return '/';
}

/**
 * Drop the workspace's last-active project when it is this archived chat.
 * A fresh workspace restores that id onto `/?project=`, which is the same
 * dead end as linking the archived project directly.
 */
export function dropLastActiveProject(
  projectId: string,
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
  key = 'termag:lastActiveProject',
): void {
  if (!storage) return;
  try {
    if (storage.getItem(key) === projectId) storage.removeItem(key);
  } catch { /* private mode */ }
}

/**
 * A chat whose row is archived while its box is still running. The live
 * project list omits it, and session access 404s it, so this is what a later
 * open of the chat shows instead of a history load: the same Stop/Hibernate
 * recovery, keyed by the project.
 */
export interface RunningBoxRecovery {
  projectId: string;
  projectName: string;
  instanceId: string | null;
  message: string;
  retry: 'stop' | 'hibernate' | null;
  /** The archive dialog, until the user dismisses it. Later opens keep the banner. */
  announced: boolean;
}

export function rememberRunningBox(
  store: Readonly<Record<string, RunningBoxRecovery>>,
  recovery: RunningBoxRecovery,
): Record<string, RunningBoxRecovery> {
  return { ...store, [recovery.projectId]: recovery };
}

export function forgetRunningBox(
  store: Readonly<Record<string, RunningBoxRecovery>>,
  projectId: string,
): Record<string, RunningBoxRecovery> {
  if (!(projectId in store)) return store;
  const next = { ...store };
  delete next[projectId];
  return next;
}

export function runningBoxRecovery(
  store: Readonly<Record<string, RunningBoxRecovery>>,
  projectId: string,
): RunningBoxRecovery | null {
  return store[projectId] ?? null;
}

/** The still-running box, from an archive that refused to pretend the box stopped. */
export function runningBoxFromNotice(
  project: { id: string; name: string; instanceId?: string | null },
  notice: Extract<ArchiveBoxNotice, { leave: false }>,
): RunningBoxRecovery {
  return {
    projectId: project.id,
    projectName: project.name,
    instanceId: project.instanceId ?? null,
    message: notice.message,
    retry: notice.retry,
    announced: true,
  };
}

/**
 * Opening the chat URL after the row is archived. While the live list still
 * has the project, that view reads this same recovery. Once the list drops
 * it, the open is the recovery panel: session access 404s an archived row,
 * so the pane chat must not load. No recovery and not in the list is the
 * missing conversation, which is why a reopen or delete must not drop the
 * recovery before the list or the route has moved on.
 */
export function archivedChatOpen(
  inLiveList: boolean,
  recovery: RunningBoxRecovery | null,
): 'live' | 'recovery' | 'missing' {
  if (inLiveList) return 'live';
  if (recovery) return 'recovery';
  return 'missing';
}

/** Parked, gone, or absent. Stop and Hibernate answer 409 from these. */
const RUNNING_BOX_DONE = new Set(['stopping', 'stopped', 'hibernating', 'hibernated', 'terminated', 'failed']);

/** The box can still take Stop or Hibernate. A parked or gone box cannot. */
export function runningBoxStillUp(status: string | null | undefined): boolean {
  return status != null && status !== '' && !RUNNING_BOX_DONE.has(status);
}

/**
 * The sidebar's "Box still running" action. A stored recovery is not enough:
 * the archived row's box may already be parked or gone.
 */
export function offerRunningBox(hasRecovery: boolean, status: string | null | undefined): boolean {
  return hasRecovery && runningBoxStillUp(status);
}

/**
 * Drop recoveries whose archived row now says the box is parked, gone, or
 * absent. A chat the list does not mention is left alone.
 */
export function settleRunningBoxes(
  store: Readonly<Record<string, RunningBoxRecovery>>,
  boxes: ReadonlyArray<{ id: string; status: string | null | undefined }>,
): Record<string, RunningBoxRecovery> {
  let next: Record<string, RunningBoxRecovery> = store;
  for (const box of boxes) {
    if (!(box.id in next) || runningBoxStillUp(box.status)) continue;
    if (next === store) next = { ...store };
    delete next[box.id];
  }
  return next;
}

/**
 * The recovery panel, once the box list has loaded. An unloaded list keeps
 * the panel. A loaded list that shows the box parked, gone, or missing does
 * not: Stop would 409.
 */
export function recoveryForOpen(
  recovery: RunningBoxRecovery | null,
  boxStatus: string | null | undefined,
  feedLoaded: boolean,
): RunningBoxRecovery | null {
  if (!recovery) return null;
  // No instance to look up, or the box list has not loaded: keep the panel.
  if (!feedLoaded || recovery.instanceId == null) return recovery;
  if (!runningBoxStillUp(boxStatus)) return null;
  return recovery;
}

/** A power call that failed because the box is already parked or gone. */
export function parkedPowerError(error: string): boolean {
  return /that is (stopping|stopped|hibernating|hibernated|terminated|failed)\b/.test(error);
}

/**
 * Dropping the recovery while this chat's URL is open and the project is
 * not in the live list is the missing-conversation page. Reopen waits until
 * the list has the project. Delete waits until the URL has left the chat.
 */
export function droppingRecoveryShowsMissing(inLiveList: boolean, leftChatUrl: boolean): boolean {
  return !inLiveList && !leftChatUrl;
}

/** Close the archive dialog without forgetting the still-running box. */
export function dismissRunningBox(
  store: Readonly<Record<string, RunningBoxRecovery>>,
  projectId: string,
): Record<string, RunningBoxRecovery> {
  const current = store[projectId];
  if (!current?.announced) return store;
  return { ...store, [projectId]: { ...current, announced: false } };
}

const RUNNING_BOX_KEY = 'termag:running-box-recoveries';
let runningBoxes: Record<string, RunningBoxRecovery> = {};
const runningBoxListeners = new Set<() => void>();

function readRunningBoxes(): Record<string, RunningBoxRecovery> {
  if (typeof sessionStorage === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(RUNNING_BOX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, RunningBoxRecovery>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

runningBoxes = readRunningBoxes();

function publishRunningBoxes(next: Record<string, RunningBoxRecovery>): void {
  runningBoxes = next;
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.setItem(RUNNING_BOX_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }
  for (const fn of runningBoxListeners) fn();
}

/** Remember a still-running box so a later open of the archived chat can stop it. */
export function saveRunningBox(recovery: RunningBoxRecovery): void {
  publishRunningBoxes(rememberRunningBox(runningBoxes, recovery));
}

/** The box was stopped, or the chat was reopened or deleted. */
export function clearRunningBox(projectId: string): void {
  publishRunningBoxes(forgetRunningBox(runningBoxes, projectId));
}

/** Replace the store when a settle actually dropped something. */
export function applyRunningBoxes(next: Record<string, RunningBoxRecovery>): void {
  if (next === runningBoxes) return;
  publishRunningBoxes(next);
}

/** The user closed the dialog. The banner, and a later open, still offer Stop/Hibernate. */
export function dismissRunningBoxNotice(projectId: string): void {
  publishRunningBoxes(dismissRunningBox(runningBoxes, projectId));
}

export function readRunningBox(projectId: string): RunningBoxRecovery | null {
  return runningBoxRecovery(runningBoxes, projectId);
}

export function runningBoxSnapshot(): Record<string, RunningBoxRecovery> {
  return runningBoxes;
}

export function subscribeRunningBoxes(fn: () => void): () => void {
  runningBoxListeners.add(fn);
  return () => { runningBoxListeners.delete(fn); };
}

/** What POST /api/chats/:id/archive put in `box` after the row was archived. */
export interface ArchiveBoxBody {
  action: string | null;
  status?: string | null;
  reason?: string;
  error?: string;
}

export type ArchiveBoxNotice =
  | { leave: true }
  | { leave: false; message: string; retry: 'stop' | 'hibernate' | null };

const ALREADY_PARKED = /^the box is already (stopping|stopped|hibernating|hibernated)$/;
const ALREADY_GONE = /^the box is (terminated|failed)$/;

/**
 * Whether leaving the chat after a successful archive is honest. The row is
 * archived either way. Leaving is honest when the box is going down, already
 * parked, gone, or absent. A power failure or a skip that leaves the box up
 * stays on the chat and says so, with a stop to retry when the archive had
 * already asked for one.
 */
export function archiveBoxNotice(box: ArchiveBoxBody): ArchiveBoxNotice {
  if (box.error) {
    const retry = box.action === 'hibernate' ? 'hibernate' : box.action === 'stop' ? 'stop' : null;
    return { leave: false, retry, message: `This session is archived. Its box is still running: ${box.error}` };
  }
  if (box.action === 'stop' || box.action === 'hibernate') return { leave: true };
  const reason = box.reason ?? '';
  if (reason === '' || reason === 'the chat has no box' || ALREADY_PARKED.test(reason) || ALREADY_GONE.test(reason)) {
    return { leave: true };
  }
  return { leave: false, retry: null, message: stillRunningReason(reason) };
}

function stillRunningReason(reason: string): string {
  if (reason === 'other projects still use this box') {
    return 'This session is archived. Its box is still running because other projects use it. Open the full UI to stop it once those projects can leave; until then it keeps billing.';
  }
  if (reason === 'a self-managed host is not powered from termag') {
    return 'This session is archived. Its host is self-managed and still running. Stop it on that machine.';
  }
  return `This session is archived. Its box is still running (${reason}). Stop it from the full UI so it stops billing.`;
}

/**
 * The sentence after the chat's name in the permanent-delete confirm.
 * The box is terminated, and the history on its disk goes, only when this
 * chat is the last project on a box that still exists — the same rule as
 * the backend's `deleteTerminatesBox`. Any other project on that box, an
 * archived one included, means the chat is deleted and the shared box stays.
 * A chat with no box, or a box already terminated, does not claim either.
 */
export function permanentDeleteDetail(
  box: { status?: string | null } | null | undefined,
  otherProjects: number,
): string {
  if (box && box.status !== 'terminated' && otherProjects === 0) {
    return "Its box is terminated, and the conversation history on it goes too. This can't be undone.";
  }
  if (box && box.status !== 'terminated' && otherProjects > 0) {
    return "This session is deleted. The shared box stays, and the conversation history on it stays with it. This can't be undone.";
  }
  return "This session is deleted. This can't be undone.";
}

/**
 * Permanent delete leaves the page only when the deleted chat is the one
 * on screen. Another open conversation stays where it is.
 */
export function deleteLeavesOpenChat(openProjectId: string | null | undefined, deletedId: string): boolean {
  return openProjectId != null && openProjectId !== '' && openProjectId === deletedId;
}

/**
 * The archived list after a permanent delete, before GET /archived returns.
 * The deleted chat leaves, and every remaining chat on that same box loses
 * one project. A confirm opened on a sibling then says the box is terminated
 * when this delete is the one that will terminate it.
 */
export function chatsAfterPermanentDelete<T extends { id: string; box: { id: string } | null; otherProjects: number }>(
  chats: readonly T[],
  deleted: { id: string; boxId: string | null },
): T[] {
  return chats.flatMap(c => {
    if (c.id === deleted.id) return [];
    if (!deleted.boxId || c.box?.id !== deleted.boxId) return [c];
    return [{ ...c, otherProjects: Math.max(0, c.otherProjects - 1) }];
  });
}

/** Same-tab signal that a chat was archived, reopened or deleted: the sidebar's archive list reloads. */
export const CHATS_CHANGED_EVENT = 'termag-chats-changed';
export function announceChatsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHATS_CHANGED_EVENT));
}
