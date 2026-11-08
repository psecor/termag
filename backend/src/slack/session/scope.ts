/**
 * What a Slack agent thread is bound to.
 * Every thread is `personal` today, an operator's own conversation run by the
 * executor; `space` and `router` threads come with space channels and the
 * router. Saved on `slack_agent_threads` (agentStore.ts) with the session.
 */

export type ThreadScope = 'personal' | 'space' | 'router';

const SCOPES: readonly ThreadScope[] = ['personal', 'space', 'router'];

export type ThreadBinding = {
  scope: ThreadScope;
  /** The space the thread is bound to now; null for a personal thread. */
  spaceId: string | null;
  /** Bumped each time the thread is routed again, so a stale route loses. */
  routeSeq: number;
  /** Set on a thread that was in a channel when it was linked or unlinked: it takes no more turns. */
  frozenAt: Date | null;
};

export const PERSONAL_BINDING: Readonly<ThreadBinding> = Object.freeze({ scope: 'personal', spaceId: null, routeSeq: 0, frozenAt: null });

/** A stored scope string as a ThreadScope: anything unknown is `personal`, the scope with the least reach. */
export function parseThreadScope(value: unknown): ThreadScope {
  return SCOPES.includes(value as ThreadScope) ? (value as ThreadScope) : 'personal';
}

export function isPersonalBinding(b: ThreadBinding): boolean {
  return b.scope === 'personal' && b.spaceId === null && b.routeSeq === 0 && b.frozenAt === null;
}
