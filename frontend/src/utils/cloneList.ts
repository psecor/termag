import { SETUP_STATUSES, type SetupStatus } from '../types';

/**
 * One clock for the project list. A read takes the next number when it
 * starts. A response applies only when that number is still the latest.
 * Retry and Start empty take a number too, so a list that started earlier
 * cannot put the row back.
 */
export interface CloneRow {
  id: string;
  setupStatus?: string | null;
  setupError?: string | null;
  repoUrl?: string | null;
  repoDefaultBranch?: string | null;
}

export interface CloneListState<T extends CloneRow> {
  generation: number;
  projects: T[];
  /** Highest generation whose projects are already on screen. */
  applied?: number;
  /** A list that succeeded while a newer read was still open. */
  held?: { generation: number; projects: T[] } | null;
}

export interface CloneActionBody {
  setupStatus?: string | null;
  setupError?: string | null;
  repoUrl?: string | null;
  repoDefaultBranch?: string | null;
}

export type CloneAction = 'retry' | 'start-empty';

export function beginListRead(generation: number): number {
  return generation + 1;
}

export function applyListRead<T extends CloneRow>(
  current: CloneListState<T>,
  read: { generation: number; projects: T[] },
): CloneListState<T> {
  if (read.generation === current.generation) {
    return { generation: current.generation, projects: read.projects, applied: read.generation, held: null };
  }
  const applied = current.applied ?? 0;
  if (read.generation <= applied || read.generation > current.generation) return current;
  if (current.held && read.generation <= current.held.generation) return current;
  return { ...current, held: { generation: read.generation, projects: read.projects } };
}

/**
 * A list read that throws gives its number back when it is still the latest
 * claim. The newest older success, if one arrived while this read was open,
 * takes the screen. A claim that already applied, including Retry, stays.
 */
export function releaseListRead<T extends CloneRow>(
  current: CloneListState<T>,
  generation: number,
): CloneListState<T> {
  if (current.generation !== generation) return current;
  const applied = current.applied ?? 0;
  const nextGeneration = Math.max(applied, generation - 1);
  if (nextGeneration === applied) {
    return { ...current, generation: nextGeneration, held: null };
  }
  const held = current.held;
  if (held && held.generation === nextGeneration) {
    return { generation: nextGeneration, projects: held.projects, applied: nextGeneration, held: null };
  }
  if (held && held.generation > nextGeneration) {
    return { ...current, generation: nextGeneration, held: null };
  }
  return { ...current, generation: nextGeneration };
}

function knownStatus(value: string | null | undefined, fallback: SetupStatus): SetupStatus {
  if (value != null && (SETUP_STATUSES as readonly string[]).includes(value)) return value as SetupStatus;
  return fallback;
}

export function applyCloneAction<T extends CloneRow>(
  current: CloneListState<T>,
  projectId: string,
  action: CloneAction,
  body: CloneActionBody,
): CloneListState<T> {
  const projects = current.projects.map(project => {
    if (project.id !== projectId) return project;
    if (action === 'retry') {
      const setupStatus = knownStatus(body.setupStatus, 'pending');
      const setupError = body.setupError !== undefined
        ? body.setupError
        : setupStatus === 'failed'
          ? (project.setupError ?? null)
          : null;
      return { ...project, setupStatus, setupError };
    }
    return {
      ...project,
      setupStatus: knownStatus(body.setupStatus, 'none'),
      setupError: body.setupError ?? null,
      repoUrl: body.repoUrl ?? null,
      repoDefaultBranch: body.repoDefaultBranch ?? null,
    };
  });
  const generation = current.generation + 1;
  return { generation, projects, applied: generation, held: null };
}

/**
 * The action response moves the row before the follow-up list read. A failed
 * read leaves that row in place and does not fail the action.
 */
export async function settleCloneAction<T extends CloneRow>(args: {
  read: () => CloneListState<T>;
  write: (state: CloneListState<T>) => void;
  projectId: string;
  action: CloneAction;
  request: () => Promise<CloneActionBody>;
  reload: () => Promise<T[]>;
}): Promise<{ requestError: unknown | null; list: T[] | null }> {
  let body: CloneActionBody;
  try {
    body = await args.request();
  } catch (requestError) {
    return { requestError, list: null };
  }
  const adopted = applyCloneAction(args.read(), args.projectId, args.action, body);
  const generation = beginListRead(adopted.generation);
  args.write({ ...adopted, generation });
  try {
    const projects = await args.reload();
    const next = applyListRead(args.read(), { generation, projects });
    // A newer read is still open. Keep this success so its failure can apply it.
    if (next.held?.generation === generation) {
      args.write(next);
      return { requestError: null, list: null };
    }
    if (next.projects !== projects) return { requestError: null, list: null };
    args.write(next);
    return { requestError: null, list: projects };
  } catch {
    return { requestError: null, list: null };
  }
}
