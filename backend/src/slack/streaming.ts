/**
 * Slack Streaming Message Updater
 *
 * Handles real-time updates to a Slack message as Claude streams output.
 */

import { WebClient } from '@slack/web-api';
import { formatResponse, splitMessage } from './formatting';

export class StreamingMessageUpdater {
  private client: WebClient;
  private channelId: string;
  private messageTs: string;
  private buffer: string = '';
  private lastUpdate: number = 0;
  private updateInterval: number;
  private pendingUpdate: NodeJS.Timeout | null = null;
  private isFinalized: boolean = false;

  constructor(client: WebClient, channelId: string, messageTs: string) {
    this.client = client;
    this.channelId = channelId;
    this.messageTs = messageTs;
    this.updateInterval = parseInt(process.env.STREAMING_UPDATE_INTERVAL_MS ?? '2000', 10);
  }

  async appendChunk(chunk: string): Promise<void> {
    if (this.isFinalized) return;
    this.buffer += chunk;

    if (!this.pendingUpdate) {
      const now = Date.now();
      const delay = Math.max(0, this.updateInterval - (now - this.lastUpdate));
      this.pendingUpdate = setTimeout(async () => {
        await this.flush();
        this.pendingUpdate = null;
      }, delay);
    }
  }

  async flush(): Promise<void> {
    if (this.isFinalized || !this.buffer) return;

    try {
      const maxLength = parseInt(process.env.MAX_RESPONSE_LENGTH ?? '3900', 10);
      const formatted = formatResponse(this.buffer);
      const indicator = '\n\n_Thinking..._';

      let text = formatted + indicator;
      if (text.length > maxLength) {
        text = formatted.substring(0, maxLength - 100) + '\n\n_...more content streaming..._';
      }

      await this.client.chat.update({
        channel: this.channelId,
        ts: this.messageTs,
        text,
      });
      this.lastUpdate = Date.now();
    } catch (error) {
      console.error('[STREAMING] Update failed:', (error as Error).message);
    }
  }

  async finalize(finalContent: string): Promise<void> {
    if (this.isFinalized) return;

    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
    this.isFinalized = true;

    try {
      const formatted = formatResponse(finalContent);
      const maxLength = parseInt(process.env.MAX_RESPONSE_LENGTH ?? '3900', 10);

      if (formatted.length <= maxLength) {
        await this.client.chat.update({
          channel: this.channelId,
          ts: this.messageTs,
          text: formatted,
        });
      } else {
        const chunks = splitMessage(formatted, maxLength);
        await this.client.chat.update({
          channel: this.channelId,
          ts: this.messageTs,
          text: chunks[0] + '\n\n_(Continued in thread...)_',
        });
        for (let i = 1; i < chunks.length; i++) {
          await this.client.chat.postMessage({
            channel: this.channelId,
            thread_ts: this.messageTs,
            text: `_(Part ${i + 1}/${chunks.length})_\n\n` + chunks[i],
          });
        }
      }
    } catch (error) {
      console.error('[STREAMING] Final update failed:', (error as Error).message);
      throw error;
    }
  }
}
