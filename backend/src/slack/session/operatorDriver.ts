/**
 * The operator's TurnDriver: `claude` on
 * the orchestrator host through the executor, in the operator's working
 * directory, resuming the thread's own Claude session (or, in a new DM thread,
 * the DM's recent one). What #555's runAgentTurn ran inline, unchanged.
 */

import { executeClaudeCommand } from '../executor';
import { AGENT_TIMEOUT_MS, agentPersona, claudeSessionFor, rememberClaudeSession } from '../agentSession';
import type { TurnDriver } from './runTurn';

export const CONTEXT_LOST = "_I couldn't pick up this thread's earlier conversation, so I'm starting fresh._";

export function operatorExecutorDriver(opts: {
  channelId: string; threadTs: string; messageTs: string; workingDir: string; inChannel: boolean;
}): TurnDriver {
  const { channelId, workingDir, inChannel } = opts;
  // Only a DM carries its recent conversation, and only into a new thread: an
  // old thread is its own conversation, not whatever the DM did last.
  const carryOver = inChannel ? undefined : channelId;
  const carryInto = opts.threadTs === opts.messageTs ? carryOver : undefined;
  return {
    name: 'operator-executor',
    async run(ctx) {
      const resume = claudeSessionFor(ctx.key, workingDir, carryInto);
      const text = await executeClaudeCommand(
        ctx.message,
        {
          workingDir,
          resumeSessionId: resume?.sessionId,
          // A carried-over session may still be running for the DM's other thread.
          forkSession: resume?.carried,
          signal: ctx.signal,
          onSessionId: (id) => rememberClaudeSession(ctx.key, id, workingDir, carryOver),
          appendSystemPrompt: agentPersona({ inChannel, tempDir: ctx.tempDir }),
          ...(ctx.tempDir && { env: { TMPDIR: ctx.tempDir } }),
          timeoutMs: AGENT_TIMEOUT_MS,
          onFreshStart: () => ctx.onNotice(CONTEXT_LOST),
        },
        (data) => ctx.onText(data.chunk),
      );
      return { text };
    },
  };
}
