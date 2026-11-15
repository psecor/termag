/**
 * An owner's box as a write's in-transaction re-check sees it: the fields
 * autoBoxPlan (services/claudeRunnerSpawn.ts) decides on. Shared by the cold
 * create (services/boxProvisioner.ts) and the warm claim
 * (services/warmPoolClaim.ts), which both ask the caller's `stillNeeded`
 * again inside their serializable transaction.
 */
export interface OwnedBoxRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  ec2InstanceId: string | null;
  lastConnectedAt: Date | null;
  createdAt: Date;
  /** `ask` for a box made for a `termag ask` (boxLifecycle.applyAskBoxPolicy): autoBoxPlan neither waits for nor starts one. */
  createdFor?: string | null;
}

export const OWNED_BOX_SELECT = {
  id: true, name: true, kind: true, status: true, ec2InstanceId: true, lastConnectedAt: true, createdAt: true, createdFor: true,
} as const;
