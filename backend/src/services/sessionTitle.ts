// A session's one title, the server's copy of frontend chat/sessionTitle.ts,
// for what the server names a
// session by: the push notifications' titles. Same order: a person's rename;
// an ask thread's own title; Claude's title; else the project's name for
// `main` and the workstream's name for any other session. An ask's chat skips
// Claude's title (#743): an untitled one is called by its `ask-<thread id>`.
import { prisma } from '../db';

export interface TitledSession {
  projectName: string;
  workstream: string;
  /** Workstream.sessionTitle, whoever set it. */
  sessionTitle?: string | null;
  /** Workstream.sessionTitleSource: `person` or `claude`; null from before it was kept, which was Claude's. */
  sessionTitleSource?: string | null;
  /** The ask thread's own title, for an ask's chat. */
  askTitle?: string | null;
  /** The ask thread's id, for an ask's chat. */
  askThreadId?: string | null;
}

export function sessionTitleOf(s: TitledSession): string {
  const own = s.sessionTitle?.trim() || null;
  if (own && s.sessionTitleSource === 'person') return own;
  const ask = s.askTitle?.trim() || null;
  if (ask) return ask;
  if (s.askThreadId) return s.workstream;
  if (own) return own;
  return s.workstream === 'main' ? s.projectName : s.workstream;
}

/**
 * The title of a project's workstream, read from its row. A row that can't be
 * read (gone, or the database is down) falls back on the names, so a push is
 * never lost for want of its title.
 */
export async function loadSessionTitle(projectId: string, projectName: string, workstream: string): Promise<string> {
  try {
    const ws = await prisma.workstream.findFirst({
      where: { projectId, name: workstream },
      select: { sessionTitle: true, sessionTitleSource: true, askThread: { select: { id: true, title: true } } },
    });
    return sessionTitleOf({
      projectName, workstream,
      sessionTitle: ws?.sessionTitle, sessionTitleSource: ws?.sessionTitleSource,
      askTitle: ws?.askThread?.title, askThreadId: ws?.askThread?.id,
    });
  } catch {
    return sessionTitleOf({ projectName, workstream });
  }
}
