import { CliError } from './errors.js';
import { VERSION } from './version.js';

export const API_PREFIX = '/api/cli/v1';
const DEFAULT_TIMEOUT_MS = 15_000;

/** The URL, headers and body of a request to the CLI API: what Api sends, and what a report sent from another process sends (usage.ts). */
export function cliRequest(host: string, method: string, path: string, body: unknown, token: string | null): {
  url: string; method: string; headers: Record<string, string>; body?: string;
} {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `termag-cli/${VERSION}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return { url: `${host}${API_PREFIX}${path}`, method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
}

/**
 * Asked for the bearer before every request. `rejected` is the one the
 * orchestrator just answered 401 to: a source that can refresh it returns a
 * new one, and the request is sent once more with it. `validForMs` asks for
 * one that stays valid at least that long (the forward's in-band renewal); a
 * source whose credential has no expiry ignores it.
 */
export type BearerSource = (opts?: { rejected?: string; validForMs?: number }) => Promise<string>;

export interface ApiOptions {
  host: string;
  /** A function is asked before every request, so a long `--wait` outlives one access token. */
  token: string | null | BearerSource;
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
    const given = this.opts.token;
    const source = typeof given === 'function' ? given : null;
    const token = typeof given === 'function' ? await given() : given;
    let res = await this.send(method, path, body, token);
    // A 401 to an access token whose clock says it's good (its key was retired): one refresh and one retry.
    // A refresh that fails throws its own auth_required, which says to run `termag login`.
    if (res.status === 401 && source && token) {
      const again = await source({ rejected: token });
      if (again && again !== token) {
        await res.body?.cancel().catch(() => {});
        res = await this.send(method, path, body, again);
      }
    }
    return this.decode<T>(res);
  }

  private async send(method: string, path: string, body: unknown, token: string | null): Promise<Response> {
    const req = cliRequest(this.opts.host, method, path, body, token);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.opts.fetch(req.url, {
        method,
        headers: req.headers,
        body: req.body,
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
    return res;
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
    // A write refused because the file changed since it was read: exit 6.
    if (res.status === 412) throw new CliError('changed', message, res.status, body);
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
  // Older orchestrators don't send the flavor; only the minimal flavor
  // surface reads it ('minimal' prefixes the create messages).
  flavor?: string;
  state: string;
  status: string;
  agentConnected: boolean;
  error: string | null;
  projects: Array<{ id: string; name: string }>;
  /**
   * small, medium or large; `<vcpu>vcpu-<memory>gib` for a box sized by its repo's .termag/environment.json
   * requirements; null for a box launched as the orchestrator's configured type. Absent from older orchestrators.
   */
  size?: string | null;
  /** The EC2 type it launched as (or was resized to); null for older and external boxes. */
  instanceType?: string | null;
  /** Its current or last resize; null when it never had one. Absent from older orchestrators. */
  resize?: {
    to: string | null;
    from: string | null;
    /** resuming, stopping, resizing, starting while it runs; then ready, stopped or failed. */
    phase: string | null;
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    byAdmin: boolean;
    reason: string | null;
  } | null;
  /** The root disk in GB it was made with (50 to 300, else 120); null for older and external boxes. Absent from older orchestrators. */
  diskGiB?: number | null;
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
