/**
 * The native port forward's telemetry: one log line
 * per open, close and refusal, and OpenTelemetry counters and histograms, the
 * way spawnMetrics.ts does them. Everything goes through the global API: with
 * no provider registered (services/otel.ts) the OTel calls are no-ops.
 *
 * Attributes are ids, enums, counts and durations: the user is
 * `context.contextKeys.user` (the user id), the box `termag.box`, the box port
 * `termag.forward.port`, a refusal or close code `termag.forward.code`. Never
 * a byte of what the forward carries.
 */
import { metrics, type Attributes, type Counter, type Histogram, type Meter } from '@opentelemetry/api';

const SCOPE = 'termag.forward';
const USER = 'context.contextKeys.user';
const BOX = 'termag.box';
const PORT = 'termag.forward.port';
const CODE = 'termag.forward.code';
const PROTOCOL = 'termag.forward.protocol';

interface Instruments {
  opens: Counter;
  refusals: Counter;
  closes: Counter;
  bytes: Counter;
  setup: Histogram;
  duration: Histogram;
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
    opens: meter.createCounter('termag.forward.opens', { description: 'Forward sockets upgraded, the box end dialed back' }),
    refusals: meter.createCounter('termag.forward.refusals', { description: 'Forward sockets and probes refused before the upgrade, by code' }),
    closes: meter.createCounter('termag.forward.closes', { description: 'Forward sockets closed, by the close code sent to the client' }),
    bytes: meter.createCounter('termag.forward.bytes', { unit: 'By', description: 'Bytes relayed, by direction: up (laptop to box) or down' }),
    setup: meter.createHistogram('termag.forward.setup', { ...seconds, description: 'From the upgrade request to the box end dialed back' }),
    duration: meter.createHistogram('termag.forward.duration', { ...seconds, description: 'From the upgrade to the close' }),
  };
  return instruments;
}

/** Test-only: forget instruments built against an earlier provider. */
export function resetForwardMetricsForTests(): void {
  instruments = null;
  meterFor = null;
}

function compact(a: Record<string, string | number | undefined>): Attributes {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Attributes;
}

const field = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? '-' : String(v));

export interface ForwardRefusal {
  /** Null before the bearer was judged. */
  userId: string | null;
  boxId: string;
  /** Null for the probe, or a port that didn't parse. */
  port: number | null;
  status: number;
  code: string;
  probe?: boolean;
}

/** A forward or probe refused before the upgrade. Never throws. */
export function recordForwardRefusal(r: ForwardRefusal): void {
  try {
    console.log(`[FORWARD] refused${r.probe ? ' probe' : ''} user=${field(r.userId)} box=${field(r.boxId)} port=${field(r.port)} status=${r.status} code=${r.code}`);
    inst().refusals.add(1, compact({ [USER]: r.userId ?? undefined, [BOX]: r.boxId, [PORT]: r.port ?? undefined, [CODE]: r.code, 'termag.forward.probe': r.probe ? 'true' : 'false' }));
  } catch { /* telemetry never breaks the relay */ }
}

export interface ForwardOpen {
  userId: string;
  boxId: string;
  port: number;
  setupMs: number;
  /** The subprotocol: `v1` opens are what keeps v1 alive. */
  protocol: 'v1' | 'v2';
}

/** A forward upgraded with its box end in place. Never throws. */
export function recordForwardOpen(o: ForwardOpen): void {
  try {
    console.log(`[FORWARD] open user=${o.userId} box=${o.boxId} port=${o.port} protocol=${o.protocol} setupMs=${Math.round(o.setupMs)}`);
    const i = inst();
    const who = compact({ [USER]: o.userId, [BOX]: o.boxId, [PORT]: o.port });
    i.opens.add(1, compact({ ...who, [PROTOCOL]: o.protocol }));
    i.setup.record(o.setupMs / 1000, compact({ [PORT]: o.port }));
  } catch { /* telemetry never breaks the relay */ }
}

export interface ForwardClose extends ForwardOpen {
  /** Laptop to box. */
  bytesIn: number;
  /** Box to laptop. */
  bytesOut: number;
  durationMs: number;
  /** The close code the client was sent (or closed with). */
  code: number;
}

/** A forward closed, both legs. Never throws. */
export function recordForwardClose(c: ForwardClose): void {
  try {
    console.log(`[FORWARD] close user=${c.userId} box=${c.boxId} port=${c.port} bytesIn=${c.bytesIn} bytesOut=${c.bytesOut} durationMs=${Math.round(c.durationMs)} code=${c.code}`);
    const i = inst();
    const who = compact({ [USER]: c.userId, [BOX]: c.boxId, [PORT]: c.port });
    i.closes.add(1, compact({ ...who, [CODE]: String(c.code) }));
    if (c.bytesIn > 0) i.bytes.add(c.bytesIn, compact({ ...who, 'termag.forward.direction': 'up' }));
    if (c.bytesOut > 0) i.bytes.add(c.bytesOut, compact({ ...who, 'termag.forward.direction': 'down' }));
    i.duration.record(c.durationMs / 1000, compact({ [CODE]: String(c.code) }));
  } catch { /* telemetry never breaks the relay */ }
}
