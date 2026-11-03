'use strict';
/**
 * A Claude Enterprise seat's monthly spend, for the session composer's
 * context ring (frontend chat/contextUsage.ts). Claude Code's stream-json
 * never carries it: a seat's rate_limit_event is an `overage` window with a
 * status and no utilization. Claude Code's own /usage reads it from
 * Anthropic's usage endpoint with the box's claude.ai login, and so does
 * this: the chat runner asks after a turn's result, only for a turn whose
 * send carried `planSpend` (chat-plan-spend-enabled for the project's owner),
 * at most once a minute for the box, and sends the
 * numbers (never the token) to the open view as a live notice,
 * `{ type: 'plan-usage', spend }`.
 *
 * Only a claude.ai login in ~/.claude/.credentials.json that has not
 * expired: Claude Code refreshes it as it runs, so right after a turn it is
 * fresh. A box on the Bedrock gateway has none and sends nothing. The
 * endpoint is not a documented API; any failure, or an answer without a
 * spend, sends nothing. TERMAG_CLAUDE_USAGE_URL points it elsewhere for the
 * e2e stack, loopback http only.
 */
const fs = require('fs');
const path = require('path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MIN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 5_000;

function usageUrl(env) {
  const override = env && env.TERMAG_CLAUDE_USAGE_URL;
  return typeof override === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(override) ? override : USAGE_URL;
}

/** The claude.ai access token, or null: none, unreadable, or expiring within 30 s. */
function readAccessToken(home, fsImpl, now) {
  try {
    const creds = JSON.parse(fsImpl.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'));
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < now() + 30_000) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

const isAmount = v => Number.isFinite(v) && v >= 0;

/**
 * The spend from the endpoint's answer: its `spend` block, else the older
 * `extra_usage` one. Amounts in minor units (cents) with their exponent.
 * Null without a limit to measure against.
 */
function spendFrom(body) {
  const s = body && body.spend;
  const extra = body && body.extra_usage;
  const reached = !!(extra && extra.spend_limit_reached === true);
  if (s && s.enabled !== false && s.used && s.limit && isAmount(s.used.amount_minor) && isAmount(s.limit.amount_minor) && s.limit.amount_minor > 0) {
    const exponent = Number.isInteger(s.used.exponent) ? s.used.exponent : 2;
    const limitExponent = Number.isInteger(s.limit.exponent) ? s.limit.exponent : exponent;
    return {
      usedMinor: s.used.amount_minor,
      limitMinor: s.limit.amount_minor,
      exponent,
      // Each amount keeps its own exponent; the browser compares them in whole units.
      limitExponent,
      currency: typeof s.used.currency === 'string' ? s.used.currency : 'USD',
      severity: typeof s.severity === 'string' ? s.severity : null,
      // At or past the limit is reached, whether or not the answer has an extra_usage block saying so.
      limitReached: reached || s.used.amount_minor * 10 ** (limitExponent - exponent) >= s.limit.amount_minor,
    };
  }
  if (extra && extra.is_enabled === true && isAmount(extra.used_credits) && isAmount(extra.monthly_limit) && extra.monthly_limit > 0) {
    return {
      usedMinor: extra.used_credits,
      limitMinor: extra.monthly_limit,
      exponent: Number.isInteger(extra.decimal_places) ? extra.decimal_places : 2,
      currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
      severity: null,
      limitReached: reached || extra.used_credits >= extra.monthly_limit,
    };
  }
  return null;
}

/** One box's spend, asked at most once a minute (an answer or a failure counts). */
function createPlanUsage({ home, env = process.env, fetchImpl = globalThis.fetch, fsImpl = fs, now = Date.now }) {
  let last = null;
  let at = -Infinity;
  let inflight = null;
  async function ask(token) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(usageUrl(env), {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: ac.signal,
      });
      return res.ok ? spendFrom(await res.json()) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function current() {
    if (now() - at < MIN_INTERVAL_MS) return last;
    if (inflight) return inflight;
    const token = readAccessToken(home, fsImpl, now);
    if (!token || typeof fetchImpl !== 'function') return null;
    inflight = ask(token).then(spend => {
      last = spend;
      at = now();
      return spend;
    }).finally(() => { inflight = null; });
    return inflight;
  }
  return { current };
}

module.exports = { MIN_INTERVAL_MS, USAGE_URL, createPlanUsage, readAccessToken, spendFrom, usageUrl };
