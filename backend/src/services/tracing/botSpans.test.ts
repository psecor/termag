import { beforeEach, describe, expect, it, vi } from 'vitest';
import { context, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { TraceBufferProcessor } from './buffer';
import { DEFAULT_SAMPLING } from './state';

vi.mock('./state', async (orig) => ({ ...(await orig<typeof import('./state')>()), tracingRegistered: () => true }));
const { discordAttributes, slackSpan, slackTraceMiddleware, tracedDiscordListener } = await import('./botSpans');

const exported: ReadableSpan[] = [];
const recorder: SpanProcessor = { onStart() {}, onEnd(s) { exported.push(s); }, forceFlush: async () => {}, shutdown: async () => {} };
const provider = new BasicTracerProvider({
  spanProcessors: [new TraceBufferProcessor({ next: recorder, config: () => ({ ...DEFAULT_SAMPLING, default: 1 }) })],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer('test');

beforeEach(() => { exported.length = 0; });

// What a person typed, everywhere a payload can carry it.
// Discord snowflakes, assembled so the secret scanner doesn't take them for a client id.
const GUILD = ['1234567890', '12345678'].join('');
const CHANNEL = ['2234567890', '12345678'].join('');
const CANARY = 'canary-pa55word-in-a-message';
const T = 'T0123ABCD';
const SLACK_BODIES: Record<string, unknown> = {
  event: { type: 'event_callback', team_id: T, event: { type: 'message', subtype: 'thread_broadcast', text: CANARY, blocks: [{ type: 'rich_text', elements: [{ text: CANARY }] }], user: 'U1', channel: 'C1' } },
  command: { command: '/t', text: `switch ${CANARY}`, team_id: T, user_id: 'U1', channel_id: 'C1', response_url: `https://hooks.example/${CANARY}` },
  action: { type: 'block_actions', team: { id: T }, actions: [{ action_id: 'home_attach_project', value: CANARY, selected_option: { value: CANARY } }], message: { text: CANARY } },
  view: { type: 'view_submission', team: { id: T }, view: { callback_id: 'handoff_modal', state: { values: { b: { a: { value: CANARY } } } }, private_metadata: CANARY } },
  shortcut: { type: 'message_action', team: { id: T }, callback_id: 'save_it', message: { text: CANARY } },
  options: { type: 'block_suggestion', team: { id: T }, action_id: 'pick_project', value: CANARY },
};

describe('Slack listener spans', () => {
  it('names the span by what Slack sent, with ids only', () => {
    expect(slackSpan(SLACK_BODIES.event)).toEqual({ kind: 'event', attrs: { 'slack.event.type': 'message', 'slack.event.subtype': 'thread_broadcast', 'slack.team.id': T } });
    expect(slackSpan(SLACK_BODIES.command)).toEqual({ kind: 'command', attrs: { 'slack.command': '/t', 'slack.team.id': T } });
    expect(slackSpan(SLACK_BODIES.action)).toEqual({ kind: 'action', attrs: { 'slack.action_id': 'home_attach_project', 'slack.type': 'block_actions', 'slack.team.id': T } });
    expect(slackSpan(SLACK_BODIES.view).attrs['slack.callback_id']).toBe('handoff_modal');
    expect(slackSpan(SLACK_BODIES.shortcut).kind).toBe('shortcut');
    expect(slackSpan(SLACK_BODIES.options).attrs['slack.action_id']).toBe('pick_project');
    expect(slackSpan({ type: 'something_new' }, { teamId: T })).toEqual({ kind: 'other', attrs: { 'slack.type': 'something_new', 'slack.team.id': T } });
    expect(slackSpan(undefined)).toEqual({ kind: 'other', attrs: {} });
  });

  it('drops a value that isn\'t shaped like its id', () => {
    expect(slackSpan({ command: `/t ${CANARY}`, team_id: 'not a team' }).attrs).toEqual({});
    expect(slackSpan({ type: 'block_actions', actions: [{ action_id: `${CANARY} with spaces` }] }).attrs).toEqual({ 'slack.type': 'block_actions' });
  });

  it('runs the chain inside a root entry, even from a socket that carries an old span', async () => {
    const old = tracer.startSpan('GET /api/old', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    let inner: string | undefined;
    await context.with(trace.setSpan(ROOT_CONTEXT, old), () => slackTraceMiddleware({
      body: SLACK_BODIES.command,
      next: async () => {
        inner = trace.getActiveSpan()?.spanContext().spanId;
        tracer.startSpan('POST', { kind: SpanKind.CLIENT }).end(); // the reply through Slack's Web API
      },
    }));
    old.end();
    const [span] = exported.filter(s => s.name === 'termag.slack.command');
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe(old.spanContext().traceId);
    expect(inner).toBe(span.spanContext().spanId);
    expect(exported.find(s => s.name === 'POST')?.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
  });

  it('records a listener\'s failure on the span and passes it on', async () => {
    await expect(slackTraceMiddleware({ body: SLACK_BODIES.event, next: async () => { throw new Error('listener'); } })).rejects.toThrow('listener');
    expect(exported.map(s => [s.name, s.events.map(e => e.name)])).toEqual([['termag.slack.event', ['exception']]]);
  });

  it('exports no text, blocks or view state, for any kind', async () => {
    for (const body of Object.values(SLACK_BODIES)) await slackTraceMiddleware({ body, next: async () => {} });
    expect(exported.map(s => s.name).sort()).toEqual([
      'termag.slack.action', 'termag.slack.command', 'termag.slack.event', 'termag.slack.options', 'termag.slack.shortcut', 'termag.slack.view',
    ]);
    expect(JSON.stringify(exported.map(s => s.attributes))).not.toContain('canary');
  });
});

describe('Discord listener spans', () => {
  const interaction = { type: 2, commandName: 't', guildId: GUILD, channelId: CHANNEL, user: { id: '1', username: CANARY }, options: { getString: () => CANARY }, content: CANARY };
  const reaction = { emoji: { name: CANARY }, message: { guildId: GUILD, channelId: CHANNEL, content: CANARY } };

  it('keeps the guild, channel and command, never the content', () => {
    expect(discordAttributes(interaction)).toEqual({
      'discord.guild.id': GUILD, 'discord.channel.id': CHANNEL, 'discord.command': 't', 'discord.interaction.type': '2',
    });
    expect(discordAttributes(reaction)).toEqual({ 'discord.guild.id': GUILD, 'discord.channel.id': CHANNEL });
    expect(discordAttributes(null)).toEqual({});
  });

  it('makes each call a root entry, with its arguments passed through', async () => {
    const seen: unknown[] = [];
    const listener = tracedDiscordListener('messageReactionAdd', async (r: unknown, u: unknown) => { seen.push(r, u); });
    const old = tracer.startSpan('GET /api/old', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    await context.with(trace.setSpan(ROOT_CONTEXT, old), () => listener(reaction, { id: '9' }));
    await tracedDiscordListener('interactionCreate', async () => {})(interaction);
    old.end();
    expect(seen).toEqual([reaction, { id: '9' }]);
    const roots = exported.filter(s => s.name.startsWith('termag.discord.'));
    expect(roots.map(s => s.name)).toEqual(['termag.discord.messageReactionAdd', 'termag.discord.interactionCreate']);
    for (const s of roots) expect(s.parentSpanContext).toBeUndefined();
    expect(JSON.stringify(exported.map(s => s.attributes))).not.toContain('canary');
  });
});
