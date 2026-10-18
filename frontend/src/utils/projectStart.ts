import type { Instance } from '../types';
import { USABLE_BOX_STATUSES } from './usableBoxes';

// Helpers for the New project form (sidebar dialog and the last step of the
// /welcome wizard): which box it pre-selects, and the
// placeholder name for an empty project. The repo-name suggestion is
// utils/repoName.ts and the usable-status list utils/usableBoxes.ts, both
// shared with the phone's New project form.

export function boxIsUsableForProject(b: Pick<Instance, 'status'>): boolean {
  return USABLE_BOX_STATUSES.includes(b.status);
}

/**
 * What the form says about a chosen box it cannot use yet. A box whose launch
 * failed is launched again under its name ('try-again'; the server retires the
 * failed one), unless a project already waits on it: that project's Retry
 * relaunches it ('retry-project'). A stopped or parked one is started from the
 * sidebar.
 */
export function unusableBoxAdvice(
  b: Pick<Instance, 'kind' | 'status'>,
  waitingProjects = 0,
): 'try-again' | 'retry-project' | 'start-it' | null {
  if (b.status === 'failed') {
    if (b.kind !== 'ec2') return null;
    return waitingProjects > 0 ? 'retry-project' : 'try-again';
  }
  return boxIsUsableForProject(b) ? null : 'start-it';
}

/**
 * A project refused because its box failed to launch. The box line already
 * shows the launch error, so the form shows no second error for it.
 */
export function isBoxFailedRefusal(err: unknown): boolean {
  return (err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'box-failed';
}

/** The box the form pre-selects: a ready one first, else one on its way. */
export function pickDefaultBox<T extends Pick<Instance, 'status'>>(boxes: readonly T[]): T | null {
  return boxes.find(b => b.status === 'ready') ?? boxes.find(boxIsUsableForProject) ?? null;
}

// A placeholder name for an empty project, so the field is never blank and
// the suggestion is memorable rather than "project-7": real, friendly words.
const FUNNY_ADJECTIVES = [
  'fuzzy', 'sleepy', 'brave', 'jolly', 'snappy', 'quiet', 'zesty', 'clever', 'mellow', 'nimble',
  'plucky', 'breezy', 'cosmic', 'dapper', 'gentle', 'hasty', 'lucky', 'merry', 'peppy', 'rusty',
  'shiny', 'spicy', 'sunny', 'tidy', 'witty', 'wobbly', 'bouncy', 'crispy', 'dusty', 'frosty',
  'giddy', 'humble', 'jumpy', 'lanky', 'minty', 'nifty', 'perky', 'quirky', 'rowdy', 'swift',
];
const FUNNY_NOUNS = [
  'pants', 'otter', 'waffle', 'teapot', 'badger', 'pickle', 'kazoo', 'walrus', 'muffin', 'noodle',
  'pretzel', 'robot', 'sloth', 'tulip', 'umbrella', 'violin', 'wombat', 'yoyo', 'zeppelin', 'acorn',
  'biscuit', 'cactus', 'donut', 'ferret', 'gumboot', 'hammock', 'igloo', 'jellybean', 'kettle', 'lantern',
  'mitten', 'narwhal', 'pancake', 'quokka', 'raccoon', 'socks', 'toaster', 'unicycle', 'wagon', 'yeti',
];

/** "proj-fuzzy-pants": a random adjective + noun, valid as a project name. */
export function funnyProjectName(rng: () => number = Math.random): string {
  const pick = (list: readonly string[]) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  return `proj-${pick(FUNNY_ADJECTIVES)}-${pick(FUNNY_NOUNS)}`;
}
