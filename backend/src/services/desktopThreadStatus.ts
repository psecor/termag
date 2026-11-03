/**
 * Which chat a desktop thread's status belongs to. The box's hook files a
 * desktop app thread's turns under the project whose `-agent` tmux session
 * holds its checkout (deploy/termag-status t3_session). A chat-runner chat has
 * no such session until something opens its pane, so its desktop thread's
 * turns land on the t3 server's own `termag-t3`, and termag web shows the chat
 * at rest while the desktop works on it. The post carries the turn's Claude
 * session id as `threadId`, and a chat the desktop holds names that session
 * (services/chatHolder.ts): Workstream.chatSessionId, or an imported thread's
 * id, `import:<instance>:<session>`. Only the posting box's own chats are
 * looked up, so a box can file status only to chats that live on it.
 */
import { prisma } from '../db';
import { sessionName } from './tmux';

// Hook posts come several a turn (PreToolUse, PostToolUse): one lookup a minute per thread.
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, { session: string | null; at: number }>();

/** The chat's status session (`<owner>-<project>[-<ws>]-agent`) for a desktop thread's Claude session on this box, or null. */
export async function chatStatusSessionFor(instanceId: string, claudeSession: string, now = Date.now()): Promise<string | null> {
  const key = `${instanceId}\u0000${claudeSession}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.session;
  const ws = await prisma.workstream.findFirst({
    where: {
      archived: false,
      project: { instanceId, archived: false },
      OR: [{ chatSessionId: claudeSession }, { t3ThreadId: { endsWith: `:${claudeSession}` } }],
    },
    select: { name: true, project: { select: { name: true, user: { select: { unixUsername: true } } } } },
    orderBy: { chatHolderAt: 'desc' },
  });
  const session = ws ? sessionName(ws.project.user.unixUsername, ws.project.name, 'agent', ws.name) : null;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { session, at: now });
  return session;
}

export function resetDesktopThreadStatusForTests(): void {
  cache.clear();
}
