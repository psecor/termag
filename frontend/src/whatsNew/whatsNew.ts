/// <reference types="vite/client" />
// What's new: the entries behind the What's new dialog in
// termag and lab, one Markdown file each in ./entries, named by the entry's id.
// They are bundled at build time, so an entry goes live with the deploy that
// ships its change. whatsNew.test.ts fails on any entry that doesn't parse or
// breaks a copy rule; here an entry that doesn't parse is left out.
import { FLAGS, type FlagKey } from '../flags';

export const SURFACES = ['termag', 'lab'] as const;
export type Surface = (typeof SURFACES)[number];

/** In the order a week's entries are listed. */
export const CATEGORIES = ['new', 'changed', 'fixed', 'removed'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface WhatsNewEntry {
  /** The file name without `.md`. Seen state is keyed by it, so it never changes. */
  id: string;
  title: string;
  surface: Surface;
  category: Category;
  /** YYYY-MM-DD: the day it went live. */
  date: string;
  /**
   * Every flag the change needs (the file's `flag` line, comma-separated):
   * only people with all of them on see the entry. Empty for a change no
   * flag gates.
   */
  flags: FlagKey[];
  /** One or two sentences of Markdown. */
  body: string;
}

export type ParsedEntry =
  | { ok: true; entry: WhatsNewEntry }
  | { ok: false; id: string; problems: string[] };

export const TITLE_MAX = 60;
export const BODY_MAX = 280;

const FIELDS = ['title', 'surface', 'category', 'date', 'flag'] as const;
type Field = (typeof FIELDS)[number];
const REQUIRED: Field[] = ['title', 'surface', 'category', 'date'];
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FLAG_KEYS = new Set<string>(Object.values(FLAGS));

const isField = (k: string): k is Field => (FIELDS as readonly string[]).includes(k);
const isSurface = (v: string): v is Surface => (SURFACES as readonly string[]).includes(v);
const isCategory = (v: string): v is Category => (CATEGORIES as readonly string[]).includes(v);

/** A real calendar day written YYYY-MM-DD. */
export function isIsoDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function unquote(v: string): string {
  const q = v[0];
  return v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q) ? v.slice(1, -1) : v;
}

/**
 * One entry file: `---`, a `key: value` line per field, `---`, then the body.
 * Not YAML: one line per field, no nesting, no comments, so a title can hold
 * a colon or a #.
 */
export function parseEntry(id: string, raw: string): ParsedEntry {
  const problems: string[] = [];
  if (!ID.test(id)) problems.push(`the file name must be lowercase words joined by hyphens, not "${id}"`);
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(raw.replace(/\r\n/g, '\n'));
  if (!m) return { ok: false, id, problems: [...problems, 'it must start with a --- block of fields, closed by ---'] };

  const fields: Partial<Record<Field, string>> = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    const key = at < 0 ? line.trim() : line.slice(0, at).trim();
    if (at < 0 || !isField(key)) { problems.push(`unknown line "${line.trim()}" (fields: ${FIELDS.join(', ')})`); continue; }
    if (key in fields) { problems.push(`${key} is given twice`); continue; }
    fields[key] = unquote(line.slice(at + 1).trim());
  }
  for (const key of REQUIRED) if (!fields[key]) problems.push(`${key} is missing`);

  const { title = '', surface = '', category = '', date = '' } = fields;
  const flags = fields.flag === undefined ? [] : fields.flag.split(',').map(f => f.trim());
  if (surface && !isSurface(surface)) problems.push(`surface must be one of ${SURFACES.join(', ')}, not "${surface}"`);
  if (category && !isCategory(category)) problems.push(`category must be one of ${CATEGORIES.join(', ')}, not "${category}"`);
  if (date && !isIsoDay(date)) problems.push(`date must be a real day written YYYY-MM-DD, not "${date}"`);
  // On/off flags the browser reads: what the dialog can evaluate (frontend/src/flags.ts).
  for (const flag of flags) {
    if (!FLAG_KEYS.has(flag) || !flag.endsWith('-enabled')) {
      problems.push(`flag must list on/off flags in frontend/src/flags.ts (FLAGS), not "${flag}"`);
    }
  }
  if (new Set(flags).size < flags.length) problems.push('flag lists a key twice');
  const body = m[2].trim();
  if (!body) problems.push('the body after the --- block is empty');

  if (problems.length || !isSurface(surface) || !isCategory(category)) return { ok: false, id, problems };
  return { ok: true, entry: { id, title, surface, category, date, flags: flags as FlagKey[], body } };
}

/**
 * The copy rules an entry is held to beyond its format.
 * The test enforces them; the dialog doesn't check.
 */
export function copyProblems(entry: WhatsNewEntry): string[] {
  const problems: string[] = [];
  const text = `${entry.title}\n${entry.body}`;
  if (entry.title.length > TITLE_MAX) problems.push(`the title is ${entry.title.length} characters; keep it to ${TITLE_MAX}`);
  if (entry.title.endsWith('.')) problems.push('the title ends with a full stop');
  if (entry.body.length > BODY_MAX) problems.push(`the body is ${entry.body.length} characters; keep it to ${BODY_MAX} (one or two sentences)`);
  if (/(^|[\s(])#\d+\b/.test(text)) problems.push('it cites a PR or issue number; say what changed instead');
  // Any listed key, and anything shaped like one (two words or more before
  // -enabled, so "re-enabled" is still a word).
  if ([...FLAG_KEYS].some(k => text.includes(k)) || /\b[a-z0-9]+(?:-[a-z0-9]+)+-enabled\b/.test(text)) {
    problems.push('it names a flag key; the flag goes in the flag field');
  }
  if (/\b(simple|full)[ -](ui|view)\b/i.test(text)) problems.push('it says simple or full UI; the two UIs are termag and lab');
  return problems;
}

/** Newest first; within a day, in CATEGORIES order, then by id. */
export function compareEntries(a: WhatsNewEntry, b: WhatsNewEntry): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const c = CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
  return c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** `./entries/side-panel-tabs.md` → `side-panel-tabs`. */
export function entryId(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.md$/, '');
}

/** Every file in `files` (path → raw text), parsed, in file name order. */
export function parseEntries(files: Record<string, string>): ParsedEntry[] {
  return Object.keys(files).sort().map(path => parseEntry(entryId(path), files[path]));
}

/** The entries that parse, sorted with compareEntries. */
export function validEntries(parsed: ParsedEntry[]): WhatsNewEntry[] {
  return parsed.flatMap(p => (p.ok ? [p.entry] : [])).sort(compareEntries);
}

/** The raw entry files, for the test that holds each one to the format and the copy rules. */
export const ENTRY_FILES: Record<string, string> = import.meta.glob<string>('./entries/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

/** Every entry that parses, newest first. */
export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = validEntries(parseEntries(ENTRY_FILES));
