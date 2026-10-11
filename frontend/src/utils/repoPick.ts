import { githubOrgLine, type OrgAccess } from '../pages/settings/githubOrgCopy';

export type RepoPick =
  | { kind: 'empty' }
  | { kind: 'listed'; fullName: string; defaultBranch: string }
  | { kind: 'starter'; templateId: string; url: string }
  | { kind: 'pasted'; url: string };

const HTTPS_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SSH_RE = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

const DEGRADED_NOTICE = 'Could not load repositories. Starters and a pasted URL still work.';

export function repoKey(url: string): string | null {
  const match = HTTPS_RE.exec(url.trim()) ?? SSH_RE.exec(url.trim());
  if (!match) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export function githubRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}.git`;
}

export type CreateRepoBody =
  | { repoUrl: null }
  | { repoUrl: string; defaultBranch: string | null };

export function createBody(pick: RepoPick): CreateRepoBody | null {
  switch (pick.kind) {
    case 'empty':
      return { repoUrl: null };
    case 'listed':
      return { repoUrl: githubRepoUrl(pick.fullName), defaultBranch: pick.defaultBranch };
    case 'starter':
      return { repoUrl: pick.url, defaultBranch: null };
    case 'pasted': {
      const url = pick.url.trim();
      if (url === '') return null;
      return { repoUrl: url, defaultBranch: null };
    }
  }
}

export interface RepoProjectRef {
  id: string;
  name: string;
  archived: boolean;
  instanceId?: string | null;
  repoUrl?: string | null;
}

export function sameRepoMatches<T extends RepoProjectRef>(
  pick: RepoPick,
  projects: readonly T[],
  instanceId: string | null,
): T[] {
  if (pick.kind === 'empty') return [];
  if (pick.kind === 'pasted' && pick.url.trim() === '') return [];
  const url = pick.kind === 'listed' ? githubRepoUrl(pick.fullName) : pick.url;
  const key = repoKey(url);
  if (!key) return [];
  return projects.filter(project =>
    !project.archived
    && (project.instanceId ?? null) === instanceId
    && project.repoUrl != null
    && repoKey(project.repoUrl) === key,
  );
}

function sanitizeBasename(base: string): string {
  return base.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function repoBasename(url: string): string {
  const match = HTTPS_RE.exec(url.trim()) ?? SSH_RE.exec(url.trim());
  return sanitizeBasename(match ? match[2] : 'project');
}

export function suggestedName(pick: RepoPick): string | null {
  if (pick.kind === 'empty') return null;
  if (pick.kind === 'pasted' && pick.url.trim() === '') return null;
  if (pick.kind === 'listed') {
    const slash = pick.fullName.lastIndexOf('/');
    return sanitizeBasename(slash >= 0 ? pick.fullName.slice(slash + 1) : pick.fullName);
  }
  return repoBasename(pick.url);
}

export function repoPromptDue(input: {
  kind: string;
  dismissedAt: string | null;
  liveCount: number;
}): boolean {
  return input.kind === 'ec2' && input.dismissedAt === null && input.liveCount === 0;
}

export interface CatalogRepo {
  fullName: string;
  defaultBranch: string;
}

export interface CatalogGroup {
  owner: string;
  kind: 'user' | 'org';
  status: 'ok' | 'sso-required' | 'app-policy' | 'rate-limited' | 'error';
  repos: CatalogRepo[];
  text: string;
  href?: string;
}

export interface RepoCatalog {
  ok: boolean;
  groups: CatalogGroup[];
  notice: string | null;
}

const GROUP_STATUSES: readonly CatalogGroup['status'][] = [
  'ok', 'sso-required', 'app-policy', 'rate-limited', 'error',
];

export function degradedCatalog(): RepoCatalog {
  return { ok: false, groups: [], notice: DEGRADED_NOTICE };
}

function parseRepo(raw: unknown): CatalogRepo | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.fullName !== 'string') return null;
  const slash = row.fullName.indexOf('/');
  if (slash <= 0 || slash !== row.fullName.lastIndexOf('/')) return null;
  if (typeof row.defaultBranch !== 'string' || row.defaultBranch === '') return null;
  return { fullName: row.fullName, defaultBranch: row.defaultBranch };
}

function groupAccess(raw: Record<string, unknown>, status: CatalogGroup['status']): OrgAccess {
  switch (status) {
    case 'sso-required':
      return { status: 'sso-required', ssoUrl: typeof raw.ssoUrl === 'string' ? raw.ssoUrl : null };
    case 'app-policy':
      return { status: 'app-policy' };
    case 'rate-limited':
      return { status: 'rate-limited', retryAfter: typeof raw.retryAfter === 'string' ? raw.retryAfter : null };
    case 'error':
      return { status: 'error', retryAfter: typeof raw.retryAfter === 'string' ? raw.retryAfter : null };
    default:
      return { status: 'ok' };
  }
}

function parseGroup(raw: unknown): CatalogGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const group = raw as Record<string, unknown>;
  if (typeof group.owner !== 'string') return null;
  if (group.kind !== 'user' && group.kind !== 'org') return null;
  if (typeof group.status !== 'string' || !GROUP_STATUSES.includes(group.status as CatalogGroup['status'])) return null;
  const status = group.status as CatalogGroup['status'];
  const keepRepos = status === 'ok' || status === 'rate-limited' || status === 'error';
  const repos = keepRepos && Array.isArray(group.repos)
    ? group.repos.flatMap(row => {
      const parsed = parseRepo(row);
      return parsed ? [parsed] : [];
    })
    : [];
  const line = githubOrgLine(group.owner, groupAccess(group, status));
  return {
    owner: group.owner,
    kind: group.kind,
    status,
    repos,
    text: line.text,
    ...(line.href ? { href: line.href } : {}),
  };
}

export function catalogFromWire(body: unknown): RepoCatalog {
  if (!body || typeof body !== 'object') return degradedCatalog();
  const raw = body as Record<string, unknown>;
  if (raw.status === 'reconnect') {
    const reconnect = raw.reconnect;
    const sentence = reconnect && typeof reconnect === 'object' && typeof (reconnect as { sentence?: unknown }).sentence === 'string'
      ? (reconnect as { sentence: string }).sentence
      : 'Reconnect GitHub in Settings';
    return { ok: false, groups: [], notice: sentence };
  }
  if (raw.status !== 'ok' || !Array.isArray(raw.groups)) return degradedCatalog();
  return {
    ok: true,
    notice: null,
    groups: raw.groups.flatMap(group => {
      const parsed = parseGroup(group);
      return parsed ? [parsed] : [];
    }),
  };
}
