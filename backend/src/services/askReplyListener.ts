/**
 * The one LISTEN connection on REPLY_CHANNEL (services/askReplyBus.ts).
 *
 * Every orchestrator process runs it, not only the lease holder: a draining
 * process can still be holding an asker's long poll. It is a dedicated
 * node-postgres Client because LISTEN belongs to one session, so it must not
 * come from the pool, and it must reach Postgres directly: through a
 * transaction-pooling proxy (PgBouncer in transaction mode) notifications
 * never arrive. termag connects to the Aurora writer endpoint, not the RDS
 * Proxy the module creates. A notification sent
 * while this connection is down is missed; that reply is lost to this process.
 */
import { Client, type ClientConfig } from 'pg';
import { iamAuthEnabled } from '../config/env';
import { iamPoolConfig } from '../db';
import { REPLY_CHANNEL, ReplyAssembler } from './askReplyBus';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function listenerConfig(env: NodeJS.ProcessEnv): ClientConfig {
  if (iamAuthEnabled(env)) {
    const { max: _max, idleTimeoutMillis: _idle, ...config } = iamPoolConfig(env);
    return config;
  }
  return { connectionString: env.DATABASE_URL };
}

let client: Client | null = null;
let running = false;
let retryTimer: NodeJS.Timeout | null = null;
let retryMs = 1000;

export function startReplyListener(onReply: (messageId: string, text: string) => void): void {
  if (running) return;
  running = true;
  const assembler = new ReplyAssembler();

  const reconnect = (why: string) => {
    if (!running || retryTimer) return;
    console.warn(`[ASK] reply listener down (${why}); replies finished meanwhile miss this process. Retrying in ${retryMs / 1000}s`);
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryMs);
    retryTimer.unref?.();
    retryMs = Math.min(retryMs * 2, 30_000);
  };

  const connect = async () => {
    const c = new Client(listenerConfig(process.env));
    client = c;
    c.on('notification', n => {
      if (n.channel !== REPLY_CHANNEL || !n.payload) return;
      const done = assembler.accept(n.payload);
      if (done) onReply(done.messageId, done.text);
    });
    c.on('error', e => { if (client === c) { client = null; c.end().catch(() => {}); reconnect(errMsg(e)); } });
    c.on('end', () => { if (client === c) { client = null; reconnect('connection closed'); } });
    try {
      await c.connect();
      await c.query(`LISTEN ${REPLY_CHANNEL}`);
      retryMs = 1000;
      console.log(`[ASK] listening for replies on ${REPLY_CHANNEL}`);
    } catch (e) {
      if (client === c) { client = null; c.end().catch(() => {}); reconnect(errMsg(e)); }
    }
  };

  void connect();
}

export function stopReplyListener(): void {
  running = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const c = client;
  client = null;
  c?.end().catch(() => {});
}
