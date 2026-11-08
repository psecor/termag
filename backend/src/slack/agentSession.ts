/**
 * Slack's agent experience for the DM / @mention executor (docs: docs.slack.dev/ai/agent-sessions).
 *
 * Used only when the app is declared an agent in its Slack settings, which grants
 * the bot token `assistant:write`. Each thread is an agent session: Slack shows
 * "Working…" and a Stop button while it is `processing`, the reply is streamed
 * with chat.startStream / appendStream / stopStream, and the thread keeps its own
 * Claude session.
 */

import type { WebClient } from '@slack/web-api';
// The turn machinery lives in session/;
// these re-exports keep every existing import of agentSession working.
export * from './session/stream';
export * from './session/tags';
export * from './session/persona';
export * from './session/claims';
export * from './session/reactions';
export * from './session/caps';

type SlackClient = Pick<WebClient, 'apiCall' | 'auth'>;

const AGENT_SCOPE = 'assistant:write';
const AGENT_CHECK_TTL_MS = 5 * 60 * 1000;

let agentCheck: { value: boolean; at: number } | null = null;

/** Whether the bot token carries `assistant:write`, i.e. the app is a Slack agent. */
export async function isAgentApp(client: SlackClient, now: number = Date.now()): Promise<boolean> {
  if (agentCheck && now - agentCheck.at < AGENT_CHECK_TTL_MS) return agentCheck.value;
  let value = false;
  try {
    const res = await client.auth.test();
    value = (res.response_metadata?.scopes ?? []).includes(AGENT_SCOPE);
  } catch (err) {
    console.error('[AGENT] auth.test failed:', (err as Error).message);
  }
  agentCheck = { value, at: now };
  return value;
}

export function resetAgentCheck(): void {
  agentCheck = null;
}

type SuggestedPrompts = { title: string; prompts: Array<{ title: string; message: string }> };

/** The Messages tab's prompts, for the project DMs run in (null: the home directory). */
export function suggestedPrompts(project: string | null, command: string = '/t'): SuggestedPrompts {
  if (!project) {
    return {
      title: `Working in your home directory. \`${command} switch <project>\` picks a project.`,
      prompts: [
        { title: 'What can you do?', message: 'What can you help me with from Slack? Keep it short.' },
        { title: "What's in my home directory?", message: 'List the projects and notable directories in my home directory, one line each.' },
      ],
    };
  }
  return {
    title: `Working in ${project}`,
    prompts: [
      { title: `Tour ${project}`, message: 'Give me a short tour of this repository: what it does, how it is laid out, and where to start reading.' },
      { title: 'What changed lately?', message: 'Summarize the commits from the last two days in this repository.' },
      { title: 'Find TODOs', message: 'List the TODO and FIXME comments in this repository, grouped by file, and say which look most important.' },
      { title: 'Uncommitted changes', message: 'Summarize the uncommitted changes in this repository and anything that looks unfinished.' },
    ],
  };
}

/**
 * Sets the prompts at the top of the Messages tab. No thread_ts: an agent app's
 * prompts belong to the tab, and Slack silently drops a call that names a thread.
 */
export async function publishSuggestedPrompts(client: SlackClient, channel: string, prompts: SuggestedPrompts): Promise<void> {
  try {
    await client.apiCall('assistant.threads.setSuggestedPrompts', { channel_id: channel, ...prompts });
  } catch (err) {
    console.error('[AGENT] setSuggestedPrompts failed:', (err as Error).message);
  }
}
