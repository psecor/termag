import type { PrGroup, PrGroupMember } from '../../services/adminApi';

/**
 * The repo-group editor's text form, one member per line:
 *   repo example-org/termag
 *   topic some-sdk                    (org example-org)
 *   topic some-topic other-org
 *   pattern example-org/*-server-sdk*
 *   path example-org/webapp internal/ai/**    (one line per path glob)
 *   share example-org/webapp 20%             (of a PR's files; default 20%)
 *   key example-org/webapp AIC               (a title key that counts at any share)
 *   exclude example-org/some-repo
 * A path member takes only the PRs of the repo that touch its paths enough.
 * Blank lines and lines starting with # are ignored. The server validates
 * the result again (services/prAnalytics/groups.ts parseGroup).
 */

const DEFAULT_SHARE = 0.2;
const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
export function groupToText(g: Pick<PrGroup, 'members' | 'excluded'>): string {
  const lines = g.members.flatMap(m => {
    if (m.kind === 'path') {
      return [
        ...(m.paths ?? []).map(p => `path ${m.value} ${p}`),
        ...(m.minShare != null && m.minShare !== DEFAULT_SHARE ? [`share ${m.value} ${pct(m.minShare)}`] : []),
        ...(m.keys ?? []).map(k => `key ${m.value} ${k}`),
      ];
    }
    return [m.kind === 'topic' && m.org && m.org !== 'example-org' ? `topic ${m.value} ${m.org}` : `${m.kind} ${m.value}`];
  });
  return [...lines, ...g.excluded.map(x => `exclude ${x}`)].join('\n');
}

/** One line for the group list: a path member is its repo and how many paths. */
export function groupSummary(g: Pick<PrGroup, 'members' | 'excluded'>): string {
  const parts = g.members.map(m => {
    if (m.kind !== 'path') return m.kind === 'topic' && m.org && m.org !== 'example-org' ? `topic ${m.value} ${m.org}` : `${m.kind} ${m.value}`;
    const n = m.paths?.length ?? 0;
    const keys = m.keys?.length ? `, or ${m.keys.join('/')}-` : '';
    return `${m.value} by path (${n} ${n === 1 ? 'glob' : 'globs'}, ≥${pct(m.minShare ?? DEFAULT_SHARE)}${keys})`;
  });
  return [...parts, ...g.excluded.map(x => `exclude ${x}`)].join(' · ');
}

export function textToGroup(text: string): { members: PrGroupMember[]; excluded: string[] } | { error: string } {
  const members: PrGroupMember[] = []; const excluded: string[] = [];
  const byRepo = new Map<string, PrGroupMember>();
  const pathMember = (repo: string) => {
    let m = byRepo.get(repo);
    if (!m) { m = { kind: 'path', value: repo, paths: [], minShare: DEFAULT_SHARE, keys: [] }; byRepo.set(repo, m); members.push(m); }
    return m;
  };
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [kind, value, org, ...rest] = line.split(/\s+/);
    if (!value || rest.length) return { error: `line ${i + 1}: expected "<kind> <value>"` };
    if (kind === 'exclude') { excluded.push(value); continue; }
    if (kind === 'path' || kind === 'share' || kind === 'key') {
      if (!org) return { error: `line ${i + 1}: expected "${kind} <owner/name> <${kind === 'path' ? 'glob' : kind === 'share' ? 'percent' : 'key'}>"` };
      const m = pathMember(value);
      if (kind === 'path') m.paths!.push(org);
      else if (kind === 'key') m.keys!.push(org.toUpperCase());
      else {
        const n = Number(org.replace(/%$/, ''));
        if (!/^\d+(\.\d+)?%?$/.test(org) || n > 100) return { error: `line ${i + 1}: share is a percent, 0 to 100` };
        m.minShare = n / 100;
      }
      continue;
    }
    if (kind === 'repo' || kind === 'pattern') {
      if (org) return { error: `line ${i + 1}: ${kind} takes one value` };
      members.push({ kind, value });
    } else if (kind === 'topic') members.push(org ? { kind, value, org } : { kind, value });
    else return { error: `line ${i + 1}: kind must be repo, topic, pattern, path, share, key or exclude` };
  }
  const pathless = [...byRepo.values()].find(m => !m.paths!.length);
  if (pathless) return { error: `${pathless.value}: share and key lines need at least one path line` };
  if (!members.length) return { error: 'a group needs at least one repo, topic, pattern or path' };
  return { members, excluded };
}
