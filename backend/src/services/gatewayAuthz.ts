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
}

export type AuthzDecision =
  | { allow: true; headers: Record<string, string>; audit: string }
  | { allow: false; status: number; message: string; audit: string; headers?: Record<string, string> };

// Who a token belongs to, or null for an unknown or revoked token.
export type BoxForToken = (token: string) => Promise<AuthzBox | null>;
