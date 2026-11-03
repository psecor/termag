/**
 * An automation's folder in a space (decision 13): an
 * automation with a `spaceName` lives in `<spaceName>:<folder>/`
 * (spaceFolder.ts: `.termag/automations/<automation id>`, fixed). The
 * orchestrator keeps named files of it in step with
 * the box, and never the folder as a whole:
 *
 *   memory/MEMORY.md   the runs' notes: pulled before a run, pushed after
 *   state.json         the task's own state, if it keeps any: the same
 *   runs/<run>.md      the run log termag writes (runLog.ts): pushed after
 *                      a run, and the previous one pulled before the next
 *   README.md          what the automation is (readme.ts): pushed when it
 *                      no longer matches the automation
 *
 * With `automation-space-folder-enabled` off only the notes file moves, as
 * the one-file mirror always did. Each transfer is a one-shot tmux session
 * whose only process is the `termag space get|put` CLI the box already has
 * (termag-reconcile installs ~/.local/bin/termag), on the box's own token.
 * Bytes never pass through the orchestrator, as for every other space
 * transfer; the orchestrator only grants the box and waits. A run's agent
 * may use the same grant for its own `termag space` calls (outputs/<run>/).
 *
 * Best effort throughout: a space that is off, gone, or not writable by the
 * owner, a box without the one-shot tmux command, or a transfer that fails
 * leaves the run with whatever files the box has, and the run row says why
 * (`spaceSyncError`). One live run per automation makes last-writer-wins
 * safe, and transfers for one remote file run one at a time in this process
 * (syncFile): a run's pull waits for the previous run's push, which the
 * row's finishing does not wait for.
 */
import { prisma } from '../../db';
import { BoolFlagKey } from '../../flags';
import { isProjectAgentConnected, projectAgentCapabilities, sendForProject } from '../agentRegistry';
import { webBase } from '../briefing/slack';
import { RUNNER_AGENT_CAPABILITY, tmuxSafe } from '../claudeRunnerSpawn';
import { boolVariation } from '../featureFlags';
import { roleAtLeast, type SpaceRole } from '../spaces/spaceAccess';
import { spaceStore, spacesEnabledFor } from '../spaces/spacesRuntime';
import { renderReadme } from './readme';
import { folderOf } from './spaceFolder';

export type SpaceSyncRefusal = 'spaces_off' | 'space_not_found' | 'space_forbidden' | 'space_read_only' | 'shared_outside_space';

/** The folder layout, the run log and the README; off, only the notes file is mirrored. */
export const SPACE_FOLDER_FLAG = 'automation-space-folder-enabled' satisfies BoolFlagKey;

/** Whether the owner's automations use their whole folder (SPACE_FOLDER_FLAG). */
export async function spaceFoldersEnabledFor(userId: string): Promise<boolean> {
  const user = await spaceStore.ldUser(userId);
  return user ? boolVariation(SPACE_FOLDER_FLAG, user, false) : false;
}

/** Where in the space the notes live, under the automation's folder (automations/<projectId> for rows from before folders). */
export function remoteMemoryPath(folder: string): string {
  return `${folder}/memory/MEMORY.md`;
}

/**
 * The largest notes or state file mirrored either way. Anyone who can write
 * the space can put any object at these paths; the box must never load more
 * than this of one, and nothing is read into the orchestrator at all.
 */
export const MEMORY_MAX_BYTES = 1024 * 1024;
/** The largest run log or README moved either way. */
export const LOG_MAX_BYTES = 64 * 1024;

export type SyncFileKey = 'memory' | 'state' | 'previous-run' | 'run-log' | 'readme';

/** One file kept in step between the box and the automation's folder. */
export interface SyncFile {
  key: SyncFileKey;
  /** Absolute path on the box. */
  local: string;
  /** Path in the space. */
  remote: string;
  maxBytes: number;
  /**
   * A file the run reads and rewrites (notes, state): its push goes only
   * after this run proved it pulled the space's copy, or the space never
   * held one, so a failed pull never replaces the space's copy with an
   * older one.
   */
  guarded: boolean;
  /** A get removes the local file first, so a failed pull leaves nothing rather than an earlier copy. */
  fresh: boolean;
}

/** `~/.termag/automations/<projectId>`, the parent of the notes dir: where termag's own files for the folder go. */
function automationDirOf(memoryDir: string): string {
  return memoryDir.replace(/\/+$/, '').replace(/\/memory$/, '');
}

export function memoryFile(folder: string, memoryDir: string): SyncFile {
  return { key: 'memory', local: `${memoryDir}/MEMORY.md`, remote: remoteMemoryPath(folder), maxBytes: MEMORY_MAX_BYTES, guarded: true, fresh: false };
}

export function stateFile(folder: string, memoryDir: string): SyncFile {
  return { key: 'state', local: `${memoryDir}/state.json`, remote: `${folder}/state.json`, maxBytes: MEMORY_MAX_BYTES, guarded: true, fresh: false };
}

/** The previous run's log, read by the next run beside its notes. */
export function previousRunFile(folder: string, memoryDir: string, logName: string): SyncFile {
  return { key: 'previous-run', local: `${memoryDir}/previous-run.md`, remote: `${folder}/runs/${logName}.md`, maxBytes: LOG_MAX_BYTES, guarded: false, fresh: true };
}

export function runLogFile(folder: string, memoryDir: string, logName: string): SyncFile {
  return { key: 'run-log', local: `${automationDirOf(memoryDir)}/runs/${logName}.md`, remote: `${folder}/runs/${logName}.md`, maxBytes: LOG_MAX_BYTES, guarded: false, fresh: false };
}

export function readmeFile(folder: string, memoryDir: string): SyncFile {
  return { key: 'readme', local: `${automationDirOf(memoryDir)}/README.md`, remote: `${folder}/README.md`, maxBytes: LOG_MAX_BYTES, guarded: false, fresh: false };
}

/**
 * A get downloads beside the file, and the box itself checks the size and
 * installs it with a rename, then writes this marker. The marker (two
 * bytes) is what proves the pull worked; the file's bytes never cross the
 * agent socket.
 */
export function pulledMarkerPath(local: string): string {
  return `${local}.pulled`;
}

export function pullPath(local: string): string {
  return `${local}.pull`;
}

const getScript = (fresh: boolean) => [
  fresh ? 'rm -f -- "$0" "$3" "$4"' : 'rm -f -- "$0" "$3"',
  '&& "$1" space get "$2" "$0"',
  '&& [ -f "$0" ]',
  '&& [ "$(wc -c < "$0")" -le "$5" ]',
  '&& mv -f -- "$0" "$4"',
  '&& printf ok > "$3";',
  's=$?; rm -f -- "$0"; exit $s',
].join(' ');
const PUT_SCRIPT = '[ "$(wc -c < "$0")" -le "$3" ] && exec "$1" space put "$0" "$2"';

/**
 * The CLI invocation for one file in one direction, as an argument list for
 * `tmux-create`'s command (the session's one process is a shell). A get
 * clears the marker and any earlier download first (and, for a fresh file,
 * the local copy), so a stale one never passes a failed get off as a
 * success, then downloads, refuses anything over the file's cap, renames it
 * over the local file and writes the marker. A put uploads the local file
 * only when it exists and is within the cap.
 */
export function syncCommand(home: string, direction: 'get' | 'put', spaceName: string, file: SyncFile): string[] {
  const bin = `${home.replace(/\/+$/, '')}/.local/bin/termag`;
  const remote = `${spaceName}:${file.remote}`;
  return direction === 'get'
    ? ['/bin/sh', '-c', getScript(file.fresh), pullPath(file.local), bin, remote, pulledMarkerPath(file.local), file.local, String(file.maxBytes)]
    : ['/bin/sh', '-c', PUT_SCRIPT, file.local, bin, remote, String(file.maxBytes)];
}

/** `<user>-automation-sync-<run>-<file>-<dir>-r`: ends in `-r` so status parsing never reads it as a project pane. */
export function syncSessionName(hostUnixUser: string, runId: string, direction: 'get' | 'put', key: SyncFileKey = 'memory'): string {
  return `${tmuxSafe(hostUnixUser)}-automation-sync-${tmuxSafe(runId)}-${key}-${direction}-r`;
}

/**
 * Whether the owner may mirror to this space, from what the store said:
 * the flag, the space, the owner's role (editor or owner writes), and
 * whether the space is read-only.
 */
export function spaceSyncDecision(i: { flagOn: boolean; space: { deletedAt: Date | null; readOnlyAt: Date | null } | null; role: SpaceRole | undefined; shareesWithoutWrite?: number }): SpaceSyncRefusal | null {
  if (!i.flagOn) return 'spaces_off';
  // A space the caller is no member of answers as a missing one, as the
  // spaces routes do: names are global, and a guessed name must not confirm
  // another user's private space exists.
  if (!i.space || i.space.deletedAt || !i.role) return 'space_not_found';
  if (!roleAtLeast(i.role, 'editor')) return 'space_forbidden';
  if (i.space.readOnlyAt) return 'space_read_only';
  // A project share attaches the sharee to the owner's own shell, so the
  // on-box notes file is theirs to read and rewrite whatever its mode: every
  // sharee must be able to write the space too, or the pull would hand them
  // the space's notes and the push would store their bytes under the
  // owner's grant.
  if (i.shareesWithoutWrite && i.shareesWithoutWrite > 0) return 'shared_outside_space';
  return null;
}

/** How many of a project's sharees cannot write the space (not a member, or only a viewer). */
export function shareesWithoutWrite(shareUserIds: readonly string[], roles: ReadonlyMap<string, SpaceRole>): number {
  return shareUserIds.filter(id => { const r = roles.get(id); return !r || !roleAtLeast(r, 'editor'); }).length;
}

export const SYNC_REFUSAL_TEXT: Record<SpaceSyncRefusal, string> = {
  spaces_off: 'Spaces are not enabled for you',
  space_not_found: 'No such space that you are a member of',
  space_forbidden: 'You can only mirror notes to a space you can write to (editor or owner)',
  space_read_only: 'That space is read-only',
  shared_outside_space: 'This automation is shared with someone who cannot write that space; mirroring would let them read and change its notes. Add them to the space as an editor, or stop sharing the project',
};

function isRefusal(reason: string | null): reason is SpaceSyncRefusal {
  return reason !== null && reason in SYNC_REFUSAL_TEXT;
}

/** Check a space for an owner, as the routes do before saving a spaceName. */
export async function checkSpaceForOwner(userId: string, spaceName: string, projectId?: string): Promise<{ ok: true; spaceId: string } | { ok: false; reason: SpaceSyncRefusal }> {
  const flagOn = await spacesEnabledFor(userId);
  const space = flagOn ? await spaceStore.findSpace(spaceName) : null;
  const roles = space ? await spaceStore.memberRoles(space.id) : new Map<string, SpaceRole>();
  const role = roles.get(userId);
  // The project's sharees, checked at every transfer (get and put) and when the space is chosen.
  const sharees = projectId
    ? (await prisma.projectShare.findMany({ where: { projectId }, select: { userId: true } })).map(s => s.userId).filter(id => id !== userId)
    : [];
  const refusal = spaceSyncDecision({ flagOn, space, role, shareesWithoutWrite: shareesWithoutWrite(sharees, roles) });
  return refusal ? { ok: false, reason: refusal } : { ok: true, spaceId: space!.id };
}

/**
 * Undo what the mirror put in reach of the owner's shell (security review,
 * #489): the SpaceBox grant the automation added (a sharee in that shell
 * could use the box token as the owner's space role) and the files pulled
 * onto the box (blanked, with their pull markers, so nothing pulled stays
 * readable and the next permitted run pulls afresh). A grant the owner added
 * by hand is left alone. Best effort; never throws.
 */
export async function unwindMirror(projectId: string, why: string): Promise<void> {
  try {
    const a = await prisma.automation.findUnique({
      where: { projectId },
      select: { id: true, spaceName: true, spaceFolder: true, mirrorGrantBoxId: true, project: { select: { name: true, userId: true, instanceId: true, instance: { select: { hostHome: true } }, user: { select: { unixUsername: true } } } } },
    });
    if (!a) return;
    if (a.mirrorGrantBoxId && a.spaceName) {
      const space = await spaceStore.findSpace(a.spaceName);
      if (space) await spaceStore.removeGrant(space.id, a.mirrorGrantBoxId);
      await prisma.automation.update({ where: { id: a.id }, data: { mirrorGrantBoxId: null } });
    }
    const p = a.project;
    if (p.instanceId) {
      const host = { userId: p.userId, instanceId: p.instanceId };
      const dir = memoryDirFor(p.instance?.hostHome ?? `/home/${p.user.unixUsername}`, projectId);
      const folder = folderOf({ id: a.id, spaceFolder: a.spaceFolder ?? null });
      // Every file a pull lands. The notes always (the one-file mirror's
      // shape); the state and the previous run's log only where the box has
      // one, so an automation that never used them gets no empty files.
      const blank = (path: string) => sendForProject(host, 'write-file', { path, content: '', mode: 0o600 }, 5000).catch(() => {});
      const notes = memoryFile(folder, dir).local;
      for (const path of [notes, pulledMarkerPath(notes)]) await blank(path);
      for (const local of [stateFile(folder, dir).local, previousRunFile(folder, dir, '').local]) {
        const got = await sendForProject(host, 'read-file', { path: local }, 5000).catch(() => null) as { content?: unknown } | null;
        if (got && typeof got.content === 'string') for (const path of [local, pulledMarkerPath(local)]) await blank(path);
      }
    }
    console.warn(`[AUTOMATION] ${p.name}: notes mirror unwound (${why}): the box's added space grant removed, the pulled files blanked`);
  } catch (err) {
    console.warn(`[AUTOMATION] ${projectId}: could not unwind the notes mirror: ${(err as Error).message}`);
  }
}

/** The mirror's check for one project, unwinding it when a sharee cannot write the space: a share accepted, a sharee's space role lowered. */
export async function recheckMirror(projectId: string): Promise<void> {
  // Called from routes whose own work is already done (a share accepted, a
  // role changed): never let the mirror fail them.
  try {
    const a = await prisma.automation.findUnique({ where: { projectId }, select: { spaceName: true, userId: true } });
    if (!a?.spaceName) return;
    const check = await checkSpaceForOwner(a.userId, a.spaceName, projectId);
    if (!check.ok && check.reason === 'shared_outside_space') await unwindMirror(projectId, check.reason);
  } catch (err) {
    console.warn(`[AUTOMATION] ${projectId}: could not recheck the notes mirror: ${(err as Error).message}`);
  }
}

/** Every automation mirroring to this space that `userId` is a sharee of, rechecked (their space role changed). */
export async function recheckMirrorsForMember(spaceName: string, userId: string): Promise<void> {
  let rows: Array<{ projectId: string }> = [];
  try {
    rows = await prisma.automation.findMany({ where: { spaceName, project: { shares: { some: { userId } } } }, select: { projectId: true } });
  } catch (err) {
    console.warn(`[AUTOMATION] could not find mirrors to recheck for ${spaceName}: ${(err as Error).message}`);
  }
  for (const r of rows) await recheckMirror(r.projectId);
}

/** Where a project's notes live on its box (the same path services/automations/runner.ts memoryDir gives). */
function memoryDirFor(home: string, projectId: string): string {
  return `${home.replace(/\/+$/, '')}/.termag/automations/${projectId}/memory`;
}

export interface SyncTarget {
  runId: string;
  userId: string;
  projectId: string;
  /** For the log line only. */
  projectName: string;
  spaceName: string;
  /** The automation's folder in the space (spaceFolder.ts folderOf). */
  folder: string;
  host: { userId: string; instanceId: string };
  box: { id: string; hostHome: string | null; hostUnixUser: string | null };
  memoryDir: string;
}

export type SyncOutcome = 'done' | 'timeout' | 'skipped' | 'failed';
/** What one transfer did, and why when it did not: a refusal code, `box_outdated`, `box_unavailable`, `timeout`, `pull_failed`, `push_unproven` or `error`. */
export interface SyncResult { outcome: SyncOutcome; reason: string | null }

const POLL_MS = 1000;

// One transfer at a time per remote file: the row of a finished run is
// final before its push lands (completion does not hold the row for it),
// so the next run's pull, admitted the moment the row is final, must queue
// behind that push or it would read stale notes and later overwrite the
// push. Keyed on the space and remote path; in-process (the scheduler's
// starts and the relay's completions run in the one orchestrator process
// outside an overlap deploy).
const inFlight = new Map<string, Promise<unknown>>();

// Runs whose pull of a guarded file failed while the space held it, keyed
// `<runId>:<file>`: their push of that file is skipped, or the space's
// durable copy would be replaced by the seed plus one run (the loss this
// feature exists to prevent). In-process, like the queue, so a put also
// re-reads the durable proof: the marker the get left on the box (removed
// before every get, written by a get that worked) and whether the space
// holds the file at all. A process restarted between the pull and the push
// decides from those, not from this set.
const pullFailed = new Set<string>();

function isPulledMarker(r: { content?: unknown } | null): boolean {
  return !!r && typeof r.content === 'string' && r.content.trim() === 'ok';
}

/** Tests: a transfer is queued or running for this remote file. */
export function syncInFlight(spaceName: string, remotePath: string): boolean {
  return inFlight.has(`${spaceName}:${remotePath}`);
}

async function waitForSession(host: { userId: string; instanceId: string }, sessionName: string, timeoutMs: number): Promise<'done' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const r = await sendForProject(host, 'tmux-has-session', { sessionName }, 5000).catch(() => null) as { exists?: unknown } | null;
    if (r && r.exists !== true) return 'done';
  }
  return 'timeout';
}

/**
 * Run one transfer of one file on the box. The box must be the owner's and
 * not terminated, must hold a grant to the space (made here if the owner
 * may add boxes: an owner's or editor's box), and must announce the
 * one-shot tmux command. Resolves to what happened; never throws.
 */
export async function syncFile(t: SyncTarget, file: SyncFile, direction: 'get' | 'put', opts: { waitMs?: number; delayMs?: number; prepare?: () => Promise<boolean> } = {}): Promise<SyncResult> {
  const key = `${t.spaceName}:${file.remote}`;
  const previous = inFlight.get(key) ?? Promise.resolve();
  // delayMs: the transfer takes its place in the queue now and starts that
  // much later (the timeout sweep's and Stop's push, which waits for the
  // interrupt to stop the turn's writes): a pull asked for meanwhile, by the
  // next run the same tick starts, queues behind it instead of ahead.
  // prepare: termag's own file, written on the box once its turn comes
  // (after the delay), so a queued push can still render from the final row.
  const run = () => (opts.delayMs ? new Promise(r => setTimeout(r, opts.delayMs)) : Promise.resolve())
    .then(async (): Promise<SyncResult> => (opts.prepare && !(await opts.prepare()) ? { outcome: 'failed', reason: 'error' } : transfer(t, file, direction, opts)));
  const own = previous.then(run, run);
  inFlight.set(key, own);
  try {
    const result = await own;
    // Anything short of pulled bytes (or a confirmed-empty space) means this
    // run's push could replace a file it never saw: a transfer that threw,
    // a box briefly without the one-shot command, a timeout.
    if (direction === 'get' && file.guarded && result.outcome !== 'done') pullFailed.add(`${t.runId}:${file.key}`);
    return result;
  } finally {
    if (inFlight.get(key) === own) inFlight.delete(key);
  }
}

/** The notes file alone, as the one-file mirror moved it (the flag off, and the first file of every pull and push). */
export async function syncMemory(t: SyncTarget, direction: 'get' | 'put', opts: { waitMs?: number; delayMs?: number } = {}): Promise<SyncOutcome> {
  return (await syncFile(t, memoryFile(t.folder, t.memoryDir), direction, opts)).outcome;
}

async function transfer(t: SyncTarget, file: SyncFile, direction: 'get' | 'put', { waitMs = 45_000 }: { waitMs?: number }): Promise<SyncResult> {
  const tag = `[AUTOMATION] ${t.projectName} ${file.key} ${direction}`;
  try {
    const check = await checkSpaceForOwner(t.userId, t.spaceName, t.projectId);
    if (!check.ok) {
      console.log(`${tag}: skipped (${check.reason})`);
      if (check.reason === 'shared_outside_space') await unwindMirror(t.projectId, check.reason);
      return { outcome: 'skipped', reason: check.reason };
    }
    // The grant below lets the box act as the owner in the space: only a box of theirs that still exists.
    const instance = await prisma.instance.findUnique({ where: { id: t.box.id }, select: { userId: true, status: true } });
    if (!instance || instance.userId !== t.userId || instance.status === 'terminated') {
      console.log(`${tag}: skipped (the box is not the owner's, or is gone)`); return { outcome: 'skipped', reason: 'box_unavailable' };
    }
    if (!isProjectAgentConnected(t.host) || !projectAgentCapabilities(t.host).includes(RUNNER_AGENT_CAPABILITY)) {
      console.log(`${tag}: skipped (box cannot run a one-shot command)`); return { outcome: 'skipped', reason: 'box_outdated' };
    }
    const granted = await spaceStore.grantedBoxIds(check.spaceId);
    if (!granted.has(t.box.id)) {
      await spaceStore.addGrant(check.spaceId, t.box.id, t.userId);
      // Remembered, so an unwind removes only a grant the mirror made, never one the owner made by hand.
      await prisma.automation.updateMany({ where: { projectId: t.projectId }, data: { mirrorGrantBoxId: t.box.id } });
    }
    let home: string = t.box.hostHome ?? '';
    if (!home) {
      const u = await prisma.user.findUnique({ where: { id: t.userId }, select: { unixUsername: true } });
      home = `/home/${u?.unixUsername ?? 'termag'}`;
    }
    if (direction === 'put' && file.guarded) {
      if (pullFailed.has(`${t.runId}:${file.key}`)) {
        console.warn(`${tag}: skipped (this run's pull failed; the space's copy is kept)`);
        return { outcome: 'skipped', reason: 'pull_failed' };
      }
      // The durable form of the same check (a restart empties pullFailed):
      // no pull marker on the box while the space holds the file means this
      // process cannot know it was pulled, and the push would replace it.
      const proof = await sendForProject(t.host, 'read-file', { path: pulledMarkerPath(file.local) }, 5000).catch(() => null) as { content?: unknown } | null;
      if (!isPulledMarker(proof) && await spaceStore.lastPutAt(check.spaceId, file.remote)) {
        console.warn(`${tag}: skipped (no pull on the box while the space holds the file; it is kept)`);
        return { outcome: 'skipped', reason: 'push_unproven' };
      }
    }
    const user: string = t.box.hostUnixUser ?? home.split('/').pop() ?? 'termag';
    const sessionName = syncSessionName(user, t.runId, direction, file.key);
    // A pull lands beside the file first: the session's end says nothing
    // about its exit status, so the pulled bytes are the proof, and only they
    // replace the local file. Nothing pulled: fine when the space has never
    // held this file (the first run seeds it), a failure otherwise.
    const command = syncCommand(home, direction, t.spaceName, file);
    await sendForProject(t.host, 'tmux-create', { sessionName, cwd: t.memoryDir, gitInit: false, command }, 15_000);
    const outcome = await waitForSession(t.host, sessionName, waitMs);
    if (outcome === 'timeout') {
      await sendForProject(t.host, 'tmux-kill', { sessionName, exact: true }, 5000).catch(() => {});
      console.warn(`${tag}: gave up after ${Math.round(waitMs / 1000)} s`);
    }
    const timedOut: SyncResult = { outcome, reason: outcome === 'timeout' ? 'timeout' : null };
    if (direction !== 'get') return timedOut;
    // Only the marker is read: the box installed the file itself.
    const pulled = await sendForProject(t.host, 'read-file', { path: pulledMarkerPath(file.local) }, 5000).catch(() => null) as { content?: unknown } | null;
    if (isPulledMarker(pulled)) return { outcome: 'done', reason: null };
    if (!(await spaceStore.lastPutAt(check.spaceId, file.remote))) return timedOut; // the space has no copy yet: nothing to pull
    if (file.guarded) {
      pullFailed.add(`${t.runId}:${file.key}`);
      console.warn(`${tag}: the space holds a copy this run could not pull; its push will be skipped`);
    } else {
      console.warn(`${tag}: the space holds a copy this run could not pull`);
    }
    return { outcome: 'failed', reason: 'pull_failed' };
  } catch (err) {
    console.warn(`${tag}: failed: ${(err as Error).message}`);
    return { outcome: 'failed', reason: 'error' };
  }
}

/** A result as the run row keeps it: a refusal or box code as itself, a transfer's trouble as `<file> <direction> <reason>`; null when it worked. */
export function syncErrorOf(file: SyncFileKey, direction: 'get' | 'put', r: SyncResult): string | null {
  if (r.outcome === 'done' || !r.reason) return null;
  if (isRefusal(r.reason) || r.reason === 'box_outdated' || r.reason === 'box_unavailable') return r.reason;
  return `${file} ${direction} ${r.reason}`;
}

/** A row's spaceSyncError in words, for the brief and the run log. */
export function syncErrorText(error: string): string {
  if (isRefusal(error)) return SYNC_REFUSAL_TEXT[error];
  if (error === 'box_outdated') return 'this box cannot run the space transfer yet (it needs an update)';
  if (error === 'box_unavailable') return "the box is not the owner's or is gone";
  return error;
}

/** The first space trouble of a run, kept on its row (a later one does not replace it). Never throws. */
export async function noteSpaceSyncError(runId: string, error: string | null): Promise<void> {
  if (!error) return;
  await prisma.automationRun.updateMany({ where: { id: runId, spaceSyncError: null }, data: { spaceSyncError: error } }).catch(() => {});
}

/** A refusal or a box that cannot transfer holds for every file: no point asking again this run. */
function stopsTheRest(r: SyncResult): boolean {
  return r.outcome === 'skipped' && (isRefusal(r.reason) || r.reason === 'box_outdated' || r.reason === 'box_unavailable');
}

/**
 * Everything a run reads from the folder, before its brief: the notes,
 * then (folders on) the state and the previous run's log, and the README
 * when it no longer matches. `error` is the first trouble, for the row;
 * `usable` is false when the notes could not come down (refused, the box
 * cannot transfer, the pull failed), and the brief says the space is not
 * available this run. Never throws.
 */
export async function pullForRun(t: SyncTarget, opts: { folders: boolean; previousLog: string | null; readme: string | null }): Promise<{ error: string | null; usable: boolean }> {
  const mem = await syncFile(t, memoryFile(t.folder, t.memoryDir), 'get');
  let error = syncErrorOf('memory', 'get', mem);
  const usable = mem.outcome === 'done';
  if (!opts.folders || stopsTheRest(mem)) return { error, usable };
  const steps: SyncFile[] = [stateFile(t.folder, t.memoryDir)];
  if (opts.previousLog) steps.push(previousRunFile(t.folder, t.memoryDir, opts.previousLog));
  for (const file of steps) error ??= syncErrorOf(file.key, 'get', await syncFile(t, file, 'get'));
  if (opts.readme !== null) error ??= await publishReadme(t, opts.readme);
  return { error, usable };
}

/**
 * The notes (and, folders on, the state) a run leaves, pushed after it
 * ends. Both take their queue places at once, before delayMs, so the next
 * run's pulls wait for them; `queued` hears when they have. `gate`, awaited
 * when their turn comes: false skips both (the push was queued before the
 * row was final, and the finish turned out not to be this push's).
 */
export async function pushAfterRun(t: SyncTarget, opts: { folders: boolean; delayMs?: number; queued?: (done: Promise<unknown>) => void; gate?: Promise<boolean> }): Promise<string | null> {
  const files = [memoryFile(t.folder, t.memoryDir), ...(opts.folders ? [stateFile(t.folder, t.memoryDir)] : [])];
  const gate = opts.gate;
  const prepare = gate ? () => gate : undefined;
  const all = Promise.all(files.map(f => syncFile(t, f, 'put', { delayMs: opts.delayMs, prepare }).then(r => syncErrorOf(f.key, 'put', r))));
  opts.queued?.(all);
  const errors = await all;
  if (gate && !(await gate)) return null;
  return errors.find(e => e !== null) ?? null;
}

/**
 * Write termag's own file on the box, then upload it. `content` may be a
 * function, called when the push's turn in the queue comes (null: nothing
 * to write); `queued` hears once the push holds its place.
 */
async function writeAndPut(
  t: SyncTarget, file: SyncFile, content: string | (() => Promise<string | null>),
  opts: { delayMs?: number; queued?: (done: Promise<unknown>) => void } = {},
): Promise<string | null> {
  let wrote = true;
  const prepare = async (): Promise<boolean> => {
    try {
      const text = typeof content === 'string' ? content : await content();
      if (text === null) { wrote = false; return false; }
      await sendForProject(t.host, 'write-file', { path: file.local, content: text, mode: 0o600 }, 5000);
      return true;
    } catch (err) {
      console.warn(`[AUTOMATION] ${t.projectName} ${file.key}: could not write it on the box: ${(err as Error).message}`);
      return false;
    }
  };
  const done = syncFile(t, file, 'put', { delayMs: opts.delayMs, prepare });
  opts.queued?.(done);
  const r = await done;
  if (!wrote) return null;
  return r.outcome === 'failed' && r.reason === 'error' ? `${file.key} put error` : syncErrorOf(file.key, 'put', r);
}

/**
 * The run's log, written on the box and uploaded to runs/<name>.md. It
 * takes its queue place at once, so the next run's pull of it (its
 * previous-run.md) waits behind it.
 */
export async function pushRunLog(
  t: SyncTarget, logName: string, content: string | (() => Promise<string | null>),
  opts: { delayMs?: number; queued?: (done: Promise<unknown>) => void } = {},
): Promise<string | null> {
  return writeAndPut(t, runLogFile(t.folder, t.memoryDir, logName), content, opts);
}

/**
 * The README, uploaded when the box's copy (the last one uploaded) differs
 * from what the automation says now. An upload that fails blanks the box's
 * copy so the next try uploads again.
 */
export async function publishReadme(t: SyncTarget, content: string): Promise<string | null> {
  const file = readmeFile(t.folder, t.memoryDir);
  const local = await sendForProject(t.host, 'read-file', { path: file.local }, 5000).catch(() => null) as { content?: unknown } | null;
  if (local && local.content === content) return null;
  const error = await writeAndPut(t, file, content);
  if (error) await sendForProject(t.host, 'write-file', { path: file.local, content: '', mode: 0o600 }, 5000).catch(() => {});
  return error;
}

/** The README for an automation as its row says now; `owner` is their unix name (the same on every path, or each would re-upload it). */
export function readmeFor(a: { id: string; spaceName: string; spaceFolder: string | null; projectId: string; schedule: string; timezone: string; prompt: string; tier: string }, projectName: string, owner: string): string {
  const base = webBase();
  return renderReadme({
    automationName: projectName, spaceName: a.spaceName, folder: folderOf(a), schedule: a.schedule, timezone: a.timezone,
    prompt: a.prompt, tier: a.tier, owner, link: base ? `${base}/automations/${encodeURIComponent(a.projectId)}` : null,
  });
}

/**
 * The README after a create or a PATCH, for an automation in a space with
 * folders on; the next run does it anyway if the box is away now. Best
 * effort, in the background; never throws.
 */
export async function publishReadmeFor(automationId: string): Promise<void> {
  try {
    const a = await prisma.automation.findUnique({
      where: { id: automationId },
      include: { project: { select: { name: true, instanceId: true, archived: true, instance: { select: { id: true, hostHome: true, hostUnixUser: true } }, user: { select: { unixUsername: true } } } } },
    });
    if (!a?.spaceName || !a.project.instance || a.project.archived) return;
    if (!(await spaceFoldersEnabledFor(a.userId))) return;
    const p = a.project;
    const box = p.instance!;
    const home = box.hostHome ?? `/home/${p.user.unixUsername}`;
    const t: SyncTarget = {
      runId: `readme-${a.id}`, userId: a.userId, projectId: a.projectId, projectName: p.name, spaceName: a.spaceName, folder: folderOf(a),
      host: { userId: a.userId, instanceId: box.id }, box: { id: box.id, hostHome: box.hostHome, hostUnixUser: box.hostUnixUser ?? p.user.unixUsername },
      memoryDir: memoryDirFor(home, a.projectId),
    };
    if (!isProjectAgentConnected(t.host)) return;
    await publishReadme(t, readmeFor({ ...a, spaceName: a.spaceName }, p.name, p.user.unixUsername));
  } catch (err) {
    console.warn(`[AUTOMATION] README for ${automationId} failed: ${(err as Error).message}`);
  }
}
