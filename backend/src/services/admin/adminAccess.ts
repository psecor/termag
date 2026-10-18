/**
 * Admin authorization.
 *
 * A user is an admin when either
 *   - users.role = 'admin' with adminSource 'grant' (an admin granted it), or
 *   - their email matches ADMIN_USERS right now.
 * An env-sourced role is NOT trusted on its own: it is re-checked against the
 * live list on every request, so removing an email from ADMIN_USERS demotes
 * at once (when the process has re-read its env), and a brand-new sign-in on
 * the list is an admin on their very first request. The startup sync below
 * persists the env verdict so the directory shows it.
 */
import type { User } from '@prisma/client';
import { prisma } from '../../db';
import { parseAdminUsers, isAdminEmail, type AdminUsersConfig } from '../../auth/adminUsers';

let cached: { raw: string | undefined; config: AdminUsersConfig } | null = null;

export function adminUsersConfig(): AdminUsersConfig {
  const raw = process.env.ADMIN_USERS;
  if (!cached || cached.raw !== raw) cached = { raw, config: parseAdminUsers(raw) };
  return cached.config;
}

export type AdminCapableUser = Pick<User, 'id' | 'googleEmail' | 'role' | 'adminSource'>;

export function isAdminUser(user: AdminCapableUser | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin' && user.adminSource !== 'env') return true;
  return isAdminEmail(adminUsersConfig(), user.googleEmail);
}

/**
 * Pure: given every user's (id, email, role, adminSource), decide which rows
 * need promoting to env-admin and which env-admins need demoting because they
 * left ADMIN_USERS. 'grant' rows are never touched here.
 */
export function planAdminSync(
  config: AdminUsersConfig,
  users: Array<Pick<User, 'id' | 'googleEmail' | 'role' | 'adminSource'>>,
): { promote: string[]; demote: string[] } {
  const promote: string[] = [];
  const demote: string[] = [];
  for (const u of users) {
    const onList = isAdminEmail(config, u.googleEmail);
    if (onList && !(u.role === 'admin' && u.adminSource === 'env')) promote.push(u.id);
    else if (!onList && u.role === 'admin' && u.adminSource === 'env') demote.push(u.id);
  }
  return { promote, demote };
}

/** Startup sync of ADMIN_USERS into users.role / adminSource. */
export async function syncAdminBootstrap(): Promise<{ promoted: number; demoted: number }> {
  const config = adminUsersConfig();
  const users = await prisma.user.findMany({
    select: { id: true, googleEmail: true, role: true, adminSource: true },
  });
  const { promote, demote } = planAdminSync(config, users);
  if (promote.length) {
    await prisma.user.updateMany({ where: { id: { in: promote } }, data: { role: 'admin', adminSource: 'env' } });
  }
  if (demote.length) {
    await prisma.user.updateMany({ where: { id: { in: demote } }, data: { role: 'member', adminSource: null } });
  }
  if (promote.length || demote.length) {
    console.log(`[ADMIN] bootstrap: promoted ${promote.length}, demoted ${demote.length} (ADMIN_USERS)`);
  }
  return { promoted: promote.length, demoted: demote.length };
}

// users.lastSeenAt: written at most once per user per 5 minutes so the
// request path doesn't take a DB write on every call.
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const lastSeenWritten = new Map<string, number>();

export function touchLastSeen(userId: string): void {
  const now = Date.now();
  const prev = lastSeenWritten.get(userId) ?? 0;
  if (now - prev < LAST_SEEN_INTERVAL_MS) return;
  lastSeenWritten.set(userId, now);
  prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } }).catch(() => {
    lastSeenWritten.delete(userId);
  });
}
