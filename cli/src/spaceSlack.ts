import type { Api } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { confirmOrRefuse } from './lifecycle.js';
import { json, table } from './output.js';

/**
 * `termag space slack …`: a space's Slack channels, over routes/spaceSlack.ts. Links made here are recorded `via: cli`.
 *
 * Not `termag space link`, which is `termag space url` (a file's browser
 * link) and has nothing to do with Slack. In Slack itself the same things are
 * `/termag link <space>` and `/termag unlink`, typed in the channel.
 */

const USAGE = [
  'termag space slack status <space>',
  'termag space slack channels [query]',
  'termag space slack link <space> <#channel|id> [--runner-box <box> | --new-box]',
  'termag space slack link <space> --create <name> [--private] [--invite-members] [--runner-box <box> | --new-box]',
  'termag space slack unlink <space> <#channel|id> [--archive]',
  'termag space slack pause|resume|disable <space>',
  'termag space slack runner <space> offer <email> | accept [--runner-box <box> | --new-box] | cancel',
];

export const SPACE_SLACK_COMMAND: CommandSpec = {
  summary: 'Link Slack channels to a space, and manage its Slack (owners); not `space link`, which is `space url`',
  usage: USAGE.join('\n       '),
  options: {
    // Not --box: option names are shared by every command, and another command's --box is a switch.
    'runner-box': { type: 'string' },
    'new-box': { type: 'boolean' },
    create: { type: 'string' },
    private: { type: 'boolean' },
    'invite-members': { type: 'boolean' },
    archive: { type: 'boolean' },
  },
  maxArgs: 4,
  details: [
    'Every link and unlink shows a preview first (who in the channel is not a member of the space) and asks;',
    'pass --yes when no terminal is attached. The first link turns Slack on for the space with you as its',
    'runner, on --runner-box <box> (one of yours) or a new small box (--new-box, the default).',
    'A channel is #name, a Slack id (C0123ABCD) or <#C0123ABCD|name>. A private channel needs termag in it:',
    '`/invite @termag` there first. From Slack: `/termag link <space>` in the channel.',
  ].join('\n'),
};

interface ChannelView {
  channelId: string; name: string; private: boolean; createdByTermag: boolean;
  linkedBy: { userId: string; email: string | null }; linkedVia: string; linkedAt: string; paused: boolean;
}
interface StatusView {
  space: string; enabled: boolean; status: string | null;
  runner: { userId: string; email: string | null } | null;
  box: { kind: 'existing'; id: string; name: string } | { kind: 'new'; size: string } | null;
  pendingRunner: { userId: string; email: string | null } | null;
  caps: { channelsPerSpace: number; allowPrivate: boolean };
  channels: ChannelView[];
  you: { owner: boolean; runner: boolean };
  slack: 'slack' | 'fake' | 'none';
}
interface PickerEntry { id: string; name: string; private: boolean; termagIn: boolean; members: number | null; linkedTo?: string | null; disabled?: string }
interface Preview { bystanders: number | null; needsInvite: boolean; firstLink: boolean; channelName: string | null; isPrivate: boolean; alreadyLinked?: boolean }

const enc = encodeURIComponent;
const SLACK_ID_RE = /^[CG][A-Z0-9]{7,}$/;
/** Picker pages a #name lookup follows (each scans up to 1,000 Slack channels). */
const NAME_LOOKUP_PAGES = 10;

function needArg(v: string | undefined, what: string): string {
  if (!v) throw usage(`${what}. Usage:\n  ${USAGE.join('\n  ')}`);
  return v;
}

/** A channel id from `#name`, an id or `<#C…|name>`; names are looked up in the picker. */
async function channelIdOf(a: Api, raw: string): Promise<{ id: string; name: string | null }> {
  const mention = /^<#([A-Z0-9]+)(?:\|([^>]*))?>$/.exec(raw);
  if (mention) return { id: mention[1], name: mention[2] || null };
  if (SLACK_ID_RE.test(raw)) return { id: raw, name: null };
  const name = raw.replace(/^#/, '').toLowerCase();
  // The picker matches by substring, a page at a time: follow its cursor until the exact name turns up.
  let found: PickerEntry | undefined;
  let cursor: string | null = null;
  for (let page = 0; page < NAME_LOOKUP_PAGES && !found; page++) {
    const r: { channels: PickerEntry[]; nextCursor: string | null } = await a.request('GET', `/spaces/slack/channels?query=${enc(name)}${cursor ? `&cursor=${enc(cursor)}` : ''}`);
    found = r.channels.find(c => c.name === name);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  if (!found) {
    const more = cursor ? ' (termag stopped looking after many channels)' : '';
    throw new CliError('not_found', `No channel #${name} that you can see${more}. A private channel needs termag in it (\`/invite @termag\`); or pass its id`);
  }
  return { id: found.id, name: found.name };
}

function boxOf(args: ParsedArgs): { existing: string } | { new: { size: 'small' } } | undefined {
  const box = typeof args.options['runner-box'] === 'string' ? args.options['runner-box'] : undefined;
  if (box && args.options['new-box']) throw usage('Pass --runner-box <box> or --new-box, not both');
  if (box) return { existing: box };
  if (args.options['new-box']) return { new: { size: 'small' } };
  return undefined;
}

function who(p: { email: string | null; userId: string } | null): string {
  return p ? (p.email ?? p.userId) : '-';
}

function printStatus(ctx: Ctx, s: StatusView): void {
  if (!s.enabled) {
    if (s.channels.length) {
      // A disable that couldn't unlink everything: say what's left, and how to finish.
      ctx.out(`Slack is off for ${s.space}, but ${s.channels.length} channel(s) are still linked: run \`termag space slack disable ${s.space}\` again, or unlink them.`);
      ctx.out(table(['CHANNEL', 'ID'], s.channels.map(c => [`#${c.name}${c.private ? ' (private)' : ''}`, c.channelId])));
      return;
    }
    ctx.out(`Slack is off for ${s.space}. Link a channel with \`termag space slack link ${s.space} <#channel>\`.`);
    return;
  }
  const box = !s.box ? '-' : s.box.kind === 'existing' ? s.box.name : `a new ${s.box.size} box`;
  ctx.out(`${s.space}: Slack ${s.status}, runner ${who(s.runner)} on ${box}${s.pendingRunner ? `; offered to ${who(s.pendingRunner)}` : ''}.`);
  ctx.out(`${s.channels.length} of ${s.caps.channelsPerSpace} channels linked${s.slack === 'fake' ? ' (fake Slack workspace)' : ''}.`);
  if (s.channels.length) {
    ctx.out(table(['CHANNEL', 'LINKED BY', 'VIA', 'LINKED', 'ID'], s.channels.map(c => [
      `#${c.name}${c.private ? ' (private)' : ''}${c.paused ? ' (paused)' : ''}`, who(c.linkedBy), c.linkedVia, c.linkedAt.slice(0, 10), c.channelId,
    ])));
  }
}

function previewText(space: string, label: string, p: Preview): string {
  const lines = [`Link ${label} to ${space}?`];
  if (p.needsInvite) lines.push('  termag isn\'t in this private channel: run `/invite @termag` there first.');
  if (p.bystanders === null) lines.push('  termag can\'t see who is in the channel yet.');
  else if (p.bystanders > 0) lines.push(`  ${p.bystanders} ${p.bystanders === 1 ? 'person' : 'people'} in it ${p.bystanders === 1 ? 'is not a member' : 'are not members'} of ${space}, and will see what termag answers there.`);
  if (p.firstLink) lines.push(`  This is ${space}'s first channel: it turns Slack on for the space, with you as its runner.`);
  return lines.join('\n');
}

function unlinkPreviewText(space: string, channel: string, threads: number | null, archive: boolean): string {
  const lines = [`Unlink #${channel} from ${space}${archive ? ' and archive it' : ''}?`];
  lines.push(`  termag stops answering for ${space} in #${channel}.`);
  if (threads) lines.push(`  ${threads} termag ${threads === 1 ? 'thread' : 'threads'} there will stop answering.`);
  return lines.join('\n');
}

async function cmdStatus(ctx: Ctx, args: ParsedArgs, a: Api): Promise<ExitCode> {
  const space = needArg(args.args[1], 'Name the space');
  const s = await a.request<StatusView>('GET', `/spaces/${enc(space)}/slack`);
  if (args.json) ctx.out(json(s));
  else printStatus(ctx, s);
  return EXIT.OK;
}

async function cmdChannels(ctx: Ctx, args: ParsedArgs, a: Api): Promise<ExitCode> {
  const query = args.args[1] ?? '';
  const r = await a.request<{ channels: PickerEntry[]; nextCursor: string | null }>('GET', `/spaces/slack/channels?query=${enc(query)}`);
  if (args.json) { ctx.out(json(r)); return EXIT.OK; }
  if (!r.channels.length) { ctx.out(query ? `No channel matches ${query}.` : 'No channels.'); return EXIT.OK; }
  const why: Record<string, string> = { channel_workstream: 'a workstream channel', channel_ext_shared: 'Slack Connect' };
  ctx.out(table(['CHANNEL', 'TERMAG IN', 'MEMBERS', 'LINKED', 'ID'], r.channels.map(c => [
    `#${c.name}${c.private ? ' (private)' : ''}`, c.termagIn ? 'yes' : 'no', c.members === null ? '-' : String(c.members),
    c.disabled === 'channel_linked' ? (c.linkedTo ?? 'another space') : c.disabled ? `can't: ${why[c.disabled] ?? c.disabled}` : '-', c.id,
  ])));
  if (r.nextCursor) ctx.out('More channels: narrow it with a query.');
  return EXIT.OK;
}

async function cmdLink(ctx: Ctx, args: ParsedArgs, a: Api): Promise<ExitCode> {
  const space = needArg(args.args[1], 'Name the space');
  const createName = typeof args.options.create === 'string' ? args.options.create : undefined;
  if (createName && args.args[2]) throw usage('Pass a channel to link, or --create <name>, not both');
  if (!createName && (args.options.private || args.options['invite-members'])) throw usage('--private and --invite-members go with --create');
  const box = boxOf(args);
  let body: Record<string, unknown>;
  let label: string;
  if (createName) {
    body = { create: { name: createName.replace(/^#/, ''), private: args.options.private === true, inviteMembers: args.options['invite-members'] === true } };
    label = `a new ${args.options.private ? 'private' : 'public'} channel #${createName.replace(/^#/, '')}`;
  } else {
    const ch = await channelIdOf(a, needArg(args.args[2], 'Name the channel (#name or its id), or pass --create <name>'));
    body = { channelId: ch.id };
    label = ch.name ? `#${ch.name}` : ch.id;
  }
  if (box) body.runner = { box };
  const base = `/spaces/${enc(space)}/slack/channels`;
  const preview = await a.request<Preview>('POST', `${base}/preview`, body);
  if (!createName && preview.channelName) label = `#${preview.channelName}`;
  // On stderr, so --json keeps stdout to the answer and --yes still shows who will see the space.
  if (!preview.alreadyLinked) ctx.err(previewText(space, label, preview));
  if (preview.needsInvite) throw new CliError('conflict', `termag isn't in ${label}: run \`/invite @termag\` in the channel, then link it again`);
  // Already linked here: nothing to ask, but still send the commit. It is a no-op for the same space that
  // also repeats an interrupted link's thread freeze, and its answer is the one --json callers read.
  if (!preview.alreadyLinked) await confirmOrRefuse(ctx, args, `Link ${label} to ${space}?`);
  // Unasked, so only while it's still linked here: if someone unlinked it in between, this links nothing.
  else body.onlyIfLinked = true;
  const r = await a.request<{ channel: ChannelView; already: boolean; failedInvites: Array<{ id: string; error: string }> }>('POST', base, body);
  if (args.json) { ctx.out(json(r)); return EXIT.OK; }
  if (r.already) ctx.out(`#${r.channel.name} was already linked to ${space}.`);
  else ctx.out(`Linked #${r.channel.name} to ${space}${r.channel.createdByTermag ? ' (created)' : ''}. Mention @termag there to talk to the space.`);
  if (r.failedInvites.length) ctx.err(`termag: ${r.failedInvites.length} member invite(s) failed: ${r.failedInvites.map(f => f.error).join(', ')}`);
  return EXIT.OK;
}

async function cmdUnlink(ctx: Ctx, args: ParsedArgs, a: Api): Promise<ExitCode> {
  const space = needArg(args.args[1], 'Name the space');
  const raw = needArg(args.args[2], 'Name the channel (#name or its id)');
  // A linked channel's id is in the status; look the name up there first, so a channel termag has left still resolves.
  let id: string;
  const status = await a.request<StatusView>('GET', `/spaces/${enc(space)}/slack`);
  const name = raw.replace(/^#/, '').toLowerCase();
  const linked = status.channels.find(c => c.channelId === raw || c.name === name);
  if (linked) id = linked.channelId;
  else id = (await channelIdOf(a, raw)).id;
  const base = `/spaces/${enc(space)}/slack/channels/${enc(id)}`;
  const preview = await a.request<{ channel: ChannelView; threads: number | null; canArchive: boolean }>('GET', base);
  if (args.options.archive && !preview.canArchive) throw usage(`--archive is only for a channel termag created; #${preview.channel.name} wasn't`);
  // The preview on stderr whatever --yes and --json say, as link's is: what stops answering is never skipped.
  ctx.err(unlinkPreviewText(space, preview.channel.name, preview.threads, !!args.options.archive));
  await confirmOrRefuse(ctx, args, `Unlink #${preview.channel.name} from ${space}${args.options.archive ? ' and archive it' : ''}?`);
  const r = await a.request<{ unlinked: string; name: string; archived: boolean }>('DELETE', `${base}${args.options.archive ? '?archive=true' : ''}`);
  if (args.json) ctx.out(json(r));
  else ctx.out(`Unlinked #${r.name} from ${space}${r.archived ? ', and archived it' : ''}.`);
  return EXIT.OK;
}

async function cmdPauseResume(ctx: Ctx, args: ParsedArgs, a: Api, action: 'pause' | 'resume'): Promise<ExitCode> {
  const space = needArg(args.args[1], 'Name the space');
  const s = await a.request<StatusView>('POST', `/spaces/${enc(space)}/slack/${action}`);
  if (args.json) ctx.out(json(s));
  else ctx.out(action === 'pause' ? `Paused ${space}: termag stops answering in its channels until you resume.` : `Resumed ${space}.`);
  return EXIT.OK;
}

async function cmdDisable(ctx: Ctx, args: ParsedArgs, a: Api): Promise<ExitCode> {
  const space = needArg(args.args[1], 'Name the space');
  await confirmOrRefuse(ctx, args, `Turn Slack off for ${space}, unlinking every channel?`);
  const r = await a.request<{ disabled: boolean; unlinked: number; remaining?: number; unfrozen?: number; reenabled?: boolean }>('DELETE', `/spaces/${enc(space)}/slack`);
  const incomplete = !!(r.remaining || r.unfrozen || r.reenabled);
  if (args.json) { ctx.out(json(r)); return incomplete ? EXIT.FAILED : EXIT.OK; }
  if (r.reenabled) {
    ctx.err(`termag: someone linked a channel to ${space} while it was being disabled, so Slack is on again; run \`termag space slack status ${space}\``);
    return EXIT.FAILED;
  }
  ctx.out(`Slack is off for ${space}; ${r.unlinked} channel(s) unlinked.`);
  if (r.unfrozen) ctx.err(`termag: ${r.unfrozen} channel(s)' threads could not be frozen yet; run \`termag space slack disable ${space}\` again`);
  if (r.unfrozen && !r.remaining) return EXIT.FAILED;
  if (r.remaining) {
    ctx.err(`termag: ${r.remaining} channel(s) are still linked; run \`termag space slack disable ${space}\` again`);
    return EXIT.FAILED;
  }
  return EXIT.OK;
}

async function cmdRunner(ctx: Ctx, args: ParsedArgs, a: Api): Promise<ExitCode> {
  const space = needArg(args.args[1], 'Name the space');
  const action = needArg(args.args[2], 'offer <email>, accept or cancel');
  let body: Record<string, unknown>;
  if (action === 'offer') body = { offer: needArg(args.args[3], 'Name the owner to offer it to (their email)') };
  else if (action === 'accept') body = { accept: true, ...(boxOf(args) ? { box: boxOf(args) } : {}) };
  else if (action === 'cancel') body = { cancel: true };
  else throw usage(`Unknown runner action ${JSON.stringify(action)}: offer <email>, accept or cancel`);
  const s = await a.request<StatusView>('POST', `/spaces/${enc(space)}/slack/runner`, body);
  if (args.json) { ctx.out(json(s)); return EXIT.OK; }
  if (action === 'offer') ctx.out(`Offered ${space}'s runner to ${who(s.pendingRunner)}; they accept with \`termag space slack runner ${space} accept\`.`);
  else if (action === 'cancel') ctx.out(`Withdrew the offer; you are still ${space}'s runner.`);
  else ctx.out(`You are now ${space}'s runner.`);
  return EXIT.OK;
}

export async function cmdSpaceSlack(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const action = needArg(args.args[0], 'Say what to do');
  const a = await authedApi(ctx, session(ctx, args), { timeoutMs: 60_000 });
  switch (action) {
    case 'status': return cmdStatus(ctx, args, a);
    case 'channels': return cmdChannels(ctx, args, a);
    case 'link': return cmdLink(ctx, args, a);
    case 'unlink': return cmdUnlink(ctx, args, a);
    case 'pause': case 'resume': return cmdPauseResume(ctx, args, a, action);
    case 'disable': return cmdDisable(ctx, args, a);
    case 'runner': return cmdRunner(ctx, args, a);
    default: throw usage(`Unknown action ${JSON.stringify(action)}. Usage:\n  ${USAGE.join('\n  ')}`);
  }
}
