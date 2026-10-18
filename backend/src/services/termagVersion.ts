/**
 * Which termag commit this orchestrator runs, for GET /api/version and the PR
 * pipeline's deploy lanes. Resolved once per process, in
 * order:
 *
 *   1. TERMAG_GIT_SHA — set by whoever starts a build that has no checkout
 *      (the container image);
 *   2. `git rev-parse HEAD` of the checkout the backend runs from — a dev box,
 *      the stage stack, or a host hot-patched by a checkout update;
 *   3. /opt/termag/.termag-baked-sha — written by the orchestrator AMI bake
 *      (packer/scripts/orchestrator-setup.sh), which deletes `.git`.
 *
 * The checkout wins over the baked file because only a hot-patch can make the
 * two disagree, and then the checkout is the newer truth.
 */

import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type VersionSource = 'env' | 'git' | 'baked' | 'unknown';

export interface TermagVersion {
  sha: string | null;
  source: VersionSource;
}

const SHA = /^[0-9a-f]{40}$/i;
const REPO_ROOT = join(__dirname, '../..');
const BAKED_SHA_FILE = '/opt/termag/.termag-baked-sha';

export interface VersionDeps {
  env: NodeJS.ProcessEnv;
  gitHead: () => Promise<string>;
  readBaked: () => Promise<string>;
}

const defaultDeps: VersionDeps = {
  env: process.env,
  gitHead: async () => (await execFileAsync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { timeout: 5000 })).stdout,
  readBaked: () => readFile(BAKED_SHA_FILE, 'utf8'),
};

function sha(value: string | undefined): string | null {
  const v = value?.trim();
  return v && SHA.test(v) ? v.toLowerCase() : null;
}

export async function resolveTermagVersion(deps: VersionDeps = defaultDeps): Promise<TermagVersion> {
  const fromEnv = sha(deps.env.TERMAG_GIT_SHA);
  if (fromEnv) return { sha: fromEnv, source: 'env' };
  const fromGit = sha(await deps.gitHead().catch(() => undefined));
  if (fromGit) return { sha: fromGit, source: 'git' };
  const fromBake = sha(await deps.readBaked().catch(() => undefined));
  if (fromBake) return { sha: fromBake, source: 'baked' };
  return { sha: null, source: 'unknown' };
}

let resolved: Promise<TermagVersion> | null = null;

/** The running commit, resolved on first use and then fixed for the process. */
export function termagVersion(): Promise<TermagVersion> {
  resolved ??= resolveTermagVersion();
  return resolved;
}
