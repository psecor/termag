import type { CaptureResponse, Project, Role, SessionRow } from './types.js';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const API_PREFIX = '/api/cli/v1';

// Refresh this long before the access token lapses, so a request in flight never carries an expired one.
const REFRESH_MARGIN_MS = 60_000;

/** A device sign-in's way to renew its access token: the device token, and when the current one lapses. */
export interface TokenRefresh {
  refreshToken: string;
  /** Epoch ms on this machine's clock. */
  expiresAt: number;
}

/**
 * Thin HTTP client for the orchestrator's /api/cli/v1, the bearer-only API
 * the termag CLI uses (backend/src/routes/cliTui.ts has the TUI's routes):
 * the lobby's project list, the session list and capture (no send-keys). The
 * token is a `termag login` access token, which the orchestrator's ALB checks
 * and which lasts an hour, or a box's agent token. With `refresh`, the access
 * token is renewed with the device token before it lapses, so the TUI can run
 * for as long as the sign-in does.
 */
export class TermagApi {
  private refreshing: Promise<void> | null = null;

  constructor(private base: string, private token: string, private refresh?: TokenRefresh) {}

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
    return this.send<T>(method, path, body, timeoutMs, await this.bearer());
  }

  private async bearer(): Promise<string> {
    const r = this.refresh;
    if (r && Date.now() >= r.expiresAt - REFRESH_MARGIN_MS) {
      // Concurrent polls share one refresh.
      this.refreshing ??= this.renew(r).finally(() => { this.refreshing = null; });
      await this.refreshing;
    }
    return this.token;
  }

  private async renew(r: TokenRefresh): Promise<void> {
    const fresh = await this.send<{ accessToken: string; accessTokenExpiresIn: number }>(
      'POST', '/token', { grant_type: 'refresh_token', refresh_token: r.refreshToken }, 8000, null);
    this.token = fresh.accessToken;
    r.expiresAt = Date.now() + fresh.accessTokenExpiresIn * 1000;
  }

  private async send<T>(method: string, path: string, body: unknown, timeoutMs: number, token: string | null): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: ctl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        throw new ApiError(res.status, `${this.base} redirected to a browser sign-in: its edge does not let the CLI API through`);
      }
      const text = await res.text();
      const ct = res.headers.get('content-type') ?? '';
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      // The ALB's jwt-validation action answers a bad or missing access token with an HTML 401.
      if (res.status === 401 && data === null) {
        throw new ApiError(401, `${this.base} refused the TUI's credential; run \`termag login\``);
      }
      if (text && data === null && !ct.includes('json')) {
        throw new ApiError(res.status, `${method} ${path}: non-JSON reply — is ${this.base} a termag backend?`);
      }
      if (!res.ok) {
        const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
        throw new ApiError(res.status, msg);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async listProjects(): Promise<Project[]> {
    return (await this.call<{ projects: Project[] }>('GET', '/lobby')).projects;
  }

  async listSessions(): Promise<SessionRow[]> {
    return (await this.call<{ sessions: SessionRow[] }>('GET', '/sessions')).sessions;
  }

  capture(projectId: string, role: Role, workstream: string, lines: number, styled = false): Promise<CaptureResponse> {
    const q = new URLSearchParams({ lines: String(Math.max(1, Math.min(1000, lines))) });
    if (workstream && workstream !== 'main') q.set('workstream', workstream);
    if (styled) q.set('styled', '1');
    return this.call('GET', `/projects/${encodeURIComponent(projectId)}/sessions/${role}/capture?${q}`);
  }
}
