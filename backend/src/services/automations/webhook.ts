/**
 * An automation's outbound webhook ("Alerts and the
 * outbound webhook"): termag POSTs a JSON body to the owner's URL when a run
 * finishes (`run.done`, `run.failed`) and when the automation is paused
 * (`automation.paused`), so people can route run events themselves.
 *
 * The URL is a credential as often as not (a Slack incoming webhook, a Zapier
 * hook), so it is sealed in the owner's credential store as `awh-<id>` with
 * the signing secret, as a T3 task's hook is (t3Hook.ts); the row keeps only
 * its host, for display, and the two are written in one transaction. The secret is minted here when a URL is saved and
 * shown to the owner once, in that save's answer. Each body is signed with
 * it: `X-Termag-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 *
 * The URL is the owner's but the request leaves from the orchestrator, so it
 * goes through the MCP broker's SSRF-safe client (mcpOAuthHttp.ts): https on
 * port 443 to a host name whose every address is public, checked again at
 * connect time, no redirects.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { deleteCredentials, getCredentialStoreConfig, readCredential, sealCredential } from '../credentialStore';
import { checkOAuthUrl, safeOAuthHttp, type OAuthHttp } from '../mcpOAuthHttp';
import { reportableSummary } from './report';

export const WEBHOOK_EVENTS = ['run.done', 'run.failed', 'automation.paused'] as const;
export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

const MAX_URL = 2000;

/** The credential row an automation's webhook is sealed in. */
export function webhookProvider(automationId: string): string {
  if (!/^[a-z0-9]{8,27}$/.test(automationId)) throw new Error('invalid automation id for a webhook');
  return `awh-${automationId}`;
}

export class WebhookStoreUnavailable extends Error {}

const STORE_OFF = 'This termag has no credential store, so it cannot keep a webhook URL and its secret';

/** `webhook: { url }` from a create or update body: the URL checked, or why not. `null` removes it. */
export function parseWebhookField(raw: unknown): { ok: true; value: { url: string } | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof r.url !== 'string' || !r.url.trim() || r.url.length > MAX_URL) return { ok: false, error: 'webhook.url must be an https URL' };
  try {
    const u = checkOAuthUrl(r.url.trim());
    return { ok: true, value: { url: u.toString() } };
  } catch (err) {
    return { ok: false, error: `webhook.url: ${(err as Error).message}` };
  }
}

export interface WebhookSecret { url: string; secret: string }

/**
 * The URL with a fresh secret, sealed (the KMS call) but not yet stored, and
 * the write that stores it. The caller puts `write` in the same Prisma
 * transaction as the automation row's `webhookHost`, so the credential and
 * the row change together or not at all: there is no rollback to get wrong.
 * Throws WebhookStoreUnavailable with no credential store.
 */
export async function sealWebhook(userId: string, automationId: string, url: string): Promise<{ secret: string; write: Prisma.PrismaPromise<unknown> }> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) throw new WebhookStoreUnavailable(STORE_OFF);
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  const provider = webhookProvider(automationId);
  const ciphertext = await sealCredential(cfg, userId, provider, { url, secret });
  const write = prisma.userCredential.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, label: 'Automation webhook', ciphertext },
    update: { label: 'Automation webhook', ciphertext },
  });
  return { secret, write };
}

/** The delete of an automation's webhook credential, for the transaction that clears its row's webhookHost. Needs no store. */
export function forgetWebhookWrite(userId: string, automationId: string): Prisma.PrismaPromise<unknown> {
  return prisma.userCredential.deleteMany({ where: { userId, provider: webhookProvider(automationId) } });
}

/**
 * The sealed URL and secret, or null when there is none. Throws when it
 * cannot tell: no credential store (WebhookStoreUnavailable), or the
 * database or KMS failing, so a caller can retry rather than take an outage
 * for a removed webhook.
 */
export async function readWebhook(userId: string, automationId: string): Promise<WebhookSecret | null> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) throw new WebhookStoreUnavailable(STORE_OFF);
  const value = await readCredential(cfg, userId, webhookProvider(automationId)) as Partial<WebhookSecret> | null;
  return typeof value?.url === 'string' && typeof value.secret === 'string' ? { url: value.url, secret: value.secret } : null;
}

/** Forget the credential on its own (an automation deleted, a create rolled back). Idempotent. */
export async function forgetWebhook(userId: string, automationId: string): Promise<void> {
  await deleteCredentials(userId, [webhookProvider(automationId)]);
}

export function webhookStoreReady(): boolean {
  return getCredentialStoreConfig() !== null;
}

/** The `X-Termag-Signature` header for a body sent at `t` (unix seconds). */
export function signWebhook(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export interface WebhookRun {
  id: string;
  state: string;
  reason: string | null;
  summary: string | null;
  trigger: string;
  scheduledFor: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  prUrl: string | null;
}

export interface WebhookBodyInput {
  event: WebhookEvent;
  /** When the event happened; also the dedupe of a retried delivery (`id` stays the same). */
  at: Date;
  automation: { id: string; projectId: string; name: string };
  run: WebhookRun | null;
  /** automation.paused only: the pausedReason, and the cause in words. */
  pause?: { reason: string; cause: string };
  /** Links back into termag, when its web address is known. */
  links: { run: string | null; automation: string | null };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The most of a summary the one-line `text` carries; the full one is in `run.summary` and `summary`. */
const TEXT_SUMMARY_MAX = 500;

/**
 * The event in one line, for a receiver that shows text as it comes (a Slack
 * Workflow Builder webhook, a Zapier step): "pr-watcher run blocked:
 * BLOCKER: …", "triage run failed (timeout): …", "triage is paused: 3 runs
 * failed in a row". The link back into termag ends it, when known.
 */
export function webhookText(i: WebhookBodyInput, summary: string | null): string {
  const name = i.automation.name;
  let line: string;
  if (i.event === 'automation.paused') {
    line = `${name} is paused${i.pause ? `: ${i.pause.cause}` : ''}`;
  } else {
    const state = i.run ? i.run.state.replace(/_/g, ' ') : i.event === 'run.failed' ? 'failed' : 'done';
    const reason = i.run?.reason ? ` (${i.run.reason.replace(/_/g, ' ')})` : '';
    const words = summary ? `: ${summary.length > TEXT_SUMMARY_MAX ? `${summary.slice(0, TEXT_SUMMARY_MAX - 1)}…` : summary}` : '';
    line = `${name} run ${state}${reason}${words}`;
  }
  const url = i.links.run ?? i.links.automation;
  return url ? `${line} · ${url}` : line;
}

/**
 * The JSON body. The summary is the run's own words, which read untrusted
 * text, so it is withheld when it looks like it holds a secret, as the Slack
 * report's is.
 *
 * Next to the nested `automation` and `run`, a few flat fields say the same at
 * the top level (`text`, `automationName`, `runState`, `summary`, `url`), for
 * receivers that read only top-level keys: a Slack Workflow Builder webhook's
 * variables are top-level strings, so `{text}` is a whole message there.
 * They are additive; the nested fields are unchanged.
 */
export function webhookBody(i: WebhookBodyInput): Record<string, unknown> {
  const summary = i.run ? reportableSummary(i.run.summary) : null;
  return {
    event: i.event,
    at: i.at.toISOString(),
    text: webhookText(i, summary),
    automationName: i.automation.name,
    runState: i.run?.state ?? null,
    summary,
    url: i.links.run ?? i.links.automation,
    automation: { id: i.automation.id, projectId: i.automation.projectId, name: i.automation.name, url: i.links.automation },
    run: i.run ? {
      id: i.run.id, state: i.run.state, reason: i.run.reason, summary, trigger: i.run.trigger,
      scheduledFor: i.run.scheduledFor.toISOString(), startedAt: iso(i.run.startedAt), finishedAt: iso(i.run.finishedAt),
      prUrl: i.run.prUrl, url: i.links.run,
    } : null,
    ...(i.pause ? { pause: i.pause } : {}),
  };
}

/** A delivery's outcome: sent, or why not and whether another attempt may do better. */
export type SendOutcome = { ok: true } | { ok: false; error: string; retry: boolean };

/** The most one send may take, connect to last byte (review on #1572): a slow receiver gives up its place, it doesn't hold the sweep. */
export const SEND_DEADLINE_MS = 10_000;

export type WebhookSend = (url: string, secret: string, body: string, deliveryId: string, now?: Date) => Promise<SendOutcome>;

/**
 * One POST. 2xx is delivered; 4xx other than 408 and 429 is the receiver
 * refusing this body for good (no retry); anything else, a timeout or a
 * refused connection included, is worth another attempt.
 */
export function webhookSender(http: OAuthHttp = safeOAuthHttp()): WebhookSend {
  return async (url, secret, body, deliveryId, now = new Date()) => {
    const t = Math.floor(now.getTime() / 1000);
    try {
      const res = await http(url, {
        method: 'POST',
        body,
        deadlineMs: SEND_DEADLINE_MS,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'termag-automation-webhook',
          'x-termag-delivery': deliveryId,
          'x-termag-signature': signWebhook(secret, body, t),
        },
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      const retry = res.status >= 500 || res.status === 408 || res.status === 429 || res.status < 200 || (res.status >= 300 && res.status < 400);
      return { ok: false, error: `answered ${res.status}`, retry };
    } catch (err) {
      return { ok: false, error: (err as Error).message, retry: true };
    }
  };
}
