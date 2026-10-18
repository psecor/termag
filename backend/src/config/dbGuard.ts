/**
 * Start-up guard for the orchestrator's database (`npm run db:guard`), run by
 * cloud-init before the schema sync and by termag.service before every start.
 * It exists for the move from the host's Postgres container to RDS
 *, where two mistakes would each bring termag up on
 * the wrong data without any error:
 *
 *   local Postgres, after the cutover → a revert of the cloud-init switch, weeks
 *     later, would start on the container's stale copy. The cutover writes
 *     DATABASE_MOVED_TO_RDS on the data volume; local mode refuses while it
 *     exists unless ALLOW_DOCKER_ROLLBACK does too (termag-rds-cutover
 *     rollback-to-docker writes that after copying RDS back).
 *   RDS, never restored → db:push would create an empty schema and termag would
 *     come up with no users, and every box's agent token invalid. RDS mode refuses
 *     while `users` is missing or empty unless ALLOW_EMPTY_DATABASE exists (a
 *     brand-new install).
 *
 * Pure: the caller supplies the marker files and the users-table probe.
 */

export const DEFAULT_DATA_DIR = '/srv/termag';

export const MARKERS = {
  movedToRds: 'DATABASE_MOVED_TO_RDS',
  allowDockerRollback: 'ALLOW_DOCKER_ROLLBACK',
  allowEmptyDatabase: 'ALLOW_EMPTY_DATABASE',
} as const;

export interface GuardMarkers {
  movedToRds: boolean;
  allowDockerRollback: boolean;
  allowEmptyDatabase: boolean;
}

export interface UsersTableProbe {
  exists: boolean;
  rows: number;
}

export interface GuardDecision {
  ok: boolean;
  message: string;
}

export function dataDirFromEnv(env: { TERMAG_DATA_DIR?: string }): string {
  return env.TERMAG_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
}

export function guardLocalDatabase(markers: GuardMarkers, dataDir: string): GuardDecision {
  if (!markers.movedToRds) return { ok: true, message: 'local database' };
  if (markers.allowDockerRollback) {
    return { ok: true, message: `local database after an RDS cutover, allowed by ${dataDir}/${MARKERS.allowDockerRollback}` };
  }
  return {
    ok: false,
    message:
      `${dataDir}/${MARKERS.movedToRds} exists: this database moved to RDS, and the local copy is stale. ` +
      `Copy RDS back first (termag-rds-cutover rollback-to-docker), which allows it with ${MARKERS.allowDockerRollback}.`,
  };
}

export function guardRdsDatabase(markers: GuardMarkers, users: UsersTableProbe, dataDir: string): GuardDecision {
  if (users.exists && users.rows > 0) return { ok: true, message: `RDS database restored (${users.rows} users)` };
  if (markers.allowEmptyDatabase) {
    return { ok: true, message: `RDS database has no users, allowed by ${dataDir}/${MARKERS.allowEmptyDatabase}` };
  }
  const state = users.exists ? 'has an empty users table' : 'has no users table';
  return {
    ok: false,
    message:
      `the RDS database ${state}: it was never restored (termag-rds-cutover migrate). ` +
      `For a brand-new install with no data to move, create ${dataDir}/${MARKERS.allowEmptyDatabase}.`,
  };
}
