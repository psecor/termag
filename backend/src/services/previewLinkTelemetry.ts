/**
 * Preview links' telemetry:
 * the audit line for every grant and denial (O3), the product events, and the
 * relay's metrics in services/forwardMetrics.ts's shape. Everything goes
 * through the global OTel API, a no-op with no provider (services/otel.ts).
 *
 * Never a token, a code, a cookie, a request body or a query string (SR21):
 * the audit line has the viewer's email, the link's id and name, the box, the
 * decision and its reason; a path is logged without its query.
 */
import { metrics, type Attributes, type Counter, type Histogram, type Meter, type UpDownCounter } from '@opentelemetry/api';
import { recordProductEvent } from './productEvents';

const SCOPE = 'termag.preview';
const KIND = { 'termag.kind': 'preview' } as const;

export type AuditStep = 'landing' | 'exchange' | 'session' | 'reverify' | 'upgrade' | 'admin';

export interface AuditLine {
  step: AuditStep;
  /** `end`: an admin ended the link; `viewer` is then the admin. */
  decision: 'grant' | 'deny' | 'end';
  /** The basis on a grant; the refusal's reason on a denial. */
  reason: string;
  viewer: string | null;
  linkId: string | null;
  name: string;
  boxId: string | null;
}

const field = (v: string | null | undefined): string => (v === null || v === undefined || v === '' ? '-' : v.replace(/\s+/g, '_'));

/** The audit log line, one per grant and denial (O3). */
export function auditLine(a: AuditLine): string {
  return `[PREVIEW-LINK] audit step=${a.step} decision=${a.decision} reason=${field(a.reason)} viewer=${field(a.viewer)} link=${field(a.linkId)} name=${field(a.name)} box=${field(a.boxId)}`;
}

export function audit(a: AuditLine): void {
  console.log(auditLine(a));
}

// ── Product events ────────────────────────────────────────────────────────

export function linkPublished(userId: string, boxId: string | null, detail: { audience: string; renewed: boolean; ttlHours: number; hostMode: string }): void {
  recordProductEvent('preview_link.published', { user: userId, box: boxId }, detail);
}

export function linkOpened(userId: string, boxId: string | null, detail: { basis: string; firstOpen: boolean; audience: string }): void {
  recordProductEvent('preview_link.opened', { user: userId, box: boxId }, detail);
}

export function linkRefused(userId: string | null, boxId: string | null, detail: { reason: string; step: AuditStep }): void {
  recordProductEvent('preview_link.refused', { user: userId, box: boxId }, detail);
}

export function linkRevoked(userId: string, boxId: string | null, detail: { sessions: number }): void {
  recordProductEvent('preview_link.revoked', { user: userId, box: boxId }, detail);
}

export function linkEnded(ownerId: string, boxId: string | null, detail: { reason: string; sessions?: number }): void {
  recordProductEvent('preview_link.ended', { user: ownerId, box: boxId }, detail);
}

export function viewerRemoved(userId: string, boxId: string | null, detail: { sessions: number }): void {
  recordProductEvent('preview_link.viewer_removed', { user: userId, box: boxId }, detail);
}

// ── Metrics ───────────────────────────────────────────────────────────────

interface Instruments {
  tunnelOpen: Histogram;
  tunnelsOpen: UpDownCounter;
  bytes: Counter;
  refusals: Counter;
  requests: Counter;
}

let instruments: Instruments | null = null;
let meterFor: Meter | null = null;
let liveLinks = 0;
let liveGaugeFor: Meter | null = null;

function inst(): Instruments {
  const meter = metrics.getMeter(SCOPE);
  if (instruments && meterFor === meter) return instruments;
  meterFor = meter;
  instruments = {
    tunnelOpen: meter.createHistogram('termag.preview.tunnel_open_ms', { unit: 'ms', description: 'From asking the box for a preview tunnel to its dial-back' }),
    tunnelsOpen: meter.createUpDownCounter('termag.preview.tunnels_open', { description: 'Preview tunnels this process carries now' }),
    bytes: meter.createCounter('termag.preview.bytes_relayed', { unit: 'By', description: 'Bytes relayed, by direction: up (viewer to app) or down' }),
    refusals: meter.createCounter('termag.preview.refusals', { description: 'Preview requests and sockets refused, by code' }),
    requests: meter.createCounter('termag.preview.requests', { description: 'Preview HTTP requests answered, by status class' }),
  };
  if (liveGaugeFor !== meter) {
    liveGaugeFor = meter;
    meter.createObservableGauge('termag.preview.live_links', { description: 'Live preview links, as of the last sweep' })
      .addCallback(r => r.observe(liveLinks, KIND));
  }
  return instruments;
}

/** Test-only: forget instruments built against an earlier provider. */
export function resetPreviewMetricsForTests(): void {
  instruments = null;
  meterFor = null;
  liveGaugeFor = null;
}

function safely(fn: () => void): void {
  try { fn(); } catch { /* telemetry never breaks the relay */ }
}

const attrs = (a: Record<string, string | number | undefined>): Attributes => ({
  ...KIND, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)),
});

export function tunnelOpened(boxId: string, ms: number): void {
  safely(() => {
    const i = inst();
    i.tunnelOpen.record(ms, attrs({ 'termag.box': boxId }));
    i.tunnelsOpen.add(1, attrs({}));
  });
}

export function tunnelClosed(): void {
  safely(() => inst().tunnelsOpen.add(-1, attrs({})));
}

export function bytesRelayed(direction: 'up' | 'down', n: number): void {
  if (n > 0) safely(() => inst().bytes.add(n, attrs({ 'termag.direction': direction })));
}

export function refused(code: string): void {
  safely(() => inst().refusals.add(1, attrs({ 'termag.code': code })));
}

export function answered(status: number): void {
  safely(() => inst().requests.add(1, attrs({ 'termag.status_class': `${Math.floor(status / 100)}xx` })));
}

/** The sweep's count of live links, for the gauge. */
export function setLiveLinks(n: number): void {
  liveLinks = n;
  safely(() => inst());
}
