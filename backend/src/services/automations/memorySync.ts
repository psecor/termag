/**
 * Memory that outlives the box: an
 * automation with a `spaceName` mirrors its notes file to that space, at
 * `automations/<projectId>/memory/MEMORY.md` (the id, like the on-box path:
 * an automation can be renamed, and a rename must not orphan the notes
 * stored under the old name). Before a run the box pulls the
 * file (`termag space get`), after a run it pushes it back (`termag space
 * put`), both as one-shot tmux sessions whose only process is the CLI the
 * box already has (termag-reconcile installs ~/.local/bin/termag), on the
 * box's own token. Bytes never pass through the orchestrator, as for every
 * other space transfer; the orchestrator only grants the box and waits.
 *
 * Best effort throughout: a space that is off, gone, or not writable by the
 * owner, a box without the one-shot tmux command, or a transfer that fails
 * leaves the run with whatever notes the box has. One live run per
 * automation makes last-writer-wins safe, and transfers for one mirrored
 * file run one at a time in this process (syncMemory): a run's pull waits
 * for the previous run's push, which the row's finishing does not wait for.
 */
import { prisma } from '../../db';
import { isProjectAgentConnected, projectAgentCapabilities, sendForProject } from '../agentRegistry';
import { RUNNER_AGENT_CAPABILITY, tmuxSafe } from '../claudeRunnerSpawn';
import { roleAtLeast, type SpaceRole } from '../spaces/spaceAccess';
import { spaceStore, spacesEnabledFor } from '../spaces/spacesRuntime';

export type SpaceSyncRefusal = 'spaces_off' | 'space_not_found' | 'space_forbidden' | 'space_read_only' | 'shared_outside_space';

/** Where in the space a project's notes live: keyed on the project id, which a rename does not change. */
export function remoteMemoryPath(projectId: string): string {
  return `automations/${projectId}/memory/MEMORY.md`;
}

/**
 * The largest notes file mirrored either way. Anyone who can write the space
 * can put any object at the notes path; the box must never load more than
 * this of it, and nothing is read into the orchestrator at all.
 */
export const MEMORY_MAX_BYTES = 1024 * 1024;

/**
 * A get downloads beside the notes file, and the box itself checks the size
 * and installs it with a rename, then writes this marker. The marker (two
 * bytes) is what proves the pull worked; the notes' bytes never cross the
 * agent socket.
 */
export function pulledMarkerPath(memoryDir: string): string {
  return `${memoryDir}/MEMORY.md.pulled`;
}

const GET_SCRIPT = [
  'rm -f -- "$0" "$3"',
  '&& "$1" space get "$2" "$0"',
  '&& [ -f "$0" ]',
  '&& [ "$(wc -c < "$0")" -le "$5" ]',
  '&& mv -f -- "$0" "$4"',
  '&& printf ok > "$3";',
  's=$?; rm -f -- "$0"; exit $s',
].join(' ');
const PUT_SCRIPT = '[ "$(wc -c < "$0")" -le "$3" ] && exec "$1" space put "$0" "$2"';

/**
 * The CLI invocation for one direction, as an argument list for
 * `tmux-create`'s command (the session's one process is a shell). A get
 * clears the marker and any earlier download first, so a stale one never
 * passes a failed get off as a success, then downloads, refuses anything over
 * MEMORY_MAX_BYTES, renames it over the notes file and writes the marker. A
 * put uploads the notes file only when it is within the cap.
 */
export function syncCommand(home: string, direction: 'get' | 'put', spaceName: string, remotePath: string, memoryDir: string): string[] {
  const bin = `${home.replace(/\/+$/, '')}/.local/bin/termag`;
  const remote = `${spaceName}:${remotePath}`;
  const notes = `${memoryDir}/MEMORY.md`;
  return direction === 'get'
    ? ['/bin/sh', '-c', GET_SCRIPT, pullPath(memoryDir), bin, remote, pulledMarkerPath(memoryDir), notes, String(MEMORY_MAX_BYTES)]
    : ['/bin/sh', '-c', PUT_SCRIPT, notes, bin, remote, String(MEMORY_MAX_BYTES)];
}

/** `<user>-automation-sync-<run>-<dir>-r`: ends in `-r` so status parsing never reads it as a project pane. */
export function syncSessionName(hostUnixUser: string, runId: string, direction: 'get' | 'put'): string {
  return `${tmuxSafe(hostUnixUser)}-automation-sync-${tmuxSafe(runId)}-${direction}-r`;
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
 * could use the box token as the owner's space role) and the notes pulled
 * onto the box (blanked, with the pull marker, so nothing pulled stays
 * readable and the next permitted run pulls afresh). A grant the owner added
 * by hand is left alone. Best effort; never throws.
 */
export async function unwindMirror(projectId: string, why: string): Promise<void> {
  try {
    const a = await prisma.automation.findUnique({
      where: { projectId },
      select: { id: true, spaceName: true, mirrorGrantBoxId: true, project: { select: { name: true, userId: true, instanceId: true, instance: { select: { hostHome: true } }, user: { select: { unixUsername: true } } } } },
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
      for (const path of [`${dir}/MEMORY.md`, pulledMarkerPath(dir)]) {
        await sendForProject(host, 'write-file', { path, content: '', mode: 0o600 }, 5000).catch(() => {});
      }
    }
    console.warn(`[AUTOMATION] ${p.name}: notes mirror unwound (${why}): the box's added space grant removed, the pulled notes blanked`);
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
  host: { userId: string; instanceId: string };
  box: { id: string; hostHome: string | null; hostUnixUser: string | null };
  memoryDir: string;
}

const POLL_MS = 1000;

// One transfer at a time per mirrored file: the row of a finished run is
// final before its push lands (completion does not hold the row for it),
// so the next run's pull, admitted the moment the row is final, must queue
// behind that push or it would read stale notes and later overwrite the
// push. Keyed on the remote path; in-process (the scheduler's starts and the
// relay's completions run in the one orchestrator process outside an
// overlap deploy).
const inFlight = new Map<string, Promise<unknown>>();

// Runs whose pull failed while the space held notes: their push is skipped,
// or the space's durable copy would be replaced by the seed plus one run
// (the loss this feature exists to prevent). In-process, like the queue, so
// a put also re-reads the durable proof: the pull file the get left on the
// box (removed before every get, written by a get that worked) and whether
// the space holds the notes at all. A process restarted between the pull
// and the push decides from those, not from this set.
const pullFailed = new Set<string>();

/** The pull lands beside the notes file; it replaces the file only once it is there. */
function isPulledMarker(r: { content?: unknown } | null): boolean {
  return !!r && typeof r.content === 'string' && r.content.trim() === 'ok';
}

export function pullPath(memoryDir: string): string {
  return `${memoryDir}/MEMORY.md.pull`;
}

/** Tests: a transfer is queued or running for this mirrored file. */
export function syncInFlight(spaceName: string, projectId: string): boolean {
  return inFlight.has(`${spaceName}:${remoteMemoryPath(projectId)}`);
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
 * Run one transfer on the box. The box must hold a grant to the space (made
 * here if the owner may add boxes: an owner's or editor's box), and must
 * announce the one-shot tmux command. Resolves to what happened; never
 * throws.
 */
export async function syncMemory(t: SyncTarget, direction: 'get' | 'put', opts: { waitMs?: number; delayMs?: number } = {}): Promise<'done' | 'timeout' | 'skipped' | 'failed'> {
  const key = `${t.spaceName}:${remoteMemoryPath(t.projectId)}`;
  const previous = inFlight.get(key) ?? Promise.resolve();
  // delayMs: the transfer takes its place in the queue now and starts that
  // much later (the timeout sweep's and Stop's push, which waits for the
  // interrupt to stop the turn's writes): a pull asked for meanwhile, by the
  // next run the same tick starts, queues behind it instead of ahead.
  const run = () => (opts.delayMs ? new Promise(r => setTimeout(r, opts.delayMs)) : Promise.resolve()).then(() => transfer(t, direction, opts));
  const own = previous.then(run, run);
  inFlight.set(key, own);
  try {
    const result = await own;
    // Anything short of pulled bytes (or a confirmed-empty space) means this
    // run's push could replace notes it never saw: a transfer that threw,
    // a box briefly without the one-shot command, a timeout.
    if (direction === 'get' && result !== 'done') pullFailed.add(t.runId);
    return result;
  } finally {
    if (inFlight.get(key) === own) inFlight.delete(key);
  }
}

async function transfer(t: SyncTarget, direction: 'get' | 'put', { waitMs = 45_000 }: { waitMs?: number }): Promise<'done' | 'timeout' | 'skipped' | 'failed'> {
  const tag = `[AUTOMATION] ${t.projectName} notes ${direction}`;
  try {
    const check = await checkSpaceForOwner(t.userId, t.spaceName, t.projectId);
    if (!check.ok) {
      console.log(`${tag}: skipped (${check.reason})`);
      if (check.reason === 'shared_outside_space') await unwindMirror(t.projectId, check.reason);
      return 'skipped';
    }
    if (!isProjectAgentConnected(t.host) || !projectAgentCapabilities(t.host).includes(RUNNER_AGENT_CAPABILITY)) {
      console.log(`${tag}: skipped (box cannot run a one-shot command)`); return 'skipped';
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
    const remotePath = remoteMemoryPath(t.projectId);
    if (direction === 'put') {
      if (pullFailed.has(t.runId)) {
        console.warn(`${tag}: skipped (this run's pull failed; the space's notes are kept)`);
        return 'skipped';
      }
      // The durable form of the same check (a restart empties pullFailed):
      // no pull file on the box while the space holds notes means this
      // process cannot know they were pulled, and the push would replace them.
      const proof = await sendForProject(t.host, 'read-file', { path: pulledMarkerPath(t.memoryDir) }, 5000).catch(() => null) as { content?: unknown } | null;
      if (!isPulledMarker(proof) && await spaceStore.lastPutAt(check.spaceId, remotePath)) {
        console.warn(`${tag}: skipped (no pull on the box while the space holds notes; they are kept)`);
        return 'skipped';
      }
    }
    const user: string = t.box.hostUnixUser ?? home.split('/').pop() ?? 'termag';
    const sessionName = syncSessionName(user, t.runId, direction);
    // A pull lands beside the file first: the session's end says nothing
    // about its exit status, so the pulled bytes are the proof, and only they
    // replace the notes file. Nothing pulled: fine when the space has never
    // held this file (the first run seeds it), a failure otherwise.
    const command = syncCommand(home, direction, t.spaceName, remotePath, t.memoryDir);
    await sendForProject(t.host, 'tmux-create', { sessionName, cwd: t.memoryDir, gitInit: false, command }, 15_000);
    const outcome = await waitForSession(t.host, sessionName, waitMs);
    if (outcome === 'timeout') {
      await sendForProject(t.host, 'tmux-kill', { sessionName, exact: true }, 5000).catch(() => {});
      console.warn(`${tag}: gave up after ${Math.round(waitMs / 1000)} s`);
    }
    if (direction !== 'get') return outcome;
    // Only the marker is read: the box installed the notes itself.
    const pulled = await sendForProject(t.host, 'read-file', { path: pulledMarkerPath(t.memoryDir) }, 5000).catch(() => null) as { content?: unknown } | null;
    if (isPulledMarker(pulled)) return 'done';
    if (!(await spaceStore.lastPutAt(check.spaceId, remotePath))) return outcome; // the space has no notes yet: nothing to pull
    pullFailed.add(t.runId);
    console.warn(`${tag}: the space holds notes this run could not pull; its push will be skipped`);
    return 'failed';
  } catch (err) {
    console.warn(`${tag}: failed: ${(err as Error).message}`);
    return 'failed';
  }
}
