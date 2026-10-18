/**
 * Spawn and box telemetry as OpenTelemetry signals. Everything goes through the global API: with no provider registered
 * (services/otel.ts) every call here is a no-op.
 *
 * - Counters and histograms come from spawn events (services/spawnEvents.ts
 *   calls emitSpawnEvent for every row it writes), in whichever process
 *   handled the event.
 * - Each event is also a log record, `event.name = termag.spawn.<kind>`.
 * - Gauges read a snapshot that only the leader refreshes (the spawn sweep),
 *   so an overlapping deploy's draining process reports none and nothing is
 *   counted twice.
 *
 * Attributes are ids, enums, counts and durations. The user is
 * `termag.user.id` (the user id, as termag's agent telemetry carries
 * it), the box `termag.box`. Never a brief, a report, a prompt,
 * pane text or an email.
 */
import { metrics, type Attributes, type Counter, type Histogram, type Meter } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const SCOPE = 'termag.spawn';
const USER = 'termag.user.id';
const BOX = 'termag.box';

interface Instruments {
  requests: Counter;
  failures: Counter;
  launches: Counter;
  reports: Counter;
  nudges: Counter;
  ends: Counter;
  timeToReport: Histogram;
  nudgeDelay: Histogram;
  lifetime: Histogram;
  sweepDuration: Histogram;
  sweepErrors: Counter;
}

let instruments: Instruments | null = null;
let meterFor: Meter | null = null;

/** Built on first use, after initOtel has registered (or not) the provider. */
function inst(): Instruments {
  const meter = metrics.getMeter(SCOPE);
  if (instruments && meterFor === meter) return instruments;
  meterFor = meter;
  const seconds = { unit: 's' };
  instruments = {
    requests: meter.createCounter('termag.spawn.requests', { description: 'Spawn requests by outcome (created, refused) and refusal reason' }),
    failures: meter.createCounter('termag.spawn.failures', { description: 'Spawns that were created but whose workstream or project could not be made' }),
    launches: meter.createCounter('termag.spawn.launches', { description: 'Spawned agents started on their brief' }),
    reports: meter.createCounter('termag.spawn.reports', { description: 'report_back calls by status' }),
    nudges: meter.createCounter('termag.spawn.nudges', { description: 'Report notices typed into a parent pane' }),
    ends: meter.createCounter('termag.spawn.ends', { description: 'Spawned agents that went away, by how' }),
    timeToReport: meter.createHistogram('termag.spawn.time_to_report', { ...seconds, description: 'From spawn to its first report' }),
    nudgeDelay: meter.createHistogram('termag.spawn.nudge_delay', { ...seconds, description: 'From a report to the parent being told' }),
    lifetime: meter.createHistogram('termag.spawn.lifetime', { ...seconds, description: 'From spawn to end' }),
    sweepDuration: meter.createHistogram('termag.spawn.sweep.duration', { ...seconds, description: 'How long a spawn or host sweep took' }),
    sweepErrors: meter.createCounter('termag.spawn.sweep.errors', { description: 'Spawn or host sweeps that threw' }),
  };
  return instruments;
}

/** Test-only: forget instruments built against an earlier provider. */
export function resetSpawnMetricsForTests(): void {
  instruments = null;
  meterFor = null;
  gaugesRegistered = false;
  snapshot = null;
}

export interface SpawnSignal {
  kind: string;
  userId: string;
  spawnId?: string | null;
  rootSpawnId?: string | null;
  reason?: string | null;
  instanceId?: string | null;
  parentProjectId?: string | null;
  parentWorkstream?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function compact(a: Record<string, string | number | boolean | undefined>): Attributes {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Attributes;
}

/** One spawn event as counters, histograms and a log record. Never throws. */
export function emitSpawnEvent(e: SpawnSignal): void {
  try {
    const d = e.detail ?? {};
    const who = compact({ [USER]: e.userId, [BOX]: str(e.instanceId) });
    const agent = str(d.provider);
    const i = inst();
    switch (e.kind) {
      case 'created':
        i.requests.add(1, compact({ ...who, 'termag.spawn.outcome': 'created', 'termag.spawn.target': str(d.target), 'termag.agent': agent, 'termag.spawn.relationship': str(d.relationship) }));
        break;
      case 'refused':
        i.requests.add(1, compact({ ...who, 'termag.spawn.outcome': 'refused', 'termag.spawn.reason': str(e.reason) ?? 'unknown', 'termag.spawn.target': str(d.target) }));
        break;
      case 'failed':
        i.failures.add(1, compact({ ...who, 'termag.spawn.reason': str(e.reason) }));
        break;
      case 'launched':
        i.launches.add(1, compact({ ...who, 'termag.spawn.launch_path': str(e.reason) }));
        break;
      case 'reported': {
        i.reports.add(1, compact({ ...who, 'termag.spawn.report_status': str(e.reason), 'termag.agent': agent }));
        const s = num(d.secondsSinceCreated);
        if (s !== undefined && d.first === true) {
          i.timeToReport.record(s, compact({ 'termag.agent': agent, 'termag.spawn.relationship': str(d.relationship) }));
        }
        break;
      }
      case 'nudged': {
        i.nudges.add(1, compact({ [USER]: e.userId }));
        const s = num(d.secondsAfterReport);
        if (s !== undefined) i.nudgeDelay.record(s);
        break;
      }
      case 'ended': {
        i.ends.add(1, compact({ ...who, 'termag.spawn.end_how': str(e.reason) }));
        const s = num(d.lifetimeSeconds);
        if (s !== undefined) i.lifetime.record(s, compact({ 'termag.spawn.end_how': str(e.reason) }));
        break;
      }
      default:
        break;
    }
    logs.getLogger(SCOPE).emit({
      eventName: `termag.spawn.${e.kind}`,
      severityNumber: e.kind === 'refused' || e.kind === 'failed' ? SeverityNumber.WARN : SeverityNumber.INFO,
      body: `spawn ${e.kind}${e.reason ? ` (${e.reason})` : ''}`,
      attributes: compact({
        ...who,
        'event.name': `termag.spawn.${e.kind}`,
        'termag.spawn.id': str(e.spawnId),
        'termag.spawn.root_id': str(e.rootSpawnId),
        'termag.spawn.reason': str(e.reason),
        'termag.parent.project_id': str(e.parentProjectId),
        'termag.parent.workstream': str(e.parentWorkstream),
        ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null).map(([k, v]) => [`termag.spawn.${k}`, v as string | number | boolean])),
      }),
    });
  } catch (err) {
    console.warn('[OTEL] spawn signal dropped:', (err as Error).message);
  }
}

/** Time a sweep and count its failures; rethrows so callers keep their own logging. */
export async function timedSweep<T>(sweep: 'nudge' | 'end' | 'sample' | 'gauges', fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } catch (err) {
    try { inst().sweepErrors.add(1, { 'termag.sweep': sweep }); } catch { /* telemetry never breaks a sweep */ }
    throw err;
  } finally {
    try { inst().sweepDuration.record((performance.now() - start) / 1000, { 'termag.sweep': sweep }); } catch { /* as above */ }
  }
}

// ---- gauges -------------------------------------------------------------

export interface GaugeSnapshot {
  /** Spawned agents that have not ended, per user and box. */
  running: Array<{ userId: string; instanceId: string | null; value: number }>;
  /** Of those, reported done and idle past the hint threshold, per user. */
  finishedRunning: Array<{ userId: string; value: number }>;
  /** Per user and per-user limit (hour, running): used / limit, and the limit. */
  limits: Array<{ userId: string; limit: 'hour' | 'running'; used: number; value: number }>;
  boxes: Array<{
    instanceId: string; ownerId: string | null;
    memoryUtilization: number | null; diskUtilization: number | null; loadPerCore: number | null;
    liveAgents: number | null; capacity: number | null; hot: boolean;
  }>;
}

let snapshot: GaugeSnapshot | null = null;
let gaugesRegistered = false;

/** The leader's latest snapshot; null stops every gauge from reporting (a draining process). */
export function setGaugeSnapshot(s: GaugeSnapshot | null): void {
  snapshot = s;
}

/** The observable gauges, once, after initOtel. Their callbacks only read the snapshot. */
export function registerSpawnGauges(): void {
  if (gaugesRegistered) return;
  gaugesRegistered = true;
  const meter = metrics.getMeter(SCOPE);
  const ratio = { unit: '1' };
  const gauge = (name: string, description: string, unit: string | undefined, read: (s: GaugeSnapshot) => Array<[number, Attributes]>) => {
    meter.createObservableGauge(name, { description, ...(unit ? { unit } : {}) }).addCallback(result => {
      if (!snapshot) return;
      for (const [value, attrs] of read(snapshot)) result.observe(value, attrs);
    });
  };
  const boxAttrs = (b: GaugeSnapshot['boxes'][number]): Attributes => compact({ [BOX]: b.instanceId, [USER]: b.ownerId ?? undefined });
  gauge('termag.spawn.running', 'Spawned agents that have not ended', undefined,
    s => s.running.map(r => [r.value, compact({ [USER]: r.userId, [BOX]: r.instanceId ?? undefined })]));
  gauge('termag.spawn.finished_running', 'Spawned agents done and idle but still running', undefined,
    s => s.finishedRunning.map(r => [r.value, { [USER]: r.userId }]));
  gauge('termag.spawn.limit.utilization', 'Used / limit for a per-user spawn limit', ratio.unit,
    s => s.limits.filter(l => l.value > 0).map(l => [l.used / l.value, { [USER]: l.userId, 'termag.spawn.limit': l.limit }]));
  gauge('termag.spawn.limit.value', 'The per-user spawn limit the flag serves', undefined,
    s => s.limits.map(l => [l.value, { [USER]: l.userId, 'termag.spawn.limit': l.limit }]));
  gauge('termag.box.memory.utilization', 'Box memory in use', ratio.unit,
    s => s.boxes.filter(b => b.memoryUtilization !== null).map(b => [b.memoryUtilization!, boxAttrs(b)]));
  gauge('termag.box.disk.utilization', 'Box disk in use under the home', ratio.unit,
    s => s.boxes.filter(b => b.diskUtilization !== null).map(b => [b.diskUtilization!, boxAttrs(b)]));
  gauge('termag.box.load.per_core', 'One-minute load per core', undefined,
    s => s.boxes.filter(b => b.loadPerCore !== null).map(b => [b.loadPerCore!, boxAttrs(b)]));
  gauge('termag.box.agents.live', 'Agent panes alive on the box', undefined,
    s => s.boxes.filter(b => b.liveAgents !== null).map(b => [b.liveAgents!, boxAttrs(b)]));
  gauge('termag.box.agents.capacity', 'The box agent capacity the flag serves (absent when there is no cap)', undefined,
    s => s.boxes.filter(b => b.capacity !== null).map(b => [b.capacity!, boxAttrs(b)]));
  gauge('termag.box.hot', '1 while the box refuses spawns as running hot', undefined,
    s => s.boxes.map(b => [b.hot ? 1 : 0, boxAttrs(b)]));
}
