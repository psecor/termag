// Generative UI's answers (Actions): a
// press or a form submit on a surface goes back to the agent as an ordinary
// user message, so it reaches an idle chat (a new turn) and a live turn
// alike, and the transcript keeps it. The message is a line a person reads
// and, under it, a ```ui-action fence the agent parses, after A2UI's action
// event: { action, surfaceId, sourceComponentId, context }.
//
// The same message, found later in the transcript, is what marks a surface
// sent (sentSurfaces), live and on replay alike.
import type { Spec } from '@json-render/core';
import { parseMarkdown, type MdBlock } from '../markdownParse';

/** The catalog's actions (catalog.ts): the only ones that send anything. */
export const GEN_UI_ACTIONS = ['submit', 'choose', 'approve', 'requestChanges', 'cancel'] as const;
export type GenUiAction = (typeof GEN_UI_ACTIONS)[number];
export const isGenUiAction = (v: unknown): v is GenUiAction => typeof v === 'string' && (GEN_UI_ACTIONS as readonly string[]).includes(v);

export const ACTION_FENCE = 'ui-action';
/** The most a surface's state may weigh as JSON; more is refused, not cut. */
export const CONTEXT_MAX_CHARS = 8 * 1024;
const TEXT_MAX = 2000;
const LABEL_MAX = 200;

export interface ActionPayload {
  action: GenUiAction;
  /** The spec fence it came from (surfaceIdOf its text). */
  surfaceId: string;
  /** The element pressed or submitted: its key in the spec. */
  sourceComponentId: string;
  /** The pressed button's label, when it had one. */
  label?: string;
  /** choose: the option's value. */
  value?: string;
  /** approve / requestChanges: the person's comment. */
  comment?: string;
  /** The surface's state when it was sent: what the person entered or left as it was. */
  context: Record<string, unknown>;
  /** A Table row action: the row it was pressed on (its key, its first column as a title, its values). */
  row?: { key: string; title?: string; values: Record<string, unknown> };
}

/** A spec fence's id: a hash of its text, the same live and on replay. */
export function surfaceIdOf(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `ui-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.replace(/\s+$/, '').slice(0, max) : undefined;

/**
 * The surface's state as plain JSON, or null when it is too big to send. State
 * is what the person entered (untrusted, and said so to the agent), so only
 * what JSON keeps goes, and nothing is cut silently.
 */
export function contextOf(state: unknown): Record<string, unknown> | null {
  let json: string;
  try { json = JSON.stringify(state ?? {}); } catch { return null; }
  if (json.length > CONTEXT_MAX_CHARS) return null;
  const copy = JSON.parse(json) as unknown;
  return copy && typeof copy === 'object' && !Array.isArray(copy) ? copy as Record<string, unknown> : {};
}

const segments = (pointer: string) => pointer.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
function getAt(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
function setAt(root: Record<string, unknown>, path: string[], value: unknown) {
  let cur: Record<string, unknown> = root;
  path.forEach((seg, i) => {
    if (i === path.length - 1) { cur[seg] = value; return; }
    const nextIsIndex = /^\d+$/.test(path[i + 1]);
    if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = nextIsIndex ? [] : {};
    cur = cur[seg] as Record<string, unknown>;
  });
}
function bindingsIn(value: unknown, out: { state: string[]; item: string[] }) {
  if (!value || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  if (typeof o.$bindState === 'string') out.state.push(o.$bindState);
  if (typeof o.$bindItem === 'string') out.item.push(o.$bindItem);
  for (const v of Object.values(o)) bindingsIn(v, out);
}

/**
 * What an answer carries of the surface's state: only the values bound to
 * its inputs ($bindState, and $bindItem with each repeated item's key), the
 * things the person could see and change. State the spec holds but binds to
 * no input never goes: text the agent seeded there would otherwise reach it
 * as the person's message under an innocent-looking button.
 */
export function boundContext(spec: Spec, state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (path: string[]) => { const v = getAt(state, path); if (v !== undefined) setAt(out, path, v); };
  const walk = (key: string, list: { path: string[]; key?: string } | null, seen: Set<string>) => {
    if (seen.has(key)) return;
    seen.add(key);
    const el = spec.elements[key];
    if (!el) return;
    const found = { state: [] as string[], item: [] as string[] };
    bindingsIn(el.props, found);
    for (const p of found.state) copy(segments(p));
    const repeat = (el as { repeat?: { statePath?: unknown; key?: unknown } }).repeat;
    const inner = typeof repeat?.statePath === 'string' ? { path: segments(repeat.statePath), key: typeof repeat.key === 'string' ? repeat.key : undefined } : list;
    if (list && found.item.length) {
      const items = getAt(state, list.path);
      if (Array.isArray(items)) items.forEach((_, i) => {
        for (const field of [...(list.key ? [list.key] : []), ...found.item]) copy([...list.path, String(i), ...field.split('/')]);
      });
    }
    for (const child of [...(el.children ?? []), ...Object.values(el.slots ?? {}).flat()]) walk(child, inner, seen);
  };
  walk(spec.root, null, new Set());
  return out;
}

/** Builds a payload from an action's resolved params; null for an action outside the catalog. */
export function payloadOf(
  action: unknown, params: Record<string, unknown>,
  at: { surfaceId: string; source: string; label?: string; row?: { key: string; title?: string; values: Record<string, unknown> } },
  context: Record<string, unknown>,
): ActionPayload | null {
  if (!isGenUiAction(action)) return null;
  const p: ActionPayload = { action, surfaceId: at.surfaceId, sourceComponentId: at.source, context };
  if (at.row) {
    const values = contextOf(at.row.values);
    if (!values) return null;
    p.row = { key: at.row.key.slice(0, LABEL_MAX), ...(clip(at.row.title, LABEL_MAX) ? { title: clip(at.row.title, LABEL_MAX) } : {}), values };
  }
  const label = clip(at.label, LABEL_MAX);
  if (label) p.label = label;
  if (action === 'choose') {
    const value = typeof params.value === 'number' || typeof params.value === 'boolean' ? String(params.value) : clip(params.value, LABEL_MAX);
    if (!value) return null;
    p.value = value;
    const chosen = clip(params.label, LABEL_MAX);
    if (chosen) p.label = chosen;
  }
  // A decline says only that: none of the surface's values go with it.
  if (action === 'cancel') p.context = {};
  if (action === 'approve' || action === 'requestChanges') {
    const comment = clip(params.comment, TEXT_MAX);
    if (comment) p.comment = comment;
  }
  return p;
}

/**
 * Text that goes into the one-line summary: one line, with no fence markers.
 * Labels, titles, comments and values can be the agent's or the person's
 * text, and the summary sits ahead of the answer's JSON in the message, so a
 * newline or a ``` in them must not add lines, or a second fence, to it.
 */
function oneLine(s: string): string {
  return s.replace(/(`{3,}|~{3,})/g, '').replace(/\s+/g, ' ').trim();
}

function shown(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') { const t = oneLine(v); return !t ? null : t.length > 60 ? `${t.slice(0, 59)}…` : t; }
  if (Array.isArray(v)) {
    if (!v.length) return null;
    // A list of records (rows, review items) is too much for one line: say how many.
    if (v.some(x => x && typeof x === 'object')) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
    return v.map(x => shown(x) ?? '').filter(Boolean).join(', ') || null;
  }
  return null;
}

/** Every value in the context, nested ones under a dotted name (`form.env`), as label and value. */
function flatValues(value: Record<string, unknown>, prefix = ''): Array<readonly [string, unknown]> {
  return Object.entries(value).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v)
    ? flatValues(v as Record<string, unknown>, `${prefix}${k}.`)
    : [[`${prefix}${k}`, v] as const]));
}

/** The surface's values as a short line: `environment: staging · form.email: a@b.c`. */
function valuesLine(context: Record<string, unknown>): string {
  const pairs = flatValues(context).map(([k, v]) => [oneLine(k), shown(v)] as const).filter(([, v]) => v !== null);
  const line = pairs.slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(' · ');
  return pairs.length > 8 ? `${line} · …` : line;
}

/** What a person reads in the bubble: one line, no markup. */
export function actionSummary(p: ActionPayload): string {
  const quoted = (raw: string) => { const s = oneLine(raw); return `“${s.length > 120 ? `${s.slice(0, 119)}…` : s}”`; };
  const label = p.label ? oneLine(p.label) : undefined;
  const onRow = p.row ? ` for ${quoted(p.row.title ?? p.row.key)}` : '';
  switch (p.action) {
    case 'choose': return `Chose ${quoted(p.label ?? p.value ?? '')}${onRow}`;
    case 'approve': return (p.comment ? `Approved: ${quoted(p.comment)}` : 'Approved') + onRow;
    case 'requestChanges': return (p.comment ? `Requested changes: ${quoted(p.comment)}` : 'Requested changes') + onRow;
    case 'cancel': return (label ? `Declined (${label})` : 'Declined') + onRow;
    case 'submit': {
      const values = valuesLine(p.context);
      const head = (label || 'Submitted') + onRow;
      return values ? `${head}: ${values}` : head;
    }
  }
}

/** The user message an action sends. */
export function formatActionMessage(p: ActionPayload): string {
  return `${actionSummary(p)}\n\n\`\`\`${ACTION_FENCE}\n${JSON.stringify(p)}\n\`\`\``;
}

const MESSAGE = new RegExp(`^([\\s\\S]*?)\\n*\`\`\`${ACTION_FENCE}\\n(\\{[^\\n]*\\})\\n\`\`\`\\s*$`);

/** An action message back as its payload; null for any other message. */
export function parseActionMessage(text: string): ActionPayload | null {
  const m = MESSAGE.exec(text);
  if (!m) return null;
  let p: unknown;
  try { p = JSON.parse(m[2]); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (!isGenUiAction(o.action) || typeof o.surfaceId !== 'string' || typeof o.sourceComponentId !== 'string') return null;
  if (!o.context || typeof o.context !== 'object' || Array.isArray(o.context)) return null;
  return o as unknown as ActionPayload;
}

function specFences(blocks: MdBlock[], out: string[]): string[] {
  for (const b of blocks) {
    // An unclosed fence too: a finished reply draws it, and it can be answered.
    if (b.type === 'code' && b.lang === 'spec') out.push(b.text);
    else if (b.type === 'quote' || b.type === 'details') specFences(b.blocks, out);
    else if (b.type === 'ul' || b.type === 'ol') for (const it of b.items) specFences(it.blocks, out);
  }
  return out;
}
const fenceCache = new Map<string, string[]>();
/** The ids of the spec fences in a finished reply's text. */
export function surfaceIdsIn(text: string): string[] {
  // A cheap test first; the parser takes `~~~ spec` and ``` ```spec ``` alike (any fence, then spaces, then spec).
  if (!/(`{3,}|~{3,})[ \t]*spec/.test(text)) return [];
  let ids = fenceCache.get(text);
  if (!ids) {
    ids = specFences(parseMarkdown(text), []).map(surfaceIdOf);
    if (fenceCache.size > 500) fenceCache.clear();
    fenceCache.set(text, ids);
  }
  return ids;
}

/** `${reply item key}|${surfaceId}`: where a surface is drawn. */
export const surfaceKey = (itemKey: string, surfaceId: string) => `${itemKey}|${surfaceId}`;

/**
 * The surfaces already answered, by surfaceKey: each action message belongs to
 * the latest reply before it that drew a surface with its id, so the same spec
 * sent twice locks only the copy that was answered.
 */
export function sentSurfaces(items: ReadonlyArray<{ kind: string; key: string; text?: string }>): Map<string, ActionPayload> {
  const latest = new Map<string, string>();
  const sent = new Map<string, ActionPayload>();
  for (const it of items) {
    if (it.kind === 'text' && it.text) {
      for (const id of surfaceIdsIn(it.text)) latest.set(id, it.key);
    } else if (it.kind === 'user' && it.text) {
      const p = parseActionMessage(it.text);
      const at = p && latest.get(p.surfaceId);
      if (p && at && !sent.has(surfaceKey(at, p.surfaceId))) sent.set(surfaceKey(at, p.surfaceId), p);
    }
  }
  return sent;
}
