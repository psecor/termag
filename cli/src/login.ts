import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Api, type TokenResponse } from './api.js';
import { CliError } from './errors.js';

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** os.hostname() made acceptable to the orchestrator (1-64 of [A-Za-z0-9._ -], alphanumeric first). */
export function deviceNameFrom(hostname: string): string {
  const cleaned = hostname.replace(/[^A-Za-z0-9._ -]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64).trim();
  return cleaned || 'device';
}

export function authorizeUrl(host: string, p: { port: number; state: string; challenge: string; deviceName: string }): string {
  const q = new URLSearchParams({
    port: String(p.port),
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    device_name: p.deviceName,
  });
  return `${host}/auth/cli/authorize?${q.toString()}`;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Cache-Control': 'no-store',
};

function page(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui,sans-serif;background:#0b0e14;color:#e6e6e6;padding:12vh 2rem;text-align:center">` +
    `<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body>`;
}

interface Callback {
  port: number;
  result: Promise<string>;
  close: () => void;
}

/**
 * Listen on 127.0.0.1 for the browser's redirect. Only a callback carrying our
 * `state` settles it; anything else is answered and ignored, so a stray or
 * forged request can neither finish nor cancel the login.
 */
export async function listenForCallback(state: string, timeoutMs: number): Promise<Callback> {
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const result = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  // The browser can settle this before the caller awaits it.
  result.catch(() => {});
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, PAGE_HEADERS).end(page('Not found', 'This is the termag CLI sign-in listener.'));
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, PAGE_HEADERS).end(page('Sign-in link mismatch',
        'This approval was for a different sign-in link than the one termag login is waiting for. ' +
        'Open the link termag login printed most recently, without editing it.'));
      return;
    }
    if (url.searchParams.get('error')) {
      res.writeHead(200, PAGE_HEADERS).end(page('Sign-in cancelled', 'The termag CLI was not signed in. You can close this tab.'));
      settle.reject(new CliError('auth_required', 'Sign-in was cancelled in the browser'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, PAGE_HEADERS).end(page('Missing code', 'Run termag login again.'));
      return;
    }
    res.writeHead(200, PAGE_HEADERS).end(page('termag CLI signed in', 'You can close this tab and return to your terminal.'));
    settle.resolve(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(() => {
    settle.reject(new CliError('timeout', 'Timed out waiting for the browser sign-in; run `termag login` again'));
  }, timeoutMs);
  timer.unref();
  return {
    port: (server.address() as AddressInfo).port,
    result,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    },
  };
}

export interface LoginDeps {
  host: string;
  deviceName: string;
  fetch: typeof fetch;
  openBrowser: (url: string) => void;
  notify: (line: string) => void;
  timeoutMs?: number;
}

/** Browser-loopback sign-in with PKCE. Only call this with a terminal attached. */
export async function browserLogin(deps: LoginDeps): Promise<TokenResponse> {
  const state = randomBytes(16).toString('base64url');
  const { verifier, challenge } = pkcePair();
  const callback = await listenForCallback(state, deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    const url = authorizeUrl(deps.host, { port: callback.port, state, challenge, deviceName: deps.deviceName });
    deps.notify('Opening your browser to sign in. If it does not open, visit:');
    deps.notify(`  ${url}`);
    deps.openBrowser(url);
    const code = await callback.result;
    const api = new Api({ host: deps.host, token: null, fetch: deps.fetch });
    return await api.request<TokenResponse>('POST', '/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    });
  } finally {
    callback.close();
  }
}
