/**
 * Whether a simple-UI chat's Claude may run tools without asking, and the
 * permission mode its runner turns use. The backend decides the mode on
 * every send, so nothing the browser sends can ask for bypass.
 *
 * Trusted only when the project owner ticked trust (Project.chatTrustedAt).
 * A GitHub owner string is not that tick by itself. The simple UI can start the
 * checkbox checked for listed owners (frontend chat/simpleChat.ts
 * repoStartsTrusted, none by default) and create records the tick; clearing
 * the checkbox leaves the project read-only until it is trusted from the
 * session. An unticked repository and a project with no repository stay
 * read-only. A
 * pull-request or fork workstream stays read-only even after the tick.
 */

import { isRunName } from './automations/schedule';

export const TRUSTED_MODE = 'bypassPermissions';
export const UNTRUSTED_MODE = 'dontAsk';
/** Claude Code's auto mode (services/chatRunner.ts AUTO_MODE): every tool, the classifier, none of the checkout's startup config. */
export const RUN_FOLLOW_UP_MODE = 'auto';

/**
 * A person's turn in an automation run's workstream (`run-<date>-<time>`)
 * never gets bypassPermissions: that tree was made from
 * origin's tip with nobody watching, and bypass is the one mode that loads
 * a checkout's .mcp.json, hooks and settings at process start. The trusted
 * ceiling there is auto, or read-only on a box whose runner has no auto
 * mode. Decided on the orchestrator, so nothing the run itself can write on
 * the box (the agent's own unattended marker included) can lift it.
 */
export function followUpMode(mode: string, workstreamName: string, runnerHasAuto: boolean): string {
  if (mode !== TRUSTED_MODE || !isRunName(workstreamName)) return mode;
  return runnerHasAuto ? RUN_FOLLOW_UP_MODE : UNTRUSTED_MODE;
}
export type ChatPermissionMode = typeof TRUSTED_MODE | typeof UNTRUSTED_MODE;

export type ChatTrustReason = 'trusted' | null;

export interface ChatTrust {
  trusted: boolean;
  reason: ChatTrustReason;
  mode: ChatPermissionMode;
}

/** A project's chat trust. Only chatTrustedAt counts; the repository URL does not. */
export function chatTrust(
  project: { repoUrl: string | null; chatTrustedAt: Date | null },
): ChatTrust {
  const trusted = project.chatTrustedAt != null;
  return { trusted, reason: trusted ? 'trusted' : null, mode: trusted ? TRUSTED_MODE : UNTRUSTED_MODE };
}

/**
 * What one workstream checkout is, as the runner reads it (agent/chat-runner.js
 * checkoutOwnTree). A pull request or a fork stays read-only. A branch-off of
 * the project's own repository does not: the runner keeps bypass when the
 * branch is marked own and its upstream is that repository, not a pull ref.
 * A missing marker and a detached HEAD stay read-only. Another ref at the
 * same commit does not change main.
 */
export interface WorkstreamCheckout {
  pullHead: boolean;
  fork: boolean;
}

/**
 * The mode a turn in this workstream may use. The owner's tick is only the
 * ceiling: a pull-request head or a fork does not inherit it. The runner
 * recomputes the checkout when the turn starts, including a queued turn
 * whose stored mode survived an agent restart.
 */
export function chatTurnMode(
  project: { repoUrl: string | null; chatTrustedAt: Date | null },
  checkout: WorkstreamCheckout,
): ChatPermissionMode {
  if (!chatTrust(project).trusted) return UNTRUSTED_MODE;
  if (checkout.pullHead || checkout.fork) return UNTRUSTED_MODE;
  return TRUSTED_MODE;
}
