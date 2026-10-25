/**
 * Repo groups: what a group is made of and
 * how it resolves to repos. Pure; the ingester supplies the org's repo list
 * and topic search results.
 *
 * Members:
 *   repo     an explicit owner/name, included at any visibility
 *   pattern  a glob over owner/name (`*` within a segment), public/internal only
 *   topic    a GitHub topic within an org, public/internal only
 *   path     an explicit owner/name, of which only some PRs count: those with
 *            at least `minShare` of their changed files under `paths`, or
 *            touching any of them with a title key (`PROJ-123`) in `keys`.
 *            For a product that lives in part of a monorepo. The ingester scores each PR as it is read.
 * The visibility rule keeps one admin's token from exposing private repos to
 * every admin: a private repo is in a group only when the group names it.
 */

export type MemberKind = 'repo' | 'pattern' | 'topic' | 'path';
export interface GroupMember { kind: MemberKind; value: string; org?: string; paths?: string[]; minShare?: number; keys?: string[] }
/** How a path member picks a repo's PRs, merged across a group's path members for one repo. */
export interface PathScope { paths: string[]; minShare: number; keys: string[] }
export const DEFAULT_MIN_SHARE = 0.2;
export interface GroupDef { slug: string; name: string; members: GroupMember[]; excluded: string[]; sort: number }
export interface RepoInfo { repo: string; visibility: string; archived: boolean; topics?: string[] }

export const DEFAULT_ORG = 'example-org';
const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The groups seeded once each, by slug; admins add their own from the PRs tab. */
export const SEED_GROUPS: GroupDef[] = [
  { slug: 'termag', name: 'termag', members: [{ kind: 'repo', value: 'example-org/termag' }], excluded: [], sort: 10 },
];

export const lowerRepo = (r: string) => r.trim().toLowerCase();

/** Glob over owner/name: `*` matches within one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  const esc = lowerRepo(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

/**
 * Glob over a file path, case-sensitive: `**` any depth (`a/**` is everything
 * under a; a leading `**` and a slash matches at any depth), `*` within one
 * segment, `?` one character.
 */
export function pathGlobToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      out += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * A scope's identity for "did it change": sorted paths and keys and the
 * share, whatever order the object's keys or arrays come in (JSONB does not
 * keep JavaScript key order). null for no scope.
 */
export function scopeKey(scope: unknown): string | null {
  if (!scope || typeof scope !== 'object') return null;
  const s = scope as Partial<PathScope>;
  const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].sort() : []);
  return JSON.stringify([list(s.paths), Number(s.minShare ?? DEFAULT_MIN_SHARE), list(s.keys)]);
}

/** Whether a PR counts for a path-scoped repo, and how many of its files matched. */
export function scorePr(scope: PathScope, files: string[], title: string): { matched: number; inGroup: boolean } {
  if (!files.length) return { matched: 0, inGroup: false };
  const res = scope.paths.map(pathGlobToRegExp);
  const matched = files.filter(f => res.some(re => re.test(f))).length;
  const keyed = scope.keys.some(k => new RegExp(`\\b${k}-\\d+`, 'i').test(title));
  return { matched, inGroup: matched / files.length >= scope.minShare || (matched > 0 && keyed) };
}

const PATH_RE = /^[A-Za-z0-9_.$@*?\/-]+$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,9}$/;

/** Validate an edited group; returns the normalised group or an error. */
export function parseGroup(input: unknown): GroupDef | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'group must be an object' };
  const g = input as Record<string, unknown>;
  const slug = typeof g.slug === 'string' ? g.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return { error: 'slug must be 1-40 lowercase letters, digits or dashes' };
  const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 60) : slug;
  if (!Array.isArray(g.members) || g.members.length === 0) return { error: 'a group needs at least one member' };
  if (g.members.length > 200) return { error: 'at most 200 members' };
  const members: GroupMember[] = [];
  for (const m of g.members as unknown[]) {
    const mm = m as Record<string, unknown>;
    const kind = mm?.kind; const value = typeof mm?.value === 'string' ? mm.value.trim() : '';
    if (kind === 'repo') {
      if (!REPO_RE.test(lowerRepo(value))) return { error: `not an owner/name repo: ${value}` };
      members.push({ kind, value: lowerRepo(value) });
    } else if (kind === 'pattern') {
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.*?-]+$/.test(lowerRepo(value))) return { error: `not an owner/name pattern: ${value}` };
      members.push({ kind, value: lowerRepo(value) });
    } else if (kind === 'topic') {
      const org = typeof mm.org === 'string' && mm.org.trim() ? mm.org.trim().toLowerCase() : DEFAULT_ORG;
      if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(value.toLowerCase())) return { error: `not a GitHub topic: ${value}` };
      members.push({ kind, value: value.toLowerCase(), org });
    } else if (kind === 'path') {
      if (!REPO_RE.test(lowerRepo(value))) return { error: `not an owner/name repo: ${value}` };
      const paths = Array.isArray(mm.paths) ? (mm.paths as unknown[]).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : [];
      if (!paths.length) return { error: `path member ${value} needs at least one path` };
      if (paths.length > 100) return { error: `path member ${value}: at most 100 paths` };
      const badPath = paths.find(x => !PATH_RE.test(x) || x.length > 200);
      if (badPath) return { error: `not a path glob: ${badPath}` };
      const minShare = mm.minShare === undefined ? DEFAULT_MIN_SHARE : Number(mm.minShare);
      if (!(minShare >= 0 && minShare <= 1)) return { error: `path member ${value}: share must be 0 to 100%` };
      const keys = Array.isArray(mm.keys) ? (mm.keys as unknown[]).filter((x): x is string => typeof x === 'string').map(x => x.trim().toUpperCase()) : [];
      const badKey = keys.find(k => !KEY_RE.test(k));
      if (badKey) return { error: `not a ticket key: ${badKey}` };
      members.push({ kind, value: lowerRepo(value), paths: [...new Set(paths)], minShare, keys: [...new Set(keys)] });
    } else return { error: `member kind must be repo, pattern, topic or path` };
  }
  const excluded = Array.isArray(g.excluded) ? (g.excluded as unknown[]).filter((x): x is string => typeof x === 'string').map(lowerRepo) : [];
  const bad = excluded.find(x => !REPO_RE.test(x));
  if (bad) return { error: `not an owner/name repo: ${bad}` };
  const sort = Number.isInteger(g.sort) ? (g.sort as number) : 100;
  return { slug, name, members, excluded, sort };
}

/**
 * Resolve one group against the known repos. `topicRepos` maps `org:topic` to
 * the repos the topic search returned. Explicit repos missing from `known` are
 * kept with visibility '' (the ingester learns it on the first sync).
 */
export function resolveGroup(group: GroupDef, known: RepoInfo[], topicRepos: Map<string, string[]>): Array<{ repo: string; visibility: string; scope?: PathScope }> {
  const byName = new Map(known.map(r => [lowerRepo(r.repo), r]));
  const shared = (r: RepoInfo | undefined) => !!r && !r.archived && (r.visibility === 'public' || r.visibility === 'internal');
  const out = new Map<string, string>();
  const scopes = new Map<string, PathScope>();
  for (const m of group.members) {
    if (m.kind === 'path') {
      const prev = scopes.get(m.value);
      scopes.set(m.value, {
        paths: [...new Set([...(prev?.paths ?? []), ...(m.paths ?? [])])],
        minShare: Math.min(prev?.minShare ?? 1, m.minShare ?? DEFAULT_MIN_SHARE),
        keys: [...new Set([...(prev?.keys ?? []), ...(m.keys ?? [])])],
      });
    } else if (m.kind === 'repo') out.set(m.value, byName.get(m.value)?.visibility ?? '');
    else if (m.kind === 'pattern') {
      const re = globToRegExp(m.value);
      for (const r of known) if (re.test(lowerRepo(r.repo)) && shared(r)) out.set(lowerRepo(r.repo), r.visibility);
    } else {
      for (const name of topicRepos.get(`${m.org ?? DEFAULT_ORG}:${m.value}`) ?? []) {
        const r = byName.get(lowerRepo(name));
        if (shared(r)) out.set(lowerRepo(name), r!.visibility);
      }
    }
  }
  // A repo the group also takes whole is not scoped.
  const scoped = [...scopes].filter(([repo]) => !out.has(repo));
  for (const x of group.excluded) { out.delete(x); scopes.delete(x); }
  return [
    ...[...out].map(([repo, visibility]) => ({ repo, visibility })),
    ...scoped.filter(([repo]) => scopes.has(repo)).map(([repo, scope]) => ({ repo, visibility: byName.get(repo)?.visibility ?? '', scope })),
  ].sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Orgs whose full repo list is needed: those that a pattern or topic member names. */
export function orgsToList(groups: GroupDef[]): string[] {
  const s = new Set<string>();
  for (const g of groups) for (const m of g.members) {
    if (m.kind === 'pattern') s.add(m.value.split('/')[0]);
    if (m.kind === 'topic') s.add(m.org ?? DEFAULT_ORG);
  }
  return [...s].sort();
}
