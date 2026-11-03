/**
 * Telling the asker an ask finished. An orchestrator chat that starts its asks with `--no-wait` has
 * nothing waiting on them, so when a turn ends termag puts one fixed notice
 * into the session that sent that message: a new turn of its chat, or a line
 * typed into its idle agent pane. The rules live here, pure; the sweep that
 * gathers their inputs and acts is askNoticeSweep.ts.
 *
 * The notice is metadata only: the state, the thread's title, ids, the PR,
 * the publish outcome and the error. Never the reply, which is the asked
 * agent's text (untrusted) and isn't stored anyway.
 */
import { NUDGE_HUMAN_QUIET_MS } from './agentSpawn';

export const ASK_NOTICE_FLAG = 'ask-completion-notify-enabled' as const;

/** How the notice reaches the session that sent the message. */
export type NoticeVia = 'chat' | 'pane';

/**
 * What became of a message's notice (AgentMessage.notice). Delivered: `chat`,
 * `pane`. Not needed: `waiter` (a poll got the finish), `together` (the
 * follow-up it was answered with tells the same session). Kept in the inbox
 * only: `gone`, `skipped`, `off`, `expired`, `failed`.
 */
export type NoticeOutcome = 'chat' | 'pane' | 'waiter' | 'together' | 'gone' | 'skipped' | 'off' | 'expired' | 'failed';

/**
 * Left this long after the finish before a notice goes, so a `termag ask`
 * or `--reply` waiting on it (woken at once, or within 2 s on the other
 * process of an overlap) marks it seen first and nobody is told twice.
 */
export const NOTICE_GRACE_MS = 15_000;
/** A session that hasn't been free to take it in a day is not told. */
export const NOTICE_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** The longest error reason a notice quotes. */
export const NOTICE_ERROR_CHARS = 200;

/** Box states whose sessions are gone for a notice: nothing starts a box to tell it. */
const DOWN_BOX_STATES = new Set(['stopping', 'stopped', 'hibernating', 'hibernated', 'terminating', 'terminated', 'failed']);

/**
 * How a checked sender is told, or null for not at all. A chat-runner turn
 * (the CLI's sender is a project and workstream) gets a chat turn. A pane
 * only when it is its workstream's agent pane: a line typed into a ctrl shell
 * would run as a command. `--no-notify` asks for none.
 */
export function noticeVia(
  sender: { kind: 'chat' } | { kind: 'pane'; session: string; agentPane: string },
  notify: boolean,
): NoticeVia | null {
  if (!notify) return null;
  if (sender.kind === 'chat') return 'chat';
  return sender.session === sender.agentPane ? 'pane' : null;
}

export interface NoticeInput {
  via: NoticeVia;
  completedAt: Date;
  now: number;
  flagOn: boolean;
  /** The sender's project, null when it is gone or no longer the asker's. */
  project: { archived: boolean; workstreamLive: boolean; askChat: boolean; automation: boolean } | null;
  box: { status: string; connected: boolean } | null;
  /** The pane's agent status (status.ts) and the person's last keystroke in the project; a pane only. */
  paneStatus?: string | null;
  humanLastTyped?: number | null;
}

/**
 * Whether to deliver now, wait for a later tick, or settle the notice without
 * delivering it (kept in the inbox only). A pane is typed into only while its
 * agent is `idle`, never `waiting` (an approval prompt the line would answer),
 * and not while its person typed in the last two minutes, the spawn nudge's
 * rules. A chat is sent to whatever it is doing: a turn running queues the
 * notice after it, as any message the person sends.
 */
export function noticeDecision(n: NoticeInput): 'deliver' | 'wait' | { settle: NoticeOutcome } {
  const age = n.now - n.completedAt.getTime();
  if (age < NOTICE_GRACE_MS) return 'wait';
  if (!n.flagOn) return { settle: 'off' };
  if (age > NOTICE_GIVE_UP_MS) return { settle: 'expired' };
  if (!n.project || n.project.archived || !n.project.workstreamLive) return { settle: 'gone' };
  // An ask's own chat: a turn there reports to nobody, so the notice stays in the inbox.
  if (n.via === 'chat' && n.project.askChat) return { settle: 'skipped' };
  // An automation's run: a turn there has no run row, timeout or budget (complete.ts finishes only a running one).
  if (n.project.automation) return { settle: 'skipped' };
  if (!n.box || DOWN_BOX_STATES.has(n.box.status)) return { settle: 'gone' };
  if (!n.box.connected) return 'wait';
  if (n.via === 'pane') {
    if (n.paneStatus !== 'idle') return 'wait';
    if (n.humanLastTyped != null && n.now - n.humanLastTyped < NUDGE_HUMAN_QUIET_MS) return 'wait';
  }
  return 'deliver';
}

/** What a notice says about one finished message. */
export interface NoticeItem {
  status: string;
  title: string | null;
  thread: string;
  message: string;
  error: string | null;
  publish: string | null;
  prUrl: string | null;
  /** The thread's other PRs (pr/<name> branches), counted. */
  morePrs: number;
  replyBytes: number | null;
  /** A follow-up that went into this message's turn and finished it (superseded, answered together). */
  answeredWith?: string | null;
}

/** One line, no control characters, at most `max` characters: text that came from a caller or a box. */
function oneLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * A title as the notice quotes it: one line, without the characters a shell
 * expands inside double quotes (` $ \\ "). A follow-up can rewrite a thread's
 * title, and a pane notice is typed and submitted.
 */
function quotedTitle(title: string): string {
  return oneLine(title.replace(/[`$\\"]/g, ''), 60);
}

function itemText(i: NoticeItem, withError: boolean): string {
  const title = i.title ? quotedTitle(i.title) : '';
  const name = title ? `ask "${title}"` : `ask ask-${i.thread}`;
  const parts = [withError && i.error ? `${i.status} (${oneLine(i.error, NOTICE_ERROR_CHARS)})` : i.status];
  if (i.answeredWith) parts.push(`answered together with follow-up ${i.answeredWith}`);
  if (i.prUrl) parts.push(`PR ${i.prUrl}${i.morePrs > 0 ? ` and ${i.morePrs} more` : ''}`);
  if (i.publish) parts.push(`publish ${i.publish}`);
  parts.push(i.replyBytes ? `reply ${size(i.replyBytes)}, not shown` : 'no reply');
  return `${name} (thread ${i.thread}, message ${i.message}) finished: ${parts.join('; ')}`;
}

/**
 * The notice: one line (a pane takes it as one prompt), fixed text plus the
 * items' metadata, and never a reply. A pane's leaves out the error text (it
 * came from the box, and a pane types it in as the agent's prompt): the state
 * stays, the error is in `--inbox`. Several messages finishing for one
 * session in the same tick share a notice.
 */
export function askNoticeText(items: NoticeItem[], via: NoticeVia = 'chat'): string {
  const head = items.length === 1 ? '[termag] Your' : `[termag] ${items.length} of your asks finished. Your`;
  // A pane's line is submitted with Enter, so it carries no backticks.
  const inbox = via === 'pane' ? 'run termag ask --inbox' : '`termag ask --inbox`';
  return `${head} ${items.map(i => itemText(i, via === 'chat')).join('. Your ')}. `
    + 'This is an automatic notice from termag, not a message from the person. '
    + `Replies are not included or kept: read the handoff the ask was told to write, or ${inbox}.`;
}
