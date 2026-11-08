/**
 * A Slack agent reply as it reaches the thread (moved from agentSession.ts, M2):
 * the session's status and title, and AgentReplyStream, which streams the
 * reply with chat.startStream / appendStream / stopStream and falls back to
 * ordinary messages.
 */

import type { WebClient } from '@slack/web-api';
import { retryAfterSeconds, type StreamGate } from '../streamBudget';

type SlackClient = Pick<WebClient, 'apiCall' | 'auth'>;

// A stream holds at most 12,000 characters of markdown in all, across every call.
const MAX_MARKDOWN_CHARS = 12_000;
const TITLE_MAX_CHARS = 60;

/** The session title Slack lists the thread under: the prompt's first line. */
export function sessionTitle(message: string): string {
  const firstLine = message.split('\n').map(l => l.trim()).find(Boolean) ?? 'New conversation';
  return firstLine.length > TITLE_MAX_CHARS ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1)}…` : firstLine;
}

export function splitMarkdown(text: string, max: number = MAX_MARKDOWN_CHARS): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

export async function setSessionStatus(
  client: SlackClient,
  args: { channel: string; threadTs: string; status: 'processing' | 'active'; title?: string },
): Promise<void> {
  try {
    await client.apiCall('agents.sessions.setStatus', {
      channel_id: args.channel,
      thread_ts: args.threadTs,
      status: args.status,
      ...(args.title && { title: args.title }),
    });
  } catch (err) {
    console.error(`[AGENT] setStatus ${args.status} failed:`, (err as Error).message);
  }
}

/**
 * A reply streamed into a thread. The stream starts with the first text; text is
 * batched so appendStream runs at most once per interval. finish() ends it, which
 * also moves the session to `active`.
 */
export type StreamRecipient = { userId: string; teamId: string };

export class AgentReplyStream {
  private ts: string | null = null;
  private pending = '';
  /** What Slack has accepted, so a failure can tell what the user has not seen. */
  private sent = '';
  /** Once finish() has started: what of its tail has not gone out yet. */
  private leftover: string | null = null;
  /** Characters in the current stream, which Slack caps in total (MAX_MARKDOWN_CHARS). */
  private streamChars = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Out of stream budget: the rest of the reply waits for finish() and goes out as ordinary messages. */
  private whole = false;

  /** `recipient` is required by chat.startStream in a channel, and unused in a DM. */
  constructor(
    private client: SlackClient,
    private channel: string,
    private threadTs: string,
    private recipient: StreamRecipient | null = null,
    private intervalMs: number = Math.max(1000, parseInt(process.env.STREAMING_UPDATE_INTERVAL_MS ?? '1500', 10)),
    /** Asked before every chat.startStream (streamBudget.ts); none: always stream. */
    private budget: StreamGate | null = null,
  ) {}

  append(text: string): void {
    if (this.closed || !text) return;
    this.pending += text;
    if (!this.timer && !this.whole) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.enqueueFlush();
      }, this.ts ? this.intervalMs : 0);
    }
  }

  /**
   * End the stream. `finalText` is the run's whole answer: whatever of it was not
   * streamed is sent now. `note` goes after it (an error, "Stopped.").
   */
  async finish(finalText: string | null, note?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.chain;

    let tail = this.unsent(finalText, note);
    this.pending = '';
    // Until each part is out, it stays in `leftover`, so a failure part-way
    // leaves unsent() with exactly what the user has not seen, note included.
    this.leftover = tail;
    if (this.whole) return this.postWhole();
    try {
      await this.finishStream(tail);
    } catch (err) {
      if (!(err instanceof NoStreamBudget)) throw err;
      this.whole = true;
      await this.postWhole();
    }
  }

  private async finishStream(tail: string): Promise<void> {

    if (!tail && !this.ts) {
      this.leftover = '';
      await setSessionStatus(this.client, { channel: this.channel, threadTs: this.threadTs, status: 'active' });
      return;
    }
    const parts = splitMarkdown(tail);
    const last = parts.pop() ?? '';
    for (const part of parts) {
      await this.send(part);
      this.leftover = (this.leftover ?? tail).slice(part.length);
    }
    // The last part goes out with the stop, unless there is no stream to stop
    // or it would take the stream past its total limit.
    if (last && (!this.ts || this.streamChars + last.length > MAX_MARKDOWN_CHARS)) {
      if (this.ts) await this.endStream();
      await this.startOrKeep(last);
      this.leftover = '';
      await this.stopQuietly();
      return;
    }
    try {
      await this.call('chat.stopStream', { ts: this.ts, ...(last && { markdown_text: last }) });
      if (last) this.sent += last;
      this.leftover = '';
    } catch (err) {
      if (!last) {
        // Everything was said already; only the session status is left to settle.
        this.leftover = '';
        await setSessionStatus(this.client, { channel: this.channel, threadTs: this.threadTs, status: 'active' });
        return;
      }
      if (!streamClosed(err)) throw err;
      // The stream timed out while Claude was quiet: say the rest in a new one.
      console.error('[AGENT] stopStream found the stream closed, restarting it:', (err as Error).message);
      this.ts = null;
      await this.startOrKeep(last);
      this.leftover = '';
      await this.stopQuietly();
    }
  }

  /**
   * What the user has not seen of `finalText` (all of the buffered text when
   * there is no final text), followed by `note`.
   */
  unsent(finalText: string | null, note?: string): string {
    if (this.leftover !== null) return this.leftover;
    let tail = finalText === null ? this.pending : remainder(this.sent, finalText, this.pending);
    if (note) tail += `${tail.trim() || this.sent.trim() ? '\n\n' : ''}${note}`;
    return tail;
  }

  private enqueueFlush(): void {
    this.chain = this.chain.then(() => this.flush()).catch(err => {
      console.error('[AGENT] stream update failed:', (err as Error).message);
    });
  }

  private async flush(): Promise<void> {
    if (!this.pending || this.closed || this.whole) return;
    const parts = splitMarkdown(this.pending);
    this.pending = '';
    let i = 0;
    try {
      if (!this.ts) { await this.startOrKeep(parts[0]); i = 1; }
      for (; i < parts.length; i++) await this.send(parts[i]);
    } catch (err) {
      // Keep what did not go out, so finish() or the fallback still says it.
      this.pending = parts.slice(i).join('') + this.pending;
      if (err instanceof NoStreamBudget) {
        this.whole = true;
        return;
      }
      throw err;
    }
  }

  /**
   * Out of stream budget: what the user has not seen (`leftover`) goes out as
   * ordinary messages, split at the stream's limit, and the session settles.
   * "Working…" stayed up meanwhile (the turn's keepalive).
   */
  private async postWhole(): Promise<void> {
    let rest = postableText(this.leftover ?? '');
    this.leftover = rest;
    for (const part of rest ? splitMarkdown(rest) : []) {
      await this.call('chat.postMessage', { thread_ts: this.threadTs, markdown_text: part });
      this.sent += part;
      rest = rest.slice(part.length);
      this.leftover = rest;
    }
    this.leftover = '';
    await setSessionStatus(this.client, { channel: this.channel, threadTs: this.threadTs, status: 'active' });
  }

  /**
   * Appends to the stream. A stream lasts at most ten minutes and holds 12,000
   * characters in all, so a full one is ended and a closed one (a long tool run)
   * replaced, and the text goes on in a new message. Any other error is thrown:
   * the append may have landed, and a retry would post it twice.
   */
  private async send(markdown: string): Promise<void> {
    if (this.ts && this.streamChars + markdown.length > MAX_MARKDOWN_CHARS) await this.endStream();
    if (!this.ts) {
      await this.startOrKeep(markdown);
      return;
    }
    try {
      await this.call('chat.appendStream', { ts: this.ts, markdown_text: markdown });
    } catch (err) {
      if (!streamClosed(err)) throw err;
      console.error('[AGENT] appendStream found the stream closed, restarting it:', (err as Error).message);
      this.ts = null;
      await this.startOrKeep(markdown);
      return;
    }
    this.sent += markdown;
    this.streamChars += markdown.length;
  }

  /**
   * Starts a stream with `markdown`. Leading blank space counts as sent (Slack
   * would trim it anyway); blank space alone starts nothing and waits for text.
   */
  private async startOrKeep(markdown: string): Promise<void> {
    const text = markdown.trimStart();
    const before = this.sent;
    this.sent += markdown.slice(0, markdown.length - text.length);
    if (!text) return;
    try {
      await this.start(text);
    } catch (err) {
      // Nothing went out: the blank space stays unsent too, so a fallback
      // (a whole post, or deliver()'s) keeps the paragraph break and the
      // code indentation it may be.
      this.sent = before;
      throw err;
    }
  }

  private async start(markdown: string): Promise<void> {
    if (this.budget && !this.budget.take()) throw new NoStreamBudget();
    let res: Awaited<ReturnType<SlackClient['apiCall']>>;
    try {
      res = await this.call('chat.startStream', {
        thread_ts: this.threadTs,
        markdown_text: markdown,
        ...(this.recipient && { recipient_user_id: this.recipient.userId, recipient_team_id: this.recipient.teamId }),
      });
    } catch (err) {
      const wait = this.budget ? retryAfterSeconds(err) : null;
      if (wait !== null) this.budget?.pause(wait);
      if (wait === null || !this.budget?.enforcing) throw err;
      console.error(`[AGENT] chat.startStream is rate limited for ${wait}s; posting the reply whole`);
      throw new NoStreamBudget();
    }
    this.ts = (res.ts as string | undefined) ?? null;
    if (!this.ts) throw new Error('chat.startStream returned no ts');
    this.sent += markdown;
    this.streamChars = markdown.length;
  }

  /** Ends the current stream mid-reply; the session stays `processing`. */
  private async endStream(): Promise<void> {
    try {
      await this.call('chat.stopStream', { ts: this.ts, session_status: 'processing' });
    } catch (err) {
      console.error('[AGENT] could not end a full stream:', (err as Error).message);
    }
    this.ts = null;
  }

  /** The final stop, once the text is out; a failure only leaves the status to settle. */
  private async stopQuietly(): Promise<void> {
    try {
      if (this.ts) {
        await this.call('chat.stopStream', { ts: this.ts });
        return;
      }
    } catch (err) {
      console.error('[AGENT] stopStream failed:', (err as Error).message);
    }
    await setSessionStatus(this.client, { channel: this.channel, threadTs: this.threadTs, status: 'active' });
  }

  private call(method: string, args: Record<string, unknown>) {
    return this.client.apiCall(method, { channel: this.channel, ...args });
  }
}

/** No stream budget for a start (streamBudget.ts): the reply goes out whole instead. */
class NoStreamBudget extends Error {
  constructor() {
    super('no stream budget');
  }
}

/** Slack's error for a stream that has ended (timed out, or stopped by the user). */
function streamClosed(err: unknown): boolean {
  const e = err as { data?: { error?: string }; message?: string };
  return (e?.data?.error ?? e?.message) === 'message_not_in_streaming_state';
}

/**
 * The part of `finalText` not already sent (all of it when nothing was). When the
 * final text does not extend what was sent, `fallback` (the unsent buffer).
 */
/**
 * Text that continues a reply, made fit to post as a message of its own: blank
 * lines before it and blank space after it go (Slack would drop them anyway),
 * but the first line keeps its leading spaces, which may be code indentation.
 */
export function postableText(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

export function remainder(sent: string, finalText: string, fallback: string = ''): string {
  // Leading blank space is never in the final text (the gate drops it); trailing
  // blank space that already went out must not be sent again.
  const shown = sent.trimStart();
  if (!shown.trim()) return finalText;
  if (finalText.startsWith(shown)) return finalText.slice(shown.length);
  // What went out ended in blank space the final text has less of, or none of
  // (the reply's very end): skip as much of it as was already shown.
  const core = shown.trimEnd();
  if (!finalText.startsWith(core)) return fallback;
  const rest = finalText.slice(core.length);
  const shownSpace = shown.length - core.length;
  const restSpace = rest.length - rest.trimStart().length;
  return rest.slice(Math.min(shownSpace, restSpace));
}
