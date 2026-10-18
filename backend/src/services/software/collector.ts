/**
 * Collects the software inventory. Leader-only,
 * started beside the other sweeps.
 *
 * Every 10 minutes:
 *   - each connected agent's running termag commit (from its hello);
 *   - each box's image (its TermagSha tag) and Claude hooks state (from the
 *     last box-update report);
 *   - the `software-inventory` RPC to agents with the capability whose last
 *     inventory is older than 6 hours (or that never sent one), which covers
 *     "at start": a new connection is asked within 10 minutes.
 * Every 6 hours, and a minute after start: the orchestrator's own inventory
 * (the agent's probe script run locally with --orchestrator), its termag
 * commit, database version and image.
 */
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DescribeImagesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { prisma } from '../../db';
import { inventoryHosts, sendToAgent, sendToInstanceAgent } from '../agentRegistry';
import { amiTermagSha, awsClientConfig, getBoxConfig } from '../boxProvisioner';
import { termagVersion } from '../termagVersion';
import { hooksFromDetail } from './versions';
import { parseInventoryReply, recordEntries, pruneChanges, ORCHESTRATOR_COMPONENTS, type Entry } from './store';
import { singleFlight } from './runner';

const execFileAsync = promisify(execFile);
export const INVENTORY_CAPABILITY = 'software-inventory-v1';
const SWEEP_MS = 10 * 60_000;
export const INVENTORY_EVERY_MS = 6 * 3600_000;
const ORCHESTRATOR = 'orchestrator';

const lastInventory = new Map<string, number>();
let lastSelfAt: number | null = null;
/** Set by refreshInventories: the next sweep asks every capable agent, whatever its last inventory. */
let forceNext = false;
const status = { lastSweepAt: null as string | null, lastSelfAt: null as string | null, lastError: null as string | null };
export function collectorStatus() { return { ...status }; }

const entry = (name: string, version: string | null, raw: string | null = version, p: string | null = null): Entry => ({ name, ok: version !== null, version, raw, path: p });

// ── image tags ─────────────────────────────────────────────────────────────
type ImageSha = { sha: string | null; created: string | null };
const tagCache = new Map<string, ImageSha & { at: number }>();

/** EC2's answer for an image id that no longer exists or never did. */
export function isMissingImageError(err: unknown): boolean {
  const name = (err as { name?: string; Code?: string } | null)?.name ?? (err as { Code?: string } | null)?.Code ?? '';
  return /^InvalidAMIID\.(NotFound|Malformed|Unavailable)$/.test(name);
}

/**
 * Look up images in batches, and when a batch fails (EC2 fails the whole
 * DescribeImages call when any one id was deregistered: InvalidAMIID.NotFound)
 * retry its ids one by one, so a single stale box image doesn't blank the
 * rest. Only an id EC2 says is missing comes back as unknown (sha null); any
 * other failure (throttling, a network blip) leaves the id out, so the caller
 * neither caches nor records it this time.
 */
export async function lookupImages(ids: string[], describe: (ids: string[]) => Promise<Array<{ ImageId?: string; CreationDate?: string; Tags?: { Key?: string; Value?: string }[] }>>): Promise<Map<string, ImageSha>> {
  const out = new Map<string, ImageSha>();
  const take = (imgs: Awaited<ReturnType<typeof describe>>) => {
    for (const img of imgs) if (img.ImageId) out.set(img.ImageId, { sha: amiTermagSha(img), created: img.CreationDate ?? null });
  };
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try { take(await describe(batch)); continue; } catch { /* one bad id fails the batch: go one by one */ }
    for (const id of batch) {
      try { take(await describe([id])); } catch (err) { if (isMissingImageError(err)) out.set(id, { sha: null, created: null }); }
    }
  }
  return out;
}

async function imageShas(ids: string[]): Promise<Map<string, ImageSha>> {
  const out = new Map<string, ImageSha>();
  const now = Date.now();
  const missing = ids.filter(id => { const c = tagCache.get(id); if (c && now - c.at < 3600_000) { out.set(id, c); return false; } return true; });
  const cfg = getBoxConfig();
  if (missing.length && cfg) {
    const ec2 = new EC2Client(awsClientConfig(cfg));
    try {
      const found = await lookupImages(missing, async batch => (await ec2.send(new DescribeImagesCommand({ ImageIds: batch }))).Images ?? []);
      for (const [id, v] of found) { tagCache.set(id, { ...v, at: now }); out.set(id, v); }
    } catch (err) {
      console.warn('[SOFTWARE] DescribeImages failed:', err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

// ── boxes and agents ───────────────────────────────────────────────────────
async function recordBoxFacts(): Promise<void> {
  const boxes = await prisma.instance.findMany({ where: { status: { not: 'terminated' } }, select: { id: true, imageId: true, lastUpdateDetail: true, lastUpdateAt: true } });
  const shas = await imageShas([...new Set(boxes.map(b => b.imageId).filter((x): x is string => !!x))]);
  for (const b of boxes) {
    const entries: Entry[] = [];
    // An image whose lookup did not answer this time (not cached, EC2 erred) is
    // left as it was rather than recorded as unknown.
    if (b.imageId && shas.has(b.imageId)) entries.push(entry('image', shas.get(b.imageId)!.sha, b.imageId));
    const hooks = hooksFromDetail(b.lastUpdateDetail);
    if (hooks) entries.push(entry('hooks', hooks));
    if (entries.length) await recordEntries(b.id, 'box', entries[0].name === 'image' ? 'image' : 'report', entries);
  }
}

async function inventoryOf(h: ReturnType<typeof inventoryHosts>[number]): Promise<void> {
  const reply = h.instanceId
    ? await sendToInstanceAgent(h.instanceId, 'software-inventory', {}, 60_000)
    : await sendToAgent(h.userId!, 'software-inventory', {}, 60_000);
  const parsed = parseInventoryReply(reply);
  if (!parsed) throw new Error('not an inventory reply');
  const extra = parsed.checkoutCommit ? [entry('termag-checkout', parsed.checkoutCommit)] : [];
  await recordEntries(h.hostKey, h.hostKind, 'agent', [...parsed.entries, ...extra]);
}

async function lastAgentInventory(hostKey: string): Promise<number> {
  const cached = lastInventory.get(hostKey);
  if (cached !== undefined) return cached;
  const row = await prisma.hostSoftware.findFirst({ where: { hostKey, source: 'agent' }, orderBy: { observedAt: 'desc' }, select: { observedAt: true } });
  const at = row?.observedAt.getTime() ?? 0;
  lastInventory.set(hostKey, at);
  return at;
}

export async function sweep(now = Date.now()): Promise<void> {
  status.lastSweepAt = new Date(now).toISOString();
  const force = forceNext;
  forceNext = false;
  const hosts = inventoryHosts();
  for (const h of hosts) {
    if (h.agentCommit) await recordEntries(h.hostKey, h.hostKind, 'hello', [entry('termag', h.agentCommit, h.agentCommitAt?.toISOString() ?? null)]);
  }
  await recordBoxFacts();
  await Promise.all(hosts.filter(h => h.capabilities.includes(INVENTORY_CAPABILITY)).map(async h => {
    if (!force && now - await lastAgentInventory(h.hostKey) < INVENTORY_EVERY_MS) return;
    lastInventory.set(h.hostKey, now); // one attempt per window, even on failure
    try { await inventoryOf(h); } catch (err) {
      console.warn(`[SOFTWARE] inventory of ${h.hostKey} failed:`, err instanceof Error ? err.message : String(err));
    }
  }));
}

// ── the orchestrator itself ────────────────────────────────────────────────
/** agent/software-inventory.js from this checkout: backend/{src,dist}/services/software → repo root. */
const PROBE_SCRIPT = path.resolve(__dirname, '../../../../agent/software-inventory.js');

async function imdsAmiId(): Promise<string | null> {
  try {
    const token = await (await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(1000) })).text();
    const res = await fetch('http://169.254.169.254/latest/meta-data/ami-id', { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1000) });
    const id = (await res.text()).trim();
    return res.ok && /^ami-[0-9a-f]+$/.test(id) ? id : null;
  } catch { return null; }
}

export async function selfInventory(): Promise<void> {
  const entries: Entry[] = [];
  try {
    const { stdout } = await execFileAsync(process.execPath, [PROBE_SCRIPT, '--json', '--orchestrator'], { timeout: 180_000, maxBuffer: 512 * 1024 });
    const parsed = parseInventoryReply(JSON.parse(stdout), ORCHESTRATOR_COMPONENTS);
    if (parsed) entries.push(...parsed.entries);
  } catch (err) {
    console.warn('[SOFTWARE] orchestrator probes failed:', err instanceof Error ? err.message : String(err));
  }
  const v = await termagVersion();
  entries.push(entry('termag', v.sha, `${v.sha ?? 'unknown'} (${v.source})`));
  try {
    const rows = await prisma.$queryRaw<Array<{ v: string }>>`SELECT current_setting('server_version') AS v`;
    entries.push(entry('postgres', rows[0]?.v?.split(' ')[0] ?? null, rows[0]?.v ?? null));
  } catch { /* the database answers every other query; a missing version is not worth failing for */ }
  const ami = await imdsAmiId();
  if (ami) { const s = (await imageShas([ami])).get(ami); if (s) entries.push(entry('image', s.sha, ami)); }
  await recordEntries(ORCHESTRATOR, 'orchestrator', 'self', entries);
  await pruneChanges();
  lastSelfAt = Date.now();
  status.lastSelfAt = new Date(lastSelfAt).toISOString();
}

// ── lifecycle ──────────────────────────────────────────────────────────────
let timer: NodeJS.Timeout | null = null;

const runner = singleFlight(async () => {
  if (lastSelfAt === null || Date.now() - lastSelfAt > INVENTORY_EVERY_MS) await selfInventory();
  await sweep();
  status.lastError = null;
}, err => {
  status.lastError = err instanceof Error ? err.message : String(err);
  console.error('[SOFTWARE] sweep failed:', status.lastError);
});
const tick = () => runner.run();

/**
 * Ask for inventories now (the admin's "refresh"): forces the next sweep past
 * the 6-hour gate. During a sweep it runs right after that one (singleFlight).
 */
export function refreshInventories(): void { forceNext = true; lastSelfAt = null; tick(); }

export function startSoftwareCollector(): void {
  if (timer) return;
  timer = setInterval(tick, SWEEP_MS);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
export async function stopSoftwareCollector(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  await runner.idle();
}
