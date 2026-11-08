// A pane chat's subagents ("Subagents in a pane
// chat"): what the box read from beside the pane Claude's session (GET
// …/chat/pane-subagents, agent pane-subagents-v1), as the SubagentViews the
// SDK chat's rows, drawer and agent tab already draw. A pane has no event
// stream, so a view has no streamed messages and no step; its brief, its
// report and whether it finished are what Claude Code wrote down. Pure, for
// the tests.
import type { SubagentStatus, SubagentView } from './subagents';

/** One subagent as the route answers it (backend routes/chatPaneSubagents.ts PaneSubagent). */
export interface PaneSubagent {
  agentId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  background: boolean;
  model: string | null;
  finished: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  prompt: string | null;
  report: string | null;
}

/** A session running alongside the pane's: another interactive Claude in its directory (paneAlongsideViews). */
export interface PaneAlongside { sessionId: string; startedAt: number | null; updatedAt: string | null; title: string | null }

export type PaneSubagentsAnswer =
  | { available: true; running: boolean; session: { sessionId: string; startedAt: number | null } | null; subagents: PaneSubagent[]; alongside: PaneAlongside[] }
  | { available: false; reason: 'offline' | 'outdated-agent' | 'unreadable' };

/** A pane subagent's id in the views and its agent tab: its Agent call's, else its own, marked. */
export const paneSubagentId = (s: Pick<PaneSubagent, 'agentId' | 'toolUseId'>): string => s.toolUseId ?? `pane-agent:${s.agentId}`;

/** When a subagent started, for its place in the list: its file's first line, else its last write. */
const startOf = (s: PaneSubagent) => Date.parse(s.startedAt ?? s.updatedAt ?? '') || 0;

/**
 * The views, oldest first as an SDK chat lists them (by when each started:
 * the box sorts by last write, which changes as they work). One that hasn't
 * finished is running while the pane's Claude is (the box found its live
 * session), else it stopped with it.
 */
export function paneSubagentViews(list: readonly PaneSubagent[], sessionLive: boolean): SubagentView[] {
  return [...list].sort((a, b) => startOf(a) - startOf(b)).map(s => {
    const id = paneSubagentId(s);
    const status: SubagentStatus = s.finished ? 'done' : sessionLive ? 'running' : 'stopped';
    const start = s.startedAt ? Date.parse(s.startedAt) : NaN;
    const end = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
    const description = s.description ?? 'Subagent';
    return {
      id,
      call: {
        kind: 'tool', key: `tool:${id}`, id, name: 'Agent',
        input: { description, ...(s.agentType ? { subagent_type: s.agentType } : {}), ...(s.prompt ? { prompt: s.prompt } : {}), ...(s.background ? { run_in_background: true } : {}) },
        inputJson: '', result: s.report, isError: false, done: s.finished,
        startedAt: s.startedAt, endedAt: s.finished ? s.updatedAt : null,
      },
      description,
      agentType: s.agentType,
      prompt: s.prompt,
      background: s.background,
      status,
      step: null,
      tokens: null,
      toolUses: null,
      // Its file's first line to its last write, once it finished.
      durationMs: s.finished && Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
      model: s.model,
      report: s.report,
      agentId: s.agentId,
      items: [],
      nested: { items: [], subagents: undefined, running: false },
      pane: true,
    };
  });
}

/** How long a pane chat keeps a subagent in view after it ends (paneKeptSubagents). */
export const PANE_SUBAGENT_KEEP_MS = 60 * 60 * 1000;

/**
 * The subagents a pane chat keeps in view (the drawer on its composer): any
 * running, and those that ended in the last PANE_SUBAGENT_KEEP_MS. A pane
 * transcript has no row for an Agent call, so the drawer is the way to one.
 */
export function paneKeptSubagents(views: readonly SubagentView[], now: number): SubagentView[] {
  return views.filter(v => {
    if (v.status === 'running') return true;
    const end = Date.parse(v.call.endedAt ?? v.call.startedAt ?? '');
    return Number.isFinite(end) && now - end <= PANE_SUBAGENT_KEEP_MS;
  });
}

/** A session running alongside's id in the views and its tab. */
export const paneSessionId = (sessionId: string): string => `pane-session:${sessionId}`;
export const isPaneSessionTab = (id: string | null | undefined): boolean => Boolean(id?.startsWith('pane-session:'));

/**
 * The sessions running alongside the pane's Claude in its directory (one
 * started in the ctrl pane, an agent team's teammate), as views the agent
 * tab draws: running, named by their first message, with no brief and no
 * report. They are listed only while their process lives, so each is
 * running; one that ends leaves the list.
 */
export function paneAlongsideViews(list: readonly PaneAlongside[]): SubagentView[] {
  return list.map(a => {
    const id = paneSessionId(a.sessionId);
    const startedAt = a.startedAt ? new Date(a.startedAt).toISOString() : null;
    const description = a.title?.split('\n')[0].trim() || 'Claude session';
    return {
      id,
      call: { kind: 'tool', key: `tool:${id}`, id, name: 'Session', input: { description }, inputJson: '', result: null, isError: false, done: false, startedAt },
      description,
      agentType: 'Running alongside',
      prompt: null,
      background: true,
      status: 'running' as const,
      step: 'In another pane',
      tokens: null,
      toolUses: null,
      durationMs: null,
      model: null,
      report: null,
      agentId: null,
      items: [],
      nested: { items: [], subagents: undefined, running: false },
      pane: true,
      paneSession: a.sessionId,
    };
  });
}
