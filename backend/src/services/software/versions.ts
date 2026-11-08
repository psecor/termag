/**
 * Version arithmetic for the Software tab. Pure.
 *
 * Tools compare against the newest version anywhere in the fleet (decided
 * 2026-10-15). termag commits and images compare against their own targets:
 * the newest box image's commit for agents, the newest orchestrator image's
 * commit for the orchestrator, the running orchestrator for web clients.
 * Kernels compare within their track and host kind (kernelTrack, below), and
 * `reboot` is the one component whose bad state is `pending`.
 */

export type SoftwareState = 'current' | 'behind' | 'outdated' | 'ahead' | 'pending' | 'missing' | 'unknown';
/** What "needs updating" counts, as the tab's NEEDS_UPDATE does: a pending reboot is an update not yet running. */
export const NEEDS_UPDATE_STATES: ReadonlySet<SoftwareState> = new Set<SoftwareState>(['behind', 'outdated', 'pending']);
/** Every state, in the order the tab counts them. */
export const SOFTWARE_STATES: readonly SoftwareState[] = ['current', 'behind', 'outdated', 'ahead', 'pending', 'missing', 'unknown'];

/** Display order; anything else sorts after, by name. */
export const COMPONENT_ORDER = [
  'termag', 'termag-checkout', 'image', 'hooks',
  'claude', 'codex', 'cursor-agent', 'devin', 'pi',
  'node', 'npm', 'gh', 'aws', 'tmux', 'git', 'docker', 'python',
  'nginx', 'envoy', 'otelcol', 'postgres', 'os', 'kernel', 'kernel-installed', 'reboot',
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

/**
 * Whether a client version is a clean build: the CLI's and TUI's come from git
 * (cli/buildVersion.mjs) as `0.1.158+30755492`, with `.dirty` for local
 * changes and `+unknown` without the history. A version with no build
 * metadata (metaterm's, a CLI from before) counts as clean.
 */
export function isCleanBuild(version: string): boolean {
  const i = version.indexOf('+');
  if (i < 0) return true;
  const meta = version.slice(i + 1);
  return meta !== 'unknown' && !meta.endsWith('.dirty');
}

/**
 * A client version without its build metadata, for ordering: as in semver,
 * what follows `+` never orders builds. parseVersion would otherwise read on
 * into a sha that starts with digits (`0.1.158+1a2b3c4d` as 0.1.158.1).
 */
const withoutBuild = (version: string) => version.split('+')[0];

/** The fleet reference for a client kind: the newest clean build, else the newest of any; the first seen wins a tie. */
export function clientReference(versions: string[]): string | null {
  const newest = (vs: string[]) => {
    let best: string | null = null;
    for (const v of vs) {
      if (!parseVersion(withoutBuild(v))) continue;
      if (best === null || (compareVersions(withoutBuild(v), withoutBuild(best)) ?? 0) > 0) best = v;
    }
    return best;
  };
  return newest(versions.filter(isCleanBuild)) ?? newest(versions);
}

/**
 * A client version against its fleet reference: toolState's grading of the
 * numbers before `+`, except that a build with the reference's number and
 * different build metadata can't be ordered against it (`0.1.158+aaaaaaaa`
 * on a branch and `0.1.158+bbbbbbbb` on main, or the reference with `.dirty`
 * local changes), so it is `unknown`, not `current`.
 */
export function clientState(version: string, reference: string | null): SoftwareState {
  const s = toolState({ version: withoutBuild(version), ok: true }, reference === null ? null : withoutBuild(reference));
  return s === 'current' && version !== reference ? 'unknown' : s;
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

/** The components a kernel reference covers: the running kernel and the newest installed one. */
export const KERNEL_COMPONENTS = new Set(['kernel', 'kernel-installed']);

/**
 * A kernel's track: major.minor and flavour of its release, `6.8.0-1067-aws` → `6.8-aws`,
 * `7.0.0-1014-aws` → `7.0-aws`, `6.8.0-147-generic` → `6.8-generic`. Box images pin 6.8 (the GA
 * kernel, for hibernation) while the orchestrator's runs the rolling 7.x, so a 6.8 box on the newest
 * 6.8 build is current, not "outdated" against 7.0. Null for anything that isn't a kernel release.
 */
export function kernelTrack(release: string | null | undefined): string | null {
  const m = /^(\d+)\.(\d+)\.\d+-\d+(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/.exec((release ?? '').trim());
  return m ? `${m[1]}.${m[2]}-${m[3] ?? 'generic'}` : null;
}

/**
 * Which kernels compare with each other: a box with boxes, the orchestrator with its per-user agents
 * (they run on its host, so report its kernel), each on one track.
 */
export const kernelGroup = (kind: 'orchestrator' | 'box' | 'agent', release: string | null | undefined): string | null => {
  const t = kernelTrack(release);
  return t ? `${kind === 'box' ? 'box' : 'orchestrator'}:${t}` : null;
};

export interface KernelSighting { kind: 'orchestrator' | 'box' | 'agent'; running: string | null; installed: string | null }

/**
 * The newest kernel per group, from every host's running kernel and newest installed one, so a box
 * that installed a newer build makes the others on its track `behind` before it has rebooted.
 */
export function kernelReferences(hosts: KernelSighting[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const h of hosts) {
    for (const v of [h.running, h.installed]) {
      const g = kernelGroup(h.kind, v);
      if (!g || !v) continue;
      const cur = refs.get(g);
      if (!cur || (compareVersions(v, cur) ?? 0) > 0) refs.set(g, v);
    }
  }
  return refs;
}

/**
 * A host's kernel (running or installed) against its group's newest; a newer kernel installed on the
 * host itself counts too, whatever its track, since that is what its next boot runs (a rolling kernel
 * moving 6.17 → 7.0 shows `outdated` until the reboot).
 */
export function kernelState(kind: KernelSighting['kind'], version: string | null, ok: boolean, path: string | null | undefined, refs: Map<string, string>, ownInstalled: string | null = null): SoftwareState {
  if (!ok) return path ? 'unknown' : 'missing';
  const g = kernelGroup(kind, version);
  if (!g || !version) return 'unknown';
  let ref = refs.get(g) ?? version;
  if (ownInstalled && kernelTrack(ownInstalled) && (compareVersions(ownInstalled, ref) ?? 0) > 0) ref = ownInstalled;
  return toolState({ version, ok: true }, ref);
}

/** The `reboot` row: `pending` while the host waits on a reboot, `current` when it doesn't. */
export function rebootState(version: string | null, ok: boolean, path: string | null | undefined): SoftwareState {
  if (!ok) return path ? 'unknown' : 'missing';
  return version === 'pending' ? 'pending' : version === 'no' ? 'current' : 'unknown';
}

/** Since when a pending reboot has waited, from the row's raw (`since 2026-11-02T06:10:00Z · …`). */
export function rebootPendingSince(raw: string | null | undefined): string | null {
  const m = /\bsince (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(raw ?? '');
  return m ? m[1] : null;
}

/** The kernel reference column: one newest build per group, boxes first. */
export function kernelReferenceText(refs: Map<string, string>): string | null {
  const list = [...refs].sort(([a], [b]) => (a.startsWith('box:') === b.startsWith('box:') ? a.localeCompare(b) : a.startsWith('box:') ? -1 : 1));
  return list.length ? list.map(([g, v]) => `${g.split(':')[0]} ${v}`).join(' · ') : null;
}
