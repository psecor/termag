import { useEffect, useState } from 'react';
import { instancesApi } from '../services/api';
import type { BoxSizeOptions, SizePick } from '../utils/boxSize';
import type { BoxDiskOptions } from '../utils/boxDisk';

/** A repository typed into a URL field settles before its environment.json is asked about. */
const REPO_SETTLE_MS = 300;

/** The repositories a box is made for, as one or several, trimmed, empties dropped. */
export type BoxRepos = string | readonly (string | null | undefined)[] | null | undefined;
const reposOf = (repos: BoxRepos): string[] =>
  (typeof repos === 'string' || repos == null ? [repos] : [...repos]).map(r => r?.trim() ?? '').filter(Boolean);

/**
 * What the New box size picker and disk field offer (GET /api/instances/sizes), read while
 * `active`, for the repositories the box is made for (several for a
 * multi-repo project, whose box takes the largest of their sizes): the server answers what
 * such a box launches at (its .termag/environment.json, else the owner's default),
 * which the dropdown preselects. Read again when the repository changes; the
 * last answer stays until the new one comes. `sizes` is null until it
 * answers, on a failure and while box-default-size is off: no picker, and the
 * box gets the server's default. `disk` (utils/boxDisk.ts) is there whatever
 * the size flag says, null until it answers or from an orchestrator before it:
 * no field, and the box gets the server's disk.
 */
export function useBoxSizes(active: boolean, repoUrls?: BoxRepos, environment?: string | null): { sizes: BoxSizeOptions | null; disk: BoxDiskOptions | null } {
  const [options, setOptions] = useState<BoxSizeOptions | null>(null);
  // A string key, so the effect runs again only when the repositories do.
  // An environment is sized by its one file instead.
  const key = environment ? '' : reposOf(repoUrls).join('\n');
  const env = environment || null;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const repos = key ? key.split('\n') : [];
    const timer = setTimeout(() => {
      (env ? instancesApi.sizes(null, env) : instancesApi.sizes(repos.length > 1 ? repos : repos[0] ?? null)).then(o => { if (!cancelled) setOptions(o); }).catch(() => {});
    }, repos.length ? REPO_SETTLE_MS : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, key, env]);
  return { sizes: options?.enabled ? options : null, disk: options?.disk ?? null };
}

/**
 * The person's pick in a New box size dropdown, for the repositories it was
 * made with: a pick made for one is dropped when the repositories change, so the dropdown goes back to what the new one's
 * `.termag/environment.json` (or the owner's default) preselects, and the
 * form sends no stale preset that would override it.
 */
export function useBoxSizePick(repoUrls?: BoxRepos, environment?: string | null): [SizePick | null, (size: SizePick) => void] {
  return usePickFor<SizePick>(repoUrls, environment);
}

/**
 * What the person typed in a New box disk field, for the repositories it was
 * typed with, dropped as a size pick is, so the field goes back to the new
 * repository's diskGiB (or 120) and sends nothing stale. Null until they type.
 */
export function useBoxDiskPick(repoUrls?: BoxRepos, environment?: string | null): [string | null, (typed: string) => void] {
  return usePickFor<string>(repoUrls, environment);
}

/** `environment`: a pick made for an environment is its own, whatever its repositories. */
function usePickFor<T>(repoUrls?: BoxRepos, environment?: string | null): [T | null, (value: T) => void] {
  const repo = environment ? `environment:${environment}` : reposOf(repoUrls).join('\n') || null;
  const [pick, setPick] = useState<T | null>(null);
  // Derived state, reset while rendering (React's documented pattern): no stale pick is ever shown or sent.
  const [pickedFor, setPickedFor] = useState(repo);
  if (pickedFor !== repo) {
    setPickedFor(repo);
    setPick(null);
  }
  return [pickedFor === repo ? pick : null, setPick];
}
