// The words and links of the feedback list (AdminFeedback.tsx),
// pure so they are tested without rendering.
import { FEEDBACK_KINDS, FEEDBACK_STATUSES, type FeedbackFilters, type FeedbackItem } from '../../services/adminApi';

/** Where it came from, in a few words: "ana-box · termag (ask thread cmx…)", "a sign-in, no box". */
export function whereFrom(f: Pick<FeedbackItem, 'box' | 'project' | 'workstream' | 'threadId' | 'credential'>): string {
  const place = [f.box, f.project].filter(Boolean).join(' · ');
  const session = f.threadId ? `ask thread ${f.threadId}` : f.workstream && f.workstream !== 'main' ? f.workstream : null;
  if (place) return session ? `${place} (${session})` : place;
  return f.credential === 'box' ? 'a box' : 'a sign-in, no box';
}

/** "claude · claude-opus-5-5 · CLI 0.4.1", whatever is known. */
export function agentText(f: Pick<FeedbackItem, 'agentProvider' | 'agentModel' | 'cliVersion'>): string {
  return [f.agentProvider, f.agentModel, f.cliVersion ? `CLI ${f.cliVersion}` : null].filter(Boolean).join(' · ');
}

/** The list's filters from the URL, ignoring values the API would refuse. */
export function feedbackFiltersFromSearch(params: URLSearchParams): FeedbackFilters {
  const f: FeedbackFilters = {};
  const status = params.get('status');
  if (status && (FEEDBACK_STATUSES as readonly string[]).includes(status)) f.status = status;
  const kind = params.get('kind');
  if (kind && (FEEDBACK_KINDS as readonly string[]).includes(kind)) f.kind = kind;
  return f;
}

/** What the empty table says: nothing logged yet, or nothing matching. */
export function emptyText(filters: FeedbackFilters): string {
  return Object.keys(filters).length ? 'no feedback matches' : 'no feedback yet: agents log it with `termag feedback`';
}

/** The most the list route returns, newest first (MAX_LIST in backend/src/services/feedback.ts). */
export const FEEDBACK_LIST_MAX = 500;

/**
 * What the list says when the route stopped at FEEDBACK_LIST_MAX and older
 * feedback matched too (its `more`): it is not in the table or its search,
 * and how to reach it. Null when the whole list is shown.
 */
export function truncatedText(more: boolean | undefined, filters: FeedbackFilters): string | null {
  if (!more) return null;
  const reach = filters.status === 'new'
    ? 'mark these seen, or pick a kind, to bring older new feedback into the list'
    : filters.kind ? 'older feedback is not listed' : 'pick a status or a kind to reach older feedback';
  return `Showing the newest ${FEEDBACK_LIST_MAX} only: ${reach}.`;
}
