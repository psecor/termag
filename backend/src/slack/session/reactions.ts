/**
 * Reactions on the person's message (moved from agentSession.ts, M2): the
 * topical ack and Claude's own `[react:…]`.
 */

import type { WebClient } from '@slack/web-api';

export async function addReaction(client: Pick<WebClient, 'reactions'>, channel: string, ts: string, name: string): Promise<boolean> {
  try {
    await client.reactions.add({ channel, timestamp: ts, name });
    return true;
  } catch (err) {
    const code = (err as { data?: { error?: string } }).data?.error;
    if (code === 'already_reacted') return true;
    console.error(`[AGENT] reaction ${name} failed:`, code ?? (err as Error).message);
    return false;
  }
}

export async function removeReaction(client: Pick<WebClient, 'reactions'>, channel: string, ts: string, name: string): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp: ts, name });
  } catch { /* already gone */ }
}
