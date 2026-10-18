import { describe, expect, it } from 'vitest';
import {
  initialState, parseDestination, reduce, toOtlp,
  type PiEventLike, type Span, type State,
} from '../../../deploy/pi-ext/termag-otel-core';

const RECORD = JSON.stringify({
  endpoint: 'https://otel.example.test',
  resourceAttributes: 'telemetry.project_id=abc123,termag.session.kind=interactive,termag.box=box1',
});
const RID = 'huuhcqcev124emZ9urmRjjPSNXLl';

/** Run events through the reducer at 10ms apart; returns every finished span. */
function run(events: PiEventLike[], start: State = initialState()) {
  let state = start;
  let n = 0;
  const spans: Span[] = [];
  const newId = (bytes: 8 | 16) => (++n).toString(16).padStart(bytes * 2, '0');
  events.forEach((ev, i) => {
    const r = reduce(state, ev, 1_000 + i * 10, newId);
    state = r.state;
    spans.push(...r.spans);
  });
  return { state, spans };
}
const named = (spans: Span[], name: string) => spans.filter(s => s.name === name);

describe('parseDestination', () => {
  it("reads termag-credentials' record and names pi's service, with the replay when it is one", () => {
    expect(parseDestination(RECORD, RID)).toEqual({
      endpoint: 'https://otel.example.test',
      resource: {
        'telemetry.project_id': 'abc123', 'termag.session.kind': 'interactive', 'termag.box': 'box1',
        'service.name': 'termag-pi-session', 'termag.agent': 'pi', 'termag.replay.id': RID,
      },
    });
    expect(parseDestination(RECORD, 'short')?.resource['termag.replay.id']).toBeUndefined();
  });

  it('is null for anything termag-credentials would not have written', () => {
    for (const bad of [
      null, '', 'not json', '{}',
      JSON.stringify({ endpoint: 'http://otel.example.test', resourceAttributes: 'telemetry.project_id=a' }),
      JSON.stringify({ endpoint: 'https://otel.example.test/v1', resourceAttributes: 'telemetry.project_id=a' }),
      JSON.stringify({ endpoint: 'https://otel.example.test', resourceAttributes: 'telemetry.project_id=a,x=y z' }),
      JSON.stringify({ endpoint: 'https://otel.example.test', resourceAttributes: 'termag.box=b' }),
    ]) {
      expect(parseDestination(bad)).toBeNull();
    }
  });
});

describe('termag pi telemetry reducer', () => {
  const run1 = () => run([
    { type: 'session_start', sessionId: 'sess-1' },
    { type: 'agent_start' },
    { type: 'turn_start', turnIndex: 0 },
    { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' },
    { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: true },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'toolUse', model: 'claude-opus-5-5', provider: 'pi', usage: { input: 100, output: 20, cacheRead: 5 } } },
    { type: 'turn_start', turnIndex: 1 },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 50, output: 10 } } },
    { type: 'agent_end' },
  ]);

  it('one interaction per run, a turn per model turn under it and a tool span under its turn', () => {
    const { spans } = run1();
    const [interaction] = named(spans, 'pi.interaction');
    const turns = named(spans, 'pi.turn');
    const [tool] = named(spans, 'pi.tool');
    expect(spans).toHaveLength(4);
    expect(turns.map(t => t.parentSpanId)).toEqual([interaction.spanId, interaction.spanId]);
    expect(tool.parentSpanId).toBe(turns[0].spanId);
    expect(new Set(spans.map(s => s.traceId)).size).toBe(1);
  });

  it('carries model, stop reason and token usage, summed on the interaction', () => {
    const { spans } = run1();
    expect(named(spans, 'pi.turn')[0].attributes).toMatchObject({
      'session.id': 'sess-1', 'turn.index': 0, 'turn.tool_count': 1, 'turn.stop_reason': 'toolUse',
      'gen_ai.request.model': 'claude-opus-5-5', 'gen_ai.system': 'pi',
      'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20, 'gen_ai.usage.cache_read_tokens': 5,
    });
    expect(named(spans, 'pi.interaction')[0].attributes).toMatchObject({
      'interaction.turn_count': 2, 'interaction.tool_count': 1, 'interaction.tool_error_count': 1, 'interaction.outcome': 'completed',
      'gen_ai.usage.input_tokens': 150, 'gen_ai.usage.output_tokens': 30, 'gen_ai.usage.cache_read_tokens': 5,
    });
    const [tool] = named(spans, 'pi.tool');
    expect(tool.error).toBe(true);
    expect(tool.attributes).toMatchObject({ 'tool.name': 'bash', 'tool.success': false, 'tool.duration_ms': 10 });
  });

  it('never reads a prompt, response, tool argument or result into a span', () => {
    const { spans } = run([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'SECRET_ARG' } } as PiEventLike,
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: 'SECRET_RESULT', isError: false } as PiEventLike,
      { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SECRET_TEXT' }] } as PiEventLike['message'] },
      { type: 'agent_end', messages: [{ role: 'user', content: 'SECRET_PROMPT' }] } as PiEventLike,
    ]);
    expect(JSON.stringify(toOtlp(parseDestination(RECORD)!, spans))).not.toMatch(/SECRET/);
  });

  it('drops a tool name or model that is not a plain identifier', () => {
    const { spans } = run([
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'rm -rf /' },
      { type: 'tool_execution_end', toolCallId: 't1' },
      { type: 'turn_start' },
      { type: 'turn_end', message: { role: 'assistant', model: 'a model with spaces' } },
      { type: 'agent_end' },
    ]);
    expect(named(spans, 'pi.tool')[0].attributes['tool.name']).toBeUndefined();
    expect(named(spans, 'pi.turn')[0].attributes['gen_ai.request.model']).toBeUndefined();
  });

  it('closes whatever is open on shutdown, so a quit mid-run still sends its spans', () => {
    const { spans, state } = run([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read' },
      { type: 'session_shutdown', reason: 'quit' },
    ]);
    expect(spans.map(s => s.name).sort()).toEqual(['pi.interaction', 'pi.tool', 'pi.turn']);
    expect(named(spans, 'pi.interaction')[0].attributes['interaction.outcome']).toBe('shutdown');
    expect(state).toMatchObject({ interaction: null, turn: null, tools: {} });
  });

  it('ignores events outside a run', () => {
    expect(run([{ type: 'turn_start' }, { type: 'turn_end' }, { type: 'tool_execution_end', toolCallId: 'x' }]).spans).toEqual([]);
  });
});

describe('toOtlp', () => {
  it('is an OTLP/JSON trace request with typed attributes and nanosecond times', () => {
    const { spans } = run([{ type: 'agent_start' }, { type: 'agent_end' }]);
    const body = toOtlp(parseDestination(RECORD)!, spans) as {
      resourceSpans: { resource: { attributes: unknown[] }; scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    expect(body.resourceSpans[0].resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'termag-pi-session' } });
    const [span] = body.resourceSpans[0].scopeSpans[0].spans;
    expect(span).toMatchObject({ name: 'pi.interaction', kind: 2, startTimeUnixNano: '1000000000', endTimeUnixNano: '1010000000', status: { code: 1 } });
    expect(span.attributes).toContainEqual({ key: 'interaction.turn_count', value: { intValue: '0' } });
  });
});
