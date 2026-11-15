/**
 * EC2 for one box: the client for its region, and the one StartInstances of a
 * stopped box. boxPower's start, the environment pool's claim and its refresh
 * all start boxes here, so each gets the same-shape type fallback when EC2 has
 * no capacity for the box's type (boxStartFallback.ts).
 */
import { EC2Client, StartInstancesCommand } from '@aws-sdk/client-ec2';
import type { Instance } from '@prisma/client';
import { awsClientConfig, getBoxConfig } from './boxProvisioner';
import { startOnFallbackType } from './boxStartFallback';

/** An EC2 client for the box's region, else the configured one. Throws when box provisioning isn't configured. */
export function ec2For(box: Pick<Instance, 'region'>): EC2Client {
  const cfg = getBoxConfig();
  if (!cfg) throw new Error('Box provisioning is not configured');
  return new EC2Client(awsClientConfig(cfg, box.region ?? cfg.region));
}

/**
 * StartInstances for a stopped box. When EC2 refuses it for capacity, another type of the same shape is tried
 * (startOnFallbackType), and `fallbackType` says which one started it; `fallback: false` (a resize, which walks its
 * own types) rethrows at once. Throws what EC2 or the fallback threw.
 */
export async function startBox(ec2: EC2Client, box: Instance, opts: { fallback?: boolean } = {}): Promise<{ fallbackType: string | null }> {
  try {
    await ec2.send(new StartInstancesCommand({ InstanceIds: [box.ec2InstanceId!] }));
    return { fallbackType: null };
  } catch (err) {
    if (opts.fallback === false) throw err;
    return { fallbackType: await startOnFallbackType(ec2, box, err) };
  }
}
