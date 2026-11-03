/**
 * Which checkout on a box holds a pull request's branch:
 * asked of the box over `git-branch-state`'s light form (agent
 * git-branch-state.js gitCheckoutFacts), so a link share can show the PR's own
 * checkout even when it isn't the workstream that asked: a project's main, a
 * plain worktree, or `~/src/<repo>` beside the project.
 *
 * Only owner-made shares look on a box. The box's answer is a report, not a
 * record: the caller still checks the PR on GitHub, and the guest path checks
 * the stack against the directory again at every attach.
 */
import { createHash } from 'crypto';
import type { ProjectHost } from './agentRegistry';
import { repoFromOrigin } from './prBranches';

// The light form runs no `git status`: a few ref reads of 2 s and a worktree
// list of 3 s, together, so a slow checkout answers (or fails) inside this.
const RPC_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;
/** Directories asked about, worktrees included, at most. */
const MAX_DIRS = 40;

/** A directory to ask about, and the workstream whose own checkout it is, if any. */
export interface CheckoutCandidate {
  dir: string;
  /** The workstream this is the checkout of (main's id may be null), or null for `~/src/<repo>`. */
  workstream: { id: string | null; name: string } | null;
  /** Also list this checkout's worktrees, and consider each. */
  worktrees: boolean;
}

export type CheckoutRefusal = 'no-checkout' | 'ambiguous-checkout' | 'checkout-unreadable';

export type CheckoutLookup =
  | {
    ok: true;
    /**
     * The checkout as asked about, a plain path under the owner's home (or a
     * worktree's own resolved path): what the share keeps as `checkoutDir`.
     */
    dir: string;
    /** Its resolved top level, which may be elsewhere (a symlinked folder): what keys the share. */
    realDir: string;
    /** The workstream whose own checkout it is, or null: then the share keeps it as `checkoutDir`. */
    workstream: { id: string | null; name: string } | null;
    repo: string;
    branch: string;
    head: string | null;
  }
  | { ok: false; reason: CheckoutRefusal; looked: string[] }
  /** The box's agent predates the light form: the caller keeps today's rule. */
  | { ok: false; reason: 'outdated-agent'; looked: string[] };

/** The fields of a light answer this reads; everything is re-validated. */
interface RawCheckoutFacts {
  light?: unknown;
  dir?: unknown;
  toplevel?: unknown;
  branch?: unknown;
  head?: unknown;
  origin?: unknown;
  worktrees?: unknown;
}

export type SendFn = (host: ProjectHost, type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const oid = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v) ? v : null);

/** A plain absolute path under `home`: no `.` or `..` segment, no doubled slash, no NUL. */
export function isPathUnder(home: string, p: unknown): p is string {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0') || !p.startsWith('/')) return false;
  if (p.split('/').slice(1).some(seg => seg === '' || seg === '.' || seg === '..')) return false;
  const base = home.replace(/\/+$/, '');
  return base !== '' && p.startsWith(`${base}/`);
}

/** The git error for a directory that isn't there, or isn't a checkout: an absent candidate, not an unread one. */
function isAbsent(message: string): boolean {
  return /not a git repository|No such file or directory|cannot change to/i.test(message);
}

/**
 * A `checkoutDir` share's active key: the box, its owner and the directory,
 * so two projects on one box can't both hold a live share of one checkout,
 * and two owners whose checkouts resolve to one directory never replace each
 * other's (the key is unique across all owners).
 */
export function checkoutLinkKey(host: ProjectHost, dir: string): string {
  const box = host.instanceId ?? `legacy:${host.userId}`;
  return `box:${box}:dir:${createHash('sha256').update(`${host.userId}\0${dir}`).digest('hex').slice(0, 16)}`;
}

/**
 * Find the PR's checkout among `candidates` (4d,
 * item 2). A match is a directory that is its own checkout's top level,
 * whose `origin` is `repo` and whose branch is `branch`. The answer, in
 * order: the asking workstream's own checkout when it matches; else
 * `checkout-unreadable` when any directory couldn't be read; else the one
 * match, `head` breaking a tie, else `ambiguous-checkout`; else
 * `no-checkout`.
 */
export async function findPrCheckout(
  input: { host: ProjectHost; home: string; candidates: CheckoutCandidate[]; asking: string | null; repo: string; branch: string; headOid: string | null },
  deps: { connected: (host: ProjectHost) => boolean; send: SendFn },
): Promise<CheckoutLookup> {
  const { host, home, repo, branch, headOid } = input;
  const candidates = input.candidates.filter(c => isPathUnder(home, c.dir)).slice(0, MAX_DIRS);
  const looked = candidates.map(c => c.dir);
  if (!deps.connected(host)) return { ok: false, reason: 'checkout-unreadable', looked };

  interface Fact { dir: string; real: string; repo: string | null; branch: string | null; head: string | null; workstream: CheckoutCandidate['workstream']; asked: string }
  const facts: Fact[] = [];
  let unread = false;
  let outdated = false;

  const one = async (c: CheckoutCandidate) => {
    let raw: RawCheckoutFacts;
    try {
      raw = (await deps.send(host, 'git-branch-state', { cwd: c.dir, light: true, ...(c.worktrees ? { worktrees: true } : {}) }, RPC_TIMEOUT_MS) ?? {}) as RawCheckoutFacts;
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (/Unknown command/i.test(message)) outdated = true;
      else if (!isAbsent(message)) unread = true;
      return;
    }
    if (raw.light !== true) { outdated = true; return; }
    const dir = str(raw.dir);
    const toplevel = str(raw.toplevel);
    const origin = repoFromOrigin(raw.origin);
    // A directory inside a checkout reports the enclosing one: only a top level
    // is itself a checkout. Its resolved path may be elsewhere (a project folder
    // symlinked to another volume): the share keeps the path it asked about.
    if (dir && toplevel && dir === toplevel) {
      facts.push({ dir: c.dir, real: dir, repo: origin, branch: str(raw.branch), head: oid(raw.head), workstream: c.workstream, asked: c.dir });
    }
    // A worktree shares its checkout's origin; its path is already resolved,
    // and only one under the owner's home is taken.
    if (c.worktrees && Array.isArray(raw.worktrees)) {
      for (const w of raw.worktrees.slice(0, MAX_DIRS) as Array<Record<string, unknown>>) {
        const p = str(w?.path);
        if (!p || !isPathUnder(home, p)) continue;
        facts.push({ dir: p, real: p, repo: origin, branch: str(w.branch), head: oid(w.head), workstream: null, asked: c.dir });
      }
    }
  };

  const queue = [...candidates];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await one(c);
  }));
  if (outdated) return { ok: false, reason: 'outdated-agent', looked };

  // One fact per resolved directory: a workstream's own answer wins over the
  // same directory listed as another checkout's worktree, or reached by a symlink.
  const byDir = new Map<string, Fact>();
  for (const f of facts) {
    const had = byDir.get(f.real);
    if (!had || (!had.workstream && f.workstream)) byDir.set(f.real, f);
  }
  const all = [...byDir.values()];
  const matches = all.filter(f => f.repo !== null && f.repo.toLowerCase() === repo.toLowerCase() && f.branch === branch);
  const answer = (f: Fact): CheckoutLookup => ({ ok: true, dir: f.dir, realDir: f.real, workstream: f.workstream, repo: f.repo!, branch: f.branch!, head: f.head });

  // 1. The asking workstream's own checkout: today's rule, whatever else is on the box.
  const own = input.asking ? matches.find(f => f.asked === input.asking && f.workstream) : undefined;
  if (own) return answer(own);
  // 2. An unread directory may be the PR's: no other match is taken in its place.
  if (unread) return { ok: false, reason: 'checkout-unreadable', looked };
  // 3. The one match; `head` breaks a tie.
  if (matches.length === 1) return answer(matches[0]);
  if (matches.length > 1) {
    const atHead = headOid ? matches.filter(f => f.head === headOid) : [];
    if (atHead.length === 1) return answer(atHead[0]);
    return { ok: false, reason: 'ambiguous-checkout', looked };
  }
  return { ok: false, reason: 'no-checkout', looked };
}
