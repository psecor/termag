/**
 * Web push when a simple-UI chat finishes its turn.
 *
 * The chat relay (services/chatRunner.ts) calls `pushOnChatTurn` after every
 * status write it makes. A chat that goes `working → idle` on a `result`
 * (Claude answered; a live turn, chat-live-v1, answers once per message and
 * may stay open on background work) or on a `turn-end` that came without one
 * pushes once to every person who can see the chat (its owner and the people
 * it is shared with, as `mayReceiveChat` lets the status socket) and opted
 * in (`User.chatTurnNotify`), with `chat-turn-notifications-enabled` and
 * `mobile-web-push-enabled` on for them. A turn someone stopped (a turn-end
 * with a signal) pushes nothing, and neither does a turn that only waits on
 * background work: that is no transition.
 *
 * The tab the person is looking at is the browser's call: the service worker
 * skips a push for a chat a focused window shows (public/sw.js).
 */
import { prisma } from '../db';
import type { AgentStatus } from '../types/index';
import { boolVariation } from './featureFlags';
import { webPushEnabledFor } from './pushFlag';
import { appBaseUrl, buildChatTurnPayload, defaultSendDeps, sendToUser, type SendDeps } from './webPush';

/** The same chat finishing again inside this window does not re-notify. */
export const CHAT_TURN_COOLDOWN_MS = 10_000;

/**
 * Pure: whether this status write ends a turn a person should hear about.
 * `event` is the chat event that caused it.
 */
export function isChatTurnEnd(prev: AgentStatus['status'] | undefined, next: AgentStatus['status'], event: unknown): boolean {
  if (prev !== 'working' || next !== 'idle') return false;
  const ev = (event && typeof event === 'object' ? event : {}) as { type?: unknown; signal?: unknown };
  if (ev.type === 'result') return true;
  return ev.type === 'turn-end' && !ev.signal;
}

/**
 * Pure: the notification's preview, the first line of a `result`'s answer, as
 * the open tab's `turnPreview` (frontend chat/turnNotify.ts) reads it; null
 * for a turn-end, so both paths say `Done · your turn` then.
 */
export function chatTurnPreview(event: unknown): string | null {
  const text = (event && typeof event === 'object' ? event : {}) as { type?: unknown; result?: unknown };
  if (text.type !== 'result' || typeof text.result !== 'string') return null;
  return text.result.split('\n').find(l => l.trim() !== '')?.replace(/\s+/g, ' ').trim() || null;
}

export function shouldPushChatTurn(
  prev: AgentStatus['status'] | undefined,
  next: AgentStatus['status'],
  event: unknown,
  lastPushedAt: number | null | undefined,
  now: number,
  cooldownMs: number = CHAT_TURN_COOLDOWN_MS,
): boolean {
  if (!isChatTurnEnd(prev, next, event)) return false;
  return lastPushedAt == null || now - lastPushedAt >= cooldownMs;
}

export interface ChatTurnPerson {
  id: string;
  googleEmail: string;
  displayName: string;
  unixUsername: string;
  defaultAgentProvider: string;
  chatTurnNotify: boolean;
}

/** Pure: the owner and the collaborators, each once, who opted in. */
export function chatTurnRecipients(owner: ChatTurnPerson, collaborators: readonly ChatTurnPerson[]): ChatTurnPerson[] {
  const seen = new Set<string>();
  const out: ChatTurnPerson[] = [];
  for (const p of [owner, ...collaborators]) {
    if (!p.chatTurnNotify || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export interface ChatTurnAudience {
  projectName: string;
  owner: ChatTurnPerson;
  collaborators: ChatTurnPerson[];
}

export interface ChatTurnDeps {
  send: SendDeps;
  loadAudience: (projectId: string) => Promise<ChatTurnAudience | null>;
  /** chat-turn-notifications-enabled and mobile-web-push-enabled, for this person. */
  allowed: (person: ChatTurnPerson) => Promise<boolean>;
}

const PERSON = { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true, chatTurnNotify: true } as const;

async function loadAudience(projectId: string): Promise<ChatTurnAudience | null> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, archived: true, user: { select: PERSON }, shares: { select: { user: { select: PERSON } } } },
  });
  if (!row || row.archived) return null;
  return { projectName: row.name, owner: row.user, collaborators: row.shares.map(s => s.user) };
}

async function allowed(person: ChatTurnPerson): Promise<boolean> {
  if (!await boolVariation('chat-turn-notifications-enabled', person, false)) return false;
  return webPushEnabledFor(person.id);
}

function defaultDeps(): ChatTurnDeps {
  return { send: defaultSendDeps(), loadAudience, allowed };
}

const lastPushedAt = new Map<string, number>();

/** Test seam. */
export function resetChatTurnPushState(): void {
  lastPushedAt.clear();
}

export interface ChatTurnTransition {
  projectId: string;
  workstream: string;
  /** The chat's agent session name. */
  session: string;
  prev: AgentStatus['status'] | undefined;
  next: AgentStatus['status'];
  event: unknown;
  now?: number;
}

/**
 * Call after every chat status write. Decides synchronously (so two frames
 * racing cannot both pass the cooldown), then resolves and sends in the
 * background. Returns whether a push was dispatched; never throws.
 */
export function pushOnChatTurn(t: ChatTurnTransition, deps?: ChatTurnDeps): boolean {
  const now = t.now ?? Date.now();
  const key = `${t.projectId}|${t.workstream}`;
  if (!shouldPushChatTurn(t.prev, t.next, t.event, lastPushedAt.get(key), now)) return false;
  const d = deps ?? defaultDeps();
  if (!d.send.vapid) return false;
  lastPushedAt.set(key, now);

  void (async () => {
    const audience = await d.loadAudience(t.projectId);
    if (!audience) return;
    const payload = buildChatTurnPayload({
      baseUrl: appBaseUrl(),
      projectId: t.projectId,
      projectName: audience.projectName,
      workstream: t.workstream,
      session: t.session,
      message: chatTurnPreview(t.event),
    });
    for (const person of chatTurnRecipients(audience.owner, audience.collaborators)) {
      if (!await d.allowed(person).catch(() => false)) continue;
      const summary = await sendToUser(person.id, payload, d.send);
      if (summary.sent || summary.failed) {
        console.log(`[PUSH] chat turn ${t.session} → ${person.unixUsername}: sent=${summary.sent} failed=${summary.failed} removed=${summary.removed}`);
      }
    }
  })().catch(err => {
    console.warn(`[PUSH] chat turn push for ${t.session} failed:`, err instanceof Error ? err.message : String(err));
  });
  return true;
}
