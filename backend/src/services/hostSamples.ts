/**
 * Host pressure per box: the
 * agent samples disk, memory, load and kept runner checkouts on its hello
 * (agentRegistry writes that) and answers the `host-sample` RPC; this sweep
 * asks every connected box that announces the capability every five minutes
 * and writes the four columns on the box row. Cloud sessions are the heaviest
 * load a box carries, and the pilot box filled its root volume with session
 * checkouts before anyone saw it.
 */
import { prisma } from '../db';
import { connectedInstanceIds, instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { parseHostSample, type HostSample } from './agentHello';
import { timedSweep } from './spawnMetrics';

export const HOST_SAMPLE_CAPABILITY = 'host-sample-v1';
export const HOST_SAMPLE_EVERY_MS = 5 * 60 * 1000;

/**
 * The box-row columns for a sample: only the fields the agent could read.
 * A `df` that failed this once must not overwrite a 95%-full reading with
 * null and so drop a critical alert; the previous value stands until a
 * reading replaces it. Nothing at all readable, or no sample, writes nothing
 * and leaves the timestamp alone.
 */
export function hostSampleData(h: HostSample | null, now: Date = new Date()): { diskUsedPct?: number; memUsedPct?: number; load1?: number; keptCheckouts?: number; hostSampledAt?: Date } {
  if (!h) return {};
  const data: { diskUsedPct?: number; memUsedPct?: number; load1?: number; keptCheckouts?: number; hostSampledAt?: Date } = {};
  if (h.diskUsedPct !== null) data.diskUsedPct = h.diskUsedPct;
  if (h.memUsedPct !== null) data.memUsedPct = h.memUsedPct;
  if (h.load1 !== null) data.load1 = h.load1;
  if (h.keptCheckouts !== null) data.keptCheckouts = h.keptCheckouts;
  if (Object.keys(data).length === 0) return {};
  data.hostSampledAt = now;
  return data;
}

/** How long host_samples rows are kept. */
export const HOST_SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Agent-role tmux sessions in a tmux-list reply: what holds an agent CLI's memory on the box. */
export function countAgentSessions(reply: unknown): number | null {
  const sessions = (reply as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return null;
  return sessions.filter(s => typeof s === 'string' && s.endsWith('-agent')).length;
}

export async function sampleHosts(now: Date = new Date()): Promise<number> {
  let written = 0;
  await Promise.all(connectedInstanceIds().map(async instanceId => {
    const t = instanceAgentTransport(instanceId);
    if (!t || !t.capabilities.includes(HOST_SAMPLE_CAPABILITY)) return;
    try {
      const reply = await sendToInstanceAgent(instanceId, 'host-sample', {}, 5000);
      const sample = parseHostSample(reply);
      const data = hostSampleData(sample, now);
      if (Object.keys(data).length === 0) return;
      await prisma.instance.update({ where: { id: instanceId }, data });
      written++;
      await recordHistory(instanceId, sample, now);
    } catch (err) {
      console.warn(`[HOST-SAMPLE] instance ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
  await prisma.hostSample.deleteMany({ where: { at: { lt: new Date(now.getTime() - HOST_SAMPLE_RETENTION_MS) } } })
    .catch(err => console.warn('[HOST-SAMPLE] retention sweep failed:', err instanceof Error ? err.message : String(err)));
  return written;
}

/** One history row per sample, with the box's live agents. Best effort: the latest reading is already on the box row. */
async function recordHistory(instanceId: string, sample: HostSample | null, now: Date): Promise<void> {
  if (!sample) return;
  const [liveAgents, spawnedLive] = await Promise.all([
    sendToInstanceAgent(instanceId, 'tmux-list', {}, 5000).then(countAgentSessions).catch(() => null),
    prisma.agentSpawn.count({ where: { childInstanceId: instanceId, launchedAt: { not: null }, endedAt: null, parkedAt: null, state: { not: 'failed' } } }).catch(() => null),
  ]);
  await prisma.hostSample.create({
    data: {
      instanceId, at: now,
      diskUsedPct: sample.diskUsedPct, memUsedPct: sample.memUsedPct, load1: sample.load1,
      cores: sample.cores, memTotalMb: sample.memTotalMb, liveAgents, spawnedLive,
    },
  }).catch(err => console.warn(`[HOST-SAMPLE] history for ${instanceId}: ${err instanceof Error ? err.message : String(err)}`));
}

let timer: NodeJS.Timeout | null = null;
export function startHostSampling(everyMs = HOST_SAMPLE_EVERY_MS): void {
  if (timer) return;
  timer = setInterval(() => { timedSweep('sample', () => sampleHosts()).catch(err => console.error('[HOST-SAMPLE] sweep failed:', err instanceof Error ? err.message : String(err))); }, everyMs);
  timer.unref?.();
}
export function stopHostSampling(): void { if (timer) { clearInterval(timer); timer = null; } }
