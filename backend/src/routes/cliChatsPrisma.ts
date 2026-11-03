/**
 * routes/cliChats.ts over the database: the project list GET /api/projects
 * answers, the statuses the status socket would send, and the history
 * GET /api/projects/:id/chat reads, for the person a device sign-in names.
 */
import type { Request } from 'express';
import { prisma } from '../db';
import { askCwd } from '../services/agentMessages';
import { SESSION_TITLES_FLAG, renameSessionFor } from '../services/chatRunner';
import { archivedSessionRow, chatSessionRows, type ChatSessionRow, type ChatSourceProject } from '../services/chatSessionRows';
import { VIEW_MAX_ENTRIES } from '../services/chatTranscriptStore';
import { desktopAppEnabled } from '../services/desktopAppFlag';
import { boolVariation } from '../services/featureFlags';
import { projectDirUnder, resolveProjectRoot } from '../services/projectPaths';
import { getAllStatuses } from '../services/status';
import { chatHistoryFor, claimChatFor } from './chat';
import { desktopChatAsksFor } from './chatAsks';
import { archiveChatFor, archivedChatsFor, reopenChatFor } from './chats';
import type { CliChatRow, CliChats } from './cliChats';
import { fullUser } from './cliLifecyclePrisma';
import { listProjectsFor } from './projects';
import { parentsFor } from './spawns';

type SpawnLinks = ReadonlyMap<string, { projectId: string; workstream: string }>;

async function spawnParents(user: Express.User): Promise<SpawnLinks> {
  const out = await parentsFor(user);
  const links = out.status === 200 ? (out.body as { links: Array<{ projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }> }).links : [];
  return new Map(links.map(l => [`${l.projectId}|${l.workstream}`, { projectId: l.parentProjectId, workstream: l.parentWorkstream }]));
}

/** The rows' own-box facts and stored session ids, in two reads. */
async function enrich(userId: string, unixUsername: string, rows: ChatSessionRow[], extra: { archivedAt?: ReadonlyMap<string, string>; spawned?: SpawnLinks }): Promise<CliChatRow[]> {
  const { archivedAt, spawned } = extra;
  const ownBoxIds = [...new Set(rows.flatMap(r => (!r.shared && r.boxId ? [r.boxId] : [])))];
  const wsIds = rows.flatMap(r => (r.workstreamId ? [r.workstreamId] : []));
  const [boxes, transcripts] = await Promise.all([
    ownBoxIds.length === 0 ? [] : prisma.instance.findMany({
      where: { id: { in: ownBoxIds }, userId },
      select: { id: true, name: true, status: true, hostHome: true },
    }),
    wsIds.length === 0 ? [] : prisma.chatTranscript.findMany({
      where: { workstreamId: { in: wsIds }, current: true },
      select: { workstreamId: true, sessionId: true, createdAt: true },
      orderBy: { updatedAt: 'asc' },
    }),
  ]);
  const boxById = new Map(boxes.map(b => [b.id, b]));
  // The newest current one wins should a chat have two.
  const sessionOf = new Map(transcripts.map(t => [t.workstreamId, t.sessionId]));
  const sessionStartOf = new Map(transcripts.map(t => [t.workstreamId, t.createdAt.toISOString()]));
  return rows.map(({ checkout, ...r }) => {
    const box = !r.shared && r.boxId ? boxById.get(r.boxId) : undefined;
    const root = box ? resolveProjectRoot({ ownerUnixUser: unixUsername, hostHome: box.hostHome }) : null;
    return {
      ...r,
      archived: archivedAt !== undefined,
      archivedAt: archivedAt?.get(r.projectId) ?? null,
      directory: root ? askCwd(projectDirUnder(root, r.projectName, checkout.workstream), checkout.repo) : null,
      // The stored transcript's current session follows every turn; the workstream's, the box's last word on a hand-over.
      sessionId: (r.workstreamId && sessionOf.get(r.workstreamId)) || r.sessionId,
      // When its session began as termag stored it (its first turn's end), else the workstream's start.
      createdAt: (r.workstreamId && sessionStartOf.get(r.workstreamId)) || r.createdAt,
      box: box ? { id: box.id, name: box.name, status: box.status } : null,
      spawnParent: spawned?.get(r.key) ?? null,
    };
  });
}

async function archivedRows(user: Express.User): Promise<CliChatRow[]> {
  const listed = await archivedChatsFor(user);
  if (listed.status !== 200) return [];
  const chats = listed.body as Array<{ id: string; archivedAt: Date | string }>;
  const projects = chats.length === 0 ? [] : await prisma.project.findMany({
    where: { id: { in: chats.map(c => c.id) }, userId: user.id },
    include: {
      workflows: true,
      workstreams: { where: { name: 'main' }, include: { _count: { select: { chatTranscripts: true } } } },
    },
  });
  const byId = new Map(projects.map(p => [p.id, p]));
  const statuses = getAllStatuses();
  const rows = chats.flatMap(c => {
    const p = byId.get(c.id);
    if (!p) return [];
    const source: ChatSourceProject = {
      ...p,
      workstreams: p.workstreams.map(({ _count, ...w }) => ({ ...w, hasTranscript: _count.chatTranscripts > 0 })),
    };
    return [archivedSessionRow(source, statuses, user.unixUsername)];
  });
  const at = new Map(chats.map(c => [c.id, typeof c.archivedAt === 'string' ? c.archivedAt : c.archivedAt.toISOString()]));
  return enrich(user.id, user.unixUsername, rows, { archivedAt: at });
}

export function createPrismaCliChats(): CliChats {
  return {
    async enabled(user) {
      const owner = await prisma.user.findUnique({ where: { id: user.id } });
      return !!owner && await desktopAppEnabled(owner);
    },
    async list(user, { archived }) {
      const viewer = await fullUser(user);
      if (archived === true) return archivedRows(viewer);
      const [projects, titlesShown, spawned] = await Promise.all([
        listProjectsFor(viewer.id),
        boolVariation(SESSION_TITLES_FLAG, viewer, false),
        spawnParents(viewer),
      ]);
      // Keys built from the viewer's own and shared projects only, so no
      // other session's status is read: what the status socket sends them.
      const rows = chatSessionRows(projects, getAllStatuses(), viewer.unixUsername, titlesShown);
      const live = await enrich(viewer.id, viewer.unixUsername, rows, { spawned });
      // `all`: the desktop mirrors an archive done in web from the one read.
      return archived === 'all' ? [...live, ...await archivedRows(viewer)] : live;
    },
    async archive(user, projectId, body) {
      const { workstream, archived } = (body && typeof body === 'object' ? body : {}) as { workstream?: unknown; archived?: unknown };
      if (typeof archived !== 'boolean') return { status: 400, body: { error: 'archived must be true or false', code: 'invalid_request' } };
      // A chat is a project: its main session archives with it. A workstream's chat is archived in termag web.
      if (workstream !== undefined && workstream !== 'main') return { status: 409, body: { error: "Archive a workstream's chat in termag web", code: 'workstream-chat' } };
      const viewer = await fullUser(user);
      return archived ? archiveChatFor(viewer, projectId, { powerBox: false }) : reopenChatFor(viewer, projectId, { startBox: false });
    },
    async title(user, projectId, body) {
      const { workstream, title } = (body && typeof body === 'object' ? body : {}) as { workstream?: unknown; title?: unknown };
      const name = typeof workstream === 'string' && workstream ? workstream : 'main';
      // Only the owner renames: a collaborator reads the chat.
      const ws = await prisma.workstream.findFirst({ where: { name, project: { id: projectId, userId: user.id } }, select: { id: true } });
      if (!ws) return { status: 404, body: { error: 'Chat not found' } };
      const renamed = await renameSessionFor(projectId, ws.id, title);
      if (!renamed) return { status: 400, body: { error: 'title is required', code: 'invalid_request' } };
      return { status: 200, body: { ...renamed, titleSource: 'person' } };
    },
    async history(user, projectId, workstream) {
      const viewer = await fullUser(user);
      const out = await chatHistoryFor(viewer.id, projectId, { workstream } as Request['query'], viewer);
      // The box and the store both keep the newest entries only (agent/chat-runner.js HISTORY_MAX_ENTRIES).
      if (out.status !== 200) return out;
      return { status: 200, body: { ...(out.body as object), entriesMax: VIEW_MAX_ENTRIES } };
    },
    claim: (user, projectId, body) => claimChatFor(user.id, projectId, body),
    async asks(user, query) {
      const viewer = await fullUser(user);
      return desktopChatAsksFor(viewer.id, query, viewer);
    },
  };
}
