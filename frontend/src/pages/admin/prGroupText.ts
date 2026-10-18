import type { PrGroup, PrGroupMember } from '../../services/adminApi';

/**
 * The repo-group editor's text form, one member per line:
 *   repo example-org/termag
 *   topic some-sdk                    (org example-org)
 *   topic some-topic other-org
 *   pattern example-org/*-server-sdk*
 *   exclude example-org/some-repo
 * Blank lines and lines starting with # are ignored. The server validates
 * the result again (services/prAnalytics/groups.ts parseGroup).
 */
export function groupToText(g: Pick<PrGroup, 'members' | 'excluded'>): string {
  const lines = g.members.map(m => (m.kind === 'topic' && m.org && m.org !== 'example-org' ? `topic ${m.value} ${m.org}` : `${m.kind} ${m.value}`));
  return [...lines, ...g.excluded.map(x => `exclude ${x}`)].join('\n');
}

export function textToGroup(text: string): { members: PrGroupMember[]; excluded: string[] } | { error: string } {
  const members: PrGroupMember[] = []; const excluded: string[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [kind, value, org, ...rest] = line.split(/\s+/);
    if (!value || rest.length) return { error: `line ${i + 1}: expected "<kind> <value>"` };
    if (kind === 'exclude') { excluded.push(value); continue; }
    if (kind === 'repo' || kind === 'pattern') {
      if (org) return { error: `line ${i + 1}: ${kind} takes one value` };
      members.push({ kind, value });
    } else if (kind === 'topic') members.push(org ? { kind, value, org } : { kind, value });
    else return { error: `line ${i + 1}: kind must be repo, topic, pattern or exclude` };
  }
  if (!members.length) return { error: 'a group needs at least one repo, topic or pattern' };
  return { members, excluded };
}
