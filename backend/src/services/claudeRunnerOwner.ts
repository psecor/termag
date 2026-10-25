/**
 * Auto-user: the termag user a Claude cloud session's owner becomes when
 * they never signed in.
 *
 * The spawn route resolves the session owner's email to a `User`; today a
 * missing row is the non-retryable 404 the hook turns into "sign in to termag
 * once". Behind `claude-runner-auto-user-enabled` the route creates the row instead,
 * with the same `ALLOWED_USERS` resolver sign-in uses, so an engineer who has
 * never opened termag gets a session from one prompt. A later sign-in (Okta,
 * OIDC or Google) finds the row by email and updates it (routes/auth.ts,
 * upsertUserByEmail); nothing is created twice.
 *
 * The decision is pure (planAutoUser) and the one write handles the two
 * uniques that can bite: a burst of spawns racing to create the same person
 * (re-read by email: the first one's row is the user), and the derived unix
 * username already belonging to another email (a collision: no row, 404).
 */
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../db';
import { resolveUnixUsername, type AllowedUsersConfig } from '../auth/allowedUsers';
import { findUserByEmail } from './userByEmail';
import { getSlackApp } from '../slack/app';

/** The subset of Slack's web client this module uses. */
export interface SlackUserLookup {
  users: { lookupByEmail: (args: { email: string }) => Promise<{ user?: { real_name?: string; profile?: { real_name?: string } } }> };
}

/**
 * What Slack calls the person, when the Slack app is up and knows the email;
 * null otherwise, and on any error. The display name is set once at creation
 * and a warm claim copies it onto the box as the git author, so the email's
 * local part is the fallback, not the default (open question 3).
 */
export async function slackRealName(email: string, client: SlackUserLookup | null | undefined = getSlackApp()?.client): Promise<string | null> {
  if (!client) return null;
  try {
    const res = await client.users.lookupByEmail({ email });
    const name = res.user?.real_name ?? res.user?.profile?.real_name ?? null;
    return name && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** The placeholder provider id prefix: `claude:<account id>`. A sign-in replaces it with `okta:`/`oidc:`/the Google id. */
export const AUTO_USER_ID_PREFIX = 'claude:';

export interface AutoUserPlan {
  unixUsername: string;
  googleId: string;
  displayName: string;
}

/**
 * The row to create for `email`, or null when the allowlist does not admit
 * it. `accountId` is the creator's Anthropic account id (required: the
 * placeholder identity must be the creator's, not the email's); `realName`
 * is what Slack knows them as, when it does, else the email's local part.
 */
export function planAutoUser(email: string, accountId: string, allowed: AllowedUsersConfig, realName: string | null = null): AutoUserPlan | null {
  const unixUsername = resolveUnixUsername(allowed, email);
  if (!unixUsername) return null;
  const localPart = email.slice(0, email.lastIndexOf('@')) || email;
  const displayName = realName?.trim() || localPart;
  return { unixUsername, googleId: `${AUTO_USER_ID_PREFIX}${accountId}`, displayName };
}

/**
 * The flag context for an owner who has no row yet (U8): a stable key
 * that is not personal data. `unixUsername` is the one the allowlist derives
 * for the email, when the caller has it, so a rule on that attribute reads
 * the same before the row exists as `flagIdentity` reads it afterwards
 * (Bugbot on #288).
 */
export function pendingOwnerContext(accountId: string, email: string, unixUsername: string = ''): { id: string; googleEmail: string; displayName: string; unixUsername: string; defaultAgentProvider: string } {
  return { id: `${AUTO_USER_ID_PREFIX}${accountId}`, googleEmail: email, displayName: '', unixUsername, defaultAgentProvider: 'claude' };
}

/**
 * The flag identity for a user: their own id, or, while their
 * provider id is still the `claude:<account id>` placeholder, that
 * placeholder, which is the key the flags were read on before the row
 * existed (U8). One key per person until sign-in replaces the placeholder,
 * so a rule targeting `claude:<id>` decides creation and the box alike.
 */
export function flagIdentity<T extends { id: string; googleId?: string | null }>(user: T): T {
  return user.googleId && user.googleId.startsWith(AUTO_USER_ID_PREFIX) ? { ...user, id: user.googleId } : user;
}

export type AutoUserOutcome =
  | { kind: 'created'; user: User }
  /** A burst's earlier spawn created the row first: it is the user. */
  | { kind: 'existing'; user: User }
  /** The derived unix username belongs to another email; no row was made. */
  | { kind: 'collision'; unixUsername: string }
  /**
   * This account id's placeholder row exists under another email. The body's
   * email is not proof of who the account is (the spawn token's holder writes
   * it), so the row is neither moved nor used: a refusal, until the
   * work order's claims can be verified.
   */
  | { kind: 'account-bound'; unixUsername: string }
  | { kind: 'not-allowed' };

const isUnique = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Create the owner's row from the plan, or say why not. Any unique violation
 * is settled by re-reading: a row for the email exists (`existing`; a burst's
 * earlier spawn made it), or a row with this account's placeholder id exists
 * under another email (`account-bound`: refused, never rebound from the
 * body), or neither does and the username is taken (`collision`). Callers
 * serialize per email (serializeByKey), so this is for the race the lock
 * cannot cover (another process, or sign-in landing at the same moment).
 */
export async function createOwnerFromAllowlist(
  input: { email: string; accountId: string; realName?: string | null },
  allowed: AllowedUsersConfig,
): Promise<AutoUserOutcome> {
  const plan = planAutoUser(input.email, input.accountId, allowed, input.realName ?? null);
  if (!plan) return { kind: 'not-allowed' };
  try {
    const user = await prisma.user.create({
      data: { googleId: plan.googleId, googleEmail: input.email, unixUsername: plan.unixUsername, displayName: plan.displayName },
    });
    return { kind: 'created', user };
  } catch (err) {
    if (!isUnique(err)) throw err;
    const existing = await findUserByEmail(input.email);
    if (existing) return { kind: 'existing', user: existing };
    const bound = await prisma.user.findUnique({ where: { googleId: plan.googleId }, select: { unixUsername: true } });
    // The account's placeholder row is someone else's email as far as termag
    // can tell: the request's email is written by whoever holds the spawn
    // token, so moving the row onto it, or placing the session as that row,
    // would let that holder rebind an engineer who has not signed in yet
    // (the Security Agent on #288). Refused; sign-in's own path handles a
    // real rename.
    if (bound) return { kind: 'account-bound', unixUsername: bound.unixUsername };
    return { kind: 'collision', unixUsername: plan.unixUsername };
  }
}
