/**
 * Suggested review groups:
 * PRs that look like one piece of work, offered as a group, never grouped
 * without the user's say. Two signals:
 *
 *   - a GitHub stack: an open PR whose base branch is another open PR's
 *     branch in the same repository (from the lane rows; no GitHub read);
 *   - references in the descriptions of reviews asked of you by name: a PR
 *     URL, `owner/name#N`, or `#N` in the same repository, to a PR that is
 *     still open (an issue, a merged or closed PR, or one GitHub does not
 *     have, is no link).
 *
 * The linked PRs form groups (connected components). Each is ordered by its
 * stacks (a base before the PRs stacked on it), else by how many of the
 * group's descriptions name a PR (most first: the shared piece, usually the
 * contract), then by repository and number. A mention says two PRs belong
 * together, not which comes first ("needs terraform#N" names a follow-up), so
 * it is no order of its own. Members already in
 * one of the user's open groups turn the suggestion into "add the rest to
 * that group". A suggestion the user dismissed stays dismissed until its set
 * of PRs changes. Descriptions are untrusted text: only references are
 * pulled out of them, and none of it is shown.
 */

import { createHash } from 'crypto';
import { prisma } from '../db';
import { prKey, type PrRow } from './prPipeline';

/** References read from one description, at most. */
export const MAX_REFS_PER_BODY = 30;
/** PRs a suggestion holds, at most (a review group's cap). */
export const MAX_SUGGESTED = 20;

export interface PrRef { repo: string; number: number }

/** What a suggestion needs of a PR: from a lane row, or from GitHub for one no lane lists. */
export interface SuggestedPr { repo: string; number: number; title: string; url: string; author: string | null }

export interface GroupSuggestion {
  /** Stable for this set of PRs (and target group): what a dismissal stores. */
  key: string;
  /** In review order. */
  members: SuggestedPr[];
  reason: 'stack' | 'references' | 'both';
  /** Set when some of the linked PRs are in one of your open groups: add these to it. */
  target: { id: string; name: string } | null;
  /** A starting name for a new group: the first member's title. */
  name: string;
}

const lower = (repo: string, number: number) => prKey(repo.toLowerCase(), number);

const URL_REF = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,9})/g;
const FULL_REF = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d{1,9})\b/g;
// Not an HTML entity (&#123;), a URL fragment or part of owner/name#N.
const BARE_REF = /(?<![\w&/#.-])#(\d{1,9})\b/g;

/** The PRs a description names, other than itself, lowercased repos, first MAX_REFS_PER_BODY. */
export function parseRefs(body: string, repo: string, self?: number): PrRef[] {
  const out = new Map<string, PrRef>();
  const add = (r: string, n: number) => {
    if (out.size >= MAX_REFS_PER_BODY || !Number.isSafeInteger(n) || n < 1) return;
    const ref = { repo: r.toLowerCase(), number: n };
    if (ref.repo === repo.toLowerCase() && n === self) return;
    out.set(lower(ref.repo, n), ref);
  };
  // URLs first, and blanked, so their `owner/name/pull/N` is not read again below.
  const rest = body.replace(URL_REF, (_m, o: string, n: string, num: string) => { add(`${o}/${n}`, Number(num)); return ' '; });
  const rest2 = rest.replace(FULL_REF, (_m, o: string, n: string, num: string) => { add(`${o}/${n}`, Number(num)); return ' '; });
  for (const m of rest2.matchAll(BARE_REF)) add(repo, Number(m[1]));
  return [...out.values()];
}

const OPEN_LANES = new Set(['checks', 'needs_approval', 'needs_my_review', 'team_review', 'ready_to_merge']);

/** Open PR rows only: the lanes' merged rows and branch rows link nothing. */
function openRows(rows: PrRow[]): PrRow[] {
  return rows.filter(r => r.kind === 'pr' && r.repo && r.number != null && OPEN_LANES.has(r.lane));
}

/** `child` is stacked on `parent`: child's base is parent's head, same repository. */
export function stackEdges(rows: PrRow[]): { parent: string; child: string }[] {
  const open = openRows(rows);
  const byHead = new Map<string, string>();
  for (const r of open) byHead.set(`${r.repo!.toLowerCase()}:${r.headRefName}`, lower(r.repo!, r.number!));
  const out: { parent: string; child: string }[] = [];
  for (const r of open) {
    const parent = byHead.get(`${r.repo!.toLowerCase()}:${r.baseRefName}`);
    const child = lower(r.repo!, r.number!);
    if (parent && parent !== child) out.push({ parent, child });
  }
  return out;
}

/** The review rows whose descriptions are read: reviews asked of you by name. */
export function bodySources(rows: PrRow[]): PrRow[] {
  return openRows(rows).filter(r => r.lane === 'needs_my_review' && r.askedYou !== false);
}

export interface SuggestInput {
  rows: PrRow[];
  /** Descriptions of bodySources(rows), by lowercased key; a missing one links nothing. */
  bodies: Map<string, string>;
  /** Referenced PRs no lane lists, by lowercased key: their state and fields. */
  others: Map<string, SuggestedPr & { open: boolean }>;
  /** The user's open groups' members, by lowercased key, with each group's size. */
  grouped: Map<string, { id: string; name: string; size: number }>;
  /** Dismissed suggestion keys, as keyHash. */
  dismissed: Set<string>;
}

/** Referenced PRs no lane lists: the ones to look up on GitHub. */
export function unknownRefs(rows: PrRow[], bodies: Map<string, string>, limit = 40): PrRef[] {
  const known = new Set(openRows(rows).map(r => lower(r.repo!, r.number!)));
  const merged = new Set(rows.filter(r => r.kind === 'pr' && r.repo && r.number != null && !OPEN_LANES.has(r.lane)).map(r => lower(r.repo!, r.number!)));
  const out = new Map<string, PrRef>();
  for (const r of bodySources(rows)) {
    for (const ref of parseRefs(bodies.get(lower(r.repo!, r.number!)) ?? '', r.repo!, r.number!)) {
      const k = lower(ref.repo, ref.number);
      if (!known.has(k) && !merged.has(k) && out.size < limit) out.set(k, ref);
    }
  }
  return [...out.values()];
}

export function suggestGroups(input: SuggestInput): GroupSuggestion[] {
  const open = openRows(input.rows);
  const prs = new Map<string, SuggestedPr>();
  for (const r of open) prs.set(lower(r.repo!, r.number!), { repo: r.repo!, number: r.number!, title: r.title, url: r.url ?? '', author: r.author });
  for (const [k, o] of input.others) if (o.open && !prs.has(k)) prs.set(k, { repo: o.repo, number: o.number, title: o.title, url: o.url, author: o.author });

  // Edges: parent before child. A stack child builds on its parent; a description names what it builds on.
  const edges: { before: string; after: string; kind: 'stack' | 'references' }[] = [];
  for (const e of stackEdges(input.rows)) edges.push({ before: e.parent, after: e.child, kind: 'stack' });
  for (const r of bodySources(input.rows)) {
    const self = lower(r.repo!, r.number!);
    for (const ref of parseRefs(input.bodies.get(self) ?? '', r.repo!, r.number!)) {
      const k = lower(ref.repo, ref.number);
      if (prs.has(k)) edges.push({ before: k, after: self, kind: 'references' });
    }
  }

  // Components (union-find).
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let p = parent.get(k) ?? k;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(k, p);
    return p;
  };
  for (const e of edges) {
    const a = find(e.before);
    const b = find(e.after);
    if (a !== b) parent.set(a, b);
  }
  const comps = new Map<string, Set<string>>();
  for (const e of edges) {
    for (const k of [e.before, e.after]) {
      const root = find(k);
      if (!comps.has(root)) comps.set(root, new Set());
      comps.get(root)!.add(k);
    }
  }

  const out: GroupSuggestion[] = [];
  for (const members of comps.values()) {
    const keys = [...members];
    const own = edges.filter(e => members.has(e.before));
    const kinds = new Set(own.map(e => e.kind));
    const named = new Map<string, number>();
    for (const e of own) if (e.kind === 'references') named.set(e.before, (named.get(e.before) ?? 0) + 1);
    const ordered = topoOrder(keys, own.filter(e => e.kind === 'stack'), prs, named);
    // Some already grouped: add the rest to the group holding the most of them.
    const holding = new Map<string, { id: string; name: string; size: number; n: number }>();
    for (const k of keys) {
      const g = input.grouped.get(k);
      if (g) holding.set(g.id, { ...g, n: (holding.get(g.id)?.n ?? 0) + 1 });
    }
    const target = [...holding.values()].sort((a, b) => b.n - a.n)[0] ?? null;
    const ungrouped = ordered.filter(k => !input.grouped.has(k));
    if (ungrouped.length === 0 || (!target && ungrouped.length < 2)) continue;
    // Added to a group, they must fit beside its own members (a group holds MAX_SUGGESTED: Bugbot, #669).
    const room = target ? MAX_SUGGESTED - target.size : MAX_SUGGESTED;
    if (room <= 0) continue;
    const chosen = ungrouped.slice(0, room).map(k => prs.get(k)).filter((p): p is SuggestedPr => !!p);
    if (chosen.length === 0 || (!target && chosen.length < 2)) continue;
    const key = `${target ? `${target.id}:` : ''}${chosen.map(p => lower(p.repo, p.number)).sort().join(' ')}`;
    if (input.dismissed.has(keyHash(key))) continue;
    out.push({
      key,
      members: chosen,
      reason: kinds.size === 2 ? 'both' : kinds.has('stack') ? 'stack' : 'references',
      target: target ? { id: target.id, name: target.name } : null,
      name: (chosen[0].title || `${chosen[0].repo}#${chosen[0].number}`).slice(0, 80),
    });
  }
  return out;
}

/** Kahn's order over stack edges, ties by mentions (most first), repository, number; a cycle's rest by the same. */
function topoOrder(keys: string[], edges: { before: string; after: string }[], prs: Map<string, SuggestedPr>, named: Map<string, number>): string[] {
  const rank = (k: string) => {
    const p = prs.get(k);
    return p ? [p.repo.toLowerCase(), p.number] as const : [k, 0] as const;
  };
  const cmp = (a: string, b: string) => {
    const m = (named.get(b) ?? 0) - (named.get(a) ?? 0);
    if (m !== 0) return m;
    const [ra, na] = rank(a);
    const [rb, nb] = rank(b);
    return ra < rb ? -1 : ra > rb ? 1 : na - nb;
  };
  const indeg = new Map(keys.map(k => [k, 0]));
  for (const e of edges) if (e.before !== e.after) indeg.set(e.after, (indeg.get(e.after) ?? 0) + 1);
  const ready = keys.filter(k => (indeg.get(k) ?? 0) === 0).sort(cmp);
  const out: string[] = [];
  const done = new Set<string>();
  while (ready.length) {
    const k = ready.shift()!;
    out.push(k);
    done.add(k);
    for (const e of edges) {
      if (e.before !== k || done.has(e.after)) continue;
      const n = (indeg.get(e.after) ?? 0) - 1;
      indeg.set(e.after, n);
      if (n === 0) { ready.push(e.after); ready.sort(cmp); }
    }
  }
  return [...out, ...keys.filter(k => !done.has(k)).sort(cmp)];
}

// ── Dismissals ───────────────────────────────────────────────────────────────

/** A suggestion key as stored: a hash, since a key lists up to MAX_SUGGESTED PRs. */
export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');

/** The store, injectable so the routes are testable without a database. */
export interface SuggestionDismissalStore {
  /** The user's dismissed key hashes. */
  list: (userId: string) => Promise<Set<string>>;
  dismiss: (userId: string, key: string) => Promise<void>;
}

export const prismaSuggestionDismissals: SuggestionDismissalStore = {
  async list(userId) {
    const rows = await prisma.prGroupSuggestionDismissal.findMany({ where: { userId }, select: { keyHash: true } });
    return new Set(rows.map(r => r.keyHash));
  },
  async dismiss(userId, key) {
    const hash = keyHash(key);
    await prisma.prGroupSuggestionDismissal.upsert({
      where: { userId_keyHash: { userId, keyHash: hash } },
      create: { userId, keyHash: hash },
      update: {},
    });
  },
};
