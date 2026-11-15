// The notice banner's content: the JSON flag
// notice-banner, read live in the browser. This file turns whatever the flag
// serves into a Notice or null, splits its light markup into text, bold and
// code, and keeps the ids this browser dismissed. NoticeBanner.tsx draws it.
//
// The value is typed by hand in the flag source, so
// nothing here trusts it: {}, null, a non-object or a value without an id or a
// message is no notice; a field that breaks its rule is dropped or clipped,
// never shown as something else; and the message is only ever text nodes.

export type NoticeTone = 'info' | 'warning' | 'outage';

export interface NoticeLink {
  label: string;
  url: string;
}

export interface Notice {
  id: string;
  tone: NoticeTone;
  title?: string;
  message: string;
  link?: NoticeLink;
  dismissible: boolean;
  /** When it hides itself, in ms since the epoch. */
  endsAt?: number;
}

export const NOTICE_LIMITS = { id: 64, title: 80, message: 400, linkLabel: 24 } as const;

const ID = /^[a-z0-9][a-z0-9-]*$/;
const TONES: readonly NoticeTone[] = ['info', 'warning', 'outage'];

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim().replace(/\s+/g, ' ');
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function link(value: unknown): NoticeLink | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { label, url } = value as { label?: unknown; url?: unknown };
  const l = text(label, NOTICE_LIMITS.linkLabel);
  if (!l || typeof url !== 'string') return undefined;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' ? { label: l, url: u.href } : undefined;
  } catch {
    return undefined;
  }
}

/** What the flag serves, as a notice to show, or null for none. */
export function parseNotice(value: unknown): Notice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id.trim() : '';
  if (!ID.test(id) || id.length > NOTICE_LIMITS.id) return null;
  const message = text(v.message, NOTICE_LIMITS.message);
  if (!message) return null;
  const notice: Notice = {
    id,
    tone: TONES.includes(v.tone as NoticeTone) ? (v.tone as NoticeTone) : 'info',
    message,
    // Anything but an explicit false can be closed: nobody is stuck with a typo.
    dismissible: v.dismissible !== false,
  };
  const title = text(v.title, NOTICE_LIMITS.title);
  if (title) notice.title = title;
  const l = link(v.link);
  if (l) notice.link = l;
  // An end time that doesn't parse is no end time: the notice still shows.
  if (typeof v.endsAt === 'string') {
    const at = Date.parse(v.endsAt);
    if (Number.isFinite(at)) notice.endsAt = at;
  }
  return notice;
}

/** Whether a notice is past its end time at `now`. */
export function noticeEnded(notice: Notice, now: number): boolean {
  return notice.endsAt !== undefined && now >= notice.endsAt;
}

/** LaunchPad Alert's status for a tone. */
export function alertStatus(tone: NoticeTone): 'info' | 'warning' | 'error' {
  return tone === 'outage' ? 'error' : tone;
}

export type NoticePart =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string };

/**
 * The message's light markup: `code`, and **bold** outside code. Nothing else
 * is markup, and an unmatched marker shows as typed. Bold can't hold code.
 */
export function noticeParts(message: string): NoticePart[] {
  const parts: NoticePart[] = [];
  const push = (kind: NoticePart['kind'], t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (kind === 'text' && last?.kind === 'text') last.text += t;
    else parts.push({ kind, text: t });
  };
  // An empty pair (two backticks, or four stars) is kept as typed, and the scan goes on past it.
  const bold = (s: string) => {
    let rest = s;
    for (;;) {
      const open = rest.indexOf('**');
      const close = open < 0 ? -1 : rest.indexOf('**', open + 2);
      if (close < 0) { push('text', rest); return; }
      push('text', rest.slice(0, open));
      if (close === open + 2) push('text', '****');
      else push('bold', rest.slice(open + 2, close));
      rest = rest.slice(close + 2);
    }
  };
  let rest = message;
  for (;;) {
    const open = rest.indexOf('`');
    const close = open < 0 ? -1 : rest.indexOf('`', open + 1);
    if (close < 0) { bold(rest); break; }
    bold(rest.slice(0, open));
    if (close === open + 1) push('text', '``');
    else push('code', rest.slice(open + 1, close));
    rest = rest.slice(close + 1);
  }
  return parts;
}

// ── Dismissal: per browser, by id ──────────────────────────────────────────
// A new id (any change to the text) shows again; only the last few ids are
// kept, so the list never grows.

export const NOTICE_DISMISSED_KEY = 'termag-notice-dismissed';
const KEEP = 20;

export function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(NOTICE_DISMISSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeDismissed(id: string): string[] {
  const next = [...readDismissed().filter(x => x !== id), id].slice(-KEEP);
  try { localStorage.setItem(NOTICE_DISMISSED_KEY, JSON.stringify(next)); } catch { /* private mode: dismissed for this page only */ }
  return next;
}
