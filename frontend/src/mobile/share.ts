// The Android share target: another app shares a link
// or some text into termag (manifest `share_target`, GET /termag/m/share).
// A GitHub pull request link can start a review; anything else is offered as
// a draft for a session's composer. Pure so it can be tested.
import { GITHUB_PR_URL } from '../utils/review';

export interface SharedInput {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

export interface Shared {
  /** What a composer would be prefilled with: the text, then the link if it is not already in it. */
  draft: string;
  /** A GitHub PR found in the share, normalized to `https://github.com/o/r/pull/N`. */
  pr: { number: number; url: string } | null;
}

const MAX_DRAFT = 4000; // the send-keys route's limit
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

/** `…/pull/12/files#diff`, `…/pull/12?w=1` → `…/pull/12`; anything else → null. */
export function normalizePrUrl(raw: string): { number: number; url: string } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
  const m = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,7})(?:\/.*)?$/.exec(u.pathname);
  if (!m) return null;
  const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
  if (!GITHUB_PR_URL.test(url)) return null;
  const number = Number(m[3]);
  return number >= 1 ? { number, url } : null;
}

export function parseShared(input: SharedInput): Shared {
  const text = (input.text ?? '').trim();
  const url = (input.url ?? '').trim();
  const title = (input.title ?? '').trim();
  // Android apps disagree on where the link goes: `url`, or inside `text`.
  const candidates = [url, ...(text.match(URL_IN_TEXT) ?? [])].filter(Boolean);
  let pr: Shared['pr'] = null;
  for (const c of candidates) { pr = normalizePrUrl(c); if (pr) break; }
  const parts: string[] = [];
  if (text) parts.push(text);
  else if (title && title !== url) parts.push(title);
  if (url && !text.includes(url)) parts.push(url);
  const draft = parts.join(' ').replace(/\s*(?:\r\n?|\n)\s*/g, ' ').trim().slice(0, MAX_DRAFT);
  return { draft, pr };
}

/** The conversation link that carries the share: a draft, or a PR for the Review sheet. */
export function sharedConversationHref(
  row: { projectId: string; workstream: string },
  share: { draft?: string; reviewUrl?: string },
): string {
  const q = new URLSearchParams();
  if (row.workstream !== 'main') q.set('ws', row.workstream);
  if (share.reviewUrl) q.set('review', share.reviewUrl);
  else if (share.draft) q.set('draft', share.draft);
  const qs = q.toString();
  return `/m/p/${encodeURIComponent(row.projectId)}${qs ? `?${qs}` : ''}`;
}
