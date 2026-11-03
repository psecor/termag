import { afterEach, describe, expect, it, vi } from 'vitest';
import { context, ROOT_CONTEXT, TraceFlags, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import {
  DEFAULT_SAMPLING, initTracingState, parseSamplingConfig, samplingConfig, setTracingFlags, tracingEnabled, tracingEnvFromEnv, tracingSource,
} from './state';
import { KillSwitchSampler } from './sampler';
import { carriesCredential, CredentialedParentPropagator } from './propagator';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

afterEach(() => { initTracingState({ mode: 'auto', rate: 1, flagSource: false }); });

describe('parseSamplingConfig', () => {
  it('is the code defaults for no value or a malformed one', () => {
    expect(parseSamplingConfig(null)).toEqual(DEFAULT_SAMPLING);
    expect(parseSamplingConfig('10')).toEqual(DEFAULT_SAMPLING);
    expect(parseSamplingConfig([])).toEqual(DEFAULT_SAMPLING);
  });

  it('takes each good key over its default, and ignores unknown keys', () => {
    expect(parseSamplingConfig({ default: 10, slowMs: 0, keepErrors: false, extra: 1 })).toEqual({ default: 10, slowMs: 0, keepErrors: false, rules: [] });
    expect(parseSamplingConfig({ default: -1, slowMs: 1.5, keepErrors: 'yes' })).toEqual(DEFAULT_SAMPLING);
  });

  it('skips a rule with a bad rate or field, and upper-cases methods', () => {
    const config = parseSamplingConfig({
      rules: [
        { route: '/a', rate: 0.5 }, { route: 5, rate: 1 }, { poll: 'yes', rate: 1 }, 'x',
        { method: 'post', route: '/api/status', rate: 100, unknown: true },
      ],
    });
    expect(config.rules).toEqual([{ method: 'POST', route: '/api/status', rate: 100 }]);
  });

  it('takes a rule\'s slowMs, and skips a rule whose slowMs is malformed', () => {
    const config = parseSamplingConfig({
      rules: [
        { namePrefix: 'termag.sweep.', rate: 20, slowMs: 30_000 },
        { namePrefix: 'termag.sweep.software', rate: 20, slowMs: 0 },
        { route: '/a', rate: 1, slowMs: -1 }, { route: '/b', rate: 1, slowMs: 1.5 }, { route: '/c', rate: 1, slowMs: '30000' },
        { route: '/d', rate: 1 },
      ],
    });
    expect(config.rules).toEqual([
      { namePrefix: 'termag.sweep.', rate: 20, slowMs: 30_000 },
      { namePrefix: 'termag.sweep.software', rate: 20, slowMs: 0 },
      { route: '/d', rate: 1 },
    ]);
  });

  it('reads the two sampling configs', () => {
    expect(parseSamplingConfig({ default: 0, keepErrors: true, slowMs: 0 })).toEqual({ default: 0, keepErrors: true, slowMs: 0, rules: [] });
  });
});

describe('the env and the flags', () => {
  it('parses TERMAG_TRACING and its rate', () => {
    expect(tracingEnvFromEnv({})).toEqual({ mode: 'auto', rate: 1, flagSource: false });
    expect(tracingEnvFromEnv({ TERMAG_TRACING: 'OFF' }).mode).toBe('off');
    expect(tracingEnvFromEnv({ TERMAG_TRACING: 'on', TERMAG_TRACING_RATE: '5' })).toEqual({ mode: 'on', rate: 5, flagSource: false });
    expect(tracingEnvFromEnv({ TERMAG_TRACING_RATE: 'lots' }).rate).toBe(1);
  });

  it('lets TERMAG_TRACING=on stand in for the flags only where no flag source is wired in', () => {
    initTracingState({ mode: 'on', rate: 4, flagSource: false });
    expect(tracingEnabled()).toBe(true);
    expect(samplingConfig()).toEqual({ ...DEFAULT_SAMPLING, default: 4 });
    expect(tracingSource()).toBe('env');
    initTracingState({ mode: 'on', rate: 4, flagSource: true });
    expect(tracingEnabled()).toBe(false);
    expect(samplingConfig()).toEqual(DEFAULT_SAMPLING);
  });

  it('follows the flags, read in the root context, now and on every change', async () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    try {
      let on = true;
      let value: unknown = { default: 0, keepErrors: true, slowMs: 0 };
      const seen: unknown[] = [];
      let listener: () => void = () => {};
      const flags = {
        enabled: vi.fn(async () => { seen.push(trace.getActiveSpan()); return on; }),
        sampling: vi.fn(async () => value),
        onChange: (l: () => void) => { listener = l; },
      };
      const parent = trace.wrapSpanContext({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED });
      await context.with(trace.setSpan(ROOT_CONTEXT, parent), () => setTracingFlags(flags));
      expect(tracingEnabled()).toBe(true);
      expect(samplingConfig().slowMs).toBe(0);
      expect(seen).toEqual([undefined]);
      on = false;
      value = { default: 10 };
      listener();
      await vi.waitFor(() => expect(tracingEnabled()).toBe(false));
      expect(samplingConfig().default).toBe(10);
      expect(tracingSource()).toBe('flags');
    } finally {
      context.disable();
    }
  });
});

describe('KillSwitchSampler', () => {
  const remote = trace.setSpanContext(ROOT_CONTEXT, { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.NONE, isRemote: true });
  const unsampledLocal = trace.setSpanContext(ROOT_CONTEXT, { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.NONE });

  it('records everything while on, nothing while off', () => {
    let on = false;
    const sampler = new KillSwitchSampler(() => on);
    expect(sampler.shouldSample(ROOT_CONTEXT).decision).toBe(SamplingDecision.NOT_RECORD);
    on = true;
    expect(sampler.shouldSample(ROOT_CONTEXT).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(sampler.shouldSample(remote).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('never records a child of an unrecorded local span', () => {
    expect(new KillSwitchSampler(() => true).shouldSample(unsampledLocal).decision).toBe(SamplingDecision.NOT_RECORD);
  });
});

describe('CredentialedParentPropagator', () => {
  const propagator = new CredentialedParentPropagator(new W3CTraceContextPropagator());
  const getter = {
    get: (c: Record<string, string>, k: string) => c[k],
    keys: (c: Record<string, string>) => Object.keys(c),
  };
  const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  const parentOf = (headers: Record<string, string>) => trace.getSpanContext(propagator.extract(ROOT_CONTEXT, headers, getter))?.traceId;

  it('starts a new trace for a request with no credential', () => {
    expect(parentOf({ traceparent })).toBeUndefined();
    expect(parentOf({ traceparent, cookie: 'other=1; termag.sidx=2' })).toBeUndefined();
  });

  it('continues it with a session cookie, the ALB identity or an Authorization header', () => {
    expect(parentOf({ traceparent, cookie: 'a=1; termag.sid=s%3Aabc' })).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(parentOf({ traceparent, 'x-amzn-oidc-data': 'jwt' })).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(parentOf({ traceparent, authorization: 'Bearer x' })).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('checks presence only, before authentication', () => {
    expect(carriesCredential(getter as never, { authorization: 'anything' })).toBe(true);
    expect(carriesCredential(getter as never, {})).toBe(false);
  });

  it('propagates trace context only, never baggage', () => {
    expect(propagator.fields()).toEqual(['traceparent', 'tracestate']);
  });

  it('drops an incoming tracestate', () => {
    const ctx = propagator.extract(ROOT_CONTEXT, { traceparent, tracestate: 'vendor=caller-value', authorization: 'Bearer x' }, getter);
    expect(trace.getSpanContext(ctx)?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(trace.getSpanContext(ctx)?.traceState).toBeUndefined();
  });

  it('injects a recorded trace\'s traceparent only, and nothing while tracing is off', () => {
    const setter = { set: (c: Record<string, string>, k: string, v: string) => { c[k] = v; } };
    const incoming = new W3CTraceContextPropagator().extract(ROOT_CONTEXT, { traceparent, tracestate: 'vendor=caller-value' }, getter);
    const span = trace.getSpanContext(incoming)!;
    const sent = (flags: number) => {
      const headers: Record<string, string> = {};
      propagator.inject(trace.setSpanContext(ROOT_CONTEXT, { ...span, isRemote: false, traceFlags: flags }), headers, setter);
      return headers;
    };
    expect(sent(TraceFlags.SAMPLED)).toEqual({ traceparent });
    // KillSwitchSampler off: the span isn't recorded, so the caller's trace id goes nowhere.
    expect(sent(TraceFlags.NONE)).toEqual({});
    const none: Record<string, string> = {};
    propagator.inject(ROOT_CONTEXT, none, setter);
    expect(none).toEqual({});
  });
});
