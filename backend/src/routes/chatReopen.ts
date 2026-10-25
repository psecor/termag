// Chat reopen's pane relaunch, kept out of routes/chats.ts so it can be
// tested without that file's Prisma client. Same plan as a project
// un-archive (planUnarchiveLaunches): every leftover workflow, agents first,
// including data. A chat already has its agent, so this never creates a
// second one. A launch that throws puts the row back; the caller has already
// marked it live.

import { planUnarchiveLaunches, type UnarchiveWorkflow } from './unarchive';

export async function relaunchChatOrRestore(opts: {
  workflows: UnarchiveWorkflow[];
  launchAgent: (wf: UnarchiveWorkflow) => Promise<unknown>;
  launchData: (wf: UnarchiveWorkflow) => Promise<unknown>;
  restore: () => Promise<unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = planUnarchiveLaunches({
    existingWorkflows: opts.workflows,
    initialAgentEnabled: false,
  });
  try {
    for (const wf of plan.relaunch) {
      if (wf.type === 'agent') await opts.launchAgent(wf);
      else await opts.launchData(wf);
    }
    return { ok: true };
  } catch (err) {
    await opts.restore().catch(restoreErr => {
      console.warn(`[CHATS] reopen rollback failed: ${restoreErr instanceof Error ? restoreErr.message : restoreErr}`);
    });
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || 'The chat could not be reopened' };
  }
}
