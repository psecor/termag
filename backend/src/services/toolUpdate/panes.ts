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
import { reviewSessionNames, sessionBelongsToUser, sessionName } from '../tmux';
import { chatNoticeText, type ChatNoticeEntry, type ChatNoticePane } from './notice';
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

/** A pane of a workstream other than its agent pane, which the box resumes itself. */
export interface OtherPaneTarget { projectId: string; workstream: string; pane: Exclude<ChatNoticePane, 'agent'> }

/**
 * Every other pane name of these projects' workstreams (ctrl, data,
 * data-ctrl, and every review slot) → its workstream, named forward as
 * agentPaneIndex does. An ask's chat workstream has no pane, and a name two
 * panes share has no entry.
 */
export function otherPaneIndex(projects: BoxProject[], unixUsername: string): Map<string, OtherPaneTarget> {
  const out = new Map<string, OtherPaneTarget>();
  // A name two panes share (main's `data-ctrl` is workstream `data`'s `ctrl`,
  // `<user>-<project>-data-ctrl` both) cannot say whose chat a notice is for:
  // it is left out, and the notice is stored on neither (Bugbot on #1301).
  const shared = new Set<string>();
  const add = (name: string, t: OtherPaneTarget) => {
    const had = out.get(name);
    if (had && (had.projectId !== t.projectId || had.workstream !== t.workstream || had.pane !== t.pane)) shared.add(name);
    else out.set(name, t);
  };
  for (const p of projects) {
    for (const wf of p.workflows) {
      if (wf.workstream.askThread) continue;
      const ws = wf.workstream.name;
      for (const pane of ['ctrl', 'data', 'data-ctrl'] as const) add(sessionName(unixUsername, p.name, pane, ws), { projectId: p.id, workstream: ws, pane });
      for (const name of reviewSessionNames(unixUsername, p.name, ws)) add(name, { projectId: p.id, workstream: ws, pane: 'review' });
    }
  }
  for (const name of shared) out.delete(name);
  return out;
}

/**
 * The notices the box printed in the panes it resumed itself (role `other`),
 * each on the workstream whose pane it is: only a pane of the owner's, of one
 * of the box's projects, whose report carries a notice that passes
 * chatNoticeText. A pane the box did not print in reports no notice.
 */
export function boxChatNotices(panes: ReportedPane[], index: Map<string, OtherPaneTarget>, unixUsername: string): ChatNoticeEntry[] {
  const out: ChatNoticeEntry[] = [];
  for (const p of panes) {
    if (p.role !== 'other' || !sessionBelongsToUser(p.session, unixUsername)) continue;
    const text = chatNoticeText(p.notice);
    const target = index.get(p.session);
    if (text && target) out.push({ ...target, text });
  }
  return out;
}
