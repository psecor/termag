/**
 * termag-otel-core — the pure part of termag's pi telemetry extension.
 *
 * Turns pi's lifecycle events into OpenTelemetry spans for the telemetry
 * project termag ships to: one `pi.interaction` per
 * agent run, a `pi.turn` per model turn under it (model, provider, stop
 * reason, token usage) and a `pi.tool` per tool execution under its turn (tool
 * name, success, duration). Metadata only, like Claude Code's export with its
 * OTEL_LOG_* gates unset: no prompt, response, tool argument or result is ever
 * read into a span. No imports, no I/O, so
 * backend/src/providers/piOtelExtension.test.ts can exercise all of it.
 */

/** The record termag-credentials writes (~/.config/termag/agent-telemetry.json). */
export interface Destination {
  endpoint: string;
  resource: Record<string, string>;
}

const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.:-]+$/;
const RESOURCE = /^[A-Za-z0-9._=,-]+$/;
const REPLAY_ID = /^[A-Za-z0-9]{20,64}$/;

/**
 * The destination from the record's text, with pi's service name and, for a
 * browser-started launch, the replay it came from; null for anything
 * termag-credentials would not have written.
 */
export function parseDestination(text: string | null, replayId?: string): Destination | null {
  if (!text) return null;
  let rec: unknown;
  try { rec = JSON.parse(text); } catch { return null; }
  const { endpoint, resourceAttributes } = (rec ?? {}) as { endpoint?: unknown; resourceAttributes?: unknown };
  if (typeof endpoint !== 'string' || !HTTPS_ORIGIN.test(endpoint)) return null;
  if (typeof resourceAttributes !== 'string' || !RESOURCE.test(resourceAttributes)) return null;
  const resource: Record<string, string> = {};
  for (const pair of resourceAttributes.split(',')) {
    const [k, v, ...rest] = pair.split('=');
    if (k && v && rest.length === 0) resource[k] = v;
  }
  if (!resource['telemetry.project_id']) return null;
  resource['service.name'] = 'termag-pi-session';
  resource['termag.agent'] = 'pi';
  if (replayId && REPLAY_ID.test(replayId)) resource['termag.replay.id'] = replayId;
  return { endpoint, resource };
}

export type AttrValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  error: boolean;
  attributes: Record<string, AttrValue>;
}

interface Open {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  attributes: Record<string, AttrValue>;
}

export interface State {
  sessionId: string | null;
  interaction: (Open & { turns: number; tools: number; toolErrors: number; tokens: Record<string, number> }) | null;
  turn: (Open & { tools: number }) | null;
  tools: Record<string, Open>;
}

/** Structural view of the pi events read here. Never import pi's types. */
export interface PiEventLike {
  type: string;
  /** session_start (filled by the adapter from ctx.sessionManager). */
  sessionId?: string;
  /** session_start / session_shutdown */
  reason?: string;
  /** turn_start / turn_end */
  turnIndex?: number;
  /** tool_execution_start / _end */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** turn_end / message_end */
  message?: {
    role?: string;
    stopReason?: string;
    model?: string;
    provider?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
}

export function initialState(): State {
  return { sessionId: null, interaction: null, turn: null, tools: {} };
}

export type NewId = (bytes: 8 | 16) => string;

const TOKEN_KEYS = [['input', 'input'], ['output', 'output'], ['cacheRead', 'cache_read'], ['cacheWrite', 'cache_write']] as const;

// A tool name is pi's own or an extension's identifier; anything else is dropped.
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const LABEL = /^[A-Za-z0-9_.:/@-]{1,128}$/;
const label = (v: unknown): string | undefined => (typeof v === 'string' && LABEL.test(v) ? v : undefined);

function closeAll(s: State, now: number, out: Span[], reason: string): void {
  for (const [id, t] of Object.entries(s.tools)) {
    out.push({ ...t, name: 'pi.tool', endMs: now, error: true, attributes: { ...t.attributes, 'tool.outcome': reason } });
    delete s.tools[id];
  }
  if (s.turn) {
    out.push({ ...s.turn, name: 'pi.turn', endMs: now, error: false, attributes: { ...s.turn.attributes, 'turn.tool_count': s.turn.tools } });
    s.turn = null;
  }
  if (s.interaction) {
    const i = s.interaction;
    const attributes: Record<string, AttrValue> = {
      ...i.attributes, 'interaction.turn_count': i.turns, 'interaction.tool_count': i.tools,
      'interaction.tool_error_count': i.toolErrors, 'interaction.outcome': reason,
    };
    for (const [k, v] of Object.entries(i.tokens)) attributes[`gen_ai.usage.${k}_tokens`] = v;
    out.push({ ...i, name: 'pi.interaction', endMs: now, error: false, attributes });
    s.interaction = null;
  }
}

function common(s: State): Record<string, AttrValue> {
  return s.sessionId ? { 'session.id': s.sessionId } : {};
}

/** One event in, the spans it finished out. Mutates nothing it was given. */
export function reduce(prev: State, ev: PiEventLike, now: number, newId: NewId): { state: State; spans: Span[] } {
  const s: State = {
    ...prev,
    interaction: prev.interaction && { ...prev.interaction, tokens: { ...prev.interaction.tokens } },
    turn: prev.turn && { ...prev.turn },
    tools: { ...prev.tools },
  };
  const out: Span[] = [];
  switch (ev.type) {
    case 'session_start': {
      closeAll(s, now, out, 'session_start');
      s.sessionId = label(ev.sessionId) ?? null;
      break;
    }
    case 'agent_start': {
      closeAll(s, now, out, 'superseded');
      s.interaction = {
        traceId: newId(16), spanId: newId(8), startMs: now, attributes: common(s),
        turns: 0, tools: 0, toolErrors: 0, tokens: {},
      };
      break;
    }
    case 'turn_start': {
      if (!s.interaction) break;
      if (s.turn) out.push({ ...s.turn, name: 'pi.turn', endMs: now, error: false, attributes: { ...s.turn.attributes, 'turn.tool_count': s.turn.tools } });
      const attributes: Record<string, AttrValue> = { ...common(s) };
      if (typeof ev.turnIndex === 'number') attributes['turn.index'] = ev.turnIndex;
      s.turn = { traceId: s.interaction.traceId, spanId: newId(8), parentSpanId: s.interaction.spanId, startMs: now, attributes, tools: 0 };
      s.interaction.turns += 1;
      break;
    }
    case 'tool_execution_start': {
      if (!s.interaction || !ev.toolCallId) break;
      const attributes: Record<string, AttrValue> = { ...common(s) };
      if (ev.toolName && TOOL_NAME.test(ev.toolName)) attributes['tool.name'] = ev.toolName;
      const parent = s.turn ?? s.interaction;
      s.tools[ev.toolCallId] = { traceId: s.interaction.traceId, spanId: newId(8), parentSpanId: parent.spanId, startMs: now, attributes };
      break;
    }
    case 'tool_execution_end': {
      const t = ev.toolCallId ? s.tools[ev.toolCallId] : undefined;
      if (!t || !ev.toolCallId) break;
      delete s.tools[ev.toolCallId];
      const error = ev.isError === true;
      out.push({ ...t, name: 'pi.tool', endMs: now, error, attributes: { ...t.attributes, 'tool.success': !error, 'tool.duration_ms': now - t.startMs } });
      if (s.turn) s.turn.tools += 1;
      if (s.interaction) {
        s.interaction.tools += 1;
        if (error) s.interaction.toolErrors += 1;
      }
      break;
    }
    case 'turn_end': {
      if (!s.turn) break;
      const m = ev.message;
      const attributes: Record<string, AttrValue> = { ...s.turn.attributes, 'turn.tool_count': s.turn.tools };
      if (m?.role === 'assistant') {
        const model = label(m.model), provider = label(m.provider), stop = label(m.stopReason);
        if (model) attributes['gen_ai.request.model'] = model;
        if (provider) attributes['gen_ai.system'] = provider;
        if (stop) attributes['turn.stop_reason'] = stop;
        for (const [from, to] of TOKEN_KEYS) {
          const n = m.usage?.[from];
          if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) continue;
          attributes[`gen_ai.usage.${to}_tokens`] = n;
          if (s.interaction) s.interaction.tokens[to] = (s.interaction.tokens[to] ?? 0) + n;
        }
      }
      out.push({ ...s.turn, name: 'pi.turn', endMs: now, error: m?.stopReason === 'error', attributes });
      s.turn = null;
      break;
    }
    case 'agent_end': {
      closeAll(s, now, out, 'completed');
      break;
    }
    case 'session_shutdown': {
      closeAll(s, now, out, 'shutdown');
      break;
    }
  }
  return { state: s, spans: out };
}

const nanos = (ms: number): string => `${Math.round(ms)}000000`;

function attr(key: string, value: AttrValue) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  return { key, value: { stringValue: value } };
}

/** An OTLP/JSON ExportTraceServiceRequest for the spans. */
export function toOtlp(dest: Destination, spans: Span[]): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: Object.entries(dest.resource).map(([k, v]) => attr(k, v)) },
      scopeSpans: [{
        scope: { name: 'termag-otel' },
        spans: spans.map(s => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: s.name === 'pi.interaction' ? 2 : 1,
          startTimeUnixNano: nanos(s.startMs),
          endTimeUnixNano: nanos(Math.max(s.endMs, s.startMs)),
          attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
          status: { code: s.error ? 2 : 1 },
        })),
      }],
    }],
  };
}
