// Root spans for the chat bots' listeners:
// Slack's Bolt and discord.js both run their listeners in
// their gateway socket's context, so each listener gets a trace of its own.
//
// Ids and enums only: the slash command's name, an action or callback id, the
// event type, the team, guild and channel ids. Never a message's text, its
// blocks, a view's state or anything a person typed (a command's text, a
// Discord option's value); ScrubbingExporter passes these attributes through
// as they are. Each value must also look like an id of its kind, so a payload
// of an unexpected shape adds nothing rather than something it shouldn't.
//
// Neither module is imported here: services/tracing.ts must load neither
// @slack/bolt nor discord.js (tracing.test.ts).
import type { Attributes } from '@opentelemetry/api';
import { rootSpan } from './spans';

const SLACK_COMMAND = /^\/[a-z0-9_-]{1,32}$/;
const SLACK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const SLACK_TEAM = /^[A-Z0-9]{1,20}$/;
const ENUM = /^[a-z_]{1,48}$/;
const SNOWFLAKE = /^\d{1,24}$/;

const pick = (v: unknown, shape: RegExp): string | undefined => (typeof v === 'string' && shape.test(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

function compact(attrs: Record<string, string | undefined>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
}

export type SlackKind = 'event' | 'command' | 'action' | 'view' | 'shortcut' | 'options' | 'other';

/** What a Bolt request is, and its ids, from its body alone. Pure. */
export function slackSpan(body: unknown, context?: unknown): { kind: SlackKind; attrs: Attributes } {
  const b = obj(body);
  const team = pick(b.team_id, SLACK_TEAM) ?? pick(obj(b.team).id, SLACK_TEAM) ?? pick(obj(context).teamId, SLACK_TEAM);
  const firstAction = obj(Array.isArray(b.actions) ? b.actions[0] : undefined);
  let kind: SlackKind = 'other';
  let ids: Record<string, string | undefined> = {};
  if (b.type === 'event_callback') {
    const event = obj(b.event);
    kind = 'event';
    ids = { 'slack.event.type': pick(event.type, ENUM), 'slack.event.subtype': pick(event.subtype, ENUM) };
  } else if (typeof b.command === 'string') {
    kind = 'command';
    ids = { 'slack.command': pick(b.command, SLACK_COMMAND) };
  } else if (b.type === 'block_actions') {
    kind = 'action';
    ids = { 'slack.action_id': pick(firstAction.action_id, SLACK_ID) };
  } else if (b.type === 'interactive_message') {
    kind = 'action';
    ids = { 'slack.callback_id': pick(b.callback_id, SLACK_ID) };
  } else if (b.type === 'view_submission' || b.type === 'view_closed') {
    kind = 'view';
    ids = { 'slack.callback_id': pick(obj(b.view).callback_id, SLACK_ID) };
  } else if (b.type === 'shortcut' || b.type === 'message_action') {
    kind = 'shortcut';
    ids = { 'slack.callback_id': pick(b.callback_id, SLACK_ID) };
  } else if (b.type === 'block_suggestion') {
    kind = 'options';
    ids = { 'slack.action_id': pick(b.action_id, SLACK_ID) };
  } else if (b.type === 'dialog_suggestion') {
    kind = 'options';
    ids = { 'slack.callback_id': pick(b.callback_id, SLACK_ID) };
  }
  const type = kind === 'event' || kind === 'command' ? undefined : pick(b.type, ENUM);
  return { kind, attrs: compact({ ...ids, 'slack.type': type, 'slack.team.id': team }) };
}

/**
 * Bolt global middleware: the rest of the chain, and every listener it
 * reaches, inside `termag.slack.<kind>`. First in slack/app.ts, so the span
 * covers slackSurfaceMiddleware and the listeners alike.
 */
export async function slackTraceMiddleware(args: { body?: unknown; context?: unknown; next: () => Promise<void> }): Promise<void> {
  let span: ReturnType<typeof slackSpan>;
  try { span = slackSpan(args.body, args.context); } catch { span = { kind: 'other', attrs: {} }; }
  await rootSpan(`termag.slack.${span.kind}`, span.attrs, () => args.next());
}

interface DiscordLike {
  guildId?: unknown;
  channelId?: unknown;
  commandName?: unknown;
  type?: unknown;
  message?: unknown;
}

/** Ids of a discord.js listener's first argument: an interaction, or a reaction (whose message has the ids). Pure. */
export function discordAttributes(first: unknown): Attributes {
  const a = obj(first) as DiscordLike;
  const message = obj(a.message) as DiscordLike;
  return compact({
    'discord.guild.id': pick(a.guildId, SNOWFLAKE) ?? pick(message.guildId, SNOWFLAKE),
    'discord.channel.id': pick(a.channelId, SNOWFLAKE) ?? pick(message.channelId, SNOWFLAKE),
    'discord.command': pick(a.commandName, /^[a-z0-9_-]{1,32}$/),
    'discord.interaction.type': typeof a.type === 'number' && Number.isInteger(a.type) ? String(a.type) : undefined,
  });
}

/** A discord.js listener in a root span `termag.discord.<event>` per call. */
export function tracedDiscordListener<A extends unknown[]>(event: string, listener: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> | void {
  const name = `termag.discord.${event}`;
  return (...args: A) => {
    let attrs: Attributes;
    try { attrs = discordAttributes(args[0]); } catch { attrs = {}; }
    return rootSpan(name, attrs, () => listener(...args));
  };
}
