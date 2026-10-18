import { CliError } from './errors.js';
import { VERSION } from './version.js';

export const API_PREFIX = '/api/cli/v1';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiOptions {
  host: string;
  /** A function is asked before every request, so a long `--wait` outlives one access token. */
  token: string | null | (() => Promise<string>);
  fetch: typeof fetch;
  timeoutMs?: number;
}

/**
 * Client for the orchestrator's /api/cli/v1. Every failure becomes a
 * CliError whose message says what to do next; none includes the token.
 */
export class Api {
  constructor(private readonly opts: ApiOptions) {}

  get host(): string {
    return this.opts.host;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.opts.host}${API_PREFIX}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `termag-cli/${VERSION}` };
    const token = typeof this.opts.token === 'function' ? await this.opts.token() : this.opts.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: ctl.signal,
      });
    } catch (err) {
      if (ctl.signal.aborted) throw new CliError('timeout', `Timed out waiting for the orchestrator at ${this.opts.host}`);
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new CliError('unreachable', `Can't reach the orchestrator at ${this.opts.host} (${cause?.code ?? cause?.message ?? (err as Error).message})`);
    } finally {
      clearTimeout(timer);
    }
    return this.decode<T>(res);
  }

  private async decode<T>(res: Response): Promise<T> {
    if (res.status >= 300 && res.status < 400) {
      let where = '';
      try { where = ` to ${new URL(res.headers.get('location') ?? '').host}`; } catch { /* no usable location */ }
      throw new CliError('edge_auth',
        `${this.opts.host} redirected the CLI${where} for a browser sign-in: its edge does not let the CLI API through yet`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    let data: { error?: unknown; code?: unknown } | null = null;
    if (isJson && text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    // The ALB's jwt-validation action answers a bad or missing access token with an HTML 401.
    if (!data && res.status === 401) {
      throw new CliError('auth_required', `${this.opts.host} refused the CLI's credential; run \`termag login\``, res.status);
    }
    if (!data) {
      throw new CliError('not_cli_enabled',
        `${this.opts.host} did not answer as a termag orchestrator with the CLI API (HTTP ${res.status}); it may predate the CLI`, res.status);
    }
    if (res.ok) return data as T;
    const message = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
    // A lapsed or reused sign-in code (POST /token) needs a new login, not a different command line.
    const body = data as Record<string, unknown>;
    if (res.status === 401 || data.code === 'invalid_grant') throw new CliError('auth_required', message, res.status, body);
    if (res.status === 404) throw new CliError('not_found', message, res.status, body);
    if (res.status === 400) throw new CliError('usage', message, res.status, body);
    if (res.status === 403) throw new CliError('forbidden', message, res.status, body);
    if (data.code === 'github-required') throw new CliError('precondition', message, res.status, body);
    if (res.status === 409) throw new CliError('conflict', message, res.status, body);
    throw new CliError('failed', message, res.status, body);
  }
}

export interface UserView {
  email: string;
  unixUsername: string;
  displayName: string;
}

export interface WhoamiResponse {
  user: UserView;
  credential:
    | { kind: 'device'; deviceName: string; expiresAt: string; maxExpiresAt: string }
    | { kind: 'box'; boxId: string | null };
}

export interface TokenResponse {
  /** The device token: the refresh token, never sent as a bearer. */
  token: string;
  tokenPrefix: string;
  accessToken: string;
  accessTokenExpiresIn: number;
  deviceName: string;
  user: UserView;
  expiresAt: string;
  maxExpiresAt: string;
}

export interface RefreshResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  expiresAt: string;
  maxExpiresAt: string;
}

export interface Box {
  id: string;
  name: string;
  addressable: boolean;
  kind: string;
  state: string;
  status: string;
  agentConnected: boolean;
  error: string | null;
  projects: Array<{ id: string; name: string }>;
}

export interface Project {
  id: string;
  name: string;
  ref: string;
  box: { id: string; name: string };
  provider: string | null;
  status: string;
  waitingReason: string | null;
  rateLimited: unknown;
  workstreams: string[];
}
