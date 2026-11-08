/**
 * One turn of an operator's Slack agent session: runTurn (session/runTurn.ts)
 * with the executor driver (session/operatorDriver.ts). Kept as the entry
 * point events.ts calls, and the module #555's tests drive.
 */

import { runTurn, type AgentTurn } from './session/runTurn';
import { operatorExecutorDriver } from './session/operatorDriver';

export type { AgentTurn, TurnContext, TurnDriver } from './session/runTurn';

export async function runAgentTurn(turn: AgentTurn): Promise<void> {
  const driver = operatorExecutorDriver({
    channelId: turn.channelId, threadTs: turn.threadTs, messageTs: turn.messageTs,
    workingDir: turn.workingDir, inChannel: turn.recipient !== null,
  });
  return runTurn(turn, driver);
}
