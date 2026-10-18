/**
 * Version arithmetic for the Software tab. Pure.
 *
 * Tools compare against the newest version anywhere in the fleet (decided
 * 2026-10-15). termag commits and images compare against their own targets:
 * the newest box image's commit for agents, the newest orchestrator image's
 * commit for the orchestrator, the running orchestrator for web clients.
 */

export type SoftwareState = 'current' | 'behind' | 'outdated' | 'ahead' | 'missing' | 'unknown';

/** Display order; anything else sorts after, by name. */
export const COMPONENT_ORDER = [
  'termag', 'termag-checkout', 'image', 'hooks',
  'claude', 'codex', 'cursor-agent', 'devin', 'pi',
  'node', 'npm', 'gh', 'aws', 'tmux', 'git', 'docker', 'python',
  'nginx', 'envoy', 'otelcol', 'postgres', 'os', 'kernel',
];
/** Components whose version is a termag commit sha. */
export const COMMIT_COMPONENTS = new Set(['termag', 'termag-checkout', 'image']);

/** Leading numeric segments: "2.1.300" → [2,1,300]; "2026.10.01-e373" → [2026,10,1]; "3.5a" → [3,5]. */
export function parseVersion(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const out: number[] = [];
  for (const seg of v.trim().replace(/^v/i, '').split(/[.\-+_ ]/)) {
    const m = /^(\d+)/.exec(seg);
    if (!m) break;
    out.push(Number(m[1]));
    if (m[1].length !== seg.length) break;
  }
  return out.length ? out : null;
}

/** Negative when a < b. Unparseable versions compare as equal to nothing: null. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a); const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest of a set of versions (the fleet reference); null when none parse. */
export function newestVersion(versions: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!v || !parseVersion(v)) continue;
    if (best === null || (compareVersions(v, best) ?? 0) > 0) best = v;
  }
  return best;
}

export interface Observed { version: string | null; ok: boolean; path?: string | null }

/**
 * A tool version against the fleet reference. Same major.minor is `behind`
 * (a patch or two), anything older `outdated`. Not installed is `missing`;
 * installed but unreadable, or never reported, is `unknown`.
 */
export function toolState(o: Observed | null, reference: string | null): SoftwareState {
  if (!o) return 'unknown';
  if (!o.ok) return o.path ? 'unknown' : 'missing';
  if (!o.version || !reference) return 'unknown';
  const c = compareVersions(o.version, reference);
  if (c === null) return 'unknown';
  if (c === 0) return 'current';
  if (c > 0) return 'ahead';
  const a = parseVersion(o.version)!; const r = parseVersion(reference)!;
  return a[0] === r[0] && (a[1] ?? 0) === (r[1] ?? 0) ? 'behind' : 'outdated';
}

/** A termag commit against its target. Commits only say equal or not. */
export function commitState(sha: string | null | undefined, target: string | null | undefined): SoftwareState {
  if (!sha) return 'unknown';
  if (!target) return 'unknown';
  return sha.toLowerCase().startsWith(target.toLowerCase().slice(0, 12)) || target.toLowerCase().startsWith(sha.toLowerCase().slice(0, 12)) ? 'current' : 'behind';
}

/** The Claude hooks step of the last box update ("… hooks=current"). */
export function hooksFromDetail(detail: string | null | undefined): string | null {
  const m = /\bhooks=([a-z-]+)/.exec(detail ?? '');
  return m ? m[1] : null;
}
export function hooksState(h: string | null): SoftwareState {
  if (!h) return 'unknown';
  if (h === 'current' || h === 'updated') return 'current';
  if (h === 'absent' || h === 'missing') return 'missing';
  if (h === 'skipped') return 'unknown';
  return 'outdated'; // would-update, failed
}

export type ClientKind = 'web' | 'mobile' | 'cli' | 'tui' | 'metaterm';
const SHA_RE = /^[0-9a-f]{7,40}$/;
const VER_RE = /^[0-9][0-9A-Za-z.+-]{0,30}$/;

/**
 * Which client sent a request, from the headers it sets:
 *   X-Termag-Client: web/<sha12> | mobile/<sha12>   (the web bundle)
 *   User-Agent: termag-cli/<v> | termag-tui/<v> | metaterm/<v>
 */
export function clientFromHeaders(xClient: string | undefined, userAgent: string | undefined): { kind: ClientKind; version: string } | null {
  const x = /^(web|mobile)\/([0-9a-f]{7,40}|unknown)$/.exec((xClient ?? '').trim());
  if (x) return { kind: x[1] as ClientKind, version: x[2] };
  const ua = /^(termag-cli|termag-tui|metaterm)\/(\S+)/.exec((userAgent ?? '').trim());
  if (ua && VER_RE.test(ua[2])) {
    const kind = ua[1] === 'termag-cli' ? 'cli' : ua[1] === 'termag-tui' ? 'tui' : 'metaterm';
    return { kind, version: ua[2] };
  }
  return null;
}
export const isSha = (v: string) => SHA_RE.test(v);

export function sortComponents(names: string[]): string[] {
  const rank = (n: string) => { const i = COMPONENT_ORDER.indexOf(n); return i < 0 ? COMPONENT_ORDER.length : i; };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export type HostKindName = 'orchestrator' | 'box' | 'agent';
/**
 * The termag commit a host should run. Boxes run a box image's checkout; the
 * orchestrator and its per-user agents run the orchestrator's. With no image
 * known (no AWS, an untagged image), the orchestrator's running commit.
 */
export function termagReference(kind: HostKindName, t: { boxImageCommit: string | null; orchestratorImageCommit: string | null; runningCommit: string | null }): string | null {
  return kind === 'box' ? t.boxImageCommit ?? t.runningCommit : t.orchestratorImageCommit ?? t.runningCommit;
}
