// Environments, what both UIs' Environments sections
// share: the edit form's draft, what it sends, and the audit log's wording.
// An environment is an inline definition (environment.json's JSON) or a
// pointer, repo : branch : path. The server validates the definition against
// the schema (docs/environment.schema.json) when it is saved; the form only
// checks that it is JSON.
import { DOCS_SITE_URL } from '../pages/settings/settingsDocs';
import type {
  EnvironmentEventView, EnvironmentFieldsView, EnvironmentInput, EnvironmentPerson, EnvironmentRepoView, EnvironmentVisibility,
} from '../services/api';

/** The implicit environment's file, which a pointer's empty path means. */
export const DEFAULT_ENVIRONMENT_FILE = '.termag/environment.json';

/**
 * The docs site's Environments guide, the one "About" link both UIs'
 * Environments sections carry; empty, and the link hidden, without a docs site.
 */
export const ENVIRONMENTS_DOCS_URL = DOCS_SITE_URL ? `${DOCS_SITE_URL}#/docs?doc=environments` : '';

/** What a new inline environment's editor starts with. */
export const DEFINITION_TEMPLATE = `{
  "$schema": "https://github.com/example-org/termag/blob/main/docs/environment.schema.json",
  "repos": [
    { "repo": "owner/name" }
  ],
  "resources": "medium"
}
`;

export type EnvironmentKind = EnvironmentFieldsView['kind'];

export interface EnvironmentDraft {
  name: string;
  kind: EnvironmentKind;
  /** The inline definition as typed. */
  definition: string;
  fileRepo: string;
  fileBranch: string;
  filePath: string;
}

export function emptyEnvironmentDraft(): EnvironmentDraft {
  return { name: '', kind: 'inline', definition: DEFINITION_TEMPLATE, fileRepo: '', fileBranch: '', filePath: '' };
}

export function draftFromEnvironment(e: EnvironmentFieldsView): EnvironmentDraft {
  return e.kind === 'inline'
    ? { ...emptyEnvironmentDraft(), name: e.name, kind: 'inline', definition: `${JSON.stringify(e.definition, null, 2)}\n` }
    : { ...emptyEnvironmentDraft(), name: e.name, kind: 'pointer', definition: '', fileRepo: e.file.repo, fileBranch: e.file.branch ?? '', filePath: e.file.path };
}

/** owner/name, lower case, from owner/name or a GitHub URL; the text trimmed otherwise. */
export function repoName(text: string): string {
  const t = text.trim();
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(t);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : t;
}

/** Why the inline definition can't be sent as it is (not JSON, not an object), else null. The schema is the server's. */
export function definitionError(text: string): string | null {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? null : 'The definition is a JSON object';
  } catch (err) {
    return `Not valid JSON: ${(err as Error).message}`;
  }
}

/** What a create or edit sends. */
export function draftInput(d: EnvironmentDraft): EnvironmentInput {
  const name = d.name.trim();
  if (d.kind === 'inline') return { name, kind: 'inline', definition: d.definition };
  return {
    name, kind: 'pointer',
    file: { repo: repoName(d.fileRepo), ...(d.fileBranch.trim() ? { branch: d.fileBranch.trim() } : {}), ...(d.filePath.trim() ? { path: d.filePath.trim() } : {}) },
  };
}

/** A pointer as it is written: `owner/name : branch : path`, the branch "default" when none is named. */
export function pointerLabel(file: { repo: string; branch: string | null; path: string }): string {
  return `${file.repo} : ${file.branch ?? 'default branch'} : ${file.path}`;
}

/** The repositories an environment names: an inline definition's `repos` (a name or `{ repo }` each), or a pointer's file's repository. */
export function environmentRepos(e: EnvironmentFieldsView): string[] {
  if (e.kind === 'pointer') return [e.file.repo];
  const repos = Array.isArray(e.definition.repos) ? e.definition.repos : [];
  return repos
    .map(r => (typeof r === 'string' ? r : r && typeof r === 'object' && typeof (r as { repo?: unknown }).repo === 'string' ? (r as { repo: string }).repo : ''))
    .filter(Boolean);
}

/**
 * The line under an environment's name in New session's environment dialog:
 * the repositories an inline definition lists, else the pointer's file.
 */
export function environmentLine(e: EnvironmentFieldsView): string {
  if (e.kind === 'pointer') return `From ${pointerLabel(e.file)}`;
  const names = environmentRepos(e);
  if (names.length === 0) return 'Names no repository';
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** The dialog's search: the trimmed query in the name or in any repository, ignoring case; an empty query matches all. */
export function matchesEnvironment(e: EnvironmentFieldsView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return e.name.toLowerCase().includes(q) || environmentRepos(e).some(r => r.toLowerCase().includes(q));
}

/**
 * The dialog's list for `query`: every match, in list order, and the selected
 * environment as `pinned` while the search filters it out, so it stays in view
 * (null when it is among the rows, when nothing is selected, or when it is gone).
 */
export function environmentMatches<E extends EnvironmentFieldsView>(list: readonly E[], { query, selected }: { query: string; selected: string | null }): { rows: E[]; pinned: E | null } {
  const rows = list.filter(e => matchesEnvironment(e, query));
  const chosen = selected === null ? undefined : list.find(e => e.name === selected);
  return { rows, pinned: chosen && !rows.includes(chosen) ? chosen : null };
}

/** A repository with what is set on it: `example-org/web (branch next, in frontend/)`. */
export function repoLabel(r: EnvironmentRepoView): string {
  const extra = [r.branch ? `branch ${r.branch}` : '', r.path ? `in ${r.path}/` : ''].filter(Boolean);
  return extra.length ? `${r.repo} (${extra.join(', ')})` : r.repo;
}

export function personLabel(p: EnvironmentPerson | null): string {
  return p ? p.name || p.email : 'someone no longer in termag';
}

export const ACTION_LABEL: Record<EnvironmentEventView['action'], string> = {
  'environment.create': 'Created',
  'environment.update': 'Edited',
  'environment.delete': 'Deleted',
  'environment.visibility': 'Switched',
};

export const VISIBILITY_LABEL: Record<EnvironmentVisibility, string> = { personal: 'Personal', shared: 'Shared' };

/** Who can use it, as the New environment form and an environment's page say. */
export const VISIBILITY_HINT: Record<EnvironmentVisibility, string> = {
  personal: 'Only you see it and use it, on your own boxes',
  shared: "Everyone signed in sees it and uses it. It runs from a file on its repository's default branch",
};

/**
 * Why a draft can't be shared as it stands, the rule as the server words it, else null. Only what the form knows
 * for certain: inline JSON. A branch, the file, and what it checks out the server reads from GitHub on save.
 */
export function shareBlocker(d: Pick<EnvironmentDraft, 'kind'>): string | null {
  return d.kind === 'inline'
    ? `A shared environment runs from a file on a repository's default branch, not inline JSON; point it at ${DEFAULT_ENVIRONMENT_FILE} on its repository's default branch`
    : null;
}

/** Personal first, then shared, each in list order; a group with none is left out. */
export function visibilityGroups<E extends { visibility: EnvironmentVisibility }>(list: readonly E[]): Array<{ visibility: EnvironmentVisibility; label: string; items: E[] }> {
  return (['personal', 'shared'] as const)
    .map(v => ({ visibility: v, label: VISIBILITY_LABEL[v], items: list.filter(e => e.visibility === v) }))
    .filter(g => g.items.length > 0);
}

/** One form's stored value, as a line: the pointer, or the inline definition's top-level keys. */
function formLine(f: EnvironmentFieldsView): string {
  return f.kind === 'pointer' ? `File ${pointerLabel(f.file)}` : `Inline definition (${Object.keys(f.definition).filter(k => k !== '$schema').join(', ') || 'empty'})`;
}

const json = (v: unknown) => JSON.stringify(v);

/**
 * One event as the lines its row lists: what was created or deleted, or each
 * stored field an edit changed, before → after (an inline definition key by key).
 */
export function describeEvent(e: Pick<EnvironmentEventView, 'action' | 'before' | 'after'>): string[] {
  const { before, after } = e;
  if (e.action === 'environment.visibility') {
    return after?.visibility ? [`${VISIBILITY_LABEL[before?.visibility ?? 'personal']} → ${VISIBILITY_LABEL[after.visibility]}`] : [];
  }
  if (e.action === 'environment.create' && after) return [after.visibility ? `${formLine(after)}, ${after.visibility}` : formLine(after)];
  if (e.action === 'environment.delete' && before) return [formLine(before)];
  if (!before || !after) return [];
  const lines: string[] = [];
  if (before.name !== after.name) lines.push(`Renamed ${before.name} → ${after.name}`);
  if (before.kind !== after.kind) {
    lines.push(`${formLine(before)} → ${formLine(after)}`);
  } else if (before.kind === 'pointer' && after.kind === 'pointer') {
    if (pointerLabel(before.file) !== pointerLabel(after.file)) lines.push(`File ${pointerLabel(before.file)} → ${pointerLabel(after.file)}`);
  } else if (before.kind === 'inline' && after.kind === 'inline') {
    const keys = [...new Set([...Object.keys(before.definition), ...Object.keys(after.definition)])];
    for (const k of keys) {
      const was = before.definition[k];
      const now = after.definition[k];
      if (json(was) === json(now)) continue;
      if (k === 'repos' && Array.isArray(was) && Array.isArray(now)) { lines.push(...repoChanges(was, now)); continue; }
      if (was === undefined) lines.push(`Added ${k}: ${json(now)}`);
      else if (now === undefined) lines.push(`Removed ${k}`);
      else lines.push(`${k}: ${json(was)} → ${json(now)}`);
    }
  }
  return lines;
}

/** A `repos` list as entries, a bare "owner/name" as `{ repo }`. */
function reposOf(list: unknown[]): EnvironmentRepoView[] {
  return list.map(r => (typeof r === 'string' ? { repo: r } : r as EnvironmentRepoView)).filter(r => r && typeof r.repo === 'string');
}

/** A `repos` edit repository by repository: added, removed, changed. */
function repoChanges(was: unknown[], now: unknown[]): string[] {
  const before = reposOf(was);
  const after = reposOf(now);
  const old = new Map(before.map(r => [r.repo.toLowerCase(), r]));
  const lines: string[] = [];
  for (const r of after) {
    const o = old.get(r.repo.toLowerCase());
    if (!o) lines.push(`Added ${repoLabel(r)}`);
    else if (repoLabel(o) !== repoLabel(r)) lines.push(`${repoLabel(o)} → ${repoLabel(r)}`);
  }
  const kept = new Set(after.map(r => r.repo.toLowerCase()));
  for (const r of before) if (!kept.has(r.repo.toLowerCase())) lines.push(`Removed ${repoLabel(r)}`);
  return lines.length ? lines : ['Reordered repos'];
}

/** The time of an event or edit, in the reader's locale. */
export function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** An API error's message, else the fallback. */
export function environmentError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

/** The commands that create things from an environment, as an environment's page shows them. */
export function environmentCommands(name: string): string[] {
  return [
    `termag project create <box>/<name> --agent claude --environment ${name}`,
    `termag project create <box>/<name> --agent claude --new-box --environment ${name}`,
  ];
}

/** A create's environmentRepos: each checkout's repository and branch, as the server compares them. */
export function checkoutsPin(repos: readonly EnvironmentRepoView[]): Array<{ repo: string; branch?: string }> {
  return repos.map(r => (r.branch ? { repo: r.repo, branch: r.branch } : { repo: r.repo }));
}
