/**
 * One turn of a Slack agent session:
 * status, a streamed reply, then any attachments and choice buttons, around a
 * TurnDriver that does the run itself (the operator's is the executor,
 * operatorDriver.ts). Stop ends the run through agentRuns.
 *
 * Moved from agentTurn.ts in M2 with no behaviour change for operators;
 * agentTurn.ts's runAgentTurn is runTurn with the operator driver.
 */

import type { WebClient } from '@slack/web-api';
import type { SpaceRole } from '../../services/spaces/spaceAccess';
import { ClaudeRunStopped } from '../executor';
import {
  threadKey, sessionTitle, setSessionStatus, AgentReplyStream, agentRuns, claimThread,
  threadHistory, threadOwnerOf, agentRunsAccepted, type AgentRunEntry,
  claimThreadRun, renewThreadRun, releaseThreadRun, RUN_BEAT_MS, threadBindingOf,
  ReplyTagGate, stripTags, reactionName, type ReplyTags,
  addReaction, removeReaction, ackEmoji, choiceBlocks, splitMarkdown, STATUS_KEEPALIVE_MS,
  type StreamRecipient, postableText,
} from '../agentSession';
import { createRunTempDir, offerAttachments } from '../agentAttachments';
import { capFor, capRefusal } from './caps';
import { countingGate, streamBudget } from '../streamBudget';
import type { ThreadScope } from './scope';

export interface TurnContext {
  key: string;
  scope: ThreadScope;
  spaceId: string | null;
  requester: { slackId: string; userId: string | null; role: SpaceRole | null };
  message: string;
  signal: AbortSignal;
  /** Prefix for routed answers outside space channels, e.g. "*payments* · ". */
  label: string | null;
  /** This run's own temp directory (agentAttachments.ts), if one could be made. */
  tempDir: string | undefined;
  onText(chunk: string): void;
  onStatus(s: 'processing' | 'waking' | 'queued'): void;
  /** A one-line note said before the reply, once (e.g. the earlier conversation could not be resumed). */
  onNotice(note: string): void;
}

export interface TurnDriver {
  readonly name: 'operator-executor' | 'space-orchestrator' | 'router' | 'router-lite';
  /** The reply's text, tags still in it; or its tags already taken out. Throws ClaudeRunStopped when stopped. */
  run(ctx: TurnContext): Promise<{ text: string; tags?: ReplyTags }>;
}

export type AgentTurn = {
  client: WebClient;
  say: (args: Record<string, unknown>) => Promise<unknown>;
  channelId: string;
  threadTs: string;
  messageTs: string;
  message: string;
  workingDir: string;
  /** Who the turn is for: the thread's owner in a channel, and the only one who may answer its buttons. */
  userId: string;
  /** Who a channel reply streams to; null in a DM. */
  recipient: StreamRecipient | null;
  /** False for a button click, where messageTs is the bot's own message: no reactions then. */
  react?: boolean;
  /**
   * Called once the turn has passed every check that could still refuse it
   * (owner, busy thread, the per-person and global caps, a restart, another process's
   * claim) and is about to run: a click marks its buttons only then.
   */
  onStart?: () => Promise<unknown> | void;
  /** Prefix for the reply (TurnContext.label); none for an operator's own thread. */
  label?: string | null;
};

export async function runTurn(turn: AgentTurn, driver: TurnDriver): Promise<void> {
  const { client, say, channelId, threadTs, messageTs, message, workingDir, userId, recipient } = turn;
  const key = threadKey(channelId, threadTs);
  const { scope, spaceId } = threadBindingOf(key);
  const label = turn.label ?? null;
  const inChannel = recipient !== null;
  const isNewThread = threadTs === messageTs;
  // A channel thread with no owner yet is one the bot has never answered in.
  const seenBefore = !inChannel || threadOwnerOf(key) !== undefined;

  // A channel thread is one person's conversation: resuming its Claude session for
  // someone else would hand them everything it loaded, posted or not.
  if (inChannel) {
    const owner = claimThread(key, userId);
    if (owner !== userId) {
      await client.chat.postEphemeral({
        channel: channelId, user: userId, thread_ts: threadTs,
        text: `This thread is <@${owner}>'s conversation with me. @mention me in a new message to start your own.`,
      }).catch(() => {});
      return;
    }
  }
  if (!agentRunsAccepted()) {
    await say({ text: RESTARTED, thread_ts: threadTs });
    return;
  }
  if (agentRuns.has(key)) {
    await say({ text: 'Still working on your last message. Press Stop to end it first.', thread_ts: threadTs });
    return;
  }
  const refusal = capRefusal(capFor(scope), { userId, spaceId });
  if (refusal) {
    await say({ text: refusal, thread_ts: threadTs });
    return;
  }

  // A DM's carry-over is released with the thread's claim (operatorDriver.ts says which).
  const carryOver = inChannel ? undefined : channelId;
  const controller = new AbortController();
  let settle!: () => void;
  const finished = new Promise<void>(resolve => { settle = resolve; });
  // Re-sending `processing` keeps "Working…" up; once the turn is finishing it
  // stops, and the turn waits for the last one, so none lands after the reply
  // ends and leaves "Working…" up for an hour.
  let keepaliveCall: Promise<void> = Promise.resolve();
  let keepaliveDone = false;
  const keepAlive = () => {
    if (keepaliveDone) return;
    keepaliveCall = keepaliveCall.then(() => setSessionStatus(client, { channel: channelId, threadTs, status: 'processing' }));
  };
  // Reserved here before the claim's await, so a second event in this process
  // sees the thread busy instead of claiming it alongside.
  const run: AgentRunEntry = { controller, userId, keepAlive, finished, ...(spaceId && { spaceId }) };
  agentRuns.set(key, run);
  if (!(await claimThreadRun(key))) {
    agentRuns.delete(key);
    settle();
    await say({ text: STILL_FINISHING, thread_ts: threadTs });
    return;
  }
  const keepalive = setInterval(keepAlive, STATUS_KEEPALIVE_MS);
  const heartbeat = setInterval(() => renewThreadRun(key), RUN_BEAT_MS);
  try {
    await turn.onStart?.();
  } catch (err) {
    console.error('[AGENT] onStart failed:', (err as Error).message);
  }
  // This run's own temp directory: the only temp location its attachments may
  // come from, so one person's turn cannot offer a file another's wrote in /tmp.
  const runDir = await createRunTempDir().catch((err) => {
    console.error('[AGENT] could not create a run temp dir:', (err as Error).message);
    return undefined;
  });
  const stopKeepalive = async () => { keepaliveDone = true; clearInterval(keepalive); await keepaliveCall; };
  // An operator's own thread streams as it always has; its starts only count
  // against the workspace's budget. Space and router turns post whole without it.
  const budget = scope === 'personal' ? countingGate(streamBudget) : streamBudget;
  const stream = new AgentReplyStream(client, channelId, threadTs, recipient, undefined, budget);
  // Said before the reply when it cannot pick up where the thread left off.
  let preface = '';
  const sayFirst = (note: string) => {
    if (preface) return;
    preface = `${note}\n\n`;
    stream.append(preface);
  };
  if (!isNewThread && seenBefore) {
    const history = threadHistory(key, workingDir);
    if (history === 'moved') sayFirst(PROJECT_CHANGED);
    else if (history === 'none') sayFirst(CONTEXT_GONE);
  }
  const reactTo = turn.react === false ? null : messageTs;
  // The tag decides the reaction once, whether it came streamed or only in the final text.
  let reacted: string | null = null;
  const react = (name: string) => {
    if (!reactTo || reacted || name === 'eyes') return;
    reacted = name;
    void addReaction(client, channelId, reactTo, name).then(ok => {
      if (!ok) void addReaction(client, channelId, reactTo, '+1');
    });
  };
  // The label goes in front of the reply's first text, streamed or whole.
  let labelled = false;
  const gate = new ReplyTagGate((kind, value) => {
    const name = kind === 'react' ? reactionName(value) : null;
    if (name) react(name);
  }, (text) => {
    if (label && !labelled) { labelled = true; stream.append(label); }
    stream.append(text);
  });
  // A topical ack stays unless Claude reacts itself.
  const ack = reactTo ? ackEmoji(message) : null;
  if (ack) await addReaction(client, channelId, messageTs, ack);

  try {
    let response: { text: string; tags?: ReplyTags };
    try {
      await setSessionStatus(client, {
        channel: channelId, threadTs, status: 'processing',
        ...(threadTs === messageTs && { title: sessionTitle(message) }),
      });
      response = await driver.run({
        key, scope, spaceId,
        requester: { slackId: userId, userId: null, role: null },
        message, signal: controller.signal, label, tempDir: runDir,
        onText: (chunk) => gate.push(chunk),
        // Slack shows only "Working…": waking and queued keep it up too.
        onStatus: () => keepAlive(),
        onNotice: sayFirst,
      });
    } catch (error) {
      gate.end();
      await stopKeepalive();
      if (!(error instanceof ClaudeRunStopped)) console.error('[AGENT] turn failed:', error);
      const note = !(error instanceof ClaudeRunStopped)
        ? `**Error:** ${(error as Error).message}`
        : run.stopReason === 'restart' ? RESTARTED : '_Stopped._';
      await deliver(turn, stream, null, note);
      return;
    }

    await stopKeepalive();
    gate.end();
    const final = response.tags ?? stripTags(response.text);
    if (final.reaction) react(final.reaction);
    // A reaction alone is the whole answer: finish() then only clears "Working…".
    const answer = final.text.trim();
    const text = answer && label ? label + answer : answer;
    await deliver(turn, stream, text || preface ? preface + text : null);
    if (final.attachments.length) {
      await offerAttachments(client, { channel: channelId, threadTs, paths: final.attachments, workingDir, forUser: userId, runDir })
        .catch(err => console.error('[AGENT] attachments failed:', err));
    }
    if (final.choices.length) {
      await client.chat.postMessage({
        channel: channelId, thread_ts: threadTs,
        text: final.choices.join(' / '),
        blocks: choiceBlocks(final.choices, userId),
      }).catch(err => console.error('[AGENT] choice buttons failed:', err));
    }
  } finally {
    clearInterval(keepalive);
    clearInterval(heartbeat);
    // Released while the slot is still reserved, so a follow-up in this thread
    // cannot claim in between and have its claim cleared by this release; and
    // before settle(), which a shutdown waits for, so the next process finds
    // the claim free instead of waiting out RUN_STALE_MS.
    await releaseThreadRun(key, carryOver);
    agentRuns.delete(key);
    if (ack && reacted && reacted !== ack) await removeReaction(client, channelId, messageTs, ack);
    settle();
  }
}

const PROJECT_CHANGED = "_Your active project changed since this thread began, so I'm starting fresh here._";
const CONTEXT_GONE = "_I don't have this thread's earlier conversation any more, so I'm starting fresh._";
const RESTARTED = '_termag is restarting, so I stopped. Send your message again in a moment and I will pick it up._';
const STILL_FINISHING = "_I'm still finishing your last message in this thread from before termag restarted. Try again in a moment._";

/**
 * Ends the stream with `text` and `note`. If streaming fails, whatever the user
 * has not seen goes out as an ordinary message, and the session is settled.
 */
async function deliver(turn: AgentTurn, stream: AgentReplyStream, text: string | null, note?: string): Promise<void> {
  const { client, channelId, threadTs } = turn;
  try {
    await stream.finish(text, note);
    return;
  } catch (err) {
    console.error('[AGENT] could not finish the stream:', (err as Error).message);
  }
  // Markdown, as the stream would have sent it.
  // Not trim(): the unsent part may start mid-reply with indented code.
  const unsent = postableText(stream.unsent(text, note));
  for (const part of unsent ? splitMarkdown(unsent) : []) {
    await client.apiCall('chat.postMessage', { channel: channelId, thread_ts: threadTs, markdown_text: part })
      .catch(err => console.error('[AGENT] fallback message failed:', (err as Error).message));
  }
  await setSessionStatus(client, { channel: channelId, threadTs, status: 'active' });
}
