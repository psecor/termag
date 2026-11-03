/**
 * The one LISTEN connection each orchestrator process holds, shared by every
 * channel it listens on: ask replies (services/askReplyListener.ts) and space
 * file changes (services/spaces/spaceFileBus.ts).
 *
 * Every process runs it, not only the lease holder: a draining process still
 * holds asks' long polls and browsers' status sockets. It is a dedicated
 * node-postgres Client because LISTEN belongs to one session, so it must not
 * come from the pool, and it must reach Postgres directly: through a
 * transaction-pooling proxy (PgBouncer in transaction mode) notifications
 * never arrive. termag connects to the Aurora writer endpoint, not the RDS
 * Proxy the module creates. One connection for all
 * channels keeps it to one session per process on top of the pool.
 *
 * A notification sent while the connection is down is missed. After every
 * (re)connect each channel's `onListening` runs, so a channel that cares can
 * catch up (the space file feed tells browsers to check what they show).
 */
import { Client, type ClientConfig } from 'pg';
import { iamAuthEnabled } from '../config/env';
import { iamPoolConfig } from '../db';

export interface ChannelHandler {
  onPayload: (payload: string) => void;
  /** LISTEN on this channel took effect: at the first connect and after every reconnect. */
  onListening?: () => void;
  /** What a dropped connection costs this channel, for the warning. */
  missed?: string;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

function listenerConfig(env: NodeJS.ProcessEnv): ClientConfig {
  if (iamAuthEnabled(env)) {
    const { max: _max, idleTimeoutMillis: _idle, ...config } = iamPoolConfig(env);
    return config;
  }
  return { connectionString: env.DATABASE_URL };
}

const channels = new Map<string, ChannelHandler>();
let client: Client | null = null;
/** The client once its LISTENs are in: a channel added later LISTENs on it directly. */
let ready: Client | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let retryMs = 1000;

function reconnect(why: string): void {
  if (channels.size === 0 || retryTimer) return;
  const missed = [...channels.values()].map(h => h.missed).filter(Boolean).join('; ');
  console.warn(`[PG-LISTEN] connection down (${why})${missed ? `; ${missed}` : ''}. Retrying in ${retryMs / 1000}s`);
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryMs);
  retryTimer.unref?.();
  retryMs = Math.min(retryMs * 2, 30_000);
}

function drop(c: Client, why: string): void {
  if (client !== c) return;
  client = null;
  ready = null;
  c.end().catch(() => {});
  reconnect(why);
}

async function connect(): Promise<void> {
  if (channels.size === 0 || client) return;
  const c = new Client(listenerConfig(process.env));
  client = c;
  c.on('notification', n => {
    if (n.payload) channels.get(n.channel)?.onPayload(n.payload);
  });
  c.on('error', e => drop(c, errMsg(e)));
  c.on('end', () => drop(c, 'connection closed'));
  try {
    await c.connect();
    for (const name of [...channels.keys()]) await c.query(`LISTEN ${name}`);
    if (client !== c) return;
    ready = c;
    retryMs = 1000;
    console.log(`[PG-LISTEN] listening on ${[...channels.keys()].join(', ')}`);
    for (const h of [...channels.values()]) h.onListening?.();
  } catch (e) {
    drop(c, errMsg(e));
  }
}

/** Listens on `channel` for this process; returns the unlisten. One handler per channel. */
export function listen(channel: string, handler: ChannelHandler): () => void {
  if (!CHANNEL.test(channel)) throw new Error(`bad channel name ${channel}`);
  channels.set(channel, handler);
  const c = ready;
  if (c) {
    c.query(`LISTEN ${channel}`).then(() => { if (ready === c && channels.get(channel) === handler) handler.onListening?.(); })
      .catch(e => drop(c, errMsg(e)));
  } else {
    void connect();
  }
  return () => {
    if (channels.get(channel) !== handler) return;
    channels.delete(channel);
    if (channels.size > 0) { ready?.query(`UNLISTEN ${channel}`).catch(() => {}); return; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const open = client;
    client = null;
    ready = null;
    open?.end().catch(() => {});
  };
}
