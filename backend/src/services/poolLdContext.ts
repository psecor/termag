import type { FlagContext } from './featureFlags';

/**
 * The warm pool's flag context: a box kind, so user targets and user
 * rules never reach it, and every replica evaluates the pool's flags alike.
 */
export const POOL_FLAG_CONTEXT: FlagContext = { kind: 'box', key: 'termag-warm-pool', name: 'warm pool', instanceKind: 'ec2' };
