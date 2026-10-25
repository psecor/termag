/**
 * Owner notices: a Slack DM to a Claude cloud session's owner about what
 * termag did or needs for the session. The engineer may have no termag
 * access yet, never see the
 * environment's Activity tab (Owners only), and on claude.ai see only
 * "waiting for a runner": Slack is where they already are.
 *
 * Behind `claude-runner-slack-notices-enabled`, per owner, and only when the Slack
 * app is up. One DM per (owner, session, refusal code) and one GitHub
 * reminder per owner per week, deduped against a table rather than process
 * memory: every deploy restarts the backend and would otherwise re-send one
 * DM per queued session. Best effort throughout: a missing Slack user, a
 * Slack error or a database error is one log line and never touches the
 * hook's answer, which has already been sent when this runs.
 *
 * `noticeFor` is the pure part: the text per code, with the claude.ai link
 * to the session and the termag link where the fix is there. No email, no
 * token, no prompt text in a notice or a log line; the DM is to the owner,
 * so it may name their box and their session.
 */
import { prisma } from '../db';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { sessionUrl } from './claudeSessions';
import { serializeByKey, type RefusalCode } from './claudeRunnerSpawn';
import { flagIdentity } from './claudeRunnerOwner';
import { getSlackApp } from '../slack/app';

export const CLAUDE_RUNNER_SLACK_NOTICES_FLAG = 'claude-runner-slack-notices-enabled';

/** How long a refusal's DM stands for its (owner, session, code). */
export const REFUSAL_NOTICE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** How long the "connect GitHub" reminder stands for an owner, whatever the session. */
export const GITHUB_NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The dedupe key of the GitHub reminder; refusal notices use their code. */
export const GITHUB_ABSENT_NOTICE = 'github-absent';

export interface NoticeInput {
  sessionId: string;
  /** The refusal's text, for the codes whose message is best said in termag's own words. */
  text: string;
  boxName?: string | null;
  /** The termag web app's URL (FRONTEND_URL + BASE_PATH), when the backend knows it. */
  termagUrl: string | null;
}

/** The first step for anyone whose fix is in termag and who may not have access to it yet. */
const ACCESS = 'If you cannot open termag yet, ask whoever runs your termag for access first.';

function links(input: NoticeInput, fixInTermag: boolean): string {
  const parts: string[] = [];
  const url = sessionUrl(input.sessionId);
  if (url) parts.push(`Session: ${url}`);
  if (fixInTermag && input.termagUrl) parts.push(`termag: ${input.termagUrl}/settings`);
  return parts.length ? `\n${parts.join('\n')}` : '';
}

/**
 * The DM for a refusal, or null when none should be sent: every code gets
 * one except the hook giving up (nothing changed for the owner) and the
 * agent-failure codes (an operator's problem, logged and in the admin view).
 */
export function noticeForRefusal(code: RefusalCode, input: NoticeInput): string | null {
  const box = input.boxName ? `"${input.boxName}"` : 'a box';
  switch (code) {
    case 'github':
      return `Your Claude Code cloud session is waiting: termag needs GitHub connected for your account before it can run on a box. ${ACCESS} Then open Settings, Credentials, "Connect GitHub"; the session is retried on its own.${links(input, true)}`;
    case 'no-box':
      return `Your Claude Code cloud session is waiting: you have no termag box running. ${ACCESS} Then start or add a box in termag; the session is retried on its own.${links(input, true)}`;
    case 'agent-too-old':
      return `Your Claude Code cloud session is waiting: your termag box runs an agent too old for cloud sessions. It is retried once the box has updated; termag updates boxes on its own.${links(input, true)}`;
    case 'boxes-full':
      return `Your Claude Code cloud session is waiting: every box of yours already runs the most cloud sessions it can. It is retried when one ends.${links(input, true)}`;
    case 'box-claimed':
      return `termag claimed box ${box} for your Claude Code cloud session. The session starts as soon as the box has its credentials, usually within a minute.${links(input, false)}`;
    case 'box-starting':
      return `termag is starting box ${box} for your Claude Code cloud session. The session starts once the box is up, one to two minutes.${links(input, false)}`;
    case 'box-provisioning':
      return `termag is provisioning box ${box} for your Claude Code cloud session. A new box takes a few minutes; the session starts on its own once it is up.${links(input, false)}`;
    case 'box-wait':
    case 'box-on-its-way':
      return `Your Claude Code cloud session is waiting for a termag box that is on its way: ${input.text}.${links(input, false)}`;
    case 'box-hold':
    case 'box-start-failed':
    case 'no-provisioning':
      return `Your Claude Code cloud session is waiting: ${input.text}. ${ACCESS}${links(input, true)}`;
    case 'box-creation-refused':
      return `Your Claude Code cloud session is waiting: termag cannot create a box for you until GitHub is connected for your account. ${ACCESS} Then open Settings, Credentials, "Connect GitHub".${links(input, true)}`;
    case 'hook-gave-up':
    case 'agent-list-failed':
    case 'agent-launch-failed':
      return null;
  }
}

/** The one-a-week reminder for a session that runs with Anthropic-managed git and no termag GitHub credential (F2). */
export function noticeForGithubAbsent(input: NoticeInput): string {
  return `Your Claude Code cloud session is running on ${input.boxName ? `box "${input.boxName}"` : 'your box'} with Anthropic-managed git: fetching and pushing its repository works. The \`gh\` CLI, other private repositories and Bazel fetches of private Go modules need GitHub connected in termag. ${ACCESS} Then open Settings, Credentials, "Connect GitHub".${links(input, true)}`;
}

/** The subset of Slack's web client this module uses. */
export interface SlackNoticeClient {
  users: { lookupByEmail: (args: { email: string }) => Promise<{ user?: { id?: string } }> };
  chat: { postMessage: (args: { channel: string; text: string }) => Promise<unknown> };
}

/**
 * The owner as the database knows them: `id` is the row (the notice's foreign
 * key), `googleId` lets the flag read use the placeholder key while they
 * have one (claudeRunnerOwner.ts, flagIdentity). Never a flag identity in
 * place of the row.
 */
export interface NoticeOwner extends FlagUser {
  slackUserId: string | null;
  googleId?: string | null;
}

/** The termag web app's URL from the backend's own env, or null when it does not know it. */
export function termagUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const front = env.FRONTEND_URL?.trim().replace(/\/+$/, '');
  if (!front || !/^https?:\/\//.test(front)) return null;
  return `${front}${(env.BASE_PATH ?? '').replace(/\/+$/, '')}`;
}

/**
 * Send `text` to the owner once per (owner, session, key) within `windowMs`,
 * recording it under a Postgres advisory lock so no two backend processes
 * send it. `key` is the refusal code, or GITHUB_ABSENT_NOTICE, which is
 * deduped per owner across sessions. Never throws.
 */
export async function notifyOwner(
  owner: NoticeOwner,
  sessionId: string,
  key: string,
  text: string,
  opts: { windowMs: number; perOwner?: boolean; client?: SlackNoticeClient | null; now?: Date } = { windowMs: REFUSAL_NOTICE_WINDOW_MS },
): Promise<boolean> {
  const client = opts.client === undefined ? (getSlackApp()?.client as SlackNoticeClient | undefined) ?? null : opts.client;
  if (!client) return false;
  const now = opts.now ?? new Date();
  // One at a time per (owner, key): the orchestrator runs several spawn hooks
  // at once, and two sessions of a burst refused the same way would both
  // read "no notice yet" and both post. One backend process serves a host.
  const lockKey = `claude-runner:notice:${owner.id}:${key}`;
  return serializeByKey(lockKey, async () => {
    try {
      if (!await boolVariation(CLAUDE_RUNNER_SLACK_NOTICES_FLAG, flagIdentity(owner), false)) return false;
      const since = new Date(now.getTime() - opts.windowMs);
      const standing = { userId: owner.id, code: key, at: { gte: since }, ...(opts.perOwner ? {} : { sessionId }) };
      // A first look without the lock below: a notice that already stands
      // costs no Slack lookup and no transaction.
      if (await prisma.claudeSessionNotice.findFirst({ where: standing, select: { id: true } })) return false;
      let channel = owner.slackUserId;
      if (!channel) {
        channel = await slackUserFor(owner, client, now);
        if (!channel) {
          console.log(`[CLAUDE-RUNNER] notice ${key} for ${owner.unixUsername} not sent: no Slack user for their email`);
          return false;
        }
        await prisma.user.update({ where: { id: owner.id }, data: { slackUserId: channel } }).catch(() => undefined);
      }
      // The record first: a crash between the two leaves a notice unsent,
      // never one sent twice. A post Slack refuses takes the record back, so
      // the next refusal tries again rather than staying silent for the window.
      // The lookup and the record run under a Postgres advisory lock on
      // (owner, key), as handoffs and asks do: the mutex above covers one
      // process, and a hook retried against another (a deploy's overlap)
      // could otherwise read "no notice yet" beside this one and post too
      // (Bugbot on #289). The second process waits, then sees the row.
      const row = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        if (await tx.claudeSessionNotice.findFirst({ where: standing, select: { id: true } })) return null;
        return tx.claudeSessionNotice.create({ data: { userId: owner.id, sessionId, code: key, at: now } });
      });
      if (!row) return false;
      try {
        await client.chat.postMessage({ channel, text });
      } catch (err) {
        await prisma.claudeSessionNotice.delete({ where: { id: row.id } }).catch(() => undefined);
        throw err;
      }
      console.log(`[CLAUDE-RUNNER] notice ${key} sent to ${owner.unixUsername} for session ${sessionId}`);
      return true;
    } catch (err) {
      console.error(`[CLAUDE-RUNNER] notice ${key} for ${owner.unixUsername} failed:`, err instanceof Error ? err.message : String(err));
      return false;
    }
  });
}

/** How long a "no Slack user for this email" answer is remembered, per owner, in this process. */
export const NO_SLACK_USER_MEMO_MS = 6 * 60 * 60 * 1000;
const noSlackUserUntil = new Map<string, number>();

/** For tests: forget every remembered miss. */
export function resetSlackUserMemo(): void {
  noSlackUserUntil.clear();
}

/**
 * The owner's Slack user id by email, or null when the workspace has none.
 * Slack answers a miss with a rejected call (`users_not_found`), not an
 * empty user, so that error is the miss (Bugbot on #289); any other error
 * propagates. A miss is remembered for NO_SLACK_USER_MEMO_MS so the refusal
 * retries of a session do not look the same address up every few minutes;
 * process memory is fine here, a restart costs one lookup.
 */
async function slackUserFor(owner: NoticeOwner, client: SlackNoticeClient, now: Date): Promise<string | null> {
  const until = noSlackUserUntil.get(owner.id);
  if (until !== undefined && until > now.getTime()) return null;
  noSlackUserUntil.delete(owner.id);
  let id: string | null;
  try {
    id = (await client.users.lookupByEmail({ email: owner.googleEmail })).user?.id ?? null;
  } catch (err) {
    if ((err as { data?: { error?: string } })?.data?.error !== 'users_not_found') throw err;
    id = null;
  }
  if (!id) noSlackUserUntil.set(owner.id, now.getTime() + NO_SLACK_USER_MEMO_MS);
  return id;
}

/** What the two senders take beyond the owner and the session; tests hand in a client. */
export interface NoticeOptions {
  termagUrl?: string | null;
  client?: SlackNoticeClient | null;
}

/** The DM for a refusal the route just answered, if the code has one (F1). */
export function notifyRefusal(owner: NoticeOwner, sessionId: string, code: RefusalCode, text: string, boxName: string | null = null, opts: NoticeOptions = {}): Promise<boolean> {
  const termagUrl = opts.termagUrl === undefined ? termagUrlFromEnv() : opts.termagUrl;
  const message = noticeForRefusal(code, { sessionId, text, boxName, termagUrl });
  if (!message) return Promise.resolve(false);
  return notifyOwner(owner, sessionId, code, message, { windowMs: REFUSAL_NOTICE_WINDOW_MS, client: opts.client });
}

/** The weekly GitHub reminder for a session placed with `--github absent` (F2). */
export function notifyGithubAbsent(owner: NoticeOwner, sessionId: string, boxName: string | null, opts: NoticeOptions = {}): Promise<boolean> {
  const termagUrl = opts.termagUrl === undefined ? termagUrlFromEnv() : opts.termagUrl;
  return notifyOwner(owner, sessionId, GITHUB_ABSENT_NOTICE, noticeForGithubAbsent({ sessionId, text: '', boxName, termagUrl }), { windowMs: GITHUB_NOTICE_WINDOW_MS, perOwner: true, client: opts.client });
}
