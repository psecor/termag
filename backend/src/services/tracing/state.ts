// What the tracer is allowed to do right now: the kill switch and the
// sampling config. Two flags decide both when a flag source with live
// targeting is wired in (setTracingFlags, read for the process's `service`
// context at start and again on each change). Without one (the default, and
// tests), TERMAG_TRACING=on and TERMAG_TRACING_RATE stand in for them.
//
// Read on every span start and end, so the readers return module variables
// and never evaluate a flag.
import { context, ROOT_CONTEXT } from '@opentelemetry/api';

/** One rule of `server-tracing-sampling`: every field it sets must match; `rate` 0 drops, 1 keeps, N keeps 1 in N. */
export interface SamplingRule {
  method?: string;
  route?: string;
  routePrefix?: string;
  name?: string;
  namePrefix?: string;
  poll?: boolean;
  rate: number;
  /** For entries this rule matches, in place of the top-level slowMs; 0 never keeps one for slowness. */
  slowMs?: number;
}

export interface SamplingConfig {
  /** The rate when no rule matches. */
  default: number;
  /** Keep every entry with a 5xx or an error span, whatever its rate. */
  keepErrors: boolean;
  /** Keep every entry that took at least this long; 0 turns slow-keeping off. */
  slowMs: number;
  rules: SamplingRule[];
}

/** `server-tracing-sampling`'s code defaults: nothing kept but errors, and slow entries once a rate is above 0. */
export const DEFAULT_SAMPLING: SamplingConfig = { default: 0, keepErrors: true, slowMs: 3000, rules: [] };

const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const optString = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';

/**
 * The flag's value over the code defaults, key by key, as agent-spawn-limits
 * does: a key of the wrong type keeps its default, a rule with a bad rate or
 * field is skipped, unknown keys are ignored.
 */
export function parseSamplingConfig(value: unknown): SamplingConfig {
  const config: SamplingConfig = { ...DEFAULT_SAMPLING, rules: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return config;
  const v = value as Record<string, unknown>;
  if (isRate(v.default)) config.default = v.default;
  if (typeof v.keepErrors === 'boolean') config.keepErrors = v.keepErrors;
  if (isRate(v.slowMs)) config.slowMs = v.slowMs;
  if (Array.isArray(v.rules)) {
    for (const raw of v.rules) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (!isRate(r.rate)) continue;
      if (![r.method, r.route, r.routePrefix, r.name, r.namePrefix].every(optString)) continue;
      if (r.poll !== undefined && typeof r.poll !== 'boolean') continue;
      if (r.slowMs !== undefined && !isRate(r.slowMs)) continue;
      const rule: SamplingRule = { rate: r.rate };
      if (r.method !== undefined) rule.method = (r.method as string).toUpperCase();
      for (const k of ['route', 'routePrefix', 'name', 'namePrefix'] as const) {
        if (r[k] !== undefined) rule[k] = r[k] as string;
      }
      if (r.poll !== undefined) rule.poll = r.poll as boolean;
      if (r.slowMs !== undefined) rule.slowMs = r.slowMs as number;
      config.rules.push(rule);
    }
  }
  return config;
}

export interface TracingEnv {
  /** `off`: no tracer at all. `on`: the env stands in for the flags where no flag source is wired in. */
  mode: 'off' | 'on' | 'auto';
  /** TERMAG_TRACING_RATE, the env stand-in's default rate (1 when unset). */
  rate: number;
  /** Whether a flag source with live targeting will call setTracingFlags, so the flags, not the env, decide. None ships. */
  flagSource: boolean;
}

export function tracingEnvFromEnv(env: NodeJS.ProcessEnv = process.env): TracingEnv {
  const raw = (env.TERMAG_TRACING ?? '').trim().toLowerCase();
  const mode = raw === 'off' ? 'off' : raw === 'on' ? 'on' : 'auto';
  const rate = Number((env.TERMAG_TRACING_RATE ?? '').trim() || '1');
  return { mode, rate: isRate(rate) ? rate : 1, flagSource: false };
}

let enabled = false;
let sampling: SamplingConfig = DEFAULT_SAMPLING;
let source: 'none' | 'env' | 'flags' = 'none';

/** At start: the env stand-in, unless a flag source will decide (then off until the flags answer). */
export function initTracingState(env: TracingEnv): void {
  if (env.mode === 'on' && !env.flagSource) {
    enabled = true;
    sampling = { ...DEFAULT_SAMPLING, default: env.rate };
    source = 'env';
  } else {
    enabled = false;
    sampling = DEFAULT_SAMPLING;
    source = 'none';
  }
}

export function tracingEnabled(): boolean {
  return enabled;
}

export function samplingConfig(): SamplingConfig {
  return sampling;
}

export function tracingSource(): 'none' | 'env' | 'flags' {
  return source;
}

export interface TracingFlagSource {
  enabled(): Promise<boolean>;
  sampling(): Promise<unknown>;
  /** Call `listener` whenever either flag changes. */
  onChange(listener: () => void): void;
}

/**
 * Hand the decision to the flag source: read both flags now and on every change.
 * Read in the root context, so a flag-evaluation hook never files the read
 * under a request's span. Resolves once the first read has landed.
 */
export function setTracingFlags(flags: TracingFlagSource): Promise<void> {
  source = 'flags';
  let seq = 0;
  const refresh = async () => {
    const mine = ++seq;
    const [on, value] = await context.with(ROOT_CONTEXT, () => Promise.all([flags.enabled(), flags.sampling()]));
    if (mine !== seq) return; // a later change's read wins
    const next = parseSamplingConfig(value);
    if (on !== enabled || JSON.stringify(next) !== JSON.stringify(sampling)) {
      console.log(`[TRACING] ${on ? 'recording' : 'recording nothing'}; sampling ${JSON.stringify(next)}`);
    }
    enabled = on;
    sampling = next;
  };
  flags.onChange(() => { refresh().catch(err => console.warn('[TRACING] flag read failed:', (err as Error).message)); });
  return refresh().catch(err => console.warn('[TRACING] flag read failed:', (err as Error).message));
}

let registered = false;

/** Set by services/tracing.ts once its provider is the global one. */
export function markTracingRegistered(): void {
  registered = true;
}

/** Whether a tracer provider is registered: what db.ts asks before adding Prisma's operation spans. */
export function tracingRegistered(): boolean {
  return registered;
}
