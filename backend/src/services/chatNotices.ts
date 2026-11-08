/**
 * Lines in a chat's timeline that are neither the person's nor the agent's
 * (`chat_notices`): today a tool update's restart notice, so someone who reads
 * the session in the simple UI, not its terminal, sees why it restarted.
 *
 * The text is never made here: it is the notice the pane printed, built by
 * services/toolUpdate/notice.ts (an agent pane the orchestrator relaunched) or
 * by the box's tu_notice (a pane the box resumed, reported as data). Either
 * way it is checked again here, as notice.ts checks its own, before it is
 * stored: a line that does not pass is dropped, never stored or shown. It is
 * read by everyone who can read the chat (GET /api/projects/:id/chat/notices)
 * and never sent to the agent.
 */
import { prisma } from '../db';
import { CHAT_NOTICE_PANES, chatNoticeText, type ChatNoticeEntry } from './toolUpdate/notice';

export { chatNoticeText };

/** How many notices a workstream keeps: the newest, the rest pruned on write. */
export const CHAT_NOTICE_KEEP = 20;

export interface ChatNoticeView { id: string; kind: string; pane: string; text: string; at: string }

/**
 * Store each entry on its workstream (by project and name), checked again,
 * then prune the workstream to its newest CHAT_NOTICE_KEEP. One entry per
 * (workstream, pane, text) per call. Returns how many were stored.
 */
export async function recordChatNotices(entries: ChatNoticeEntry[], runId: string | null, at: Date = new Date()): Promise<number> {
  const seen = new Set<string>();
  let stored = 0;
  for (const e of entries) {
    const text = chatNoticeText(e.text);
    if (!text || !(CHAT_NOTICE_PANES as readonly string[]).includes(e.pane)) continue;
    const key = `${e.projectId}\0${e.workstream}\0${e.pane}\0${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ws = await prisma.workstream.findUnique({ where: { projectId_name: { projectId: e.projectId, name: e.workstream } }, select: { id: true } });
    if (!ws) continue;
    await prisma.chatNotice.create({ data: { workstreamId: ws.id, kind: 'tool-update', pane: e.pane, text, runId, at } });
    stored++;
    const old = await prisma.chatNotice.findMany({ where: { workstreamId: ws.id }, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: CHAT_NOTICE_KEEP, select: { id: true } });
    if (old.length) await prisma.chatNotice.deleteMany({ where: { id: { in: old.map(o => o.id) } } });
  }
  return stored;
}

/** A workstream's notices, oldest first, each checked again on the way out. */
export async function listChatNotices(workstreamId: string): Promise<ChatNoticeView[]> {
  const rows = await prisma.chatNotice.findMany({ where: { workstreamId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: CHAT_NOTICE_KEEP });
  return rows
    .filter(r => chatNoticeText(r.text) !== null)
    .reverse()
    .map(r => ({ id: r.id, kind: r.kind, pane: r.pane, text: r.text, at: r.at.toISOString() }));
}
