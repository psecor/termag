// The way between the phone client (/m) and the simple UI (/chat), both
// directions. Pure, so the hrefs are unit-testable.
import { chatHref, isSdkChat } from '../chat/simpleChat';
import type { Project } from '../types';
import { installedAppMode, MOBILE_MEDIA_QUERY, TOUCH_MEDIA_QUERY } from './redirect';

/** The tab bar's Chat tab: the simple UI's home. */
export const CHAT_HOME_HREF = '/chat';

/**
 * Whether a session has a conversation in the simple UI, so "Open in Chat"
 * goes somewhere: the rows chatRows lists. An automation's `main` has none
 * (each run is its own workstream); MetaTerm and cloud
 * sessions are not conversations the simple UI drives.
 */
export function opensInChat(row: { kind?: string | null; workstream: string }): boolean {
  const kind = row.kind ?? 'normal';
  return kind === 'normal' || (kind === 'automation' && row.workstream !== 'main');
}

/**
 * Whether the phone client treats a session as a chat: one the simple UI
 * lists (opensInChat) whose agent is a chat runner, so it has no agent pane.
 * isSdkChat alone is not enough: chatProvider falls back to another
 * workstream's agent, so an automation's `main` would read as a chat.
 */
export function showsAsChat(
  project: Pick<Project, 'kind' | 'workflows' | 'workstreams'>,
  workstream: string,
): boolean {
  return opensInChat({ kind: project.kind, workstream }) && isSdkChat(project, workstream);
}

/** "Open in Chat" for one session: its conversation under /chat (the SDK chat, or the pane chat). */
export function openInChatHref(row: { projectId: string; workstream: string }): string {
  return chatHref(row.projectId, row.workstream);
}

/**
 * "Phone view" from the simple UI: the open conversation in the phone
 * client, else its home. Always the agent tab; the review tab is a phone-only
 * idea the simple UI has no state for.
 */
export function phoneViewHref(projectId: string | null | undefined, workstream = 'main'): string {
  if (!projectId) return '/m';
  const base = `/m/p/${encodeURIComponent(projectId)}`;
  return workstream === 'main' ? base : `${base}?ws=${encodeURIComponent(workstream)}`;
}

type MediaList = { matches: boolean; addEventListener?: (type: 'change', cb: () => void) => void; removeEventListener?: (type: 'change', cb: () => void) => void };
type MatchMediaFn = (query: string) => MediaList;

/** The media queries offersPhoneView reads, so a rotation or install re-reads it. */
export const PHONE_VIEW_QUERIES = [MOBILE_MEDIA_QUERY, TOUCH_MEDIA_QUERY, '(display-mode: standalone)', '(display-mode: fullscreen)'];

/** Calls onChange whenever any of offersPhoneView's media queries changes; returns the unsubscribe. */
export function subscribePhoneView(env: { matchMedia?: MatchMediaFn } | undefined, onChange: () => void): () => void {
  const lists: MediaList[] = [];
  if (env?.matchMedia) {
    for (const q of PHONE_VIEW_QUERIES) {
      try {
        const mq = env.matchMedia(q);
        mq.addEventListener?.('change', onChange);
        lists.push(mq);
      } catch { /* no media queries: nothing changes */ }
    }
  }
  return () => { for (const mq of lists) mq.removeEventListener?.('change', onChange); };
}

/**
 * Whether the simple UI offers "Phone view": where the workspace would send
 * this browser to /m (a phone-sized touch viewport, or the app installed on a
 * touch device), whether or not it pressed Lab. A narrow desktop window is
 * not a phone.
 */
export function offersPhoneView(env: { matchMedia?: MatchMediaFn; navigator?: object } | undefined): boolean {
  if (!env?.matchMedia) return false;
  try { return env.matchMedia(MOBILE_MEDIA_QUERY).matches || installedAppMode(env); } catch { return false; }
}
