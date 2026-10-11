/**
 * What the CLI routes need from the database, as an interface so the routers
 * can be tested against an in-memory fake. The Prisma implementation is
 * services/cliStorePrisma.ts.
 */
import type { CliBox, CliProject, DeviceRow } from './cliViews';

export interface CliUser {
  id: string;
  googleEmail: string;
  unixUsername: string;
  displayName: string;
}

export interface CliSessionRecord extends DeviceRow {
  userId: string;
  user: CliUser;
}

/** The parts of routes/agentTokens.ts validateAgentToken's result a box credential is judged on. */
export interface ValidatedAgentTokenLike {
  user: CliUser | null;
  instance: { id: string } | null;
  token: { scope: string };
}

/**
 * Whether a validated `tmag_` token may act as a box credential on
 * /api/cli/v1. Only `agent` scope with an owner does: `admin` tokens (and any
 * scope added later) share the table and the prefix, but are not a box's.
 */
export function boxCredentialFromAgentToken(
  result: ValidatedAgentTokenLike | null,
): { user: CliUser; instanceId: string | null } | null {
  if (!result?.user || result.token.scope !== 'agent') return null;
  return { user: result.user, instanceId: result.instance?.id ?? null };
}

export interface CliStore {
  /** Create a device session, revoking the user's earlier live sessions on the same device name. */
  createSession(input: { userId: string; deviceName: string; tokenHash: string; tokenPrefix: string; now: Date }): Promise<CliSessionRecord>;
  findSessionByHash(tokenHash: string): Promise<CliSessionRecord | null>;
  /** By id: an access token's `jti`. */
  findSessionById(id: string): Promise<CliSessionRecord | null>;
  touchSession(id: string, now: Date): Promise<void>;
  revokeSession(id: string, now: Date): Promise<void>;
  /**
   * An owner-bound, `agent`-scoped token (a box's, or a legacy per-user one).
   * Ownerless warm tokens and other scopes are null.
   */
  validateAgentToken(rawToken: string): Promise<{ user: CliUser; instanceId: string | null } | null>;
  listBoxes(userId: string): Promise<CliBox[]>;
  listProjects(userId: string): Promise<CliProject[]>;
  listDevices(userId: string): Promise<DeviceRow[]>;
  revokeDevice(userId: string, id: string, now: Date): Promise<boolean>;
}
