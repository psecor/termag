/**
 * Project icons' rows: storing an image
 * (checked by projectIcons.ts), choosing a project's icon, and the candidates
 * its picker offers, each with its image inline as a data: URI. Every read and write is by the
 * caller's id: an icon is its owner's alone, like the project it's on.
 */
import { prisma } from '../db';
import { checkIcon, iconChoiceOf, iconSrc, type IconChoice, type IconChoicePlan, type IconMime } from './projectIcons';
import type { RouteResult } from '../routes/routeResult';

/** An upload no project has shown for this long is deleted at the person's next upload. */
const UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;

/** What a person may upload: rasters only. An SVG reaches the server only from a repository, through the allowlist. */
export const UPLOAD_MIMES: readonly IconMime[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export type SavedIcon = { ok: true; id: string; mimeType: string } | { ok: false; error: string };

/**
 * Store an image as one of the person's icons: read from a repository (its
 * repoKey and path) or uploaded (repoKey ""). The same image again is the row
 * it already has.
 */
export async function saveIcon(
  userId: string, input: { data: Uint8Array; repoKey?: string; path?: string | null; only?: readonly IconMime[] },
): Promise<SavedIcon> {
  const checked = checkIcon(input.data);
  if (!checked.ok) return checked;
  if (input.only && !input.only.includes(checked.mimeType)) return { ok: false, error: 'Upload a PNG, JPEG, GIF or WebP image' };
  const repoKey = input.repoKey ?? '';
  const row = await prisma.projectIcon.upsert({
    where: { userId_repoKey_sha256: { userId, repoKey, sha256: checked.sha256 } },
    create: { userId, repoKey, path: input.path ?? null, sha256: checked.sha256, mimeType: checked.mimeType, data: checked.data },
    update: {},
    select: { id: true, mimeType: true },
  });
  return { ok: true, id: row.id, mimeType: row.mimeType };
}

/**
 * POST /api/user-projects/icons: an upload, a raster only (the picker sends a 128 × 128 PNG, 64 × 64 if that's over 32 KiB), stored like
 * any icon; the person's older uploads that no project shows are deleted.
 */
export async function saveUpload(userId: string, data: Uint8Array): Promise<SavedIcon> {
  const saved = await saveIcon(userId, { data, only: UPLOAD_MIMES });
  if (!saved.ok) return saved;
  await prisma.projectIcon.deleteMany({
    where: {
      userId, repoKey: '', id: { not: saved.id }, createdAt: { lt: new Date(Date.now() - UPLOAD_KEEP_MS) },
      projects: { none: {} },
    },
  });
  return saved;
}

export const PROJECT_NOT_FOUND = { error: 'No such project', code: 'user_project_not_found' } as const;

/**
 * PUT /api/user-projects/:id/icon: what the project shows. An image must be
 * one of the caller's icons. An upload the project showed before, which no
 * project shows now, is deleted.
 */
export async function setProjectIcon(userId: string, projectId: string, plan: Extract<IconChoicePlan, { ok: true }>): Promise<RouteResult> {
  const project = await prisma.userProject.findFirst({ where: { id: projectId, userId }, select: { id: true, iconId: true } });
  if (!project) return { status: 404, body: PROJECT_NOT_FOUND };
  if (plan.iconId) {
    const icon = await prisma.projectIcon.findFirst({ where: { id: plan.iconId, userId }, select: { id: true } });
    if (!icon) return { status: 404, body: { error: 'No such icon', code: 'project_icon_not_found' } };
  }
  // One transaction: the choice and the clean-up of the upload it leaves commit together, or neither does.
  const previous = project.iconId && project.iconId !== plan.iconId ? project.iconId : null;
  await prisma.$transaction([
    prisma.userProject.update({ where: { id: project.id }, data: { iconChoice: plan.iconChoice, iconId: plan.iconId } }),
    ...(previous ? [prisma.projectIcon.deleteMany({ where: { id: previous, userId, repoKey: '', projects: { none: {} } } })] : []),
  ]);
  return { status: 200, body: { ok: true } };
}

export interface IconCandidate {
  id: string;
  /** Where it was read from in its repository; null for an upload. */
  path: string | null;
  mimeType: string;
  /** The image, a data: URI (at most 32 KiB of image). */
  src: string;
}

export interface RepoIcons {
  repoKey: string;
  /** The candidate automatic shows for it, if any. */
  detectedId: string | null;
  /** When the repository was last read for icons; null: never. */
  checkedAt: string | null;
  candidates: IconCandidate[];
}

export interface ProjectIconsView {
  choice: IconChoice;
  imageId: string | null;
  /** The image it shows when it's an upload, which no repository offers. */
  upload: IconCandidate | null;
  repos: RepoIcons[];
}

const CANDIDATE_SELECT = { id: true, path: true, mimeType: true, repoKey: true, createdAt: true, data: true } as const;

/** Each repository's stored candidates, its detected one first, then by path. */
export async function repoIcons(userId: string, repos: ReadonlyArray<{ repoKey: string; iconId?: string | null; iconsCheckedAt?: Date | null }>): Promise<RepoIcons[]> {
  const keys = repos.map(r => r.repoKey);
  const rows = keys.length === 0 ? [] : await prisma.projectIcon.findMany({ where: { userId, repoKey: { in: keys } }, select: CANDIDATE_SELECT });
  return repos.map(r => {
    const mine = rows.filter(x => x.repoKey === r.repoKey)
      .sort((a, b) => Number(b.id === r.iconId) - Number(a.id === r.iconId) || (a.path ?? '').localeCompare(b.path ?? ''));
    return {
      repoKey: r.repoKey,
      detectedId: r.iconId && mine.some(x => x.id === r.iconId) ? r.iconId : null,
      checkedAt: r.iconsCheckedAt?.toISOString() ?? null,
      candidates: mine.map(x => ({ id: x.id, path: x.path, mimeType: x.mimeType, src: iconSrc(x) })),
    };
  });
}

/** The detected icon each repository has in the person's projects (any of them; they're stamped together). */
export async function storedRepoIcons(userId: string, repoKeys: readonly string[]): Promise<Map<string, string>> {
  const rows = repoKeys.length === 0 ? [] : await prisma.userProjectRepo.findMany({
    where: { repoKey: { in: [...repoKeys] }, userProject: { userId }, iconId: { not: null } }, select: { repoKey: true, iconId: true },
  });
  return new Map(rows.map(r => [r.repoKey, r.iconId as string]));
}

/** A project's repositories (null when it isn't the caller's): what its picker looks for icons in. */
export async function projectRepoKeys(userId: string, projectId: string): Promise<string[] | null> {
  const project = await prisma.userProject.findFirst({ where: { id: projectId, userId }, select: { repos: { select: { repoKey: true } } } });
  return project ? project.repos.map(r => r.repoKey) : null;
}

/** GET /api/user-projects/:id/icons: what its picker offers, and what it shows now. */
export async function projectIconsFor(userId: string, projectId: string): Promise<ProjectIconsView | null> {
  const project = await prisma.userProject.findFirst({
    where: { id: projectId, userId },
    select: {
      iconChoice: true, iconId: true,
      icon: { select: CANDIDATE_SELECT },
      repos: { select: { repoKey: true, iconId: true, iconsCheckedAt: true, position: true }, orderBy: { position: 'asc' } },
    },
  });
  if (!project) return null;
  const { choice, imageId } = iconChoiceOf(project);
  const upload = project.icon && project.icon.repoKey === ''
    ? { id: project.icon.id, path: null, mimeType: project.icon.mimeType, src: iconSrc(project.icon) } : null;
  return { choice, imageId, upload, repos: await repoIcons(userId, project.repos) };
}
