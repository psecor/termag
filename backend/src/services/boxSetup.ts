/**
 * Whether termag sets a box up beyond what it needs to
 * manage it.
 *
 *   on   (the default) the skills, agent harness config, MCP registration,
 *        git and docker config, delivered credentials, seeded AGENTS.md /
 *        CLAUDE.md, and a warm-pool box when there is one.
 *   off  termag runs, updates, parks and SSH-syncs the box and keeps the
 *        status hooks, the CLI and the guest browser, and delivers nothing
 *        else: no skills, agent config, credentials or project seeding, and
 *        never a warm-pool box.
 *
 * Chosen once, at launch, and stored on Instance.setupEnabled. The box learns
 * it from ~/.config/termag/setup (`off`), which cloud-init writes and
 * termag-reconcile and the agent read. Set from the CLI
 * (`--no-setup`), the API (`setupEnabled: false`) and a repository's
 * environment.json (`"setupEnabled": false`); the UI has no control for it.
 * The empty-box-enabled flag (the feature's first name) only gates turning it
 * off: a box launched with setup off keeps it off with the flag off.
 */
import type { RouteResult } from '../routes/routeResult';

export const SETUP_OFF_FLAG = 'empty-box-enabled';

/** Relative to the box user's home; deploy/termag-reconcile and agent/box-setup.js read the same path. */
export const BOX_SETUP_DIR = '.config/termag';
export const BOX_SETUP_FILE = `${BOX_SETUP_DIR}/setup`;

/** The code every refusal for a box with setup off carries, for a client to explain. */
export const SETUP_DISABLED_CODE = 'setup_disabled';

export function isSetupOff(box: { setupEnabled?: boolean | null } | null | undefined): boolean {
  return box?.setupEnabled === false;
}

/** A create body's `setupEnabled`: absent is on; anything but a boolean is refused. */
export function parseSetupEnabled(raw: unknown): { setupEnabled: boolean } | { error: string } {
  if (raw === undefined || raw === null) return { setupEnabled: true };
  if (typeof raw === 'boolean') return { setupEnabled: raw };
  return { error: 'setupEnabled must be true or false' };
}

/**
 * A create's setting, in this order: the one asked for
 * (`--setup`, `--no-setup`, the API's `setupEnabled`), else the repos'
 * environment.json when the caller stated it (`repoSetup`, null when it
 * didn't or the flag is off), else on. `from: 'repo'` only when the repos
 * turned it off, for the 201 to say so.
 */
export function decideBoxSetup(
  raw: unknown, repoSetup: { setupEnabled: boolean | null; repos: string[] } | null,
): { setupEnabled: boolean; from: 'asked' | 'repo' | 'default'; repos: string[] } | { error: string } {
  if (raw !== undefined && raw !== null) {
    const parsed = parseSetupEnabled(raw);
    return 'error' in parsed ? parsed : { setupEnabled: parsed.setupEnabled, from: 'asked', repos: [] };
  }
  if (repoSetup?.setupEnabled === false) return { setupEnabled: false, from: 'repo', repos: repoSetup.repos };
  return { setupEnabled: true, from: 'default', repos: [] };
}

/**
 * Why a create may not have the setting it asked for, or null. Only a managed
 * box can have setup off: an external box is the owner's own machine, which
 * termag never sets up anyway.
 */
export function boxSetupRefusal(setupEnabled: boolean, kind: string, flagOn: boolean): RouteResult | null {
  if (setupEnabled) return null;
  if (kind !== 'ec2') return { status: 400, body: { error: 'Only a managed box can have termag setup off' } };
  if (!flagOn) {
    return { status: 403, body: { error: `Turning termag setup off isn't enabled for you (flag ${SETUP_OFF_FLAG})`, code: 'setup_off_not_enabled' } };
  }
  return null;
}

/** A feature that needs what setup off leaves out, refused. */
export function setupOffRefusal(feature: string): RouteResult {
  return { status: 409, body: { error: `${feature}: termag setup is off on this box`, code: SETUP_DISABLED_CODE } };
}
