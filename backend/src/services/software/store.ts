/**
 * host_software / software_changes writes.
 */
import { prisma } from '../../db';

export interface Entry { name: string; ok: boolean; version: string | null; raw: string | null; path: string | null }
export type HostKind = 'orchestrator' | 'box' | 'agent';
export type Source = 'agent' | 'self' | 'image' | 'hello' | 'report';

const NAME_RE = /^[a-z0-9-]{1,40}$/;

/**
 * What an agent's reply may write: its own probes (agent/software-inventory.js
 * PROBES, kept in step by a test) plus the OS and kernel. termag, image and
 * hooks come from the orchestrator's own sources, never from a reply.
 */
export const AGENT_COMPONENTS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'cursor-agent', 'devin', 'pi', 'node', 'npm', 'gh', 'aws', 'tmux', 'git', 'docker', 'python', 'os', 'kernel',
]);
/** The orchestrator's own run adds its ORCHESTRATOR_PROBES. */
export const ORCHESTRATOR_COMPONENTS: ReadonlySet<string> = new Set([...AGENT_COMPONENTS, 'nginx', 'envoy', 'otelcol']);
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);

/** Validate an agent's `software-inventory` reply; null when it isn't one. */
export function parseInventoryReply(reply: unknown, allowed: ReadonlySet<string> = AGENT_COMPONENTS): { entries: Entry[]; agentCommit: string | null; checkoutCommit: string | null } | null {
  if (typeof reply !== 'object' || reply === null) return null;
  const r = reply as Record<string, unknown>;
  if (!Array.isArray(r.entries)) return null;
  const entries: Entry[] = [];
  for (const e of r.entries.slice(0, 60)) {
    const x = e as Record<string, unknown>;
    if (typeof x?.name !== 'string' || !NAME_RE.test(x.name) || !allowed.has(x.name)) continue;
    entries.push({ name: x.name, ok: x.ok === true, version: clip(x.version, 60), raw: clip(x.raw, 200), path: clip(x.path, 300) });
  }
  const sha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : null);
  return { entries, agentCommit: sha(r.agentCommit), checkoutCommit: sha(r.checkoutCommit) };
}

/**
 * Installed but unreadable this time (a probe timed out, or printed something
 * odd): `ok: false` with a path. The agent sets path null only when the binary
 * is absent, so this is not an uninstall.
 */
export const isTransient = (e: Entry) => !e.ok && !!e.path;

/**
 * Pure: the entries to write. A transient failure keeps the last good row
 * rather than overwriting it, so a flaky probe writes no fake uninstall and
 * reinstall into the history; with no row yet it is written (as unknown).
 */
export function entriesToWrite(prev: Map<string, string | null>, next: Entry[]): Entry[] {
  return next.filter(e => !(isTransient(e) && prev.has(e.name)));
}

/** Pure: which entries changed version against what is stored. A first sighting is a change from null. */
export function changedEntries(prev: Map<string, string | null>, next: Entry[]): Array<{ component: string; from: string | null; to: string | null }> {
  const out: Array<{ component: string; from: string | null; to: string | null }> = [];
  for (const e of next) {
    if (isTransient(e)) continue;
    const to = e.ok ? e.version : null;
    if (!prev.has(e.name)) { if (to !== null) out.push({ component: e.name, from: null, to }); continue; }
    const from = prev.get(e.name) ?? null;
    if (from !== to) out.push({ component: e.name, from, to });
  }
  return out;
}

export async function recordEntries(hostKey: string, hostKind: HostKind, source: Source, entries: Entry[], at = new Date()): Promise<number> {
  if (!entries.length) return 0;
  const existing = await prisma.hostSoftware.findMany({ where: { hostKey, component: { in: entries.map(e => e.name) } }, select: { component: true, version: true, ok: true } });
  const prev = new Map(existing.map(r => [r.component, r.ok ? r.version : null]));
  const write = entriesToWrite(prev, entries);
  const changes = changedEntries(prev, write);
  await prisma.$transaction([
    ...write.map(e => {
      const data = { hostKind, version: e.version, raw: e.raw, path: e.path, ok: e.ok, source, observedAt: at };
      return prisma.hostSoftware.upsert({ where: { hostKey_component: { hostKey, component: e.name } }, create: { hostKey, component: e.name, ...data }, update: data });
    }),
    ...(changes.length ? [prisma.softwareChange.createMany({ data: changes.map(c => ({ hostKey, component: c.component, from: c.from, to: c.to, at })) })] : []),
  ]);
  return changes.length;
}

export const RETENTION_DAYS = 180;
export async function pruneChanges(now = Date.now()): Promise<void> {
  await prisma.softwareChange.deleteMany({ where: { at: { lt: new Date(now - RETENTION_DAYS * 86_400_000) } } });
}
