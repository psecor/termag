import type { PrTeamMemberInput } from '../../services/adminApi';

/**
 * The team editor's text form: one GitHub login per line, optionally with a
 * display name and email:
 *   psmith
 *   lhenry Hal Brown
 *   mons Fay Field fabian@example.com
 * Blank lines and lines starting with # are ignored. The server validates the
 * result again (services/prAnalytics/teams.ts parseTeamMember).
 */
export function teamToText(members: string[]): string {
  return members.join('\n');
}

export function textToMembers(text: string): { members: PrTeamMemberInput[] } | { error: string } {
  const members: PrTeamMemberInput[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const login = tokens[0].replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login)) return { error: `line ${i + 1}: not a GitHub login: ${tokens[0]}` };
    // A trailing token with @ is the email; everything between is the name, spaces and all.
    const rest = tokens.slice(1);
    const email = rest.length && rest[rest.length - 1].includes('@') ? rest.pop() : undefined;
    const name = rest.join(' ');
    members.push({ login, ...(name ? { name } : {}), ...(email ? { email } : {}) });
  }
  // An empty list is valid: the editor edits the manual overrides, and clearing them all is a save.
  return { members };
}

/**
 * The org-tree's `teams-export.json` as the Teams card's Import export… reads
 * it: JSON with a non-empty `teams` list and a `members` object. The backend
 * checks the rest (services/prAnalytics/teamSync.ts exportProblem).
 */
export function parseTeamsExportFile(text: string): { json: unknown } | { error: string } {
  if (!text.trim()) return { error: 'The file is empty' };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { error: 'The file is not JSON: pick the org-tree\'s teams-export.json' }; }
  const o = json as { teams?: unknown; members?: unknown } | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.teams) || o.teams.length === 0
    || !o.members || typeof o.members !== 'object' || Array.isArray(o.members)) {
    return { error: 'That is not a teams export: it needs teams and members (the org-tree\'s teams-export.json)' };
  }
  return { json };
}

/** What an import did, for the line beside the button. */
export function importedTeamsNote(r: { teams: number; members: number; skipped: number }): string {
  const skipped = r.skipped ? `; ${r.skipped} skipped (no GitHub login)` : '';
  return `Imported ${r.teams} team${r.teams === 1 ? '' : 's'} and ${r.members} membership${r.members === 1 ? '' : 's'}${skipped}.`;
}
