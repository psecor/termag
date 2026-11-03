/**
 * The agent panes a tool update stopped, mapped back to the project
 * and workstream whose agent they are, so the orchestrator relaunches exactly
 * those. Pure: the
 * projects come from the database, the launch is agentRuntime's.
 *
 * A tmux session name cannot be parsed back (a project and a workstream may
 * both hold `-`), so the box's own projects are named forward with
 * tmux.sessionName and the reported name is looked up among them.
 */
import { sessionBelongsToUser, sessionName } from '../tmux';
import type { ReportedPane } from './run';

export interface AgentPaneTarget {
  projectId: string;
  projectName: string;
  workstream: string;
  provider: string;
  backend: string | null;
  model: string | null;
}

/** The owner's projects on the box, with their agent workflows, as the report handler reads them. */
export interface BoxProject {
  id: string;
  name: string;
  workflows: Array<{ type: string; provider: string | null; backend: string | null; model: string | null; workstream: { name: string; askThread?: { id: string } | null } }>;
}

/** Every agent pane name of these projects → its target. An ask's chat workstream has no pane. */
export function agentPaneIndex(projects: BoxProject[], unixUsername: string, defaultProvider: string): Map<string, AgentPaneTarget> {
  const out = new Map<string, AgentPaneTarget>();
  for (const p of projects) {
    for (const wf of p.workflows) {
      if (wf.type !== 'agent' || wf.workstream.askThread) continue;
      out.set(sessionName(unixUsername, p.name, 'agent', wf.workstream.name), {
        projectId: p.id, projectName: p.name, workstream: wf.workstream.name,
        provider: wf.provider ?? defaultProvider, backend: wf.backend, model: wf.model,
      });
    }
  }
  return out;
}

export type PaneSkip = 'not-agent' | 'not-owner' | 'unknown-session' | 'other-provider' | 'duplicate';
export type PanePlan =
  | { session: string; action: 'relaunch'; target: AgentPaneTarget; resume: boolean; sessionId: string | null }
  | { session: string; action: 'skip'; reason: PaneSkip };

/**
 * What to do with each reported pane: relaunch an agent pane of one of the
 * box's projects, resuming only when it had a conversation (a never-used
 * session would fail with "No conversation found"), and nothing else. A pane
 * the report calls `other` already had `claude --resume` typed on the box.
 * `providers` is the tool's (components.ts): a pane whose agent is another
 * provider's was not stopped by this tool, whatever the report says.
 * `sessionId` is the conversation the box saw in the pane, which a bridge
 * provider (Codex) resumes by id; Claude Code's resumeCommand continues the
 * pane's last one.
 */
export function planRelaunches(panes: ReportedPane[], index: Map<string, AgentPaneTarget>, unixUsername: string, providers: readonly string[]): PanePlan[] {
  const seen = new Set<string>();
  return panes.map((p): PanePlan => {
    if (p.role !== 'agent') return { session: p.session, action: 'skip', reason: 'not-agent' };
    if (!sessionBelongsToUser(p.session, unixUsername)) return { session: p.session, action: 'skip', reason: 'not-owner' };
    const target = index.get(p.session);
    if (!target) return { session: p.session, action: 'skip', reason: 'unknown-session' };
    if (!providers.includes(target.provider)) return { session: p.session, action: 'skip', reason: 'other-provider' };
    if (seen.has(p.session)) return { session: p.session, action: 'skip', reason: 'duplicate' };
    seen.add(p.session);
    return { session: p.session, action: 'relaunch', target, resume: p.hadConversation, sessionId: p.hadConversation ? p.sessionId : null };
  });
}

/** The preview's counts from the orchestrator's live status of the box's agent panes that run the tool: live is any agent up, busy one in a turn. */
export function sessionCounts(statuses: Array<'working' | 'waiting' | 'idle' | 'not_running'>): { liveSessions: number; busySessions: number } {
  return {
    liveSessions: statuses.filter(s => s !== 'not_running').length,
    busySessions: statuses.filter(s => s === 'working').length,
  };
}
