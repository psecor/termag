/**
 * What the gateway's ext_authz checks share (routes/gatewayCheck.ts): the box
 * a token names, and a decision Envoy acts on. An allow's headers go back to
 * Envoy (the ones it forwards upstream or logs); a refusal's status and
 * message go back to the box's client as they are.
 */

export interface AuthzBox {
  userId: string;
  instanceId: string;
  // An owned EC2 box: the only kind the gateway serves.
  managed: boolean;
  email?: string;
  /**
   * An ownerless EC2 box's row as the token resolved it, now: its status and
   * the environment it was launched for (null outside an environment pool).
   * Only the GitHub broker reads it, for the environment pool's rule
   * (services/githubAuthz.ts); every other gateway refuses on `managed`.
   */
  /**
   * An ownerless pool box's row. `repos`: the repositories an environment pool
   * box was launched to prepare (Instance.poolRepos, owner/name), which the
   * broker's pool rule reads in place of resolving the environment again.
   */
  pool?: { status: string; environmentId: string | null; repos?: readonly string[] | null };
}

export type AuthzDecision =
  | { allow: true; headers: Record<string, string>; audit: string }
  | { allow: false; status: number; message: string; audit: string; headers?: Record<string, string> };

// Who a token belongs to, or null for an unknown or revoked token.
export type BoxForToken = (token: string) => Promise<AuthzBox | null>;
