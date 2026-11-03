/**
 * Starting a stopped box when EC2 has no capacity for its type: retype it to
 * another type of the same shape and start it again, the way a launch walks
 * its fallback types (boxProvisioner.runInstanceWithFallback). Behind
 * `box-start-type-fallback-enabled`, read for the owner and the box.
 *
 * A launch can also try another subnet; a box that exists can't, since its
 * root volume and network interface live in its zone. A hibernated box can't
 * be retyped at all (EC2 refuses to modify one), so only a stopped box walks.
 *
 * The candidates are the box's size's types (boxSize.ts), or BOX_INSTANCE_TYPE
 * and its fallbacks for a box with no size, narrowed to:
 *   - the same vCPU and memory as the type it has, so the box neither grows
 *     (and costs more) nor loses hibernation (its root holds a swap file the
 *     size of its RAM, boxResizePolicy.hibernationAfterResize);
 *   - a type the provisioner role may set (boxResizePolicy.resizeTypeAllowed,
 *     the `Ec2ResizeTaggedInstances` list in terraform).
 * When none of them starts either, the box goes back to the type it had and
 * the first refusal is what the caller sees.
 */
import { DescribeInstanceTypesCommand, EC2Client, ModifyInstanceAttributeCommand, StartInstancesCommand } from '@aws-sdk/client-ec2';
import type { Instance } from '@prisma/client';
import { prisma } from '../db';
import { POOL_FLAG_CONTEXT } from './boxHibernationFlag';
import { getBoxConfig, isCapacityRefusal } from './boxProvisioner';
import { hibernationAfterResize, resizeTypeAllowed } from './boxResizePolicy';
import { boxSizeSpec, isBoxSize } from './boxSize';
import { boolVariation, boolVariationForContext } from './featureFlags';

export const BOX_START_TYPE_FALLBACK_FLAG = 'box-start-type-fallback-enabled';

export interface TypeShape { vcpus: number; memoryMiB: number; hibernationSupported: boolean }

/** The types to try after `current` was refused, in order: same shape, settable, and still hibernating if the box does. */
export function startFallbackTypes(
  current: string,
  types: string[],
  shapes: Map<string, TypeShape>,
  hibernationConfigured: boolean,
): string[] {
  const from = shapes.get(current);
  if (!from) return [];
  return [...new Set(types)].filter(type => {
    const to = shapes.get(type);
    if (type === current || !to) return false;
    if (to.vcpus !== from.vcpus || to.memoryMiB !== from.memoryMiB) return false;
    if (!resizeTypeAllowed(type, to)) return false;
    return !hibernationConfigured || hibernationAfterResize(current, type, shapes) !== false;
  });
}

/** The box's size's types, else the configured BOX_INSTANCE_TYPE and its fallbacks. */
function configuredTypes(instance: Instance): string[] {
  if (isBoxSize(instance.size)) return boxSizeSpec(instance.size).types;
  const cfg = getBoxConfig();
  return cfg ? [cfg.instanceType, ...cfg.fallbackInstanceTypes] : [];
}

async function flagOn(instance: Instance): Promise<boolean> {
  const owner = instance.userId ? await prisma.user.findUnique({ where: { id: instance.userId } }) : null;
  if (!owner) return boolVariationForContext(BOX_START_TYPE_FALLBACK_FLAG, POOL_FLAG_CONTEXT, false);
  return boolVariation(BOX_START_TYPE_FALLBACK_FLAG, owner, false, { id: instance.id, name: instance.name, kind: instance.kind });
}

async function shapesOf(ec2: EC2Client, types: string[]): Promise<Map<string, TypeShape>> {
  const out = new Map<string, TypeShape>();
  const res = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: types as any }));
  for (const t of res.InstanceTypes ?? []) {
    if (t.InstanceType) {
      out.set(t.InstanceType, {
        vcpus: t.VCpuInfo?.DefaultVCpus ?? 0, memoryMiB: t.MemoryInfo?.SizeInMiB ?? 0, hibernationSupported: !!t.HibernationSupported,
      });
    }
  }
  return out;
}

/**
 * After StartInstances refused `instance` (a stopped box) with `refusal`:
 * start it on another type, or throw. Resolves to the type it started on.
 * Throws `refusal` when the flag is off, nothing qualifies, or every
 * candidate was refused too; any other error from EC2 ends the walk.
 */
export async function startOnFallbackType(ec2: EC2Client, instance: Instance, refusal: unknown): Promise<string> {
  if (instance.status !== 'stopped' || !isCapacityRefusal(refusal)) throw refusal;
  const current = instance.instanceType;
  if (!current || !await flagOn(instance)) throw refusal;
  const types = configuredTypes(instance);
  let shapes: Map<string, TypeShape>;
  try {
    shapes = await shapesOf(ec2, [...new Set([current, ...types])]);
  } catch (err) {
    console.warn(`[BOX] ${instance.name}: no capacity for ${current}, and DescribeInstanceTypes failed (${errMsg(err)}); not trying another type`);
    throw refusal;
  }
  const candidates = startFallbackTypes(current, types, shapes, instance.hibernationConfigured);
  if (candidates.length === 0) throw refusal;

  const InstanceId = instance.ec2InstanceId!;
  let retyped = current;
  const retype = async (type: string) => {
    await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId, InstanceType: { Value: type } }));
    retyped = type;
    await prisma.instance.update({ where: { id: instance.id }, data: { instanceType: type } });
  };
  let started = false;
  try {
    for (const type of candidates) {
      console.warn(`[BOX] ${instance.name}: no capacity for ${retyped} (${errMsg(refusal)}); retyping to ${type} and starting again`);
      await retype(type);
      try {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [InstanceId] }));
      } catch (err) {
        if (!isCapacityRefusal(err)) throw err;
        continue;
      }
      started = true;
      console.log(`[BOX] ${instance.name}: started on fallback ${type} (was ${current})`);
      return type;
    }
    throw refusal;
  } finally {
    if (!started && retyped !== current) {
      await retype(current).catch(err => console.error(`[BOX] ${instance.name}: putting ${current} back failed (left on ${retyped}):`, errMsg(err)));
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
