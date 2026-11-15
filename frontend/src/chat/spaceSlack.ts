// What the simple UI's Slack channels dialog (pages/chat/SpaceSlackDialog.tsx)
// says and checks, kept pure so it is tested without rendering: the space
// menu's entry, a new channel's name rules (the backend's
// slack/channels.ts spaceChannelNameProblem, which stays authoritative), and
// the wording of a link's preview, a picker entry and "linked by … via …".
import type { MenuAction } from '../pages/chat/ContextMenu';
import type { SlackPickerChannel, SpaceSlackChannel, SpaceSlackPreview } from '../services/api';

export const SLACK_CHANNEL_NAME_MAX = 80;

/** Boxes that can't be a runner's (backend services/spaceSlack/enable.ts GONE_BOX_STATUSES, kept in step). */
export const GONE_BOX_STATUSES: ReadonlySet<string> = new Set(['terminated', 'failed', 'quarantined']);

/** Why a new channel's name can't be used, or null: lowercase letters, digits, - and _, at most 80, not proj-…. */
export function channelNameProblem(name: string): string | null {
  if (!name) return 'Name the channel';
  if (name.length > SLACK_CHANNEL_NAME_MAX) return `At most ${SLACK_CHANNEL_NAME_MAX} characters`;
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Only lowercase letters, digits, - and _';
  if (name.startsWith('proj-')) return 'proj-… names are for workstream channels';
  return null;
}

/** The name the create form starts with. */
export function defaultChannelName(space: string): string {
  return `space-${space}`.slice(0, SLACK_CHANNEL_NAME_MAX);
}

const VIA: Record<string, string> = {
  web: 'termag', cli: 'the CLI', create: 'termag (created)', slack_command: '/termag link',
  slack_shortcut: 'a Slack shortcut', app_home: 'Slack\'s App Home',
};

/** "linked by ana@… via the CLI · 4 Nov" for a linked channel's row. */
export function linkedLine(c: SpaceSlackChannel, now = new Date()): string {
  const at = new Date(c.linkedAt);
  const date = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `Linked by ${c.linkedBy.email ?? 'someone'} via ${VIA[c.linkedVia] ?? c.linkedVia} · ${date}${c.paused ? ' · paused' : ''}`;
}

/** The picker's line under a channel: why it can't be picked, or what linking it does. */
export function pickerHint(c: SlackPickerChannel, space: string, opts: { allowPrivate?: boolean } = {}): string {
  if (c.disabled === 'channel_linked') return c.linkedTo === space ? `Already linked to ${space}` : c.linkedTo ? `Already linked to ${c.linkedTo}` : 'Already linked to another space';
  if (c.disabled === 'channel_workstream') return 'A workstream channel: it can\'t be linked';
  if (c.disabled === 'channel_ext_shared') return 'Shared with another organisation: it can\'t be linked';
  // Linking needs you in the channel, public or private, from termag as from Slack (backend picker.ts).
  if (c.disabled === 'not_in_channel') return 'You aren\'t in this channel: join it in Slack to link it';
  if (c.disabled === 'actor_not_in_slack') return 'termag can\'t find your Slack account: sign in with the email you use in Slack';
  if (c.private && opts.allowPrivate === false) return 'Private channels can\'t be linked to spaces here';
  const members = c.members === null ? '' : `${c.members} ${c.members === 1 ? 'member' : 'members'}`;
  const termag = c.termagIn ? '' : 'termag joins when you link it';
  return [c.private ? 'Private' : '', members, termag].filter(Boolean).join(' · ');
}

/** The preview's lines, the warning first. */
export function previewLines(p: SpaceSlackPreview, space: string): Array<{ tone: 'warning' | 'info'; text: string }> {
  if (p.alreadyLinked) return [{ tone: 'info', text: `${p.channelName ? `#${p.channelName}` : 'This channel'} is already linked to ${space}.` }];
  const out: Array<{ tone: 'warning' | 'info'; text: string }> = [];
  if (p.needsInvite) out.push({ tone: 'warning', text: 'termag isn\'t in this private channel. Type /invite @termag in the channel, then try again.' });
  if (p.bystanders === null) {
    if (!p.needsInvite) out.push({ tone: 'info', text: 'termag can\'t see who is in this channel yet.' });
  } else if (p.bystanders > 0) {
    out.push({ tone: 'warning', text: `${p.bystanders} ${p.bystanders === 1 ? 'person' : 'people'} in this channel ${p.bystanders === 1 ? 'isn\'t a member' : 'aren\'t members'} of ${space}, and will see what termag answers there.` });
  } else {
    out.push({ tone: 'info', text: `Everyone in this channel is a member of ${space}.` });
  }
  if (p.firstLink) out.push({ tone: 'info', text: `This is ${space}'s first channel: linking it turns Slack on for the space, with you as its runner.` });
  return out;
}

/** The message of a failed request: the server's own refusal where there is one. */
export function slackErrorText(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string; suggestion?: string } } })?.response?.data;
  if (data?.error) return data.suggestion && !data.error.includes(data.suggestion) ? `${data.error} Try ${data.suggestion}.` : data.error;
  return fallback;
}

/**
 * The space's Slack channels entry in its head's ⋮ menu (chat/spaceMenu.ts's
 * space section, after Share space). Only with space-channels-enabled on;
 * nothing for "No space".
 */
export function spaceSlackActions(space: string | null, enabled: boolean, open: (space: string) => void): Array<MenuAction & { hint: string }> {
  if (space === null || !enabled) return [];
  return [{ label: 'Slack channels', hint: `Slack channels linked to ${space}`, onSelect: () => open(space) }];
}
