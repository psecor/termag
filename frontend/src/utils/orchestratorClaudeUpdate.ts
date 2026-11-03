/**
 * The Software tab's orchestrator row: what its
 * "Update Claude Code" says. The orchestrator host's /usr/bin/claude runs the runner orchestrator, which
 * runs no turns, so a run always try-restarts it and offers no restart choice; host users' sessions on
 * the old binary are counted in the run, never stopped. The routes are the boxes' (hostKey `orchestrator`),
 * and answer 404 claude_update_off while orchestrator-claude-update-enabled is off, which hides this.
 */
import type { ToolUpdatePreview } from '../services/adminApi';

export function orchestratorConfirmText(p: ToolUpdatePreview): string {
  return [
    'Update Claude Code on the orchestrator host?',
    '',
    `${p.current ?? 'unknown'} → ${p.target ?? `the floor${p.floor ? ` ${p.floor}` : ''} (no version pinned)`}${p.target && p.floor ? ` (floor ${p.floor})` : ''}`,
    'The runner orchestrator restarts on the new binary (it runs no turns).',
    'Host users’ Claude Code sessions keep the old binary until they restart; the run counts them.',
  ].join('\n');
}

/**
 * The row's line with no version pinned (decided on #1165: exact versions only on the orchestrator host,
 * from orchestrator-claude-update-policy): what a run would do, or that it would do nothing. Null with a pin.
 */
export function floorOnlyText(p: ToolUpdatePreview): string | null {
  if (!p.floorOnly) return null;
  return p.nothingToDo
    ? `Floor only: set a version in orchestrator-claude-update-policy to move it (at or above the floor${p.floor ? ` ${p.floor}` : ''}, nothing to install).`
    : `Floor only: no version is pinned in orchestrator-claude-update-policy, so a run brings it up to the floor${p.floor ? ` ${p.floor}` : ''} and no further.`;
}

/** The line the row shows while a quarantine holds the runner orchestrator, or null. */
export function heldText(p: ToolUpdatePreview): string | null {
  return p.runnerHeld
    ? 'Claude Code is quarantined on this host: the last install could not be verified or put back, so the runner orchestrator is stopped and will not start. A run that installs a verified version (this button, the nightly run or the next boot) starts it again.'
    : null;
}

type HttpError = { response?: { status?: number; data?: { code?: string; error?: string } } } | null | undefined;
const CONFLICT: Record<string, string> = {
  not_capable: 'This orchestrator image has no Claude Code updater yet (claude-orchestrator-update).',
  run_in_flight: 'An update is already running on the orchestrator host.',
  floor_only: 'Floor only: set a version in orchestrator-claude-update-policy to move it.',
  restart_not_supported: 'The orchestrator host takes no session restart: only its runner orchestrator restarts.',
  helper_refused: 'The root helper refused the run',
};
/** A 409 or the helper's 502 as a sentence, or null for anything else (the caller shows errorText). */
export function orchestratorConflictText(e: unknown): string | null {
  const r = (e as HttpError)?.response;
  const code = r?.data?.code;
  if (r?.status === 502 && code === 'helper_refused') return `${CONFLICT.helper_refused}${r.data?.error ? `: ${r.data.error}` : '.'}`;
  if (r?.status !== 409) return null;
  return (code && CONFLICT[code]) ?? `Refused${code ? ` (${code})` : ''}.`;
}
