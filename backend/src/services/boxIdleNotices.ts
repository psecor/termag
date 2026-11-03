/**
 * The Slack DMs around an automatic park: the warning a lead time before, with a Keep running
 * button, and the notice once the box has parked, with what the unsaved-work
 * scan found and how to get the box back. The lifecycle sweep sends them
 * after its own guarded writes, which are what make each one go once.
 *
 * The bot reaches only the people in its own workspace.
 * An owner it can't find gets the box row
 * alone, and every send records box.idle.notice with whether it went, so the
 * pilot can measure the reach.
 */
import { prisma } from '../db';
import { getSlackApp } from '../slack/app';
import { resolveTermagUser } from '../slack/userMapping';
import { slackEscape, slackIdFor, webBase } from './briefing/slack';
import type { IdleLimit, ParkAction } from './boxLifecyclePolicy';
import { recordProductEvent } from './productEvents';

export const KEEP_RUNNING_ACTION = 'box_keep_running';

export interface NoticeOwner {
  id: string;
  slackUserId: string | null;
  googleEmail: string;
}

export interface NoticeBox {
  id: string;
  name: string;
}

interface SlackMessage {
  text: string;
  blocks: unknown[];
}

/** "40 minutes", "2 hours", "3 days": a span in the unit that reads naturally. */
export function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** "about 2 hours", "about 40 minutes", "about 3 days". */
export function aboutDuration(ms: number): string {
  return `about ${spanText(ms)}`;
}

function openTermagButton(): unknown[] {
  const base = webBase();
  return base ? [{ type: 'button', text: { type: 'plain_text', text: 'Open termag' }, url: base }] : [];
}

export interface WarningFacts {
  action: ParkAction;
  /** When the warning promised the park. */
  parkAt: Date;
  /** How long since the box's idle clock started. */
  idleMs: number;
  /** Enabled automations on the box that can't wake it, which a park skips. */
  skippedAutomations: number;
}

/** The warning DM: when the box goes down, why, what survives, and Keep running. */
export function warningMessage(box: NoticeBox, facts: WarningFacts, nowMs: number = Date.now()): SlackMessage {
  const name = slackEscape(box.name);
  const stops = facts.action === 'stop';
  const when = aboutDuration(facts.parkAt.getTime() - nowMs);
  const parts = [
    `Your box *${name}* will ${stops ? 'stop' : 'hibernate'} in ${when}: nothing has happened on it for ${spanText(facts.idleMs)}.`,
    stops
      ? 'Its disks, projects and checkouts are kept; what runs in its terminals stops with it.'
      : 'It keeps everything in memory and resumes where it was when you start it.',
  ];
  if (facts.skippedAutomations > 0) {
    const n = facts.skippedAutomations;
    parts.push(`${n} automation${n === 1 ? '' : 's'} on it can't wake it, so ${n === 1 ? 'it is' : 'they are'} skipped while it is ${stops ? 'stopped' : 'hibernated'}.`);
  }
  parts.push('Use it, or press Keep running, to keep it up.');
  const text = parts.join(' ');
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: KEEP_RUNNING_ACTION, style: 'primary', text: { type: 'plain_text', text: 'Keep running' }, value: box.id },
          ...openTermagButton(),
        ],
      },
    ],
  };
}

const MAX_NAMED_REPOS = 3;

/** One clause on the unsaved-work scan the sweep took just before the park. */
export function scanClause(scan: unknown): string {
  const s = scan && typeof scan === 'object' && !Array.isArray(scan) ? scan as Record<string, unknown> : null;
  if (!s || 'error' in s || !Array.isArray(s.repos)) return "termag couldn't check it for work that exists only on the box.";
  const repos = (s.repos as Array<{ path?: unknown }>)
    .map(r => (typeof r.path === 'string' ? r.path.split('/').filter(Boolean).pop() : null))
    .filter((n): n is string => !!n);
  const kept = typeof s.keptCheckouts === 'number' ? s.keptCheckouts : 0;
  // Repos the agent couldn't read are unchecked, not clean (Devin on #621).
  const unreadable = Array.isArray(s.errors) ? s.errors.length : 1;
  const unchecked = unreadable
    ? ` termag couldn't check ${unreadable === 1 ? 'one repo' : `${unreadable} repos`} on it, so there may be more.`
    : '';
  if (repos.length === 0 && kept === 0) {
    return unreadable
      ? `Before it went down, termag found no work that exists only on the box in the repos it could read.${unchecked}`
      : 'Before it went down, termag found no work that exists only on the box.';
  }
  const named = repos.slice(0, MAX_NAMED_REPOS).map(r => `\`${slackEscape(r)}\``).join(', ');
  const more = repos.length > MAX_NAMED_REPOS ? ` and ${repos.length - MAX_NAMED_REPOS} more` : '';
  const found = [
    repos.length ? `uncommitted or unpushed changes in ${named}${more}` : null,
    kept ? `${kept} kept cloud-session checkout${kept === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', and ');
  return `Before it went down, termag found work that exists only on the box: ${found}. It is all still there.${unchecked}`;
}

/** The notice once the box has parked: what EC2 did, what the scan found, and the way back. */
export function parkedMessage(box: NoticeBox, result: 'stopped' | 'hibernated', limit: IdleLimit, scan: unknown): SlackMessage {
  const name = slackEscape(box.name);
  const why = `after ${limit.hours} hours with no activity${limit.source === 'default' ? ' (the default limit)' : ''}`;
  const parts = result === 'stopped'
    ? [
      `I stopped *${name}* ${why}. Its disks, projects and checkouts are kept.`,
      scanClause(scan),
      `To get it back, open termag › Boxes › Start box, or run \`termag box start ${name}\`.`,
      "When it's ready, a minute or two later, its panes come back and Claude picks up the conversation it was in; dev servers and anything else you ran in a terminal need starting again.",
    ]
    : [
      `I hibernated *${name}* ${why}. Everything is where you left it, in memory too.`,
      scanClause(scan),
      `To get it back, open termag › Boxes › Resume box, or run \`termag box start ${name}\`.`,
    ];
  const text = parts.join(' ');
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements: openTermagButton() }].filter(b => b.type !== 'actions' || (b as { elements: unknown[] }).elements.length > 0) };
}

/** The warning before the sweep stops a box that never came up after a start. */
export function stuckStartWarningMessage(box: NoticeBox, startedAt: Date, stopAt: Date, nowMs: number = Date.now()): SlackMessage {
  const name = slackEscape(box.name);
  const text = `Your box *${name}* was started at ${startedAt.toISOString().slice(11, 16)} UTC, and its agent hasn't connected, `
    + `so termag can't reach it. It will be stopped in ${aboutDuration(stopAt.getTime() - nowMs)} so it stops billing; `
    + 'its disks, projects and checkouts are kept. If you are using it over SSH, restart its agent '
    + '(`systemctl --user restart termag-agent`) and it is kept.';
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements: openTermagButton() }].filter(b => b.type !== 'actions' || (b as { elements: unknown[] }).elements.length > 0) };
}

/** The notice for a box the sweep stopped because it never came up after a start. */
export function stuckStartMessage(box: NoticeBox, startedAt: Date | null): SlackMessage {
  const name = slackEscape(box.name);
  const when = startedAt ? ` at ${startedAt.toISOString().slice(11, 16)} UTC` : '';
  const text = `I stopped *${name}*: it was started${when}, and its agent never connected, `
    + 'so it was running with nobody able to use it. Its disks, projects and checkouts are kept. '
    + `Start it again from termag or with \`termag box start ${name}\`, or terminate it if that keeps happening.`;
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

/**
 * The notice for automations paused because their box was terminated
 * (boxLifecycle.pauseAutomationsForTerminate), so they don't vanish with
 * their archived projects unannounced.
 */
export function automationsPausedMessage(box: NoticeBox, names: string[], by: 'lifecycle' | 'admin'): SlackMessage {
  const name = slackEscape(box.name);
  const list = names.map(n => `*${slackEscape(n)}*`).join(', ');
  const who = by === 'admin' ? 'An admin terminated' : 'termag terminated';
  const text = `${who} your box *${name}*, which hosted ${names.length === 1 ? 'the automation' : 'the automations'} ${list}. `
    + `I paused ${names.length === 1 ? 'it' : 'them'} (the box is gone), so no run is skipped silently. `
    + 'To keep it running, recreate it on another box with `termag automation create`.';
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements: openTermagButton() }].filter(b => b.type !== 'actions' || (b as { elements: unknown[] }).elements.length > 0) };
}

/**
 * DM the owner. Never throws: a box goes down whether or not anyone could be
 * told. Records box.idle.notice either way.
 */
export async function sendIdleNotice(kind: 'warning' | 'parked' | 'automation-paused', owner: NoticeOwner, box: NoticeBox, message: SlackMessage): Promise<boolean> {
  const event = (delivered: boolean, reason: string) => {
    recordProductEvent('box.idle.notice', { user: owner.id, box: box.id }, { kind, delivered, reason });
    return delivered;
  };
  const client = getSlackApp()?.client;
  if (!client) return event(false, 'no-slack');
  const channel = await slackIdFor(client, owner);
  if (!channel) {
    console.log(`[LIFECYCLE] ${box.name}: ${kind} not sent: the bot has no Slack user for its owner`);
    return event(false, 'no-slack-user');
  }
  try {
    await client.chat.postMessage({ channel, ...message, unfurl_links: false, unfurl_media: false });
    return event(true, 'sent');
  } catch (err) {
    console.warn(`[LIFECYCLE] ${box.name}: ${kind} not sent:`, err instanceof Error ? err.message : String(err));
    return event(false, 'post-failed');
  }
}

/** Enabled automations on the box that can't wake it, for the warning. */
export async function automationsSkippedWhileParked(boxId: string): Promise<number> {
  return prisma.automation.count({ where: { enabled: true, wakeBox: false, project: { instanceId: boxId, archived: false } } })
    .catch(() => 0);
}

/**
 * Keep running from the warning DM. The clicking Slack user is matched to a
 * termag user (linked id, else email); only the box's owner is let through,
 * and the message is edited to say what happened.
 */
export function registerBoxIdleSlackActions(app: any): void {
  app.action(KEEP_RUNNING_ACTION, async ({ ack, body, client, action }: any) => {
    await ack();
    const slackUserId = body?.user?.id as string | undefined;
    const boxId = typeof action?.value === 'string' ? action.value : null;
    const channel = body?.container?.channel_id ?? body?.channel?.id;
    const ts = body?.container?.message_ts ?? body?.message?.ts;
    const reply = async (text: string) => {
      if (channel && ts) await client.chat.update({ channel, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch(() => {});
      else if (slackUserId) await client.chat.postMessage({ channel: slackUserId, text }).catch(() => {});
    };
    if (!slackUserId || !boxId) return;
    const user = await resolveTermagUser(slackUserId, client);
    if (!user) { await reply('I could not match your Slack account to a termag user, so the box was left as it was.'); return; }
    // Loaded here: routes/instances imports the lifecycle sweep, which imports this module.
    const { keepOwnedBoxRunning } = await import('../routes/instances');
    const result = await keepOwnedBoxRunning(user, boxId, 'slack');
    if (result.status === 200) {
      const lifecycle = (result.body as { lifecycle?: { idleLimitHours?: number | null } }).lifecycle;
      const hours = lifecycle?.idleLimitHours;
      await reply(`Kept running.${hours ? ` It parks after another ${hours} hours with no activity.` : ''}`);
    } else {
      await reply((result.body as { error?: string }).error ?? 'The box could not be kept running.');
    }
  });
}
