/**
 * Environments as objects. An environment is a name
 * and one definition, environment.json's JSON, in one of two forms (decided
 * 2026-10-29, the person):
 *
 *   inline   the JSON stored here, set and edited in the UI;
 *   pointer  `repo : branch : path`, a file read from that branch (else the
 *            repository's default) when a box is made.
 *
 * Either way the definition lists the repositories a project made from it
 * holds (`repos`; a pointer's file repository is one of them on its own) and
 * what its box needs (`resources` today), read by
 * services/repoEnvironment.ts parseEnvironmentData and
 * resolveEnvironmentDefinition. An inline definition is checked when it is
 * saved; a pointer's file when it is read, where anything it can't use is a
 * warning, never a failure.
 *
 * Shared: anyone signed in can see, use and edit every environment, so every
 * create, edit and delete writes an EnvironmentEvent (who, when, the stored
 * fields before and after) in the same transaction as the change. The events
 * have no foreign key and are never pruned, so a deleted environment's
 * history stays readable.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { repoKey } from './boxSize';
import { findSecretsInText } from './secretPatterns';
import { repoOrgs } from './githubRepos';
import { isBranchName } from './repoCreate';
import {
  parseEnvironmentData, parseRepoEnvironment, REPO_ENVIRONMENT_PATH, repoEnvironment, resolveEnvironmentDefinition,
  type EnvironmentRepo, type RepoEnvironmentReader, type ResolvedEnvironment,
} from './repoEnvironment';

export type { EnvironmentRepo } from './repoEnvironment';

export const ENVIRONMENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ENVIRONMENT_NAME_ERROR = 'an environment name is up to 40 lowercase letters, digits and dashes, starting with a letter or digit';
const MAX_PATH_CHARS = 200;
const PATH_RE = /^[A-Za-z0-9._/-]+$/;
/** An inline definition's most JSON, as a file's (services/repoEnvironment.ts reads files up to 16 KiB). */
const MAX_DEFINITION_BYTES = 16 * 1024;

/** A pointer: the file's repository (owner/name, lower case), its branch (null: the default) and path. */
export interface EnvironmentFile {
  repo: string;
  branch: string | null;
  path: string;
}

/** What is stored, and what an event's before and after hold. */
export type EnvironmentFields =
  | { name: string; kind: 'inline'; definition: Record<string, unknown> }
  | { name: string; kind: 'pointer'; file: EnvironmentFile };

/** Personal: only its owner sees, uses, edits or deletes it. Shared: everyone signed in sees and uses it (sharedRuleError). */
export type EnvironmentVisibility = 'personal' | 'shared';

export type EnvironmentRecord = EnvironmentFields & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  visibility: EnvironmentVisibility;
  /** Its creator; the one who switches it between personal and shared, and the only one who sees a personal one. */
  ownerUserId: string | null;
};

/** An event's before or after: the stored fields, with whose it was and who could see it. */
export type EnvironmentSnapshot = EnvironmentFields & { visibility?: EnvironmentVisibility; ownerUserId?: string | null };

export type EnvironmentAction = 'environment.create' | 'environment.update' | 'environment.delete' | 'environment.visibility';

export interface EnvironmentEventRecord {
  id: string;
  at: Date;
  environmentId: string;
  actorUserId: string;
  action: EnvironmentAction;
  before: EnvironmentSnapshot | null;
  after: EnvironmentSnapshot | null;
}

/** A path in a repository: relative, no `..`, no empty segments. */
function filePathError(value: string): string | null {
  if (!value || value.length > MAX_PATH_CHARS) return `the file's path is 1 to ${MAX_PATH_CHARS} characters`;
  if (!PATH_RE.test(value)) return "the file's path is letters, digits, '.', '_', '-' and '/'";
  const parts = value.split('/');
  if (value.startsWith('/') || parts.some(p => p === '' || p === '.' || p === '..')) {
    return "the file's path is relative to the repository's root, with no '.' or '..' parts";
  }
  return null;
}

/**
 * The repositories (owner/name) not in our GitHub orgs (githubRepos.ts repoOrgs, GITHUB_REPO_ORGS): an environment's
 * steps run on their own once it's picked, so its repositories are only ours (decision #58, #998).
 */
export function reposOutsideOrgs(repos: readonly string[], orgs: readonly string[] = repoOrgs()): string[] {
  const ours = new Set(orgs.map(o => o.toLowerCase()));
  return repos.filter(r => !ours.has(r.split('/')[0].toLowerCase()));
}

function outsideOrgsError(repos: readonly string[]): string {
  return `${repos.join(', ')} ${repos.length > 1 ? 'are' : 'is'} not in our GitHub orgs (${repoOrgs().join(', ')}): an environment's repositories are theirs`;
}

/** An inline definition: a JSON object (or its text) that parseEnvironmentData takes without a warning, naming at least one repository. */
export function parseDefinition(value: unknown): { ok: true; definition: Record<string, unknown> } | { ok: false; error: string } {
  let data = value;
  if (typeof value === 'string') {
    try { data = JSON.parse(value); } catch { return { ok: false, error: 'the definition is not valid JSON' }; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'the definition is a JSON object' };
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_DEFINITION_BYTES) return { ok: false, error: `the definition is over ${MAX_DEFINITION_BYTES / 1024} KiB` };
  // Anyone signed in reads a definition, and its history keeps every version with no purge, so nothing
  // secret-shaped is stored (as handoffs refuse it): one value per line, for the line-based patterns.
  const secrets = findSecretsInText(JSON.stringify(data, null, 1));
  if (secrets.length) {
    return { ok: false, error: `the definition holds what looks like a secret (${secrets.join(', ')}); every signed-in person can read it and its history, so keep it out, and have the box supply it` };
  }
  const parsed = parseEnvironmentData(data, 'the definition');
  // A file's warnings end "so it was ignored"; a save is refused outright, so the reason alone.
  if (parsed.warnings.length) return { ok: false, error: parsed.warnings.map(w => w.replace(/,? so (?:it|\S+) was (?:ignored|left out)(?:; .*)?$/, '')).join('; ') };
  if (!parsed.repos?.length) return { ok: false, error: 'the definition names at least one repository, in "repos": [{ "repo": "owner/name" }]' };
  const outside = reposOutsideOrgs(parsed.repos.map(r => r.repo));
  if (outside.length) return { ok: false, error: outsideOrgsError(outside) };
  return { ok: true, definition: data as Record<string, unknown> };
}

/**
 * A create's or edit's body as the fields to store, or why not:
 * `{ name, kind: 'inline', definition }` or
 * `{ name, kind: 'pointer', file: { repo, branch?, path? } }`. A pointer's
 * path defaults to the implicit environment's `.termag/environment.json`.
 */
export function parseEnvironmentInput(body: unknown): { ok: true; fields: EnvironmentFields } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!ENVIRONMENT_NAME_RE.test(name)) return { ok: false, error: ENVIRONMENT_NAME_ERROR };
  if (b.kind === 'inline') {
    const d = parseDefinition(b.definition);
    return d.ok ? { ok: true, fields: { name, kind: 'inline', definition: d.definition } } : d;
  }
  if (b.kind !== 'pointer') return { ok: false, error: 'kind is inline (a definition) or pointer (a file in a repository)' };
  const f = (b.file && typeof b.file === 'object' ? b.file : {}) as Record<string, unknown>;
  const repo = typeof f.repo === 'string' ? repoKey(f.repo) : null;
  if (!repo) return { ok: false, error: `${JSON.stringify(f.repo ?? null)} is not a GitHub repository (owner/name)` };
  const branch = typeof f.branch === 'string' && f.branch.trim() ? f.branch.trim() : null;
  if (f.branch != null && typeof f.branch !== 'string') return { ok: false, error: "the file's branch must be text" };
  if (branch && !isBranchName(branch)) return { ok: false, error: `"${branch}" is not a branch name` };
  const path = typeof f.path === 'string' && f.path.trim() ? f.path.trim() : REPO_ENVIRONMENT_PATH;
  const badPath = filePathError(path);
  if (badPath) return { ok: false, error: badPath };
  if (reposOutsideOrgs([repo]).length) return { ok: false, error: outsideOrgsError([repo]) };
  return { ok: true, fields: { name, kind: 'pointer', file: { repo, branch, path } } };
}

/** JSON with every object's keys sorted, so a definition Postgres stored (JSONB reorders keys) compares equal to the one sent. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Whether two stored forms say the same thing, so an edit that changes nothing writes no event. */
export function sameFields(a: EnvironmentFields, b: EnvironmentFields): boolean {
  return canonical(fieldsOf(a)) === canonical(fieldsOf(b));
}

/** Only the stored fields (an event's before and after). */
export function fieldsOf(e: EnvironmentFields): EnvironmentFields {
  return e.kind === 'inline'
    ? { name: e.name, kind: 'inline', definition: e.definition }
    : { name: e.name, kind: 'pointer', file: { repo: e.file.repo, branch: e.file.branch, path: e.file.path } };
}

export type EnvironmentWrite =
  | { ok: true; environment: EnvironmentRecord; changed: boolean }
  | { ok: false; reason: 'not_found' | 'name_taken' | 'changed' };

/**
 * Where environments live. Every write records its event in the same
 * transaction; `expectedUpdatedAt`, when given, refuses an edit or delete of
 * an environment someone else changed since (`changed`).
 */
export interface EnvironmentStore {
  list(): Promise<EnvironmentRecord[]>;
  get(id: string): Promise<EnvironmentRecord | null>;
  byName(name: string): Promise<EnvironmentRecord | null>;
  /** The actor owns what they create; personal unless `visibility` says shared (checked first, sharedRuleError). */
  create(actorUserId: string, fields: EnvironmentFields, visibility?: EnvironmentVisibility): Promise<EnvironmentWrite>;
  /** Personal or shared: the owner's switch (the routes check who may, and the shared rules). */
  setVisibility(actorUserId: string, id: string, visibility: EnvironmentVisibility, expectedUpdatedAt?: Date): Promise<EnvironmentWrite>;
  update(actorUserId: string, id: string, fields: EnvironmentFields, expectedUpdatedAt?: Date): Promise<EnvironmentWrite>;
  remove(actorUserId: string, id: string, expectedUpdatedAt?: Date): Promise<EnvironmentWrite>;
  /** Newest first: one environment's, or with none every environment's (the audit log), at most `limit`, from `skip` on. */
  events(environmentId: string | null, limit?: number, skip?: number): Promise<EnvironmentEventRecord[]>;
}

type Row = {
  id: string; name: string; kind: string; definition: Prisma.JsonValue; fileRepo: string | null; fileBranch: string | null; filePath: string | null;
  createdAt: Date; updatedAt: Date; createdByUserId: string | null; updatedByUserId: string | null; visibility: string | null; ownerUserId: string | null;
};

/**
 * What a row with no visibility reads as until backfillEnvironmentVisibility has decided it: a pointer on its
 * repository's default branch (no branch named) shared, anything else personal; either way owned by its creator.
 */
export function legacyVisibility(row: Pick<Row, 'kind' | 'fileBranch'>): EnvironmentVisibility {
  return row.kind === 'pointer' && !row.fileBranch ? 'shared' : 'personal';
}

function fromRow(row: Row): EnvironmentRecord {
  const meta = {
    id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, createdByUserId: row.createdByUserId, updatedByUserId: row.updatedByUserId,
    visibility: (row.visibility == null ? legacyVisibility(row) : row.visibility === 'shared' ? 'shared' : 'personal') as EnvironmentVisibility,
    ownerUserId: row.visibility == null ? row.ownerUserId ?? row.createdByUserId : row.ownerUserId,
  };
  if (row.kind === 'inline') {
    const definition = row.definition && typeof row.definition === 'object' && !Array.isArray(row.definition) ? row.definition as Record<string, unknown> : {};
    return { ...meta, name: row.name, kind: 'inline', definition };
  }
  return { ...meta, name: row.name, kind: 'pointer', file: { repo: row.fileRepo ?? '', branch: row.fileBranch, path: row.filePath ?? REPO_ENVIRONMENT_PATH } };
}

/** The columns a write sets: one form's, the other's cleared. */
function columns(f: EnvironmentFields) {
  return f.kind === 'inline'
    ? { name: f.name, kind: 'inline', definition: f.definition as Prisma.InputJsonValue, fileRepo: null, fileBranch: null, filePath: null }
    : { name: f.name, kind: 'pointer', definition: Prisma.DbNull, fileRepo: f.file.repo, fileBranch: f.file.branch, filePath: f.file.path };
}

const asJson = (f: EnvironmentFields | null, who?: { visibility: EnvironmentVisibility; ownerUserId: string | null }) =>
  (f ? { ...fieldsOf(f), ...(who ? { visibility: who.visibility, ownerUserId: who.ownerUserId } : {}) } as unknown as Prisma.InputJsonValue : Prisma.DbNull);

class Refused extends Error {
  constructor(readonly reason: 'not_found' | 'changed') { super(reason); }
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** The most events one read returns (the audit log's page). */
export const MAX_EVENTS = 500;

export const prismaEnvironmentStore: EnvironmentStore = {
  async list() {
    return (await prisma.environment.findMany({ orderBy: { name: 'asc' } })).map(fromRow);
  },
  async get(id) {
    const row = await prisma.environment.findUnique({ where: { id } });
    return row ? fromRow(row) : null;
  },
  async byName(name) {
    const row = await prisma.environment.findUnique({ where: { name: name.trim().toLowerCase() } });
    return row ? fromRow(row) : null;
  },
  async create(actorUserId, fields, visibility = 'personal') {
    const f = fieldsOf(fields);
    const who = { visibility, ownerUserId: actorUserId };
    try {
      const row = await prisma.$transaction(async tx => {
        const created = await tx.environment.create({ data: { ...columns(f), createdByUserId: actorUserId, updatedByUserId: actorUserId, ...who } });
        await tx.environmentEvent.create({ data: { environmentId: created.id, actorUserId, action: 'environment.create', before: Prisma.DbNull, after: asJson(f, who) } });
        return created;
      });
      return { ok: true, environment: fromRow(row), changed: true };
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'name_taken' };
      throw err;
    }
  },
  async update(actorUserId, id, fields, expectedUpdatedAt) {
    const f = fieldsOf(fields);
    try {
      return await prisma.$transaction(async tx => {
        const current = await tx.environment.findUnique({ where: { id } });
        if (!current) throw new Refused('not_found');
        if (expectedUpdatedAt && current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new Refused('changed');
        const before = fromRow(current);
        if (sameFields(before, f)) return { ok: true as const, environment: before, changed: false };
        // Guarded on the version read, so two edits at once can't both pass the check above.
        const { count } = await tx.environment.updateMany({ where: { id, updatedAt: current.updatedAt }, data: { ...columns(f), updatedByUserId: actorUserId } });
        if (count === 0) throw new Refused('changed');
        await tx.environmentEvent.create({ data: { environmentId: id, actorUserId, action: 'environment.update', before: asJson(before, before), after: asJson(f, before) } });
        return { ok: true as const, environment: fromRow(await tx.environment.findUniqueOrThrow({ where: { id } })), changed: true };
      });
    } catch (err) {
      if (err instanceof Refused) return { ok: false, reason: err.reason };
      if (isUniqueViolation(err)) return { ok: false, reason: 'name_taken' };
      throw err;
    }
  },
  async remove(actorUserId, id, expectedUpdatedAt) {
    try {
      return await prisma.$transaction(async tx => {
        const current = await tx.environment.findUnique({ where: { id } });
        if (!current) throw new Refused('not_found');
        if (expectedUpdatedAt && current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new Refused('changed');
        const { count } = await tx.environment.deleteMany({ where: { id, updatedAt: current.updatedAt } });
        if (count === 0) throw new Refused('changed');
        const before = fromRow(current);
        await tx.environmentEvent.create({ data: { environmentId: id, actorUserId, action: 'environment.delete', before: asJson(before, before), after: Prisma.DbNull } });
        return { ok: true as const, environment: before, changed: true };
      });
    } catch (err) {
      if (err instanceof Refused) return { ok: false, reason: err.reason };
      throw err;
    }
  },
  async setVisibility(actorUserId, id, visibility, expectedUpdatedAt) {
    try {
      return await prisma.$transaction(async tx => {
        const current = await tx.environment.findUnique({ where: { id } });
        if (!current) throw new Refused('not_found');
        if (expectedUpdatedAt && current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new Refused('changed');
        const before = fromRow(current);
        if (before.visibility === visibility) return { ok: true as const, environment: before, changed: false };
        const { count } = await tx.environment.updateMany({ where: { id, updatedAt: current.updatedAt }, data: { visibility, updatedByUserId: actorUserId } });
        if (count === 0) throw new Refused('changed');
        await tx.environmentEvent.create({ data: {
          environmentId: id, actorUserId, action: 'environment.visibility', before: asJson(before, before), after: asJson(before, { visibility, ownerUserId: before.ownerUserId }),
        } });
        return { ok: true as const, environment: fromRow(await tx.environment.findUniqueOrThrow({ where: { id } })), changed: true };
      });
    } catch (err) {
      if (err instanceof Refused) return { ok: false, reason: err.reason };
      throw err;
    }
  },
  async events(environmentId, limit = MAX_EVENTS, skip = 0) {
    const rows = await prisma.environmentEvent.findMany({
      where: environmentId ? { environmentId } : {}, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: Math.min(limit, MAX_EVENTS), skip,
    });
    return rows.map(r => ({
      id: r.id, at: r.at, environmentId: r.environmentId, actorUserId: r.actorUserId, action: r.action as EnvironmentAction,
      before: r.before as unknown as EnvironmentSnapshot | null, after: r.after as unknown as EnvironmentSnapshot | null,
    }));
  },
};

/**
 * What a project made from an environment records of its definition, for the
 * box's steps (Project.environmentFile, services/projectEnvironment.ts): an
 * inline definition's JSON as `text`, else the pointer (its repository, branch
 * and path). Either way the definition lists the repositories (`repos`).
 */
export interface ProjectEnvironmentFile { name: string; repo?: string; branch?: string; path?: string; text?: string; editedBy?: string }

/**
 * The record for `env`. The one place the steps read an environment's shape:
 * an inline definition's JSON as the text the box runs, else the pointer
 * (repo, branch, path), which the orchestrator reads again at claim, at its
 * branch (services/projectEnvironment.ts).
 */
export function environmentFileRecord(env: EnvironmentFields & { updatedByUserId?: string | null; createdByUserId?: string | null }, readText?: string): ProjectEnvironmentFile {
  // Who wrote the version the project is made from: its steps start on their own only for that person's
  // projects (services/projectEnvironment.ts environmentUpRequest; Security Agent, #998).
  const editor = env.updatedByUserId ?? env.createdByUserId ?? null;
  const editedBy = editor ? { editedBy: editor } : {};
  // Compact, as it was size-checked on save: pretty-printed it can pass the box's 16 KiB cap (Bugbot, #998).
  if (env.kind === 'inline') return { name: env.name, text: JSON.stringify(env.definition), ...editedBy };
  // A pointer: with the text its resolve read, so the create freezes that rather than reading it again (Bugbot, #998).
  return { name: env.name, repo: env.file.repo, ...(env.file.branch ? { branch: env.file.branch } : {}), path: env.file.path, ...(readText !== undefined ? { text: readText } : {}), ...editedBy };
}

/** The GitHub URL a project clones an environment repository from. */
export function environmentRepoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

/**
 * What a project made from an environment's repositories is created with:
 * one is a single-repository project (its branch as the default branch; a
 * checkout path has nothing to name there), two or more a multi-repo project
 * of exactly those, each checked out at its path.
 */
export function projectSourceFor(repos: readonly EnvironmentRepo[]):
  | { repoUrl: string; defaultBranch: string | null }
  | { repos: Array<{ url: string; name?: string; defaultBranch?: string }> } {
  if (repos.length === 1) {
    const [only] = repos;
    return { repoUrl: environmentRepoUrl(only.repo), defaultBranch: only.branch ?? null };
  }
  return {
    repos: repos.map(r => ({
      url: environmentRepoUrl(r.repo),
      ...(r.path ? { name: r.path } : {}),
      ...(r.branch ? { defaultBranch: r.branch } : {}),
    })),
  };
}

/** The refusal for a create that names an environment there is none of. */
export function unknownEnvironment(name: string): { status: 404; body: { error: string; code: 'environment_not_found' } } {
  return { status: 404, body: { error: `There is no environment named "${name}"`, code: 'environment_not_found' } };
}

/** An environment named in a create (`environment`): its record, a 404, or a 400 for a value that isn't a name. */
export async function resolveEnvironment(
  store: Pick<EnvironmentStore, 'byName'>, value: unknown, viewerId: string,
): Promise<{ environment: EnvironmentRecord } | { status: 400 | 404; body: { error: string; code: string } }> {
  if (typeof value !== 'string' || !value.trim()) {
    return { status: 400, body: { error: 'environment must be an environment name', code: 'invalid_request' } };
  }
  const env = await store.byName(value);
  // Someone else's personal environment is no environment of theirs: the same answer as none by that name.
  return env && visibleTo(env, viewerId) ? { environment: env } : unknownEnvironment(value.trim());
}

/**
 * The environment named `value` as `viewerId` runs it: resolveEnvironment's, and a shared one only while it keeps to
 * the shared rules against the default branches GitHub has now (400 environment_not_shareable otherwise).
 */
export async function usableEnvironment(
  store: Pick<EnvironmentStore, 'byName'>, value: unknown, viewerId: string, github?: DefaultBranchReader,
): Promise<{ environment: EnvironmentRecord } | { status: 400 | 404; body: { error: string; code: string } }> {
  const found = await resolveEnvironment(store, value, viewerId);
  if (!('environment' in found) || found.environment.visibility !== 'shared') return found;
  const broken = await sharedRuleError(viewerId, found.environment, github ?? repoEnvironment);
  return broken ? { status: 400, body: { error: `${found.environment.name}: ${broken}`, code: 'environment_not_shareable' } } : found;
}

/** Whether `userId` sees, and may use, an environment: a shared one, or their own personal one. */
export function visibleTo(env: Pick<EnvironmentRecord, 'visibility' | 'ownerUserId'>, userId: string): boolean {
  return env.visibility === 'shared' || env.ownerUserId === userId;
}

/** What the shared rules read from GitHub: a repository's default branch, and a file's text at it. */
export type DefaultBranchReader = Pick<RepoEnvironmentReader, 'defaultBranch' | 'text'>;

/**
 * Why `fields` can't be a shared environment, or null when it can. A shared environment runs on anyone's box, so it
 * runs only what its repositories' own review and push rules let onto their default branch: it is a pointer to a file
 * on its repository's default branch (no inline JSON, no other branch), and that file checks out every repository it
 * names on that repository's default branch. The default branches are GitHub's, read now (`userId`'s credential).
 */
export async function sharedRuleError(userId: string, fields: EnvironmentFields, github: DefaultBranchReader = repoEnvironment): Promise<string | null> {
  if (fields.kind !== 'pointer') {
    return "a shared environment runs from a file on a repository's default branch, not inline JSON; point it at .termag/environment.json on its repository's default branch";
  }
  const { repo, branch, path } = fields.file;
  const def = await github.defaultBranch(userId, repo);
  if ('error' in def) return `couldn't check ${repo}'s default branch (${def.error}); a shared environment runs from a file on it`;
  if (branch && branch !== def.branch) return `a shared environment runs from a file on ${repo}'s default branch; point it at ${path} on ${def.branch}`;
  const file = await github.text(userId, repo, path, def.branch);
  if ('error' in file) return `a shared environment runs from a file on ${repo}'s default branch: ${file.error}`;
  for (const r of parseRepoEnvironment(file.text, repo, path).repos ?? []) {
    if (!r.branch) continue;
    const theirs = r.repo === repo ? def : await github.defaultBranch(userId, r.repo);
    if ('error' in theirs) return `couldn't check ${r.repo}'s default branch (${theirs.error}); a shared environment checks out every repository on it`;
    if (r.branch !== theirs.branch) return `a shared environment checks out every repository on its default branch; ${r.repo} names ${r.branch}, not ${theirs.branch}`;
  }
  return null;
}

/** Resolves a stored environment for `userId` (pointer files with their GitHub credential). */
export type EnvironmentResolver = (userId: string, env: EnvironmentFields) => Promise<ResolvedEnvironment>;

export const resolveStoredEnvironment: EnvironmentResolver = (userId, env) => resolveEnvironmentDefinition(userId, env);

/**
 * Decides every environment with no visibility: shared, owned by its creator, when it keeps to the shared rules as
 * its creator reads GitHub (sharedRuleError), else personal to its creator. Run at startup; idempotent, and a row
 * someone switched meanwhile keeps their choice. No audit event: nobody changed it. Returns the counts it wrote.
 */
export async function backfillEnvironmentVisibility(github: DefaultBranchReader = repoEnvironment): Promise<{ shared: number; personal: number }> {
  const rows = await prisma.environment.findMany({ where: { visibility: null } });
  const counts = { shared: 0, personal: 0 };
  for (const row of rows) {
    const env = fromRow(row);
    const visibility: EnvironmentVisibility = row.createdByUserId && !(await sharedRuleError(row.createdByUserId, env, github)) ? 'shared' : 'personal';
    // Raw, so updatedAt (an open editor's version) stays as it was.
    const n = await prisma.$executeRaw`UPDATE "environments" SET "visibility" = ${visibility}, "ownerUserId" = COALESCE("ownerUserId", "createdByUserId") WHERE "id" = ${row.id} AND "visibility" IS NULL`;
    if (n) counts[visibility]++;
  }
  return counts;
}

/**
 * `environmentRepos` as `owner/name@branch` keys (empty branch: the default),
 * or null when it isn't a list of `owner/name` strings or `{ repo, branch? }`.
 */
function checkoutKeys(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const v of value) {
    const entry = (typeof v === 'string' ? { repo: v } : v) as { repo?: unknown; branch?: unknown } | null;
    if (!entry || typeof entry !== 'object' || typeof entry.repo !== 'string') return null;
    if (entry.branch != null && typeof entry.branch !== 'string') return null;
    keys.push(`${repoKey(entry.repo) ?? entry.repo}@${entry.branch ?? ''}`);
  }
  return keys;
}

/**
 * A project create's input with `environment` replaced by the repositories
 * that environment resolves to (projectSourceFor), or the refusal: an
 * unknown name, a create that names repositories too, or an environment that
 * resolves to none. Input without one comes back as it is.
 */
export async function withEnvironmentRepos<T extends { environment?: string | null; repoUrl?: string | null; repos?: unknown; defaultBranch?: string | null; environmentRepos?: unknown }>(
  store: Pick<EnvironmentStore, 'byName'>, userId: string, input: T, resolve: EnvironmentResolver = resolveStoredEnvironment,
  github?: DefaultBranchReader,
): Promise<{ input: Omit<T, 'environment' | 'environmentRepos'> & { environmentFile?: ProjectEnvironmentFile }; warnings: string[]; environmentId?: string } | { status: 400 | 404 | 409; body: { error: string; code: string } }> {
  const { environment, environmentRepos: shown, ...rest } = input;
  if (environment == null || environment === '') return { input: rest, warnings: [] };
  if (input.repoUrl || input.repos != null || input.defaultBranch != null) {
    return { status: 400, body: { error: 'An environment names its repositories; leave out repoUrl, repos and defaultBranch', code: 'invalid_request' } };
  }
  // Every create says which checkouts it was made for (GET …/resolved: each repository at its branch), and this one
  // resolution must be those. An ask of the project runs them without asking, as Full access does, whenever it comes,
  // so a change to the shared environment (or its pointer's file) in between would run code the caller never saw:
  // another repository, or the same one at a branch someone else can push to.
  const found = await usableEnvironment(store, environment, userId, github);
  if (!('environment' in found)) return found;
  const shownKeys = checkoutKeys(shown);
  if (!shownKeys) {
    return { status: 400, body: { error: 'A project from an environment needs environmentRepos: the repositories, each at its branch, it was made for', code: 'invalid_request' } };
  }
  const resolved = await resolve(userId, found.environment);
  if (!resolved.repos.length) {
    return { status: 400, body: { error: [`${found.environment.name} names no repository`, ...resolved.warnings].join('; '), code: 'environment_no_repos' } };
  }
  // One stored before the org rule, or a pointer whose file names another org's repository, makes no project.
  const outside = reposOutsideOrgs(resolved.repos.map(r => r.repo));
  if (outside.length) return { status: 400, body: { error: outsideOrgsError(outside), code: 'environment_repo_outside_orgs' } };
  if (shownKeys.join('\n') !== resolved.repos.map(r => `${r.repo}@${r.branch ?? ''}`).join('\n')) {
    return { status: 409, body: { error: `${found.environment.name}'s repositories changed since you looked; read them again`, code: 'environment_repos_changed' } };
  }
  // environmentId: which environment the checkouts came from, for the project row (its asks are capped, askService).
  // environmentFile: its definition, recorded on the project for the box's steps (services/projectEnvironment.ts).
  return { input: { ...rest, ...projectSourceFor(resolved.repos), environmentFile: environmentFileRecord(found.environment, resolved.text) }, warnings: resolved.warnings, environmentId: found.environment.id };
}
