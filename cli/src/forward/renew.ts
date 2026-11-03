import WebSocket from 'ws';
import type { BearerSource } from '../api.js';

/** How often the forward asks for a renewed access token while any v2 connection is open. */
export const RENEW_EVERY_MS = 5 * 60_000;
/**
 * Each ask, and each dial, wants a token valid at least this long, so the
 * token every open connection holds has at least RENEW_VALID_FOR_MS -
 * RENEW_EVERY_MS (10 min) left at all times. The source measures that on
 * this machine's clock from when the token was minted (`expiresAtFrom`), so
 * a laptop clock that is off by any amount doesn't move it.
 */
export const RENEW_VALID_FOR_MS = 15 * 60_000;
/** After a failed ask (offline, or the refresh refused), the next one comes this soon. */
export const RENEW_RETRY_MS = 30_000;

/** `{"t":"token","token":…}`: a control frame for the orchestrator alone, which never relays it. */
export function tokenFrame(token: string): string {
  return JSON.stringify({ t: 'token', token });
}

/**
 * The device sign-in an access token belongs to: its `jti`, read without
 * verifying (the token is our own, and the orchestrator judges it). Null for
 * a token that isn't a JWT carrying one.
 */
export function signInOf(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const jti = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { jti?: unknown }).jti;
    return typeof jti === 'string' ? jti : null;
  } catch {
    return null;
  }
}

export interface Renewer {
  /**
   * A v2 connection opened with `token`: it is sent every renewed token of the same sign-in until it
   * closes, except while `skip()` says it is ending (its port being released by Forward.close).
   */
  add(ws: WebSocket, token: string, skip?: () => boolean): void;
  /**
   * Whether the connection was opened under a sign-in that the source no
   * longer mints for (a later `termag login` replaced it): it ran on to its
   * token's `exp` unrenewed.
   */
  outlived(ws: WebSocket): boolean;
  /** No more asks, and no timer left behind. */
  stop(): void;
}

/**
 * One access-token renewal for every open v2 connection of a forward: the
 * source is asked once per RENEW_EVERY_MS however many are open (and not at
 * all while none is), and a token it hands back that a connection doesn't
 * have yet goes to each as a text frame, but only to connections opened under
 * the same sign-in (`jti`): the orchestrator refuses another's (4406). After
 * a second `termag login` the source mints only for the new sign-in, so a
 * connection of the old one keeps its token to `exp` and is then closed
 * (4402, `outlived`); new connections dial with the new sign-in. It isn't
 * renewed with the old sign-in's device token: that is gone from disk, and a
 * logout should stop renewals too. A connection on v1 is never added: that
 * orchestrator would relay the frame to the box, whose agent would end the
 * tunnel for it.
 */
export function tokenRenewer(
  source: BearerSource,
  opts: { everyMs?: number; validForMs?: number; retryMs?: number; onError?: (err: Error) => void; onRenewed?: () => void } = {},
): Renewer {
  const everyMs = opts.everyMs ?? RENEW_EVERY_MS;
  const validForMs = opts.validForMs ?? RENEW_VALID_FOR_MS;
  /** Each connection, the token it holds, and whether it is ending. */
  const held = new Map<WebSocket, { token: string; skip?: () => boolean }>();
  const wanted = (ws: WebSocket, skip?: () => boolean) => ws.readyState === WebSocket.OPEN && !skip?.();
  /** Connections a renewal skipped for being another sign-in's. */
  const stranded = new WeakSet<WebSocket>();
  let timer: NodeJS.Timeout | null = null;
  let asking = false;
  let stopped = false;

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || held.size === 0) return;
    timer = setTimeout(() => { timer = null; void ask(); }, ms);
    timer.unref?.();
  };

  async function ask(): Promise<void> {
    if (asking || stopped) return;
    // Every connection ending (their ports released): nothing to ask for until another opens.
    if (![...held].some(([ws, h]) => wanted(ws, h.skip))) { schedule(everyMs); return; }
    asking = true;
    let token: string;
    try {
      token = await source({ validForMs });
    } catch (err) {
      asking = false;
      opts.onError?.(err as Error);
      schedule(opts.retryMs ?? RENEW_RETRY_MS);
      return;
    }
    asking = false;
    if (stopped) return;
    opts.onRenewed?.();
    const signIn = signInOf(token);
    for (const [ws, h] of held) {
      if (h.token === token || !wanted(ws, h.skip)) continue;
      if (signInOf(h.token) !== signIn) { stranded.add(ws); continue; }
      ws.send(tokenFrame(token));
      h.token = token;
    }
    schedule(everyMs);
  }

  return {
    add(ws, token, skip) {
      if (stopped || !wanted(ws, skip)) return;
      held.set(ws, { token, skip });
      ws.once('close', () => {
        held.delete(ws);
        // The last one gone: no ask until another opens.
        if (held.size === 0 && timer) { clearTimeout(timer); timer = null; }
      });
      // Its token is good for RENEW_VALID_FOR_MS: the next ask, at most RENEW_EVERY_MS away, is soon enough.
      if (!timer && !asking) schedule(everyMs);
    },
    outlived: ws => stranded.has(ws),
    stop() {
      stopped = true;
      held.clear();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
