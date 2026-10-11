/**
 * Whether a project may have tmux sessions yet. While a repo project's setup
 * owns its directory (`pending`, `cloning`, `failed`), nothing creates a
 * session there: `tmux-create` makes the dir and `git init`s it, which would
 * poison the clone target. Pure, read by every launcher and the terminal
 * attach; `projectSetup.ts` owns the status itself.
 */

import { toSetupStatus, type SetupStatus } from './projectSetup';

export interface SessionRefusal {
  setupStatus: string;
  message: string;
}

/**
 * The setup owner's own launch, made while it holds the project and before it
 * commits the move: the ready launch runs while the row still says `cloning`,
 * the pane checkout while it says `pending`.
 */
export interface SetupAdmission {
  projectId: string;
  from: SetupStatus;
}

const REFUSALS: Readonly<Record<SetupStatus, string | null>> = {
  none: null,
  ready: null,
  pending: 'This project is waiting for its box to clone the repository.',
  cloning: 'This project is still cloning its repository.',
  failed: "This project's clone failed. Retry it or start empty.",
};

const UNKNOWN_REFUSAL = 'This project is in an unknown setup state.';

/** Null when sessions are allowed, or when the admission names this project in its current status. */
export function refuseUnreadySessions(
  project: { id: string; setupStatus: string },
  admission?: SetupAdmission,
): SessionRefusal | null {
  const status = toSetupStatus(project.setupStatus);
  const message = status ? REFUSALS[status] : UNKNOWN_REFUSAL;
  if (message === null) return null;
  if (admission && admission.projectId === project.id && admission.from === project.setupStatus) return null;
  return { setupStatus: project.setupStatus, message };
}

export class SessionGateError extends Error {
  constructor(readonly refusal: SessionRefusal) {
    super(refusal.message);
    this.name = 'SessionGateError';
  }
}
