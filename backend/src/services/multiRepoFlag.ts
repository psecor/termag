/**
 * Whether a user may create a multi-repo project: the boolean flag
 * `multi-repo-projects-enabled`, off by default and whenever flags are.
 *
 *
 * Off, `POST /api/projects` refuses `repos`. A multi-repo project that already
 * exists keeps its sessions, clones and workstreams whatever the flag says, so
 * turning it off never strands one.
 */
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { MULTI_REPO_FLAG } from './projectRepos';

/** The `code` a refused request carries, for clients to tell it from other refusals. */
export const MULTI_REPO_DISABLED_CODE = 'multi_repo_disabled';

export async function multiRepoEnabled(user: FlagUser): Promise<boolean> {
  return boolVariation(MULTI_REPO_FLAG, user, false);
}
