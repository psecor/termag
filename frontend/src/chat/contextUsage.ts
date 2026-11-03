// What the session composer's context ring shows (chat/ContextRing.tsx):
// how full Claude's context window is, and, on a claude.ai sign-in, how much
// of the plan's rate-limit windows is used. Everything comes from Claude
// Code's own stream-json events as chat/sdkChat.ts folds them in:
//
// - context used: the latest main-thread API call's prompt, `message.usage`
//   (input + cache read + cache creation tokens) on `message_start` and on
//   each `assistant` event;
// - context window: `result.modelUsage[<model>].contextWindow`, or a guess
//   from the model's name until a result says;
// - plan windows: `rate_limit_event`, one window per event, which Claude Code
//   sends only for a claude.ai sign-in (never on the Bedrock gateway). What
//   they hold depends on the plan: Pro and Max report 5-hour and 7-day windows
//   with a utilization; a Claude Enterprise seat reports one `overage` (extra
//   usage) window with a status and a monthly reset and no utilization, so it
//   has nothing to show until its status says it is near or at its limit
//   (shownWindows);
// - a seat's monthly spend: the box's `plan-usage` notice after an answer
//   (agent/claude-plan-usage.js, what Claude Code's /usage reads), shown as
//   the Monthly spend window with its amounts and the overage window's reset.

export interface PlanWindow {
  /** Fraction of the window used, usually 0-1 (Claude Code's own scale; it can run past 1). */
  utilization: number | null;
  /** When the window resets, in epoch milliseconds. */
  resetsAt: number | null;
  /** Claude Code's word: allowed, allowed_warning or rejected. */
  status: string | null;
  /** A line under the row, such as a spend's "$818 of $7,000". */
  detail?: string | null;
}

export interface ChatUsage {
  /** The prompt size of the latest main-thread API call. */
  contextTokens: number | null;
  /** That call's model (the assistant message's `model`). */
  model: string | null;
  /** The context window the latest result reported for that model. */
  contextWindow: number | null;
  /** Plan rate-limit windows seen, by Claude Code's rateLimitType (five_hour, seven_day, …). */
  limits: Record<string, PlanWindow>;
}

export const emptyUsage: ChatUsage = { contextTokens: null, model: null, contextWindow: null, limits: {} };

type AnyEvent = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A message's prompt size, or null when its usage has no input counts. */
export function promptTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as AnyEvent;
  const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].map(num);
  if (parts.every(p => p == null)) return null;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
}

/**
 * Fold in an assistant message (from `assistant` or `stream_event`
 * message_start). A subagent's call (`parent_tool_use_id`) has its own
 * context, and a message Claude Code wrote itself (`<synthetic>`) made no call.
 */
export function withMessageUsage(u: ChatUsage, message: unknown, parentToolUseId: unknown): ChatUsage {
  if (parentToolUseId) return u;
  if (!message || typeof message !== 'object') return u;
  const m = message as AnyEvent;
  if (m.model === '<synthetic>') return u;
  const tokens = promptTokens(m.usage);
  if (tokens == null || tokens === 0) return u;
  const model = typeof m.model === 'string' && m.model ? m.model : u.model;
  return { ...u, contextTokens: tokens, model, contextWindow: model === u.model ? u.contextWindow : null };
}

/** The context window a result reports for the session's model: its own entry, else the largest one. */
export function withResultUsage(u: ChatUsage, modelUsage: unknown): ChatUsage {
  if (!modelUsage || typeof modelUsage !== 'object') return u;
  const entries = Object.entries(modelUsage as Record<string, AnyEvent>)
    .map(([name, v]) => [name, num(v?.contextWindow)] as const)
    .filter((e): e is readonly [string, number] => e[1] != null && e[1] > 0);
  if (!entries.length) return u;
  const own = u.model ? entries.find(([name]) => name === u.model || name.startsWith(u.model!) || u.model!.startsWith(name)) : undefined;
  const window = own ? own[1] : Math.max(...entries.map(e => e[1]));
  return { ...u, contextWindow: window };
}

/** A `rate_limit_event`'s `rate_limit_info`: one plan window, by its type. */
export function withRateLimit(u: ChatUsage, info: unknown): ChatUsage {
  if (!info || typeof info !== 'object') return u;
  const i = info as AnyEvent;
  const type = typeof i.rateLimitType === 'string' && i.rateLimitType ? i.rateLimitType : 'plan';
  const resets = num(i.resetsAt);
  const window: PlanWindow = {
    utilization: num(i.utilization),
    // Claude Code sends epoch seconds; take milliseconds too.
    resetsAt: resets == null ? null : resets < 1e12 ? resets * 1000 : resets,
    status: typeof i.status === 'string' ? i.status : null,
  };
  const limits = { ...u.limits, [type]: window };
  // The seat's overage window says when the month resets; the spend does not.
  // A later one with no reset clears it rather than leave a stale date.
  if (type === 'overage' && limits[SPEND]) limits[SPEND] = { ...limits[SPEND], resetsAt: window.resetsAt };
  return { ...u, limits };
}

const SPEND = 'monthly_spend';

/** "$818", "$7,000": whole units in the spend's currency, in the browser's locale. */
export function formatMoney(minor: number, exponent: number, currency: string, locale?: string): string {
  const amount = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

/** A `plan-usage` notice's spend: the Monthly spend window, its reset from the overage window. */
export function withPlanSpend(u: ChatUsage, spend: unknown, locale?: string): ChatUsage {
  if (!spend || typeof spend !== 'object') return u;
  const s = spend as AnyEvent;
  const used = num(s.usedMinor);
  const limit = num(s.limitMinor);
  if (used == null || limit == null || limit <= 0) return u;
  const exponent = Number.isInteger(s.exponent) ? s.exponent as number : 2;
  // The limit's own exponent, when the box says it differs from the used amount's.
  const limitExponent = Number.isInteger(s.limitExponent) ? s.limitExponent as number : exponent;
  const currency = typeof s.currency === 'string' && s.currency ? s.currency : 'USD';
  const severity = typeof s.severity === 'string' ? s.severity : '';
  const window: PlanWindow = {
    // Scaled by the exponents' difference, so equal ones divide exactly.
    utilization: (used / limit) * 10 ** (limitExponent - exponent),
    resetsAt: u.limits.overage?.resetsAt ?? u.limits[SPEND]?.resetsAt ?? null,
    status: s.limitReached === true ? 'rejected' : /warn|high|critical/i.test(severity) ? 'allowed_warning' : 'allowed',
    detail: `${formatMoney(used, exponent, currency, locale)} of ${formatMoney(limit, limitExponent, currency, locale)}`,
  };
  return { ...u, limits: { ...u.limits, [SPEND]: window } };
}

/**
 * Plan windows merged from a reload (withKeptUsage in sdkChat.ts). The seat's
 * spend only ever arrives live (a `plan-usage` notice), never in a replay or
 * in history, so it is what the chat had; its reset follows the merged
 * overage window, as withRateLimit does for a live one.
 */
export function withSpendReset(limits: Record<string, PlanWindow>): Record<string, PlanWindow> {
  const spend = limits[SPEND];
  if (!spend || !limits.overage) return limits;
  // An overage window with no reset clears the spend's, as withRateLimit does live.
  const reset = limits.overage.resetsAt ?? null;
  if (spend.resetsAt === reset) return limits;
  return { ...limits, [SPEND]: { ...spend, resetsAt: reset } };
}

// Models Claude Code runs with a 1M window and no [1m] suffix (its model
// configuration docs): Fable, Mythos, Opus 4.7 and later, Sonnet 5 and later,
// Haiku 5.5 and later. Opus 4.6 and Sonnet 4.6 reach 1M only as `…[1m]`.
const NATIVE_1M = /claude-(fable|mythos)|claude-opus-(4-[7-9]|[5-9])|claude-sonnet-[5-9]|claude-haiku-[5-9]/i;

/** The window to assume before a result says: 1M for a 1M-context model, else 200k. */
export function assumedWindow(model: string | null): number {
  if (!model) return 200_000;
  return /\[1m\]|(^|[-_.])1m($|[-_.])/i.test(model) || NATIVE_1M.test(model) ? 1_000_000 : 200_000;
}

export interface ContextView {
  used: number;
  window: number;
  /** 0-100, rounded. */
  percent: number;
}

export function contextView(u: ChatUsage): ContextView | null {
  if (u.contextTokens == null) return null;
  const window = u.contextWindow ?? assumedWindow(u.model);
  return { used: u.contextTokens, window, percent: Math.round(Math.min(1, u.contextTokens / window) * 100) };
}

/** A plan window's use as 0-100 (it can pass 100 when usage runs past the cap). */
export function windowPercent(w: PlanWindow): number | null {
  return w.utilization == null ? null : Math.round(w.utilization * 100);
}

export type RingTone = 'ok' | 'warn' | 'danger';
export function ringTone(percent: number | null): RingTone {
  if (percent == null || percent < 70) return 'ok';
  return percent < 90 ? 'warn' : 'danger';
}

const TONE_RANK: Record<RingTone, number> = { ok: 0, warn: 1, danger: 2 };

/** A window's own word for how close it is: Enterprise's overage window has no utilization to go on. */
export function statusTone(w: PlanWindow): RingTone {
  return w.status === 'rejected' ? 'danger' : w.status === 'allowed_warning' ? 'warn' : 'ok';
}

/**
 * The inner ring's fill: the fullest plan window with a row (shownWindows). A
 * rejected window with no utilization (an Enterprise seat's extra usage) is full.
 */
export function planPercent(u: ChatUsage): number | null {
  const all = shownWindows(u.limits).map(([, w]) => windowPercent(w) ?? (w.status === 'rejected' ? 100 : null))
    .filter((p): p is number => p != null);
  return all.length ? Math.max(...all) : null;
}

/** The inner ring's colour: its fill's, or a plan window's status when that says more. */
export function planTone(u: ChatUsage): RingTone {
  return Object.values(u.limits).map(statusTone)
    .reduce((worst, t) => (TONE_RANK[t] > TONE_RANK[worst] ? t : worst), ringTone(planPercent(u)));
}

/** 950, 84.2k, 200k, 1M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? (Math.round(k * 10) / 10).toString() : Math.round(k).toString()}k`;
  }
  const m = n / 1_000_000;
  return `${(Math.round(m * 10) / 10).toString()}M`;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  seven_day_opus: '7-day Opus window',
  seven_day_sonnet: '7-day Sonnet window',
  seven_day_overage_included: '7-day window with extra usage',
  monthly_spend: 'Monthly spend',
  overage: 'Extra usage',
  plan: 'Plan limit',
};
export function windowLabel(type: string): string {
  return WINDOW_LABELS[type] ?? type.replace(/_/g, ' ');
}

/** The windows in a steady order: 5-hour first, then the weekly ones, then anything else. */
export function orderedWindows(limits: Record<string, PlanWindow>): Array<[string, PlanWindow]> {
  const order = Object.keys(WINDOW_LABELS);
  return Object.entries(limits).sort(([a], [b]) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
}

/**
 * The windows worth a row: one with a utilization, or one whose status says it
 * is near or at its limit. An Enterprise seat's overage window, while all is
 * well, is neither.
 */
export function shownWindows(limits: Record<string, PlanWindow>): Array<[string, PlanWindow]> {
  return orderedWindows(limits).filter(([, w]) => w.utilization != null || statusTone(w) !== 'ok');
}

/** A window row's value: its percent, else what its status says. */
export function windowValue(w: PlanWindow): string {
  if (w.status === 'rejected') return 'Limit reached';
  const p = windowPercent(w);
  if (p != null) return `${p}%`;
  return w.status === 'allowed_warning' ? 'Close to the limit' : '–';
}

/** "resets 6:40 PM" today, "resets Mon 9:00 AM" later, in the browser's locale and zone. */
export function resetText(resetsAt: number, now: number, locale?: string): string {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  if (sameDay) return `resets ${time}`;
  const within = resetsAt - now < 6 * 86_400_000;
  const day = at.toLocaleDateString(locale, within ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
  return `resets ${day} ${time}`;
}

/** The ring button's accessible name. */
export function ringLabel(u: ChatUsage): string {
  const ctx = contextView(u);
  const parts = [ctx ? `Context ${ctx.percent}% used` : 'Context usage not known yet'];
  for (const [type, w] of shownWindows(u.limits)) {
    const p = windowPercent(w);
    parts.push(p != null && w.status !== 'rejected' ? `${windowLabel(type)} ${p}% used` : `${windowLabel(type)}: ${windowValue(w).toLowerCase()}`);
  }
  return parts.join(', ');
}
