'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MIN_INTERVAL_MS, USAGE_URL, createPlanUsage, readAccessToken, spendFrom, usageUrl } = require('./claude-plan-usage');

// The shape a Claude Enterprise seat answers with (trimmed): no 5-hour or
// 7-day windows, a monthly spend in cents.
const SEAT = {
  five_hour: null,
  seven_day: null,
  extra_usage: { is_enabled: true, monthly_limit: 700000, used_credits: 81822, utilization: 11.69, currency: 'USD', decimal_places: 2, spend_limit_reached: false },
  spend: {
    used: { amount_minor: 81822, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 700000, currency: 'USD', exponent: 2 },
    percent: 12, severity: 'normal', enabled: true,
  },
};

function memFs(files) {
  return { readFileSync: p => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; } };
}
const CREDS = '/h/.claude/.credentials.json';
const login = (over = {}) => JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123', expiresAt: 10_000_000, subscriptionType: 'enterprise', ...over } });

test('spend: the spend block, else extra_usage, else nothing', () => {
  assert.deepEqual(spendFrom(SEAT), { usedMinor: 81822, limitMinor: 700000, exponent: 2, limitExponent: 2, currency: 'USD', severity: 'normal', limitReached: false });
  assert.deepEqual(spendFrom({ extra_usage: { ...SEAT.extra_usage, spend_limit_reached: true } }),
    { usedMinor: 81822, limitMinor: 700000, exponent: 2, currency: 'USD', severity: null, limitReached: true });
  assert.equal(spendFrom({ spend: { ...SEAT.spend, enabled: false } }), null);
  assert.equal(spendFrom({ spend: { ...SEAT.spend, limit: { amount_minor: 0, exponent: 2 } } }), null);
  assert.equal(spendFrom({ extra_usage: { ...SEAT.extra_usage, is_enabled: false } }), null);
  assert.equal(spendFrom({ five_hour: { utilization: 10 } }), null);
  assert.equal(spendFrom(null), null);
});

test('spend: at or past its limit is reached without an extra_usage block saying so, and each amount keeps its exponent', () => {
  assert.equal(spendFrom({ spend: { ...SEAT.spend, used: { ...SEAT.spend.used, amount_minor: 728000 } } }).limitReached, true);
  assert.equal(spendFrom({ spend: { ...SEAT.spend, used: { ...SEAT.spend.used, amount_minor: 700000 } } }).limitReached, true);
  assert.equal(spendFrom({ extra_usage: { ...SEAT.extra_usage, used_credits: 700000 } }).limitReached, true);
  // $3,000.00 used of a limit given in whole dollars ($7,000): compared in whole units, not minor ones.
  const mixed = spendFrom({ spend: { ...SEAT.spend, used: { ...SEAT.spend.used, amount_minor: 300000, exponent: 2 }, limit: { ...SEAT.spend.limit, amount_minor: 7000, exponent: 0 } } });
  assert.equal(mixed.exponent, 2);
  assert.equal(mixed.limitExponent, 0);
  assert.equal(mixed.limitReached, false);
});

test('the login: a claude.ai access token that is not about to expire', () => {
  const now = () => 1_000_000;
  assert.equal(readAccessToken('/h', memFs({ [CREDS]: login() }), now), 'tok-123');
  assert.equal(readAccessToken('/h', memFs({ [CREDS]: login({ expiresAt: 1_010_000 }) }), now), null);
  assert.equal(readAccessToken('/h', memFs({ [CREDS]: JSON.stringify({ mcpOAuth: {} }) }), now), null);
  assert.equal(readAccessToken('/h', memFs({ [CREDS]: 'not json' }), now), null);
  assert.equal(readAccessToken('/h', memFs({}), now), null);
});

test('the endpoint: Anthropic, or a loopback stand-in for the e2e stack', () => {
  assert.equal(usageUrl({}), USAGE_URL);
  assert.equal(usageUrl({ TERMAG_CLAUDE_USAGE_URL: 'http://127.0.0.1:4780/_claude/api/oauth/usage' }), 'http://127.0.0.1:4780/_claude/api/oauth/usage');
  assert.equal(usageUrl({ TERMAG_CLAUDE_USAGE_URL: 'https://evil.example/collect' }), USAGE_URL);
  assert.equal(usageUrl({ TERMAG_CLAUDE_USAGE_URL: 'http://127.0.0.1.evil.example/' }), USAGE_URL);
});

test('asks with the login, at most once a minute, and never without one', async () => {
  let t = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, auth: opts.headers.Authorization, beta: opts.headers['anthropic-beta'] }); return { ok: true, json: async () => SEAT }; };
  const plan = createPlanUsage({ home: '/h', env: {}, fetchImpl, fsImpl: memFs({ [CREDS]: login() }), now: () => t });
  const [a, b] = await Promise.all([plan.current(), plan.current()]);
  assert.equal(a.usedMinor, 81822);
  assert.equal(b, a);
  assert.deepEqual(calls, [{ url: USAGE_URL, auth: 'Bearer tok-123', beta: 'oauth-2025-04-20' }]);
  t += MIN_INTERVAL_MS - 1;
  await plan.current();
  assert.equal(calls.length, 1);
  t += 1;
  await plan.current();
  assert.equal(calls.length, 2);

  const none = createPlanUsage({ home: '/h', env: {}, fetchImpl, fsImpl: memFs({}), now: () => t });
  assert.equal(await none.current(), null);
  assert.equal(calls.length, 2);
});

test('a failure sends nothing and is not asked again within the minute', async () => {
  let n = 0;
  const failing = createPlanUsage({ home: '/h', env: {}, fetchImpl: async () => { n++; throw new Error('offline'); }, fsImpl: memFs({ [CREDS]: login() }), now: () => 1_000_000 });
  assert.equal(await failing.current(), null);
  assert.equal(await failing.current(), null);
  assert.equal(n, 1);
  const refused = createPlanUsage({ home: '/h', env: {}, fetchImpl: async () => ({ ok: false, json: async () => ({}) }), fsImpl: memFs({ [CREDS]: login() }), now: () => 1_000_000 });
  assert.equal(await refused.current(), null);
});
