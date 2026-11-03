/**
 * One turn of a Slack agent session (agentSession.ts): status, a streamed reply,
 * the thread's own Claude session, then any attachments and choice buttons.
 * Stop ends the run through agentRuns.
 */

import type { WebClient } from '@slack/web-api';
import { executeClaudeCommand, ClaudeRunStopped } from './executor';
import {
  threadKey, sessionTitle, setSessionStatus, AgentReplyStream, agentRuns, claimThread, runsFor,
  MAX_AGENT_RUNS_PER_USER, threadHistory, threadOwnerOf, agentRunsAccepted, type AgentRunEntry,
  claimThreadRun, renewThreadRun, releaseThreadRun, RUN_BEAT_MS,
  rememberClaudeSession, claudeSessionFor, agentPersona, ReplyTagGate, stripTags, reactionName,
  addReaction, removeReaction, ackEmoji, choiceBlocks, splitMarkdown, AGENT_TIMEOUT_MS, STATUS_KEEPALIVE_MS,
  type StreamRecipient,
} from './agentSession';
import { offerAttachments } from './agentAttachments';

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
   * (owner, busy thread, the per-person cap, a restart, another process's
   * claim) and is about to run: a click marks its buttons only then.
   */
  onStart?: () => Promise<unknown> | void;
};

export async function runAgentTurn(turn: AgentTurn): Promise<void> {
  const { client, say, channelId, threadTs, messageTs, message, workingDir, userId, recipient } = turn;
  const key = threadKey(channelId, threadTs);
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
  if (runsFor(userId) >= MAX_AGENT_RUNS_PER_USER) {
    await say({
      text: `You have ${MAX_AGENT_RUNS_PER_USER} conversations with me running already. Stop one, or wait for one to finish, then ask again.`,
      thread_ts: threadTs,
    });
    return;
  }

  // Only a DM carries its recent conversation, and only into a new thread: an
  // old thread is its own conversation, not whatever the DM did last.
  const carryOver = inChannel ? undefined : channelId;
  const carryInto = isNewThread ? carryOver : undefined;
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
  const run: AgentRunEntry = { controller, userId, keepAlive, finished };
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
  const stopKeepalive = async () => { keepaliveDone = true; clearInterval(keepalive); await keepaliveCall; };
  const stream = new AgentReplyStream(client, channelId, threadTs, recipient);
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
  const gate = new ReplyTagGate((kind, value) => {
    const name = kind === 'react' ? reactionName(value) : null;
    if (name) react(name);
  }, (text) => stream.append(text));
  // A topical ack stays unless Claude reacts itself.
  const ack = reactTo ? ackEmoji(message) : null;
  if (ack) await addReaction(client, channelId, messageTs, ack);

  try {
    let response: string;
    try {
      await setSessionStatus(client, {
        channel: channelId, threadTs, status: 'processing',
        ...(threadTs === messageTs && { title: sessionTitle(message) }),
      });
      const resume = claudeSessionFor(key, workingDir, carryInto);
      response = await executeClaudeCommand(
        message,
        {
          workingDir,
          resumeSessionId: resume?.sessionId,
          // A carried-over session may still be running for the DM's other thread.
          forkSession: resume?.carried,
          signal: controller.signal,
          onSessionId: (id) => rememberClaudeSession(key, id, workingDir, carryOver),
          appendSystemPrompt: agentPersona({ inChannel }),
          timeoutMs: AGENT_TIMEOUT_MS,
          onFreshStart: () => sayFirst(CONTEXT_LOST),
        },
        (data) => gate.push(data.chunk),
      );
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
    const final = stripTags(response);
    if (final.reaction) react(final.reaction);
    // A reaction alone is the whole answer: finish() then only clears "Working…".
    const text = final.text.trim();
    await deliver(turn, stream, text || preface ? preface + text : null);
    if (final.attachments.length) {
      await offerAttachments(client, { channel: channelId, threadTs, paths: final.attachments, workingDir, forUser: userId })
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
const CONTEXT_LOST = "_I couldn't pick up this thread's earlier conversation, so I'm starting fresh._";
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
  const unsent = stream.unsent(text, note).trim();
  for (const part of unsent ? splitMarkdown(unsent) : []) {
    await client.apiCall('chat.postMessage', { channel: channelId, thread_ts: threadTs, markdown_text: part })
      .catch(err => console.error('[AGENT] fallback message failed:', (err as Error).message));
  }
  await setSessionStatus(client, { channel: channelId, threadTs, status: 'active' });
}
