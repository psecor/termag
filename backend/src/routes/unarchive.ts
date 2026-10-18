// Pure planning for the "create a project whose name matches an archived one"
// path in projects.ts. Kept in its own module (like bulkPin.ts) so it can be
// unit-tested without dragging in projects.ts's PrismaClient / tmux / agent
// imports.
//
// Background: un-archiving re-points the project at whatever box the caller
// picked. The project's tmux sessions live on the box it was archived from
// (or were killed by the archive), so every existing workflow needs its
// sessions (re)created on the new host — otherwise the UI attaches to a name
// the box's tmux server has never seen and tmux prints a bare "no sessions".

export interface UnarchiveWorkflow {
  /** 'agent' or 'data' — the Prisma WorkflowType as a string. */
  type: string;
  /** Persisted provider id for agent workflows; null for data workflows. */
  provider: string | null;
  /** Workstream name the workflow's sessions belong to ('main' by default). */
  workstream: string;
}

export interface UnarchivePlan {
  /**
   * True when the caller asked for an initial agent and the archived project
   * has no agent workflow yet — create one (the pre-existing behaviour).
   */
  createAgentWorkflow: boolean;
  /**
   * Every workflow the project already had. Each one's tmux sessions must be
   * ensured on the project's (possibly new) host. Agent workflows first so
   * the pane the user is about to look at comes up first.
   */
  relaunch: UnarchiveWorkflow[];
}

export function planUnarchiveLaunches(opts: {
  existingWorkflows: UnarchiveWorkflow[];
  initialAgentEnabled: boolean;
}): UnarchivePlan {
  const { existingWorkflows, initialAgentEnabled } = opts;
  const hasAgent = existingWorkflows.some(w => w.type === 'agent');
  const agents = existingWorkflows.filter(w => w.type === 'agent');
  const others = existingWorkflows.filter(w => w.type !== 'agent');
  return {
    createAgentWorkflow: initialAgentEnabled && !hasAgent,
    relaunch: [...agents, ...others],
  };
}
