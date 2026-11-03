/**
 * The simple UI's sessions as rows, on the server: which chats termag web's
 * sidebar lists and what it calls them, for the desktop app's own sidebar
 * (GET /api/cli/v1/chats, routes/cliChats.ts). It mirrors the browser's pure
 * row logic, so the two apps list the same sessions under the same names:
 * buildRows (frontend/src/mobile/inbox.ts), chatRows, askPlaceholderProjects,
 * withoutAskPlaceholders and chatRowName (frontend/src/chat/simpleChat.ts).
 * chatSessionRows.mirror.test.ts runs both on the same projects and fails
 * when they part.
 *
 * Not mirrored: the order. The browser sorts its sidebar by band (needs you,
 * running, the rest) from review rings this server doesn't read here; the
 * desktop sorts threads its own way. Rows come in listProjectsFor's order.
 */
import { providerForSource } from '../providers/registry';
import { isClaudeAuthError } from './claudeAuthError';
import type { AgentStatus } from '../types';
import { statusKey } from './statusKey';
import { sessionName } from './tmux';

/** A workstream as listProjectsFor (routes/projects.ts) shapes it. */
export interface ChatSourceWorkstream {
  id: string;
  name: string;
  archived?: boolean;
  sessionTitle?: string | null;
  sessionTitleAt?: Date | string | null;
  sessionTitleSource?: string | null;
  spaceId?: string | null;
  spaceFixedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  lastActiveAt?: Date | string | null;
  createdAt?: Date | string | null;
  hasTranscript?: boolean;
  chatHolder?: string | null;
  t3ThreadId?: string | null;
  chatSessionId?: string | null;
  hasTurns?: boolean;
  askThread?: {
    id: string;
    title?: string | null;
    parentProjectId?: string | null;
    parentWorkstream?: string | null;
    /** The workstream the ask runs in, and its repository there: an ask chat has no worktree of its own. */
    workstream?: string | null;
    repoName?: string | null;
  } | null;
}

/** A project as listProjectsFor shapes it: owned, or shared with the viewer (role collaborator). */
export interface ChatSourceProject {
  id: string;
  name: string;
  archived?: boolean;
  kind?: string | null;
  createdFor?: string | null;
  instanceId: string | null;
  lastActiveAt?: Date | string | null;
  ownerUsername?: string | null;
  role?: string | null;
  workflows: Array<{ type: string; provider?: string | null; workstreamId?: string | null }>;
  workstreams: ChatSourceWorkstream[];
}

export type ChatStatusValue = AgentStatus['status'];

export interface ChatSessionRow {
  /** `${projectId}|${workstream}`, the browser's rowKey. */
  key: string;
  projectId: string;
  projectName: string;
  workstream: string;
  /** Null for a project with no workstreams yet (its implicit main). */
  workstreamId: string | null;
  boxId: string | null;
  kind: 'normal' | 'automation';
  /** The agent: a chat runner's (claude-chat, pi-chat) or a pane provider's. */
  provider: string | null;
  /** What the row leads with, and under it, as chatRowName decides. */
  title: string | null;
  where: string | null;
  ask: boolean;
  askThreadId: string | null;
  /** The session that sent the ask, which termag web nests it under. */
  askParent: { projectId: string; workstream: string } | null;
  sessionTitle: string | null;
  /** When sessionTitle last changed, and who set it: a person's rename sticks against Claude's titles. */
  titleAt: string | null;
  titleSource: 'person' | 'claude' | null;
  spaceId: string | null;
  /** The viewer is a collaborator, not the owner. */
  shared: boolean;
  owner: string;
  status: {
    value: ChatStatusValue | 'not_running';
    waitingReason: AgentStatus['waitingReason'] | null;
    /** When it last came to rest from working or waiting: it has had a turn. */
    stoppedAt: string | null;
    /** The last status write, else the project's last activity. */
    updatedAt: string | null;
    /** What web shows under the row: the agent's last line, or the hook's message. */
    message: string | null;
    /** Why it needs a hand at rest: Claude's sign-in is gone, or the session hit a usage cap. */
    problem: 'auth' | 'rate-limited' | null;
    /** The usage cap's own words ("resets 3:45pm"), while it holds. */
    rateLimited: string | null;
  };
  /** The workstream row's own last change (a new session title among them). */
  updatedAt: string | null;
  /** The workstream's last activity, else the project's. */
  lastActiveAt: string | null;
  /** When the workstream began; GET /chats gives its session's start instead when termag stored it. */
  createdAt: string | null;
  hasTranscript: boolean;
  /** Who drives its Claude session: termag's chat runner, or the desktop app's thread (services/chatHolder.ts). */
  holder: 'runner' | 't3';
  /** The desktop's thread for the session, once one started it or took it. */
  t3ThreadId: string | null;
  /** The Claude session the box last named for it on a hand-over (Workstream.chatSessionId). */
  sessionId: string | null;
  /** Whose checkout its turns run in: its own workstream's, or for an ask the asked one's (routes/chat.ts chatTarget). */
  checkout: { workstream: string; repo: string | null };
}

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : typeof d === 'string' ? d : d.toISOString();

/** The browser's runningProviderForSource: a status's source names the agent, but not the poller's or a T3 thread's. */
function runningProviderFor(source: string | null | undefined): string | undefined {
  if (!source || source === 'tmux-poller' || source.startsWith('t3:')) return undefined;
  return providerForSource(source);
}

function providerFor(p: ChatSourceProject, workstreamId: string | undefined, liveSource?: string | null): string | null {
  const live = runningProviderFor(liveSource);
  if (live) return live;
  const ws = workstreamId ? p.workflows.find(w => w.type === 'agent' && w.workstreamId === workstreamId) : undefined;
  const any = p.workflows.find(w => w.type === 'agent');
  return ws?.provider ?? any?.provider ?? null;
}

const ASK_CHAT_WORKSTREAM = /^ask-[a-z0-9]{8,40}$/;
const isAskChat = (w: ChatSourceWorkstream) => Boolean(w.askThread) || ASK_CHAT_WORKSTREAM.test(w.name);

/** askPlaceholderProjects: projects whose unused main only stands in for their asks. */
function askPlaceholderProjects(projects: readonly ChatSourceProject[]): Set<string> {
  const out = new Set<string>();
  for (const p of projects) {
    const main = p.workstreams.find(w => w.name === 'main');
    if (!main || main.sessionTitle?.trim() || main.hasTranscript || main.hasTurns) continue;
    const asked = p.workstreams.some(w => !w.archived && w.name !== 'main' && isAskChat(w));
    if (asked || p.createdFor === 'ask') out.add(p.id);
  }
  return out;
}

interface Built extends ChatSessionRow {
  askTitle: string | null;
}

/** chatRowName: an ask leads with its title (else ask-<id>); else Claude's title when shown; else the project. */
function rowName(row: Built, titlesShown: boolean): Pick<ChatSessionRow, 'title' | 'where' | 'ask'> {
  const session = titlesShown ? row.sessionTitle?.trim() || null : null;
  const askName = row.askThreadId ? row.askTitle?.trim() || row.workstream : null;
  if (askName) return { title: askName, where: session && session !== askName ? session : null, ask: true };
  const label = row.workstream === 'main' ? row.projectName : `${row.projectName} · ${row.askTitle?.trim() || row.workstream}`;
  return { title: session, where: label, ask: false };
}

type StatusMap = ReadonlyMap<string, AgentStatus> | Record<string, AgentStatus | undefined>;

function statusOf(map: StatusMap, key: string): AgentStatus | undefined {
  return map instanceof Map ? map.get(key) : (map as Record<string, AgentStatus | undefined>)[key];
}

/** buildRows' row for one workstream (or a project's implicit main), before it is named. */
function rowFor(p: ChatSourceProject, ws: Partial<ChatSourceWorkstream> & { name: string }, statuses: StatusMap, username: string): Built {
  const owner = p.ownerUsername ?? username;
  const st = statusOf(statuses, statusKey(p.instanceId, sessionName(owner, p.name, 'agent', ws.name)));
  return {
    key: `${p.id}|${ws.name}`,
    projectId: p.id,
    projectName: p.name,
    workstream: ws.name,
    workstreamId: ws.id ?? null,
    boxId: p.instanceId ?? null,
    kind: p.kind === 'automation' ? 'automation' : 'normal',
    provider: providerFor(p, ws.id, st?.source),
    title: null,
    where: null,
    ask: false,
    askTitle: ws.askThread ? ws.askThread.title?.trim() || null : null,
    askThreadId: ws.askThread?.id ?? null,
    askParent: ws.askThread?.parentProjectId && ws.askThread.parentWorkstream
      ? { projectId: ws.askThread.parentProjectId, workstream: ws.askThread.parentWorkstream }
      : null,
    sessionTitle: ws.sessionTitle ?? null,
    titleAt: iso(ws.sessionTitleAt),
    titleSource: ws.sessionTitleSource === 'person' || ws.sessionTitleSource === 'claude' ? ws.sessionTitleSource : null,
    spaceId: ws.spaceId ?? null,
    shared: p.role === 'collaborator',
    owner,
    status: {
      value: st?.status ?? 'not_running',
      waitingReason: st?.waitingReason ?? null,
      stoppedAt: iso(st?.stoppedAt),
      updatedAt: iso(st?.updatedAt) ?? iso(p.lastActiveAt),
      message: st?.message || null,
      problem: isClaudeAuthError(st?.message) ? 'auth' : st?.rateLimited ? 'rate-limited' : null,
      rateLimited: st?.rateLimited || null,
    },
    updatedAt: iso(ws.updatedAt),
    lastActiveAt: iso(ws.lastActiveAt) ?? iso(p.lastActiveAt),
    createdAt: iso(ws.createdAt),
    hasTranscript: Boolean(ws.hasTranscript),
    holder: ws.chatHolder === 't3' ? 't3' : 'runner',
    t3ThreadId: ws.t3ThreadId ?? null,
    sessionId: ws.chatSessionId ?? null,
    checkout: ws.askThread
      ? { workstream: ws.askThread.workstream || 'main', repo: ws.askThread.repoName ?? null }
      : { workstream: ws.name, repo: null },
  };
}

/**
 * The sessions termag web's sidebar lists for `username`, from its project
 * list and the statuses it can see (keyed by statusKey). `titlesShown` is
 * simple-ui-session-titles-enabled for the viewer.
 */
export function chatSessionRows(
  projects: readonly ChatSourceProject[],
  statuses: StatusMap,
  username: string,
  titlesShown: boolean,
): ChatSessionRow[] {
  const built: Built[] = [];
  for (const p of projects) {
    if (p.archived || !p.workflows.some(w => w.type === 'agent')) continue;
    const kind = p.kind ?? 'normal';
    const workstreams = p.workstreams.filter(w => !w.archived);
    const list: Array<Partial<ChatSourceWorkstream> & { name: string }> = workstreams.length > 0 ? workstreams : [{ name: 'main' }];
    for (const ws of list) {
      // chatRows: conversations only. An automation's runs are; its main is not.
      if (!(kind === 'normal' || (kind === 'automation' && ws.name !== 'main'))) continue;
      built.push(rowFor(p, ws, statuses, username));
    }
  }
  // withoutAskPlaceholders, as the server sees it: no open tabs to keep, and
  // a main counts as used once its status shows a turn.
  const placeholders = askPlaceholderProjects(projects);
  const used = (r: Built) => r.status.value === 'working' || r.status.value === 'waiting' || Boolean(r.status.stoppedAt);
  return built
    .filter(r => !(r.workstream === 'main' && placeholders.has(r.projectId) && !used(r) && !r.sessionTitle?.trim()))
    .map(({ askTitle, ...r }) => ({ ...r, ...rowName({ ...r, askTitle }, titlesShown) }));
}

/**
 * An archived chat as the sidebar's Archived section lists it (routes/chats.ts
 * archivedChatsFor): one row per project, its main, under the project's name.
 */
export function archivedSessionRow(p: ChatSourceProject, statuses: StatusMap, username: string): ChatSessionRow {
  const { askTitle: _ask, ...row } = rowFor(p, p.workstreams.find(w => w.name === 'main') ?? { name: 'main' }, statuses, username);
  return { ...row, title: null, where: p.name, ask: false };
}
