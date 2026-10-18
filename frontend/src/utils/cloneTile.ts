import { SETUP_STATUSES, type Instance, type Project, type SetupStatus } from '../types';

export type ClonePhase = 'waiting' | 'cloning' | 'failed';

export interface CloneTileView {
  phase: ClonePhase | null;
  label: string | null;
  holdTerminal: boolean;
  retry: boolean;
  startEmpty: boolean;
}

const OPEN: CloneTileView = {
  phase: null, label: null, holdTerminal: false, retry: false, startEmpty: false,
};

const VIEWS: Record<SetupStatus, CloneTileView> = {
  none: OPEN,
  ready: OPEN,
  pending: { phase: 'waiting', label: 'waiting for box', holdTerminal: true, retry: false, startEmpty: false },
  cloning: { phase: 'cloning', label: 'cloning', holdTerminal: true, retry: false, startEmpty: false },
  failed: { phase: 'failed', label: 'clone failed', holdTerminal: true, retry: true, startEmpty: true },
};

const BOX_FAILED: CloneTileView = {
  phase: 'failed', label: 'box failed', holdTerminal: true, retry: true, startEmpty: false,
};

/**
 * What the tile knows about the project beyond its setup status: whether the
 * box it waits on failed to launch (Retry then launches a new one), and
 * whether there is a repository at all (an empty project's setup has no
 * clone to fail or to start without).
 */
export interface SetupContext {
  boxFailed?: boolean;
  boxError?: string | null;
  hasRepo?: boolean;
}

/**
 * The context from the box feed. A box still missing from a list fetched
 * after the project was seen pointing at it (`absenceConfirmed`, BoxFeed's
 * isGone) is one the owner no longer has, since the feed lists no terminated
 * box; a project just moved onto a new box only looks that way until the
 * next list. A collaborator's feed never has the owner's boxes, so only the
 * owner reads absence.
 */
export function setupContext(
  project: Pick<Project, 'instanceId' | 'repoUrl' | 'role'>,
  boxes: readonly Pick<Instance, 'id' | 'status' | 'provisioningError'>[],
  absenceConfirmed: boolean,
): SetupContext {
  const box = project.instanceId ? boxes.find(b => b.id === project.instanceId) : undefined;
  const gone = !box && !!project.instanceId && absenceConfirmed && project.role !== 'collaborator';
  return {
    boxFailed: gone || box?.status === 'failed',
    boxError: box?.provisioningError ?? null,
    hasRepo: !!project.repoUrl,
  };
}

const UNRECOGNIZED: CloneTileView = {
  phase: null, label: null, holdTerminal: true, retry: false, startEmpty: false,
};

function isSetupStatus(value: string): value is SetupStatus {
  return (SETUP_STATUSES as readonly string[]).includes(value);
}

export function cloneTile(setupStatus: string | null | undefined, ctx: SetupContext = {}): CloneTileView {
  if (setupStatus == null || setupStatus === '') return OPEN;
  if (!isSetupStatus(setupStatus)) return UNRECOGNIZED;
  if (setupStatus === 'pending' && ctx.boxFailed) return BOX_FAILED;
  if (setupStatus === 'failed' && ctx.hasRepo === false) return { ...VIEWS.failed, label: 'setup failed', startEmpty: false };
  return VIEWS[setupStatus];
}

export function cloneInFlight(setupStatus: string | null | undefined): boolean {
  const phase = cloneTile(setupStatus).phase;
  return phase === 'waiting' || phase === 'cloning';
}

export function cloneHoldCopy(
  setupStatus: string | null | undefined,
  setupError: string | null | undefined,
  ctx: SetupContext = {},
): string {
  const view = cloneTile(setupStatus, ctx);
  if (!view.holdTerminal) return '';
  if (view === BOX_FAILED) {
    const detail = ctx.boxError?.trim();
    return `The box failed to launch${detail ? `: ${detail}` : ''}. Retry on the project launches a new one.`;
  }
  if (view.phase === 'failed') {
    const detail = setupError?.trim();
    return detail ? `${view.label}: ${detail}` : view.label ?? '';
  }
  if (view.label) return view.label;
  return 'This project is not ready.';
}
