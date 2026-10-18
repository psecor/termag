/**
 * The briefing as a Slack DM (decided 2026-10-11, phase 2): the window label
 * first, then the summary, what was left open and what to pick up, each item
 * linking into its session when FRONTEND_URL is set, and a "Run again"
 * button. Only the composed text goes to Slack, never pane or transcript text.
 *
 * Sent with the Web API client, which stays up on a draining process too; the
 * button's action arrives through Socket Mode, i.e. on the lease holder.
 */
import { prisma } from '../../db';
import { getSlackApp } from '../../slack/app';
import { resolveTermagUser } from '../../slack/userMapping';
import { readSchedule } from './schedule';
import { startBriefing } from './runner';
import { viewById } from './store';
import type { BriefingView } from './types';
import { windowPrefix } from './window';

export const RUN_AGAIN_ACTION = 'briefing_run_again';

const KIND_LABEL: Record<string, string> = { question: 'Question', decision: 'Decision', action: 'To do', blocked: 'Blocked' };

/** Slack mrkdwn needs &, < and > escaped in user-visible text. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sessionLink(base: string | null, projectId: string | null, workstream: string | null): string | null {
  if (!base || !projectId) return null;
  const ws = workstream && workstream !== 'main' ? `&ws=${encodeURIComponent(workstream)}` : '';
  return `${base}/?project=${encodeURIComponent(projectId)}${ws}`;
}

export function webBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.FRONTEND_URL?.trim();
  if (!url) return null;
  return `${url.replace(/\/+$/, '')}${(env.BASE_PATH ?? '').replace(/\/+$/, '')}`;
}

export function briefingBlocks(b: BriefingView, base: string | null): { text: string; blocks: unknown[] } {
  const c = b.content;
  const where = (projectId: string | null, workstream: string | null) => {
    const name = projectId ? b.projects[projectId]?.name : null;
    if (!name) return null;
    const label = slackEscape(workstream && workstream !== 'main' ? `${name} · ${workstream}` : name);
    const link = sessionLink(base, projectId, workstream);
    return link ? `<${link}|${label}>` : `*${label}*`;
  };
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Your termag briefing' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${windowPrefix(b.window.basis)} · ${slackEscape(b.window.label)}${b.boxName ? ` · reviewed on ${slackEscape(b.boxName)}` : ''}` }] },
  ];
  if (b.status !== 'done' || !c) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackEscape(b.error ?? 'The briefing did not finish.') } });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackEscape(c.summary) } });
    if (c.carryovers.length) {
      const lines = c.carryovers.slice(0, 10).map(x => {
        const w = where(x.projectId, x.workstream);
        return `• *${KIND_LABEL[x.kind] ?? 'To do'}*${w ? ` ${w}` : ''}: ${slackEscape(x.title)}${x.detail ? `\n   ${slackEscape(x.detail)}` : ''}`;
      });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Left open*\n${lines.join('\n')}`.slice(0, 2900) } });
    }
    if (c.suggestions.length) {
      const lines = c.suggestions.slice(0, 5).map((x, i) => {
        const w = where(x.projectId, x.workstream);
        return `${i + 1}. ${w ? `${w}: ` : ''}${slackEscape(x.text)}${x.why ? ` _${slackEscape(x.why)}_` : ''}`;
      });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Pick up today*\n${lines.join('\n')}`.slice(0, 2900) } });
    }
  }
  const actions: unknown[] = [{ type: 'button', action_id: RUN_AGAIN_ACTION, text: { type: 'plain_text', text: 'Run again' }, value: 'run' }];
  if (base) actions.push({ type: 'button', text: { type: 'plain_text', text: 'Open dashboard' }, url: `${base}/dashboard` });
  blocks.push({ type: 'actions', elements: actions });
  const text = c ? `Your termag briefing: ${c.summary}`.slice(0, 300) : `Your termag briefing: ${b.error ?? 'did not finish'}`;
  return { text, blocks };
}

/** The user's Slack id: the linked one, else a lookup by email (users:read.email), linked for next time. */
export async function slackIdFor(client: any, user: { id: string; slackUserId: string | null; googleEmail: string }): Promise<string | null> {
  if (user.slackUserId) return user.slackUserId;
  try {
    const r = await client.users.lookupByEmail({ email: user.googleEmail });
    const id = r?.user?.id as string | undefined;
    if (!id) return null;
    await prisma.user.update({ where: { id: user.id }, data: { slackUserId: id } }).catch(() => {});
    return id;
  } catch {
    return null;
  }
}

/** Undelivered DMs are retried by the scheduler for this long after the run finished. */
export const DM_RETRY_MS = 30 * 60 * 1000;

/**
 * DM a finished (or failed) briefing once, if its run asked for one: the
 * scheduler sets `deliverSlack` from the schedule's DM choice, Slack's "Run
 * again" always sets it, and "Run now" never does. The claim is released when
 * the post fails, so the scheduler's retry pass tries again. Without a Slack
 * account the row stops asking (deliverSlack false).
 */
export async function deliverBriefingDm(briefingId: string): Promise<void> {
  const client = getSlackApp()?.client;
  if (!client) return;
  const row = await prisma.briefing.findUnique({
    where: { id: briefingId },
    select: { userId: true, deliverSlack: true, slackSentAt: true, user: { select: { id: true, slackUserId: true, googleEmail: true } } },
  });
  if (!row || !row.deliverSlack || row.slackSentAt) return;
  const view = await viewById(row.userId, briefingId);
  if (!view) return;
  const channel = await slackIdFor(client, row.user);
  if (!channel) {
    console.log(`[BRIEFING] ${briefingId}: no Slack account for the owner, DM skipped`);
    await prisma.briefing.update({ where: { id: briefingId }, data: { deliverSlack: false } }).catch(() => {});
    return;
  }
  const claimed = await prisma.briefing.updateMany({ where: { id: briefingId, slackSentAt: null }, data: { slackSentAt: new Date() } });
  if (claimed.count === 0) return;
  try {
    await client.chat.postMessage({ channel, ...briefingBlocks(view, webBase()) });
  } catch (err) {
    await prisma.briefing.updateMany({ where: { id: briefingId }, data: { slackSentAt: null } }).catch(() => {});
    throw err;
  }
}

/** Finished runs that asked for a DM and have none yet, recent enough to retry. */
export async function undeliveredDms(now: Date): Promise<string[]> {
  const rows = await prisma.briefing.findMany({
    where: {
      deliverSlack: true,
      slackSentAt: null,
      status: { in: ['done', 'failed'] },
      // Past the first minute, so the result's own delivery is not raced.
      finishedAt: { gt: new Date(now.getTime() - DM_RETRY_MS), lt: new Date(now.getTime() - 60_000) },
    },
    select: { id: true },
    take: 50,
  });
  return rows.map(r => r.id);
}

/** "Run again" from a DM: a new run for the clicking user, delivered as a DM. */
export function registerBriefingSlackActions(app: any): void {
  app.action(RUN_AGAIN_ACTION, async ({ ack, body, client }: any) => {
    await ack();
    const slackUserId = body?.user?.id as string | undefined;
    if (!slackUserId) return;
    const user = await resolveTermagUser(slackUserId, client);
    const say = (text: string) => client.chat.postMessage({ channel: slackUserId, text }).catch(() => {});
    if (!user) { await say('I could not match your Slack account to a termag user.'); return; }
    const tz = readSchedule(user.briefingSchedule).timezone ?? 'UTC';
    try {
      const out = await startBriefing({ user, trigger: 'slack', tz, deliverSlack: true });
      if (out.kind === 'already_running') {
        // The run in flight may be a dashboard one, made without a DM: opt it
        // in. If it finishes before this lands, the scheduler's retry pass
        // still sends it (it looks for deliverSlack rows with no DM yet).
        await prisma.briefing.updateMany({ where: { id: out.id, userId: user.id }, data: { deliverSlack: true } });
        await say('A briefing is already being written. It will arrive here when it is done.');
      }
      else if (out.kind === 'started') await say('Reviewing everything since your last briefing. It usually takes a minute or two.');
      else if (out.kind === 'skipped' || out.kind === 'failed') {
        const v = await viewById(user.id, out.id);
        await say(v?.error ?? 'The briefing could not start.');
      }
    } catch (err) {
      console.error('[BRIEFING] Slack run again failed:', (err as Error).message);
      await say('The briefing could not start.');
    }
  });
}
