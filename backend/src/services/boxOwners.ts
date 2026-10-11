/**
 * Which termag user owns each box, by unix username, in memory
 *. The worktime accumulator in
 * services/status.ts banks a runner session's working time under its box
 * owner, and that path is synchronous, so the answer has to be here already:
 * filled from Postgres at startup (before statuses are hydrated) and kept
 * current by the agent hello, which is when a box's owner is confirmed.
 */
import { prisma } from '../db';

const owners = new Map<string, string>();

export function rememberBoxOwner(instanceId: string, unixUsername: string): void {
  owners.set(instanceId, unixUsername);
}

export function forgetBoxOwner(instanceId: string): void {
  owners.delete(instanceId);
}

/** The owner's unix username, or null for an unknown or unclaimed box. */
export function boxOwnerUsername(instanceId: string | null | undefined): string | null {
  return instanceId ? owners.get(instanceId) ?? null : null;
}

/** Every owned box, from Postgres. Returns how many were loaded. */
export async function primeBoxOwners(): Promise<number> {
  const rows = await prisma.instance.findMany({ where: { userId: { not: null } }, select: { id: true, user: { select: { unixUsername: true } } } });
  for (const r of rows) if (r.user) owners.set(r.id, r.user.unixUsername);
  return rows.length;
}

/** Tests only. */
export function resetBoxOwners(): void { owners.clear(); }
