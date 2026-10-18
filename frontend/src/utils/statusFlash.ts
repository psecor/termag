import type { AgentStatusValue } from '../types';

/**
 * Whether a project's status change earns the tile's 15 s transition flash.
 * A first status out of `not_running` is a launch, not news: a new project's
 * first `idle` would otherwise flash red, which reads as a failure.
 */
export function flashesTransition(prev: AgentStatusValue | undefined, next: AgentStatusValue): boolean {
  return prev !== undefined && prev !== 'not_running' && prev !== next;
}
