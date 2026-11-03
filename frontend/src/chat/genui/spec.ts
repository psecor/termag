// A ```spec fence's text as a json-render spec:
// the JSONL patches json-render's inline mode streams (one RFC 6902 patch a
// line, the format the agent is taught), or one JSON object, then checked.
// A fence still streaming (`open`) is read up to its last whole line and may
// lack elements its children name.
//
// A model's spec is sometimes a little wrong: a line that is not JSON, an
// element of a type the catalog lacks, a child it never wrote. Those are left
// out, each with a note the surface shows under what could be drawn, rather
// than losing the whole UI to one line. What is unsafe (a prototype key or
// path, too much to draw, a cycle) still refuses the spec, which is then
// shown as the code block it is.
//
// What is checked here is the structure: size, the element types (the
// catalog's only), each element's shape, that the tree from the root has no
// cycle and is not too deep. Props are checked on every render once
// json-render has resolved their expressions (registry.tsx).
import { applySpecStreamPatch, autoFixSpec, validateSpec, type Spec, type SpecStreamLine } from '@json-render/core';
import { GEN_UI_COMPONENTS } from './catalog';
import { REPEAT_MAX_ITEMS, REPEAT_PATH_PROP } from './limits';

/** The longest fence read; a longer one is shown as code. */
export const SPEC_MAX_CHARS = 64 * 1024;
export const SPEC_MAX_ELEMENTS = 300;
export const SPEC_MAX_DEPTH = 24;
/** The most elements a spec may draw, counting each time a shared child or a repeat draws one again. */
export const SPEC_MAX_RENDERED = 2000;
export { REPEAT_MAX_ITEMS, REPEAT_PATH_PROP } from './limits';

export type SpecRead =
  /** `notes`: what was left out, and why, for the surface to say. */
  | { ok: true; spec: Spec; notes: string[] }
  /** `waiting`: nothing to draw yet, but the fence is still streaming and may become a spec. */
  | { ok: false; waiting: boolean; reason: string };

const TYPES = new Set<string>(GEN_UI_COMPONENTS);
const OPS = new Set(['add', 'replace', 'remove', 'move', 'copy', 'test']);
const FORBIDDEN_SEGMENT = /(^|\/)(__proto__|constructor|prototype)(\/|$)/;
const FORBIDDEN_KEY = new Set(['__proto__', 'constructor', 'prototype']);
const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');

function fail(reason: string, waiting = false): SpecRead {
  return { ok: false, waiting, reason };
}

/** The most lines one patch may be pretty-printed over. */
const PATCH_MAX_LINES = 200;
const NOT_JSON = Symbol('not JSON');
const parsed = (text: string): unknown => { try { return JSON.parse(text); } catch { return NOT_JSON; } };

/** How many brackets a line leaves open (negative when it closes more), outside strings. */
function bracketDepth(line: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth;
}

const lineName = (from: number, to: number) => (from === to ? `line ${from + 1}` : `lines ${from + 1}–${to + 1}`);

/**
 * The patches in a JSONL body, with a note for each line left out; a last
 * line still streaming is left for later. A patch pretty-printed over several
 * lines is read whole. A path naming an object prototype refuses the body.
 */
function patches(body: string, open: boolean): { patches: SpecStreamLine[]; notes: string[] } | string {
  const lines = body.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  const out: SpecStreamLine[] = [];
  const notes: string[] = [];
  for (let i = 0; i <= last; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let end = i;
    let patch = parsed(line);
    if (patch === NOT_JSON && line.startsWith('{')) {
      // Read on to where its brackets close.
      let depth = bracketDepth(line);
      while (depth > 0 && end < last && end - i < PATCH_MAX_LINES) depth += bracketDepth(lines[++end]);
      if (depth > 0 && open && end === last) break;
      if (depth === 0 && end > i) patch = parsed(lines.slice(i, end + 1).join('\n'));
      if (patch === NOT_JSON) end = depth === 0 ? end : i;
    }
    if (patch === NOT_JSON) {
      if (open && end === last) break;
      notes.push(`${lineName(i, end)} ${end > i ? 'are' : 'is'} not JSON`);
    } else if (!plainObject(patch) || typeof patch.op !== 'string' || typeof patch.path !== 'string') {
      notes.push(`${lineName(i, end)} is not a JSON patch`);
    } else if (FORBIDDEN_SEGMENT.test(patch.path) || (typeof patch.from === 'string' && FORBIDDEN_SEGMENT.test(patch.from))) {
      return `${lineName(i, end)}: path not allowed`;
    } else if (!OPS.has(patch.op)) {
      notes.push(`${lineName(i, end)}: unknown op "${patch.op}"`);
    } else {
      out.push(patch as unknown as SpecStreamLine);
    }
    i = end;
  }
  return { patches: out, notes };
}

/** Why an element can't be drawn, or null. */
function elementProblem(el: unknown): string | null {
  if (!plainObject(el)) return 'is not an element';
  if (typeof el.type !== 'string' || !TYPES.has(el.type)) return `has unknown type ${JSON.stringify(el.type)}`;
  if (el.props !== undefined && !plainObject(el.props)) return 'props is not an object';
  if (el.children !== undefined && !stringArray(el.children)) return 'children is not a list of keys';
  if (el.slots !== undefined && !(plainObject(el.slots) && Object.values(el.slots).every(stringArray))) return 'slots is not a map of key lists';
  if (el.on !== undefined && !plainObject(el.on)) return 'on is not an object';
  if (el.watch !== undefined && !plainObject(el.watch)) return 'watch is not an object';
  // A link goes where the spec says, never somewhere built from state: a
  // $template href could carry what the person types to another site.
  if (el.type === 'Link' && el.props !== undefined && typeof (el.props as Record<string, unknown>).href !== 'string') return 'Link href must be a fixed URL';
  return null;
}

/** A closed spec's children that name no element, taken out, with a note for those not already left out. */
function pruneMissing(spec: Spec, leftOut: Set<string>, notes: string[]): void {
  const missing = new Set<string>();
  const keep = (keys: string[]) => keys.filter(k => (spec.elements[k] ? true : (leftOut.has(k) || missing.add(k), false)));
  for (const el of Object.values(spec.elements)) {
    if (el.children?.length) el.children = keep(el.children);
    if (el.slots) el.slots = Object.fromEntries(Object.entries(el.slots).map(([slot, keys]) => [slot, keep(keys)]));
  }
  if (missing.size) {
    const names = [...missing].slice(0, 3).map(k => JSON.stringify(k)).join(', ');
    notes.push(`${missing.size === 1 ? 'element' : 'elements'} ${names}${missing.size > 3 ? ` and ${missing.size - 3} more` : ''} never arrived`);
  }
}

/**
 * A key anywhere in the spec that names an object prototype. JSON.parse keeps
 * `"__proto__"` as an own key, but copying it into another object by
 * assignment (elements[key] = …) would set that object's prototype, so the
 * whole object is checked, as patch paths are.
 */
function forbiddenKey(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 64) return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.has(key)) return key;
    const found = forbiddenKey((value as Record<string, unknown>)[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** The value at a JSON pointer in the spec's state (`/items/0`), or undefined. */
function atPointer(state: unknown, pointer: string): unknown {
  let cur = state;
  for (const raw of pointer.split('/').slice(1)) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/**
 * Why the spec would draw too much, or null. Elements are counted as drawn:
 * a child two parents share is drawn twice (a few shared levels would draw
 * millions from a small spec), and a repeat as if its list were as long as it
 * may ever get (REPEAT_MAX_ITEMS), since a press can set a longer one than
 * the spec started with. A repeat inside a repeat is refused (its fan-out
 * multiplies, item by item), and so is a list already over the limit.
 */
function overBudget(spec: Spec): string | null {
  const memo = new Map<string, number>();
  let problem: string | null = null;
  let repeats = false;
  const size = (key: string, inRepeat: boolean): number => {
    if (problem) return 0;
    const memoKey = `${inRepeat ? 'r' : 'n'}:${key}`;
    const known = memo.get(memoKey);
    if (known !== undefined) return known;
    const el = spec.elements[key];
    if (!el) return 0;
    const repeat = (el as { repeat?: { statePath?: unknown } }).repeat;
    let times = 1;
    if (repeat) {
      if (inRepeat) { problem = `"${key}" repeats inside another repeat`; return 0; }
      const items = typeof repeat.statePath === 'string' ? atPointer(spec.state, repeat.statePath) : undefined;
      if (Array.isArray(items) && items.length > REPEAT_MAX_ITEMS) { problem = `"${key}" repeats over more than ${REPEAT_MAX_ITEMS} items`; return 0; }
      times = REPEAT_MAX_ITEMS;
      repeats = true;
    }
    let total = 1;
    for (const child of [...(el.children ?? []), ...Object.values(el.slots ?? {}).flat()]) {
      total += times * size(child, inRepeat || !!repeat);
      if (total > SPEC_MAX_RENDERED || problem) break;
    }
    memo.set(memoKey, total);
    return total;
  };
  const total = size(spec.root, false);
  if (problem || total <= SPEC_MAX_RENDERED) return problem;
  return `would draw more than ${SPEC_MAX_RENDERED} elements${repeats ? ` (a repeat counts as ${REPEAT_MAX_ITEMS} items)` : ''}`;
}

/**
 * Why the tree from the root can't be drawn: an element inside itself (the
 * renderer would recurse forever) or nesting past SPEC_MAX_DEPTH. null when fine.
 */
function cycleOrDepth(spec: Spec): string | null {
  const onPath = new Set<string>();
  const visit = (key: string, depth: number): string | null => {
    if (depth > SPEC_MAX_DEPTH) return `nested more than ${SPEC_MAX_DEPTH} deep`;
    if (onPath.has(key)) return `"${key}" contains itself`;
    const el = spec.elements[key];
    if (!el) return null;
    onPath.add(key);
    for (const child of [...(el.children ?? []), ...Object.values(el.slots ?? {}).flat()]) {
      const problem = visit(child, depth + 1);
      if (problem) return problem;
    }
    onPath.delete(key);
    return null;
  };
  return visit(spec.root, 0);
}

/**
 * Reads a fence body as a spec. `open` is the markdown parser's: the closing
 * fence has not streamed in yet.
 */
export function readSpec(body: string, open: boolean): SpecRead {
  if (body.length > SPEC_MAX_CHARS) return fail(`longer than ${SPEC_MAX_CHARS / 1024} KB`);
  const trimmed = body.trim();
  if (!trimmed) return fail('empty', open);

  // One object (pretty-printed or not) unless it is a lone patch; several lines of patches fail to parse as one.
  let raw: Record<string, unknown> = {};
  const notes: string[] = [];
  const whole = parsed(trimmed);
  if (plainObject(whole) && !('op' in whole)) {
    raw = whole;
  } else {
    const read = patches(trimmed, open);
    if (typeof read === 'string') return fail(read);
    if (!read.patches.length) return fail(read.notes[0] ?? 'nothing yet', open);
    notes.push(...read.notes);
    for (const patch of read.patches) {
      try { applySpecStreamPatch(raw, patch); } catch { notes.push(`a patch to ${patch.path} could not be applied`); }
    }
  }

  const bad = forbiddenKey(raw);
  if (bad) return fail(`key "${bad}" not allowed`);
  if (typeof raw.root !== 'string' || !raw.root) return fail('no root', open);
  if (!plainObject(raw.elements)) return fail('no elements', open);
  if (raw.state !== undefined && !plainObject(raw.state)) return fail('state is not an object');
  const entries = Object.entries(raw.elements);
  if (entries.length > SPEC_MAX_ELEMENTS) return fail(`more than ${SPEC_MAX_ELEMENTS} elements`);

  const elements: Spec['elements'] = {};
  const leftOut = new Set<string>();
  for (const [key, el] of entries) {
    // One element that can't be drawn is left out; the root can't be.
    const problem = elementProblem(el);
    if (problem && key === raw.root) return fail(`"${key}" ${problem}`);
    if (problem) { notes.push(`"${key}" ${problem}`); leftOut.add(key); continue; }
    const ok = el as Record<string, unknown>;
    elements[key] = { ...ok, type: ok.type, props: (ok.props as Record<string, unknown>) ?? {}, children: (ok.children as string[]) ?? [] } as Spec['elements'][string];
  }

  // Lossless fixes (visible, on, repeat or watch written inside props); a
  // child that never arrived is taken out below, once the fence has closed.
  const spec = autoFixSpec({ root: raw.root, elements, ...(raw.state ? { state: raw.state as Record<string, unknown> } : {}) }, { lossy: false }).spec;
  for (const [key, el] of Object.entries(spec.elements)) {
    // No watchers: a state change that runs an action can feed itself (a
    // pushState into the path it watches loops forever), and nothing here
    // needs one. Each repeat carries its list's path for the render-time check.
    const { watch: _watch, ...rest } = el as Spec['elements'][string] & { watch?: unknown };
    const { [REPEAT_PATH_PROP]: _given, ...props } = (rest.props ?? {}) as Record<string, unknown>;
    const repeat = (rest as { repeat?: { statePath?: unknown } }).repeat;
    spec.elements[key] = { ...rest, props: typeof repeat?.statePath === 'string' ? { ...props, [REPEAT_PATH_PROP]: repeat.statePath } : props } as Spec['elements'][string];
  }

  if (!spec.elements[spec.root]) return fail(`root "${spec.root}" is not an element`, open);
  if (!open) pruneMissing(spec, leftOut, notes);
  const issues = validateSpec(spec).issues.filter(i => i.severity === 'error' && !(open && i.code === 'missing_child'));
  if (issues.length) return fail(issues[0].message);
  const problem = cycleOrDepth(spec) ?? overBudget(spec);
  if (problem) return fail(problem);
  return { ok: true, spec, notes };
}
