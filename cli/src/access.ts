import { Api, type RefreshResponse } from './api.js';
import { saveLogin, type StoredLogin } from './credentials.js';

// Refresh this long before the access token lapses, so a request in flight never carries an expired one.
export const REFRESH_MARGIN_MS = 60_000;

export function expiresAtFrom(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

export interface FreshAccess {
  accessToken: string;
  /** On this machine's clock. */
  accessTokenExpiresAt: string;
}

/**
 * The login's access token, refreshed with its device token (and saved) when
 * missing, about to lapse (within REFRESH_MARGIN_MS, or `validForMs` when
 * that is longer), or `rejected`: the one the orchestrator just refused (its
 * signing key was retired, say), which no clock can tell. Expiry is on this
 * machine's clock (`expiresAtFrom`), so its skew from the orchestrator's
 * doesn't count.
 */
export async function freshAccess(
  deps: { host: string; credsPath: string; fetch: typeof fetch },
  login: StoredLogin,
  opts: { rejected?: string; validForMs?: number } = {},
): Promise<FreshAccess> {
  const expiresAt = Date.parse(login.accessTokenExpiresAt ?? '');
  const refused = opts.rejected !== undefined && login.accessToken === opts.rejected;
  const margin = Math.max(REFRESH_MARGIN_MS, opts.validForMs ?? 0);
  if (login.accessToken && login.accessTokenExpiresAt && !refused && expiresAt - margin > Date.now()) {
    return { accessToken: login.accessToken, accessTokenExpiresAt: login.accessTokenExpiresAt };
  }
  const fresh = await new Api({ host: deps.host, token: null, fetch: deps.fetch }).request<RefreshResponse>('POST', '/token', {
    grant_type: 'refresh_token',
    refresh_token: login.token,
  });
  const access = { accessToken: fresh.accessToken, accessTokenExpiresAt: expiresAtFrom(fresh.accessTokenExpiresIn) };
  saveLogin(deps.credsPath, deps.host, { ...login, ...access, expiresAt: fresh.expiresAt, maxExpiresAt: fresh.maxExpiresAt });
  return access;
}
