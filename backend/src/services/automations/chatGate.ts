/**
 * Who may speak in an automation run's conversation, and when.
 * While a run is live its brief must be
 * the only turn: completion finishes the row on the run's turn-end
 * (complete.ts), so a turn someone else started first, in the moments
 * between the workstream's creation and the brief's send, would end the run
 * with their own result instead. A follow-up is a person continuing a
 * finished run, and is fine once the row says it is over.
 */
import { prisma } from '../../db';
import { isRunName } from './schedule';
import { LIVE_RUN_STATES } from './store';

export type RunChatRefusal = 'run_starting' | 'run_live';

/**
 * Pure: a run workstream of an automation project takes a message only once
 * its run row exists and is finished. Anything else is left alone.
 */
export function runChatRefusal(i: { projectKind: string | null | undefined; workstream: string; run: { state: string } | null }): RunChatRefusal | null {
  if (i.projectKind !== 'automation' || !isRunName(i.workstream)) return null;
  if (!i.run) return 'run_starting';
  if ((LIVE_RUN_STATES as readonly string[]).includes(i.run.state)) return 'run_live';
  return null;
}

export const RUN_CHAT_REFUSAL_TEXT: Record<RunChatRefusal, string> = {
  run_starting: 'This run is starting; you can reply once it has finished',
  run_live: 'This run is still going; you can reply once it has finished, or stop it from the automation',
};

/** The refusal for a send to this workstream, read from the database. */
export async function runChatRefusalFor(projectId: string, workstreamId: string, workstream: string): Promise<RunChatRefusal | null> {
  if (!isRunName(workstream)) return null;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { kind: true } });
  if (project?.kind !== 'automation') return null;
  const run = await prisma.automationRun.findUnique({ where: { workstreamId }, select: { state: true } });
  return runChatRefusal({ projectKind: project.kind, workstream, run });
}
