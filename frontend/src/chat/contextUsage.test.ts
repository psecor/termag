import { describe, expect, it } from 'vitest';
import {
  assumedWindow, contextView, emptyUsage, formatTokens, orderedWindows, promptTokens, resetText, ringLabel, planPercent, planTone, ringTone,
  formatMoney, shownWindows, windowLabel, windowValue, withMessageUsage, withPlanSpend, withRateLimit, withResultUsage, type ChatUsage, withSpendReset,
} from './contextUsage';
import { applyEvent, emptyChat, fromHistory, withKeptUsage } from './sdkChat';

const call = (input: number, read: number, write: number, model = 'claude-opus-5-5') => ({
  id: 'msg_1', role: 'assistant', model, content: [],
  usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 12 },
});

describe('promptTokens', () => {
  it('adds the fresh, cached and cache-written input', () => {
    expect(promptTokens({ input_tokens: 6, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4_200 })).toBe(84_206);
  });
  it('is null for a usage without input counts', () => {
    expect(promptTokens({ output_tokens: 40 })).toBeNull();
    expect(promptTokens(undefined)).toBeNull();
  });
});

describe('withMessageUsage', () => {
  it("takes the latest main-thread call's prompt and model", () => {
    const u = withMessageUsage(emptyUsage, call(6, 80_000, 4_200), null);
    expect(u).toMatchObject({ contextTokens: 84_206, model: 'claude-opus-5-5' });
  });
  it("leaves out a subagent's call and a message Claude Code wrote itself", () => {
    const u = withMessageUsage(emptyUsage, call(6, 1_000, 0), null);
    expect(withMessageUsage(u, call(6, 90_000, 0), 'toolu_1')).toBe(u);
    expect(withMessageUsage(u, { ...call(6, 90_000, 0), model: '<synthetic>' }, null)).toBe(u);
  });
  it('forgets the window a result gave for another model', () => {
    const u: ChatUsage = { ...emptyUsage, contextTokens: 10, model: 'claude-opus-5-5', contextWindow: 1_000_000 };
    expect(withMessageUsage(u, call(6, 500, 0), null).contextWindow).toBe(1_000_000);
    expect(withMessageUsage(u, call(6, 500, 0, 'claude-haiku-5-5'), null).contextWindow).toBeNull();
  });
});

describe('withResultUsage', () => {
  it("uses the session model's own window", () => {
    const u = { ...emptyUsage, model: 'claude-opus-5-5' };
    const modelUsage = { 'claude-haiku-5-5': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 1_000_000 } };
    expect(withResultUsage(u, modelUsage).contextWindow).toBe(1_000_000);
  });
  it('falls back to the largest window when no entry is the model', () => {
    const modelUsage = { a: { contextWindow: 200_000 }, b: { contextWindow: 400_000 } };
    expect(withResultUsage(emptyUsage, modelUsage).contextWindow).toBe(400_000);
  });
  it('ignores a result without windows', () => {
    expect(withResultUsage(emptyUsage, undefined)).toBe(emptyUsage);
    expect(withResultUsage(emptyUsage, { a: { inputTokens: 3 } })).toBe(emptyUsage);
  });
});

describe('withRateLimit', () => {
  it('keeps one window per type, its reset in milliseconds', () => {
    let u = withRateLimit(emptyUsage, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.23, resetsAt: 1_800_000_000 });
    u = withRateLimit(u, { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81 });
    u = withRateLimit(u, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: 1_800_000_000_000 });
    expect(u.limits).toEqual({
      five_hour: { utilization: 0.3, resetsAt: 1_800_000_000_000, status: 'allowed' },
      seven_day: { utilization: 0.81, resetsAt: null, status: 'allowed_warning' },
    });
  });
  it('files a window with no type under plan', () => {
    expect(Object.keys(withRateLimit(emptyUsage, { status: 'rejected' }).limits)).toEqual(['plan']);
  });
});

describe('the numbers the ring shows', () => {
  it('assumes 1M for a model Claude Code runs at 1M, else 200k, until a result says', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-7', 'us.anthropic.claude-opus-5-5-v1:0']) {
      expect(assumedWindow(m)).toBe(1_000_000);
    }
    expect(assumedWindow('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(assumedWindow('claude-opus-4-6')).toBe(200_000);
    expect(assumedWindow('claude-sonnet-4-6')).toBe(200_000);
    expect(assumedWindow('claude-haiku-4-5')).toBe(200_000);
    expect(assumedWindow(null)).toBe(200_000);
    expect(contextView({ ...emptyUsage, contextTokens: 50_000 })).toEqual({ used: 50_000, window: 200_000, percent: 25 });
    expect(contextView({ ...emptyUsage, contextTokens: 50_000, contextWindow: 1_000_000 })?.percent).toBe(5);
    expect(contextView(emptyUsage)).toBeNull();
  });

  it('fills the inner ring with the fullest plan window, whatever the context', () => {
    const u: ChatUsage = {
      ...emptyUsage, contextTokens: 190_000,
      limits: { five_hour: { utilization: 0.23, resetsAt: null, status: 'allowed' }, seven_day: { utilization: 0.81, resetsAt: null, status: 'allowed' } },
    };
    expect(planPercent(u)).toBe(81);
    expect(planTone(u)).toBe('warn');
    // The context is 95% full, but that is the outer ring's.
    expect(planPercent({ ...u, limits: {} })).toBeNull();
    expect(planTone({ ...u, limits: {} })).toBe('ok');
    // A rejected window with no number is full; a fine one with none has no row, so no fill.
    expect(planPercent({ ...u, limits: { overage: { utilization: null, resetsAt: null, status: 'rejected' } } })).toBe(100);
    expect(planPercent({ ...u, limits: { overage: { utilization: null, resetsAt: null, status: 'allowed' } } })).toBeNull();
  });

  it('turns amber from 70% and red from 90%', () => {
    expect([null, 0, 69, 70, 89, 90, 120].map(ringTone)).toEqual(['ok', 'ok', 'ok', 'warn', 'warn', 'danger', 'danger']);
  });

  it('writes token counts short', () => {
    expect([950, 84_206, 200_000, 123_456, 1_000_000, 1_250_000].map(formatTokens)).toEqual(['950', '84.2k', '200k', '123k', '1M', '1.3M']);
  });

  it('names and orders the plan windows', () => {
    expect(windowLabel('five_hour')).toBe('5-hour window');
    expect(windowLabel('seven_day_opus')).toBe('7-day Opus window');
    expect(windowLabel('overage')).toBe('Extra usage');
    expect(windowLabel('some_new_window')).toBe('some new window');
    const w = { utilization: 0.1, resetsAt: null, status: null };
    expect(orderedWindows({ seven_day: w, odd: w, five_hour: w }).map(([t]) => t)).toEqual(['five_hour', 'seven_day', 'odd']);
  });

  it('says when a window resets: a time today, a weekday this week, a date after that', () => {
    const now = new Date(2026, 9, 23, 14, 0).getTime();
    // Some ICU versions put a narrow no-break space before AM/PM.
    const at = (...d: [number, number, number, number, number]) => resetText(new Date(...d).getTime(), now, 'en-US').replace(/\s/g, ' ');
    expect(at(2026, 9, 23, 18, 40)).toBe('resets 6:40 PM');
    expect(at(2026, 9, 26, 9, 0)).toBe('resets Mon 9:00 AM');
    expect(at(2026, 10, 5, 9, 0)).toBe('resets Nov 5 9:00 AM');
  });

  it('labels the button with every number', () => {
    expect(ringLabel(emptyUsage)).toBe('Context usage not known yet');
    const u: ChatUsage = { ...emptyUsage, contextTokens: 84_000, limits: { five_hour: { utilization: 0.23, resetsAt: null, status: 'allowed' } } };
    expect(ringLabel(u)).toBe('Context 42% used, 5-hour window 23% used');
    const near: ChatUsage = { ...u, limits: { overage: { utilization: null, resetsAt: null, status: 'allowed_warning' } } };
    expect(ringLabel(near)).toBe('Context 42% used, Extra usage: close to the limit');
  });

  it("leaves out an Enterprise seat's extra-usage window until its status turns", () => {
    // What Claude Code sends for a Claude Enterprise seat: no utilization.
    const fine = { utilization: null, resetsAt: 1_793_491_200_000, status: 'allowed' };
    const u: ChatUsage = { ...emptyUsage, contextTokens: 84_000, model: 'claude-opus-5-5', limits: { overage: fine } };
    expect(shownWindows(u.limits)).toEqual([]);
    expect(ringLabel(u)).toBe('Context 8% used');
    expect(planTone(u)).toBe('ok');
    const near = { ...u, limits: { overage: { ...fine, status: 'allowed_warning' } } };
    expect(shownWindows(near.limits).map(([t]) => t)).toEqual(['overage']);
    expect(windowValue(near.limits.overage)).toBe('Close to the limit');
    expect(planTone(near)).toBe('warn');
    const out = { ...u, limits: { overage: { ...fine, status: 'rejected' } } };
    expect(windowValue(out.limits.overage)).toBe('Limit reached');
    expect(planTone(out)).toBe('danger');
  });
});

describe('the chat reducer', () => {
  it('takes context from message_start and assistant events, the window from the result, limits from rate_limit_event', () => {
    let s = applyEvent(emptyChat, { type: 'stream_event', event: { type: 'message_start', message: call(6, 40_000, 2_000) } });
    expect(s.usage?.contextTokens).toBe(42_006);
    s = applyEvent(s, { type: 'assistant', message: { ...call(6, 42_000, 1_500), content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null });
    expect(s.usage?.contextTokens).toBe(43_506);
    // A subagent's call has its own context.
    s = applyEvent(s, { type: 'assistant', message: { ...call(6, 150_000, 0), content: [] }, parent_tool_use_id: 'toolu_9' });
    expect(s.usage?.contextTokens).toBe(43_506);
    s = applyEvent(s, { type: 'result', subtype: 'success', modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 } } });
    expect(s.usage?.contextWindow).toBe(1_000_000);
    s = applyEvent(s, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2, resetsAt: 1_800_000_000 } });
    expect(s.usage?.limits.five_hour?.utilization).toBe(0.2);
    // Everything else the chat renders is as before.
    expect(s.items.map(it => it.kind)).toEqual(['text']);
  });

  it("fills the ring from a reopened chat's history, which keeps each call's prompt size, and has none from an older box's", () => {
    const s = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 6, cache_read_input_tokens: 84_000, cache_creation_input_tokens: 200 } } },
    ]);
    expect(s.usage?.contextTokens).toBe(84_206);
    // No result in history to report the window: Opus 5.5's is 1M.
    expect(contextView(s.usage!)?.window).toBe(1_000_000);
    const old = fromHistory([
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hello' }] } },
    ]);
    expect(old.usage).toBeUndefined();
  });

  it("keeps a chat's numbers from when it was last open in this tab, and the window and plan a history cannot carry", () => {
    const limits = { overage: { utilization: null, resetsAt: null, status: 'allowed_warning' } };
    const remembered = { contextTokens: 90_000, model: 'claude-opus-5-5', contextWindow: 200_000, limits };
    const old = fromHistory([]);
    expect(withKeptUsage(emptyChat, old, remembered).usage).toEqual(remembered);
    const fresh = fromHistory([
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 6, cache_read_input_tokens: 95_000 } } },
    ]);
    expect(withKeptUsage(emptyChat, fresh, remembered).usage).toEqual({ contextTokens: 95_006, model: 'claude-opus-5-5', contextWindow: 200_000, limits });
    const otherModel = { ...remembered, model: 'claude-sonnet-5-5' };
    expect(withKeptUsage(emptyChat, fresh, otherModel).usage?.contextWindow).toBeNull();
  });

  it('keeps the numbers through a history reload of the same chat', () => {
    const live = applyEvent(emptyChat, { type: 'assistant', message: { ...call(6, 30_000, 0), content: [] }, parent_tool_use_id: null });
    const reloaded = fromHistory([]);
    expect(withKeptUsage(live, reloaded).usage?.contextTokens).toBe(30_006);
    expect(withKeptUsage(emptyChat, reloaded)).toBe(reloaded);
    const fresher = applyEvent(emptyChat, { type: 'assistant', message: { ...call(6, 50_000, 0), content: [] }, parent_tool_use_id: null });
    expect(withKeptUsage(live, fresher).usage?.contextTokens).toBe(50_006);
  });

  it('merges the plan windows by type, so a replay that carries one keeps the others', () => {
    const fiveHour = { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.23, resetsAt: 1_793_040_000 };
    const sevenDay = { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.47, resetsAt: 1_793_400_000 };
    const live = applyEvent(applyEvent(emptyChat, { type: 'rate_limit_event', rate_limit_info: fiveHour }), { type: 'rate_limit_event', rate_limit_info: sevenDay });
    const replay = applyEvent(emptyChat, { type: 'rate_limit_event', rate_limit_info: { ...fiveHour, utilization: 0.31 } });
    const kept = withKeptUsage(live, replay).usage!;
    expect(Object.keys(kept.limits).sort()).toEqual(['five_hour', 'seven_day']);
    // The snapshot's own window is the fresher one.
    expect(kept.limits.five_hour.utilization).toBe(0.31);
    expect(kept.limits.seven_day.utilization).toBe(0.47);
    expect(withKeptUsage(emptyChat, replay, live.usage!).usage?.limits.seven_day?.utilization).toBe(0.47);
  });
});

describe("a seat's monthly spend", () => {
  // What agent/claude-plan-usage.js sends for a Claude Enterprise seat.
  const spend = { usedMinor: 81822, limitMinor: 700000, exponent: 2, currency: 'USD', severity: 'normal', limitReached: false };

  it('is the Monthly spend window, with its amounts and the overage window\'s reset either way round', () => {
    const overage = { status: 'allowed', resetsAt: 1_793_491_200, rateLimitType: 'overage', overageStatus: 'allowed' };
    const first = withPlanSpend(withRateLimit(emptyUsage, overage), spend, 'en-US');
    expect(first.limits.monthly_spend).toEqual({ utilization: 81822 / 700000, resetsAt: 1_793_491_200_000, status: 'allowed', detail: '$818 of $7,000' });
    const later = withRateLimit(withPlanSpend(emptyUsage, spend, 'en-US'), overage);
    expect(later.limits.monthly_spend.resetsAt).toBe(1_793_491_200_000);
    expect(windowLabel('monthly_spend')).toBe('Monthly spend');
    // The overage window itself still has nothing to show; the spend does.
    expect(shownWindows(first.limits).map(([t]) => t)).toEqual(['monthly_spend']);
    expect(ringLabel({ ...first, contextTokens: 84_000, model: 'claude-opus-5-5' })).toBe('Context 8% used, Monthly spend 12% used');
  });

  it('turns amber on a warning severity and red at its limit', () => {
    expect(withPlanSpend(emptyUsage, { ...spend, severity: 'warning' }).limits.monthly_spend.status).toBe('allowed_warning');
    const out = withPlanSpend(emptyUsage, { ...spend, usedMinor: 700000, limitReached: true });
    expect(out.limits.monthly_spend.status).toBe('rejected');
    expect(planTone(out)).toBe('danger');
    expect(windowValue(out.limits.monthly_spend)).toBe('Limit reached');
  });

  it('compares and shows a limit given with its own exponent', () => {
    // $3,000.00 used of a $7,000 limit sent in whole dollars.
    const got = withPlanSpend(emptyUsage, { ...spend, usedMinor: 300000, exponent: 2, limitMinor: 7000, limitExponent: 0 }, 'en-US').limits.monthly_spend;
    expect(got.utilization).toBeCloseTo(3000 / 7000);
    expect(got.detail).toBe('$3,000 of $7,000');
  });

  it('drops a stale reset when a later overage window has none', () => {
    const overage = { status: 'allowed', resetsAt: 1_793_491_200, rateLimitType: 'overage' };
    const withReset = withRateLimit(withPlanSpend(emptyUsage, spend, 'en-US'), overage);
    expect(withReset.limits.monthly_spend.resetsAt).toBe(1_793_491_200_000);
    expect(withRateLimit(withReset, { ...overage, resetsAt: null }).limits.monthly_spend.resetsAt).toBeNull();
  });

  it("follows a reloaded overage window's reset, a missing one included, as a live one does", () => {
    const kept = { utilization: 0.12, resetsAt: 1_793_491_200_000, status: 'allowed', detail: '$818 of $7,000' };
    const overage = (resetsAt: number | null) => ({ utilization: null, resetsAt, status: 'allowed' });
    expect(withSpendReset({ monthly_spend: kept, overage: overage(1_796_169_600_000) }).monthly_spend.resetsAt).toBe(1_796_169_600_000);
    expect(withSpendReset({ monthly_spend: kept, overage: overage(null) }).monthly_spend.resetsAt).toBeNull();
    // No overage window in the snapshot, or no spend: nothing to follow.
    const alone = { monthly_spend: kept };
    expect(withSpendReset(alone)).toBe(alone);
    const none = { overage: overage(null) };
    expect(withSpendReset(none)).toBe(none);
  });

  it('ignores a notice it cannot read', () => {
    expect(withPlanSpend(emptyUsage, null)).toBe(emptyUsage);
    expect(withPlanSpend(emptyUsage, { usedMinor: 5 })).toBe(emptyUsage);
    expect(withPlanSpend(emptyUsage, { ...spend, limitMinor: 0 })).toBe(emptyUsage);
  });

  it('survives a reload whose snapshot has other windows, such as a running turn\'s replayed overage event', () => {
    const overage = { status: 'allowed', resetsAt: 1_793_491_200, rateLimitType: 'overage', overageStatus: 'allowed' };
    const live = applyEvent(applyEvent(emptyChat, { type: 'rate_limit_event', rate_limit_info: overage }), { type: 'plan-usage', spend });
    // The replay has the overage window again, but never the spend notice.
    const replay = applyEvent(emptyChat, { type: 'rate_limit_event', rate_limit_info: { ...overage, resetsAt: 1_796_169_600 } });
    const kept = withKeptUsage(live, replay).usage!;
    expect(kept.limits.monthly_spend?.utilization).toBeCloseTo(0.1169, 3);
    expect(kept.limits.monthly_spend?.resetsAt).toBe(1_796_169_600_000);
    expect(kept.limits.overage?.resetsAt).toBe(1_796_169_600_000);
    // From the tab's memory too, when the view is new.
    expect(withKeptUsage(emptyChat, replay, live.usage!).usage?.limits.monthly_spend?.detail).toBe(live.usage!.limits.monthly_spend.detail);
    // And a snapshot with no windows at all keeps everything, as before.
    expect(withKeptUsage(live, emptyChat).usage?.limits).toEqual(live.usage!.limits);
  });

  it('comes in through the chat reducer from the box\'s plan-usage notice', () => {
    const s = applyEvent(emptyChat, { type: 'plan-usage', spend });
    expect(s.usage?.limits.monthly_spend?.utilization).toBeCloseTo(0.1169, 3);
    expect(s.items).toEqual(emptyChat.items);
  });

  it('writes amounts in whole units of their currency', () => {
    expect(formatMoney(81822, 2, 'USD', 'en-US')).toBe('$818');
    expect(formatMoney(700000, 2, 'EUR', 'en-US')).toBe('€7,000');
    expect(formatMoney(5000, 2, 'not a currency', 'en-US')).toBe('50 not a currency');
  });
});
